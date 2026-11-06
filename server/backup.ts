import fs from "node:fs";
import path from "node:path";
import { contentHash } from "./parse.ts";
import { toLocalIso } from "./store.ts";
import { maskSecret, patchSection, readSection } from "./config.ts";
import { createWebdavClient, WebdavError, type WebdavClient } from "./webdav.ts";

/**
 * 通用 WebDAV 备份。
 *
 * 设计要点：
 * - 本地 `data/notes` 永远是唯一真源，这里只读不写
 * - 云端 `latest/` 是增量镜像，`snapshots/<日期>/` 是每日全量，`monthly/<年-月>/` 永久归档
 * - 本地 manifest 记录"已上传的 hash"，内容没变时**一次请求都不发**
 * - 免费额度每 30 分钟 600 次请求 → 不逐次保存触发，靠 60 分钟定时 + 手动
 */

export type BackupConfig = {
  url: string;
  account: string;
  appPassword: string;
  remoteRoot: string;
  intervalMinutes: number;
  keepDays: number;
};

export type BackupConfigView = {
  url: string;
  account: string;
  passwordMasked: string;
  remoteRoot: string;
  intervalMinutes: number;
  keepDays: number;
  configured: boolean;
};

export type BackupStatus = {
  configured: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  pending: number;
  nextRunAt: string | null;
  snapshots: number;
  keepDays: number;
  intervalMinutes: number;
};

export type SnapshotSummary = {
  day: string;
  files: number;
  bytes: number;
  monthly: boolean;
};

export type SnapshotFile = { path: string; bytes: number };

export type BackupResult = {
  ok: boolean;
  skipped: boolean;
  uploaded: number;
  removed: number;
  snapshotDay: string | null;
  tookMs: number;
};

type Manifest = {
  version: 1;
  updatedAt: string;
  /** 远端指纹：换了账号/地址/根目录就必须重传全量，否则本地清单会谎报"云端已有" */
  remote: string;
  uploaded: Record<string, string>;
  snapshots: Array<{ day: string; files: string[] }>;
  monthly: string[];
};

type State = {
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
};

const DEFAULTS = {
  url: "",
  remoteRoot: "study-notes",
  intervalMinutes: 60,
  keepDays: 14,
};

const MANIFEST_NAME = "manifest.json";

function emptyManifest(): Manifest {
  return { version: 1, updatedAt: "", remote: "", uploaded: {}, snapshots: [], monthly: [] };
}

function remoteFingerprint(cfg: BackupConfig): string {
  return `${cfg.url.replace(/\/+$/, "")}|${cfg.account}|${cfg.remoteRoot}`;
}

function emptyState(): State {
  return { lastSuccessAt: null, lastAttemptAt: null, lastError: null };
}

function manifestFile(dataDir: string): string {
  return path.join(dataDir, "backup-manifest.json");
}

function stateFile(dataDir: string): string {
  return path.join(dataDir, "backup-state.json");
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// —— 配置 ——

export function loadBackupConfig(dataDir: string): BackupConfig | null {
  const raw = readSection<Partial<BackupConfig>>(dataDir, "backup");
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const account = typeof raw.account === "string" ? raw.account.trim() : "";
  const appPassword = typeof raw.appPassword === "string" ? raw.appPassword : "";
  if (!url || !account || !appPassword) return null;
  return {
    url,
    account,
    appPassword,
    remoteRoot: (typeof raw.remoteRoot === "string" && raw.remoteRoot.trim()) || DEFAULTS.remoteRoot,
    intervalMinutes: clampInt(raw.intervalMinutes, DEFAULTS.intervalMinutes, 5, 1440),
    keepDays: clampInt(raw.keepDays, DEFAULTS.keepDays, 1, 3650),
  };
}

export function saveBackupConfig(
  dataDir: string,
  patch: Partial<BackupConfig> & { password?: string },
): BackupConfig | null {
  const current = readSection<Partial<BackupConfig>>(dataDir, "backup");
  const next: Partial<BackupConfig> = {
    url: patch.url ?? current.url ?? DEFAULTS.url,
    account: patch.account ?? current.account ?? "",
    remoteRoot: patch.remoteRoot ?? current.remoteRoot ?? DEFAULTS.remoteRoot,
    intervalMinutes: clampInt(patch.intervalMinutes ?? current.intervalMinutes, DEFAULTS.intervalMinutes, 5, 1440),
    keepDays: clampInt(patch.keepDays ?? current.keepDays, DEFAULTS.keepDays, 1, 3650),
  };
  // 空密码 = 不改（前端只会回传掩码串，不能把真密码覆盖掉）
  const password = typeof patch.password === "string" && patch.password ? patch.password : current.appPassword;
  if (password) next.appPassword = password;
  patchSection(dataDir, "backup", next);
  return loadBackupConfig(dataDir);
}

export function maskBackupConfig(cfg: BackupConfig | null): BackupConfigView {
  return {
    url: cfg?.url ?? DEFAULTS.url,
    account: cfg?.account ?? "",
    passwordMasked: cfg ? maskSecret(cfg.appPassword) : "",
    remoteRoot: cfg?.remoteRoot ?? DEFAULTS.remoteRoot,
    intervalMinutes: cfg?.intervalMinutes ?? DEFAULTS.intervalMinutes,
    keepDays: cfg?.keepDays ?? DEFAULTS.keepDays,
    configured: Boolean(cfg),
  };
}

// —— 扫描本地笔记 ——

type LocalFile = { relPath: string; abs: string; hash: string; bytes: number };

export function scanNotes(notesRoot: string): LocalFile[] {
  const out: LocalFile[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // 跳过隐藏文件/目录（.gitkeep、.trash、.history 都不会被扫到）
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        try {
          const raw = fs.readFileSync(full, "utf8");
          out.push({
            relPath: path.relative(notesRoot, full).split(path.sep).join("/"),
            abs: full,
            hash: contentHash(raw),
            bytes: Buffer.byteLength(raw, "utf8"),
          });
        } catch {
          // 单个文件读失败不影响整次备份
        }
      }
    }
  };
  walk(notesRoot);
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

// —— 服务 ——

export type BackupDeps = {
  dataDir: string;
  notesRoot: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** 每次自动检查的最小间隔（毫秒），默认 60s，测试里会调小 */
  tickMs?: number;
};

export type BackupService = {
  status(): BackupStatus;
  pendingCount(): number;
  run(): Promise<BackupResult>;
  /** 定时器调用：到点才真正备份，返回是否真的跑了 */
  autoRun(): Promise<BackupResult | null>;
  test(): Promise<void>;
  listSnapshots(): SnapshotSummary[];
  snapshotFiles(day: string): SnapshotFile[];
  readSnapshotFile(day: string, relPath: string): Promise<string | null>;
  invalidate(): void;
};

export function createBackupService(deps: BackupDeps): BackupService {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  let running: Promise<BackupResult> | null = null;
  let lastAutoAttempt = 0;

  const manifest = (): Manifest => readJson(manifestFile(deps.dataDir), emptyManifest());
  const state = (): State => readJson(stateFile(deps.dataDir), emptyState());

  function client(): WebdavClient {
    const cfg = loadBackupConfig(deps.dataDir);
    if (!cfg) throw new BackupError("未配置 WebDAV 地址、账号与应用密码", "UNCONFIGURED", 400);
    return createWebdavClient(
      { url: cfg.url, account: cfg.account, appPassword: cfg.appPassword, remoteRoot: cfg.remoteRoot },
      fetchImpl,
    );
  }

  function pendingCount(): number {
    const m = manifest();
    const files = scanNotes(deps.notesRoot);
    const changed = files.filter((file) => m.uploaded[file.relPath] !== file.hash).length;
    const deleted = Object.keys(m.uploaded).filter((relPath) => !files.some((file) => file.relPath === relPath)).length;
    return changed + deleted;
  }

  function status(): BackupStatus {
    const cfg = loadBackupConfig(deps.dataDir);
    const st = state();
    const m = manifest();
    let nextRunAt: string | null = null;
    if (cfg) {
      const base = st.lastAttemptAt ? new Date(st.lastAttemptAt) : now();
      const next = new Date(base.getTime() + cfg.intervalMinutes * 60_000);
      nextRunAt = toLocalIso(next);
    }
    return {
      configured: Boolean(cfg),
      lastSuccessAt: st.lastSuccessAt,
      lastError: st.lastError,
      lastAttemptAt: st.lastAttemptAt,
      pending: cfg ? pendingCount() : 0,
      nextRunAt,
      snapshots: m.snapshots.length,
      keepDays: cfg?.keepDays ?? DEFAULTS.keepDays,
      intervalMinutes: cfg?.intervalMinutes ?? DEFAULTS.intervalMinutes,
    };
  }

  function dayCutoff(keepDays: number): string {
    const cutoff = new Date(now().getTime() - keepDays * 86_400_000);
    return toLocalIso(cutoff).slice(0, 10);
  }

  async function doRun(): Promise<BackupResult> {
    const started = Date.now();
    const cfg = loadBackupConfig(deps.dataDir);
    if (!cfg) throw new BackupError("未配置 WebDAV 地址、账号与应用密码", "UNCONFIGURED", 400);

    const webdav = createWebdavClient(
      { url: cfg.url, account: cfg.account, appPassword: cfg.appPassword, remoteRoot: cfg.remoteRoot },
      fetchImpl,
    );
    const m = manifest();
    // 换了远端（账号/地址/根目录）：本地清单不再可信，按首次备份重来
    if (m.remote !== remoteFingerprint(cfg)) {
      m.remote = remoteFingerprint(cfg);
      m.uploaded = {};
      m.snapshots = [];
      m.monthly = [];
    }
    const files = scanNotes(deps.notesRoot);
    const today = toLocalIso(now()).slice(0, 10);
    const month = today.slice(0, 7);

    const byPath = new Map(files.map((file) => [file.relPath, file]));
    const changed = files.filter((file) => m.uploaded[file.relPath] !== file.hash);
    const deleted = Object.keys(m.uploaded).filter((relPath) => !byPath.has(relPath));
    const hasToday = m.snapshots.some((entry) => entry.day === today);

    const st = state();
    st.lastAttemptAt = toLocalIso(now());
    writeJson(stateFile(deps.dataDir), st);

    if (changed.length === 0 && deleted.length === 0 && hasToday) {
      const skipped: BackupResult = {
        ok: true,
        skipped: true,
        uploaded: 0,
        removed: 0,
        snapshotDay: today,
        tookMs: Date.now() - started,
      };
      st.lastSuccessAt = toLocalIso(now());
      st.lastError = null;
      writeJson(stateFile(deps.dataDir), st);
      return skipped;
    }

    let uploaded = 0;
    let removed = 0;
    try {
      await webdav.ensureDir("latest");
      // 今天的快照已经拍过时，快照里已有的路径就保持"当天首次备份时的样子"；
      // 但**当天新增**的笔记必须补进去 —— 否则"上午新建、下午写坏"当天无从恢复。
      const todayEntry = m.snapshots.find((entry) => entry.day === today);
      const inTodaySnapshot = new Set(todayEntry?.files ?? []);

      for (const file of changed) {
        const raw = fs.readFileSync(file.abs, "utf8");
        await webdav.put(`latest/${file.relPath}`, raw);
        m.uploaded[file.relPath] = file.hash;
        uploaded += 1;
        if (todayEntry && !inTodaySnapshot.has(file.relPath)) {
          await webdav.put(`snapshots/${today}/${file.relPath}`, raw);
          inTodaySnapshot.add(file.relPath);
          todayEntry.files.push(file.relPath);
        }
      }
      for (const relPath of deleted) {
        await webdav.remove(`latest/${relPath}`);
        delete m.uploaded[relPath];
        removed += 1;
      }

      // 每天第一次备份：传一份全量快照（32 KB 级别，成本可忽略）
      if (!todayEntry) {
        for (const file of files) {
          const raw = fs.readFileSync(file.abs, "utf8");
          await webdav.put(`snapshots/${today}/${file.relPath}`, raw);
        }
        m.snapshots.push({ day: today, files: files.map((file) => file.relPath) });
      }

      // 每月第一次备份：额外留一份永久归档（一年 12 份，几 MB 级别）
      if (!m.monthly.includes(month)) {
        for (const file of files) {
          const raw = fs.readFileSync(file.abs, "utf8");
          await webdav.put(`monthly/${month}/${file.relPath}`, raw);
        }
        m.monthly.push(month);
      }

      // 清理过期的日快照（月度归档不动）
      const cutoff = dayCutoff(cfg.keepDays);
      const expired = m.snapshots.filter((entry) => entry.day < cutoff);
      for (const entry of expired) {
        for (const relPath of entry.files) {
          try {
            await webdav.remove(`snapshots/${entry.day}/${relPath}`);
          } catch {
            // 清理失败不影响这次备份的结论，下次再试
          }
        }
      }
      if (expired.length > 0) {
        m.snapshots = m.snapshots.filter((entry) => entry.day >= cutoff);
      }

      m.updatedAt = toLocalIso(now());
      await webdav.put(MANIFEST_NAME, JSON.stringify(m, null, 2));
      writeJson(manifestFile(deps.dataDir), m);

      st.lastSuccessAt = toLocalIso(now());
      st.lastError = null;
      st.lastAttemptAt = st.lastSuccessAt;
      writeJson(stateFile(deps.dataDir), st);

      return {
        ok: true,
        skipped: false,
        uploaded,
        removed,
        snapshotDay: today,
        tookMs: Date.now() - started,
      };
    } catch (err) {
      st.lastError = err instanceof Error ? err.message : String(err);
      writeJson(stateFile(deps.dataDir), st);
      // 已成功的部分写回，避免下次重复上传
      writeJson(manifestFile(deps.dataDir), m);
      throw err;
    }
  }

  function run(): Promise<BackupResult> {
    // 单飞：定时与手动撞在一起时共用一个在跑的 Promise
    if (running) return running;
    running = doRun().finally(() => {
      running = null;
    });
    return running;
  }

  async function autoRun(): Promise<BackupResult | null> {
    const cfg = loadBackupConfig(deps.dataDir);
    if (!cfg) return null;
    const st = state();
    const base = st.lastAttemptAt ? new Date(st.lastAttemptAt).getTime() : 0;
    if (base && Date.now() - base < cfg.intervalMinutes * 60_000) return null;
    // 同一进程内也别检查太密（默认 60s 一次，纯本地计算，不发请求）
    if (Date.now() - lastAutoAttempt < (deps.tickMs ?? 60_000)) return null;
    lastAutoAttempt = Date.now();
    try {
      return await run();
    } catch {
      return null;
    }
  }

  async function test(): Promise<void> {
    // 先存后测：前端点"测试连接"时可能刚填了密码但没保存
    await client().probe();
  }

  function listSnapshots(): SnapshotSummary[] {
    const m = manifest();
    const files = scanNotes(deps.notesRoot);
    const sizes = new Map(files.map((file) => [file.relPath, file.bytes]));
    return m.snapshots
      .map((entry) => ({
        day: entry.day,
        files: entry.files.length,
        bytes: entry.files.reduce((sum, relPath) => sum + (sizes.get(relPath) ?? 0), 0),
        monthly: m.monthly.includes(entry.day.slice(0, 7)),
      }))
      .sort((a, b) => (a.day < b.day ? 1 : -1));
  }

  function snapshotFiles(day: string): SnapshotFile[] {
    const entry = manifest().snapshots.find((item) => item.day === day);
    if (!entry) return [];
    return entry.files.map((relPath) => ({ path: relPath, bytes: 0 }));
  }

  async function readSnapshotFile(day: string, relPath: string): Promise<string | null> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new BackupError("快照日期格式不对", "BAD_REQUEST", 400);
    if (!isSafeRelPath(relPath)) throw new BackupError("非法的文件路径", "BAD_REQUEST", 400);
    return await client().get(`snapshots/${day}/${relPath}`);
  }

  function invalidate(): void {
    // 配置变了就重算 pending / nextRunAt —— 目前状态都是现算的，这里留个钩子
  }

  return { status, pendingCount, run, autoRun, test, listSnapshots, snapshotFiles, readSnapshotFile, invalidate };
}

export class BackupError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 502) {
    super(message);
    this.name = "BackupError";
    this.code = code;
    this.status = status;
  }
}

/** 只允许相对路径：拒绝绝对路径、上跳、盘符、反斜杠。 */
export function isSafeRelPath(relPath: string): boolean {
  if (!relPath || relPath.length > 512) return false;
  if (path.isAbsolute(relPath)) return false;
  if (relPath.includes("\\") || relPath.includes("\0")) return false;
  const parts = relPath.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

export function describeWebdavError(err: unknown): { message: string; code: string } {
  if (err instanceof WebdavError) return { message: err.message, code: err.code };
  if (err instanceof BackupError) return { message: err.message, code: err.code };
  return { message: err instanceof Error ? err.message : String(err), code: "UNKNOWN" };
}
