import { useEffect, useRef, useState } from "react";
import * as api from "../api.ts";
import type { BackupConfigView, BackupStatus, SnapshotDay, SnapshotFile } from "../api.ts";
import Preview from "./Preview.tsx";
import { clockTime, dayKey, relativeTime, todayKey } from "../lib/time.ts";

type Props = {
  open: boolean;
  onClose: () => void;
  /** 本地已有笔记的 relPath：决定恢复确认文案是「覆盖」还是「按原路径恢复」。 */
  localPaths: string[];
  /** 编辑器里正开着的那篇；同一篇有未保存改动时不发起恢复，避免双重冲突。 */
  openNote: { relPath: string; hash: string; dirty: boolean } | null;
  /** 恢复成功后通知 App 刷新列表/时间流（relPath 用来判断要不要重载编辑器）。 */
  onRestored: (relPath: string) => void;
};

type Tab = "status" | "config" | "snapshots";

/** 快照预览的当前对象（day + 路径 + 剥掉 frontmatter 的正文）。 */
type PreviewState = { day: string; path: string; title: string; body: string };

const DEFAULT_CONFIG: BackupConfigView = {
  url: "",
  account: "",
  passwordMasked: "",
  remoteRoot: "study-notes",
  intervalMinutes: 60,
  keepDays: 14,
};

/** 15 / 60 / 1440 分钟三档 + 14/30/90/365 天，和设计文档 6.6 / 十.3 保持一致。 */
const INTERVAL_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 15, label: "每 15 分钟" },
  { value: 60, label: "每 1 小时" },
  { value: 1440, label: "每天" },
];

const KEEP_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 14, label: "14 天" },
  { value: 30, label: "30 天" },
  { value: 90, label: "90 天" },
  { value: 365, label: "365 天" },
];

/** 下拉里可能拿到服务端存的非候选值（例如手改过 config.json），补一个只读选项兜底。 */
function withFallback(options: Array<{ value: number; label: string }>, value: number) {
  if (options.some((option) => option.value === value)) return options;
  return [...options, { value, label: `${value} 分钟` }];
}

/** 快照里是带 frontmatter 的原始 .md：预览前剥掉 YAML 头，并尽量取出标题。 */
function splitFrontmatter(raw: string): { title: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { title: "", body: raw };
  const head = match[1] ?? "";
  const titleLine = /^title:\s*(.*)$/m.exec(head);
  const title = titleLine ? (titleLine[1] ?? "").trim().replace(/^["']|["']$/g, "") : "";
  return { title, body: raw.slice(match[0].length) };
}

/** 列表里只有路径：`backend-go/00-代码地图.md` → `00-代码地图` 当显示标题。 */
function titleFromPath(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.md$/i, "");
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** nextRunAt 是未来时间：relativeTime 对未来只会回落到时钟，所以单独格式化。 */
function formatNextRun(iso: string | null): string {
  if (!iso) return "未安排";
  const key = dayKey(iso);
  const clock = clockTime(iso);
  if (!clock) return key;
  return key === todayKey() ? `今天 ${clock}` : `${key} ${clock}`;
}

/** 快照预览是只读副本：双链/标签点进去不该把正在编辑的笔记换掉。 */
function noop(): void {
  // 故意为空
}

/**
 * WebDAV 备份面板（右侧抽屉）。
 *
 * 三段：状态 / 设置 / 快照恢复。为什么是抽屉而不是居中弹窗：设置项和快照列表都可能很长，
 * 右侧铺满高度能少滚动，也不遮住左边的笔记列表。
 */
export default function BackupPanel({ open, onClose, localPaths, openNote, onRestored }: Props) {
  const [tab, setTab] = useState<Tab>("status");

  // —— 状态段 ——
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runMessage, setRunMessage] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  // —— 设置段 ——
  const [config, setConfig] = useState<BackupConfigView | null>(null);
  const [url, setUrl] = useState(DEFAULT_CONFIG.url);
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [remoteRoot, setRemoteRoot] = useState(DEFAULT_CONFIG.remoteRoot);
  const [intervalMinutes, setIntervalMinutes] = useState(DEFAULT_CONFIG.intervalMinutes);
  const [keepDays, setKeepDays] = useState(DEFAULT_CONFIG.keepDays);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // —— 快照 / 恢复段 ——
  const [snapshots, setSnapshots] = useState<SnapshotDay[] | null>(null);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [snapshotsError, setSnapshotsError] = useState<string | null>(null);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [filesByDay, setFilesByDay] = useState<Record<string, SnapshotFile[]>>({});
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);

  // 多个异步请求会同时飞，用各自的序号丢弃过期结果（切 tab / 连点时不串数据）
  const statusSeq = useRef(0);
  const snapshotsSeq = useRef(0);
  const previewSeq = useRef(0);

  const localSet = new Set(localPaths);

  async function loadStatus(): Promise<void> {
    const seq = ++statusSeq.current;
    setStatusLoading(true);
    setStatusError(null);
    try {
      const next = await api.getBackupStatus();
      if (seq !== statusSeq.current) return;
      setStatus(next);
      if (!next.configured) {
        // 没配置就没有"状态"可看，直接落在设置段并给一句引导
        setTab("config");
        void loadConfig();
      }
    } catch (err) {
      if (seq === statusSeq.current) setStatusError(api.errorMessage(err));
    } finally {
      if (seq === statusSeq.current) setStatusLoading(false);
    }
  }

  async function loadConfig(): Promise<void> {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const view = await api.getBackupConfig();
      setConfig(view);
      setUrl(view.url || DEFAULT_CONFIG.url);
      setAccount(view.account);
      setPassword("");
      setRemoteRoot(view.remoteRoot || DEFAULT_CONFIG.remoteRoot);
      setIntervalMinutes(view.intervalMinutes || DEFAULT_CONFIG.intervalMinutes);
      setKeepDays(view.keepDays || DEFAULT_CONFIG.keepDays);
    } catch (err) {
      setConfigError(api.errorMessage(err));
    } finally {
      setConfigLoading(false);
    }
  }

  async function loadSnapshots(): Promise<void> {
    const seq = ++snapshotsSeq.current;
    setSnapshotsLoading(true);
    setSnapshotsError(null);
    try {
      const items = await api.getSnapshots();
      if (seq !== snapshotsSeq.current) return;
      setSnapshots(items);
    } catch (err) {
      if (seq === snapshotsSeq.current) setSnapshotsError(api.errorMessage(err));
    } finally {
      if (seq === snapshotsSeq.current) setSnapshotsLoading(false);
    }
  }

  // 每次打开都重新取一遍：可能在别处（自动备份）已经跑过一次了
  useEffect(() => {
    if (!open) return;
    setTab("status");
    setRunning(false);
    setRunMessage(null);
    setRunError(null);
    setConfigError(null);
    setTestMessage(null);
    setPassword("");
    setPreview(null);
    setPreviewError(null);
    setConfirming(false);
    setRestoreError(null);
    setRestoreNotice(null);
    setExpandedDay(null);
    setFilesByDay({});
    setFilesError(null);
    setSnapshots(null);
    setSnapshotsError(null);
    void loadStatus();
    // 只在 open 变化时重置；各 load 函数每次渲染都是新引用，放进来会无限触发
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      // 预览 / 二次确认是抽屉里的下一层，Esc 先退一层更符合预期
      if (confirming) {
        setConfirming(false);
        return;
      }
      if (preview) {
        setPreview(null);
        setPreviewError(null);
        return;
      }
      onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, confirming, preview]);

  if (!open) return null;

  function selectTab(next: Tab): void {
    setTab(next);
    if (next === "config") void loadConfig();
    if (next === "snapshots" && snapshots === null) void loadSnapshots();
    if (next === "status") void loadStatus();
  }

  async function backupNow(): Promise<void> {
    if (running) return;
    setRunning(true);
    setRunError(null);
    setRunMessage(null);
    try {
      const res = await api.runBackup();
      setRunMessage(
        res.skipped
          ? "没有变化，跳过上传（0 请求）"
          : `已上传 ${res.uploaded} 篇，用时 ${Math.max(1, Math.round(res.tookMs / 1000))} 秒`,
      );
      // 备份可能生成了今天的新快照 / 清了过期快照：缓存的快照列表作废
      setSnapshots(null);
      setFilesByDay({});
      await loadStatus();
    } catch (err) {
      setRunError(api.errorMessage(err));
      // 服务端会把 lastError 记进状态里，读回来就能看到可读的那句
      void loadStatus();
    } finally {
      setRunning(false);
    }
  }

  /** 只做「上行保存」，测试连接要先存后测，所以抽出来复用。返回 null 表示没保存。 */
  async function submitConfig(): Promise<BackupConfigView | null> {
    if (saving) return null;
    if (!url.trim()) {
      setConfigError("WebDAV 地址不能为空，请填写服务商提供的根地址。");
      return null;
    }
    if (!account.trim()) {
      setConfigError("WebDAV 账号不能为空。");
      return null;
    }
    if (!config?.passwordMasked && !password.trim()) {
      setConfigError("第一次配置需要填写 WebDAV 密码或应用密码。");
      return null;
    }

    const patch: api.BackupConfigPatch = {
      url: url.trim(),
      account: account.trim(),
      remoteRoot: remoteRoot.trim() || DEFAULT_CONFIG.remoteRoot,
      intervalMinutes,
      keepDays,
    };
    // 空密码 = 不改：掩码串不能回传，否则真密码会被覆盖成 ••••••••
    if (password.trim()) patch.password = password.trim();

    setSaving(true);
    setConfigError(null);
    setTestMessage(null);
    try {
      return await api.saveBackupConfig(patch);
    } catch (err) {
      setConfigError(api.errorMessage(err));
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function saveConfig(): Promise<void> {
    const wasConfigured = status?.configured === true;
    const saved = await submitConfig();
    if (!saved) return;
    setConfig(saved);
    setPassword("");
    await loadStatus();
    if (!wasConfigured) {
      // 第一次配好，下一步就是「立即备份」，别让人再自己找一遍
      setTab("status");
      setRunMessage("设置已保存，可以点「立即备份」了");
    } else {
      setTestMessage({ ok: true, text: "设置已保存" });
    }
  }

  async function checkConnection(): Promise<void> {
    if (testing || saving) return;
    // 服务端测试连接读的是**已保存**的配置，所以先存再测（刚填的密码才不会白填）
    const saved = await submitConfig();
    if (!saved) return;
    setConfig(saved);
    setPassword("");
    setTesting(true);
    setTestMessage(null);
    try {
      await api.testBackup();
      setTestMessage({ ok: true, text: "连接正常，可以备份了" });
      await loadStatus();
    } catch (err) {
      setTestMessage({ ok: false, text: `连接失败：${api.errorMessage(err)}` });
    } finally {
      setTesting(false);
    }
  }

  async function toggleDay(day: string): Promise<void> {
    setPreview(null);
    setPreviewError(null);
    setConfirming(false);
    setRestoreError(null);
    if (expandedDay === day) {
      setExpandedDay(null);
      return;
    }
    setExpandedDay(day);
    if (filesByDay[day]) return;
    setFilesLoading(true);
    setFilesError(null);
    try {
      const files = await api.getSnapshotFiles(day);
      setFilesByDay((prev) => ({ ...prev, [day]: files }));
    } catch (err) {
      setFilesError(api.errorMessage(err));
    } finally {
      setFilesLoading(false);
    }
  }

  async function openFile(day: string, relPath: string): Promise<void> {
    const seq = ++previewSeq.current;
    setConfirming(false);
    setRestoreError(null);
    setRestoreNotice(null);
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      const raw = await api.getSnapshotFile(day, relPath);
      if (seq !== previewSeq.current) return;
      const parsed = splitFrontmatter(raw);
      setPreview({
        day,
        path: relPath,
        title: parsed.title || titleFromPath(relPath),
        body: parsed.body,
      });
    } catch (err) {
      if (seq !== previewSeq.current) return;
      setPreview(null);
      setPreviewError(api.errorMessage(err));
    } finally {
      if (seq === previewSeq.current) setPreviewLoading(false);
    }
  }

  async function restore(): Promise<void> {
    const target = preview;
    if (!target || restoring) return;
    // 只是"正在看的快照文件"恰好就是编辑器里这篇：这时才需要乐观锁
    const opened = openNote && openNote.relPath === target.path ? openNote : null;
    if (opened && opened.dirty) {
      // 设计 6.4：正开着且有没保存的改动时先拦一道，不给用户制造双重冲突
      setRestoreError("这篇正在编辑还有未保存改动，先保存或放弃修改再恢复。");
      return;
    }

    setRestoring(true);
    setRestoreError(null);
    setRestoreNotice(null);
    try {
      // baseHash 用编辑器里当前这篇的 hash；没开着这篇就没有乐观锁可言，传空串
      const result = await api.restoreFromSnapshot(target.day, target.path, opened ? opened.hash : "");
      setConfirming(false);
      setPreview(null);
      setRestoreNotice(`已用 ${target.day} 的版本写回《${target.title}》`);
      onRestored(result.relPath || target.path);
      // 恢复不动云端，但本地"是否有这篇"变了，状态里的待备份篇数要重算
      void loadStatus();
    } catch (err) {
      const conflict = api.conflictInfo(err);
      setRestoreError(
        conflict ? "这篇在你打开后又被改过，先保存或重新加载再恢复" : api.errorMessage(err),
      );
    } finally {
      setRestoring(false);
    }
  }

  function renderStatus() {
    if (statusLoading && !status) return <p className="backup-hint">正在读取备份状态…</p>;
    if (statusError && !status) {
      return (
        <div className="backup-error" role="alert">
          <p>{statusError}</p>
          <button type="button" className="btn btn--small" onClick={() => void loadStatus()}>
            重试
          </button>
        </div>
      );
    }

    const lastBackup = status?.lastSuccessAt ? relativeTime(status.lastSuccessAt) : "还没备份过";
    return (
      <>
        <dl className="backup-facts">
          <div className="backup-facts__row">
            <dt>上次备份</dt>
            <dd>{lastBackup}</dd>
          </div>
          <div className="backup-facts__row">
            <dt>待备份</dt>
            <dd>{status && status.pending > 0 ? `${status.pending} 篇` : "没有变化"}</dd>
          </div>
          <div className="backup-facts__row">
            <dt>下次自动</dt>
            <dd>{formatNextRun(status?.nextRunAt ?? null)}</dd>
          </div>
          <div className="backup-facts__row">
            <dt>云端快照</dt>
            <dd>{status ? `${status.snapshots} 份 · 保留 ${status.keepDays} 天` : "—"}</dd>
          </div>
        </dl>

        <div className="backup-actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void backupNow()}
            disabled={running || status?.configured === false}
            title="把有变化的笔记传到云端，并生成今天的快照"
          >
            {running ? "备份中…" : "立即备份"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void loadStatus()}
            disabled={running || statusLoading}
            title="重新读取备份状态"
          >
            刷新
          </button>
        </div>

        {status?.configured === false ? (
          <p className="backup-hint">还没配账号，去「设置」填 WebDAV 地址与应用密码后就能备份。</p>
        ) : null}

        {runMessage ? (
          <p className="backup-ok" role="status">
            {runMessage}
          </p>
        ) : null}

        {runError || status?.lastError ? (
          <div className="backup-error" role="alert">
            <p>{runError ?? status?.lastError}</p>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => void backupNow()}
              disabled={running}
            >
              重试
            </button>
          </div>
        ) : null}

        <p className="backup-hint">
          备份只往云端写，不会改本地笔记；恢复是显式动作，在「快照」里手动做。
        </p>
      </>
    );
  }

  function renderConfig() {
    return (
      <>
        {status?.configured === false ? (
          <p className="backup-hint backup-hint--lead">
            还没有配置。请从你的 WebDAV 服务商获取服务地址、账号和密码；推荐使用可单独吊销的应用密码。
          </p>
        ) : null}

        {configLoading ? <p className="backup-hint">正在读取设置…</p> : null}

        <label className="field">
          <span>WebDAV 地址</span>
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://dav.example.com/remote.php/dav/files/user/"
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>WebDAV 账号</span>
          <input
            value={account}
            onChange={(event) => setAccount(event.target.value)}
            placeholder="you@example.com"
            spellCheck={false}
            autoComplete="username"
          />
        </label>

        <label className="field">
          <span>应用密码</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={
              config?.passwordMasked
                ? `已保存：${config.passwordMasked}（留空则不修改）`
                : "WebDAV 密码或应用密码"
            }
            spellCheck={false}
            autoComplete="new-password"
          />
        </label>

        <label className="field">
          <span>远端根目录</span>
          <input
            value={remoteRoot}
            onChange={(event) => setRemoteRoot(event.target.value)}
            placeholder="study-notes"
            spellCheck={false}
          />
        </label>

        <div className="settings__row">
          <label className="field">
            <span>自动备份间隔</span>
            <select
              value={String(intervalMinutes)}
              onChange={(event) => setIntervalMinutes(Number(event.target.value))}
            >
              {withFallback(INTERVAL_OPTIONS, intervalMinutes).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>快照保留</span>
            <select value={String(keepDays)} onChange={(event) => setKeepDays(Number(event.target.value))}>
              {withFallback(KEEP_OPTIONS, keepDays).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="settings__tip">
          免费版限制每 30 分钟 600 次请求，所以默认每 1 小时一次；保存笔记本身不会触发备份。
        </p>

        {configError ? (
          <p className="backup-error" role="alert">
            {configError}
          </p>
        ) : null}
        {testMessage ? (
          <p className={testMessage.ok ? "backup-ok" : "backup-error"} role="status">
            {testMessage.text}
          </p>
        ) : null}

        <div className="backup-actions backup-actions--end">
          <button
            type="button"
            className="btn"
            onClick={() => void checkConnection()}
            disabled={saving || testing}
            title="先保存当前设置，再访问一次 WebDAV 根目录"
          >
            {testing ? "测试中…" : "测试连接"}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void saveConfig()}
            disabled={saving || testing}
            title="保存设置并刷新备份状态"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
        <p className="settings__tip">「测试连接」会先把上面的设置存下来——服务端只会拿已保存的密码去连。</p>
      </>
    );
  }

  function renderSnapshots() {
    if (status?.configured === false) {
      return <p className="backup-hint">先配好账号，有了第一份备份才会出现快照。</p>;
    }
    if (snapshotsLoading && snapshots === null) return <p className="backup-hint">正在读取快照列表…</p>;
    if (snapshotsError) {
      return (
        <div className="backup-error" role="alert">
          <p>{snapshotsError}</p>
          <button type="button" className="btn btn--small" onClick={() => void loadSnapshots()}>
            重试
          </button>
        </div>
      );
    }
    if (snapshots !== null && snapshots.length === 0) {
      return <p className="backup-hint">云端还没有快照。去「状态」点一下「立即备份」，就会留下今天这一份。</p>;
    }

    return (
      <>
        <p className="backup-hint">点日期展开文件，点文件看快照里的内容；恢复是显式动作，不会自动发生。</p>

        <ul className="backup-days">
          {(snapshots ?? []).map((snap) => {
            const expanded = expandedDay === snap.day;
            const files = filesByDay[snap.day];
            const size = formatBytes(snap.bytes);
            return (
              <li key={snap.day} className="backup-day">
                <button
                  type="button"
                  className={`backup-day__head${expanded ? " is-open" : ""}`}
                  onClick={() => void toggleDay(snap.day)}
                  aria-expanded={expanded}
                  title={`${snap.day} 的快照：${snap.files} 篇`}
                >
                  <span className="backup-day__date">{snap.day}</span>
                  {snap.monthly ? <span className="backup-day__badge">月度</span> : null}
                  <span className="backup-day__meta">
                    {snap.files} 篇{size ? ` · ${size}` : ""}
                  </span>
                  <span className="backup-day__chevron" aria-hidden="true">
                    {expanded ? "▾" : "▸"}
                  </span>
                </button>

                {expanded ? (
                  <div className="backup-day__files">
                    {filesLoading && !files ? <p className="backup-hint">读取文件列表…</p> : null}
                    {filesError ? (
                      <p className="backup-error" role="alert">
                        {filesError}
                      </p>
                    ) : null}
                    {(files ?? []).map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        className={`backup-file${
                          preview && preview.day === snap.day && preview.path === file.path ? " is-active" : ""
                        }`}
                        onClick={() => void openFile(snap.day, file.path)}
                        title={`预览 ${file.path}`}
                      >
                        <span className="backup-file__name">{titleFromPath(file.path)}</span>
                        <span className="backup-file__path">{file.path}</span>
                      </button>
                    ))}
                    {files && files.length === 0 ? <p className="backup-hint">这份快照里没有文件。</p> : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>

        {previewLoading ? <p className="backup-hint">正在取回快照内容…</p> : null}
        {previewError ? (
          <p className="backup-error" role="alert">
            {previewError}
          </p>
        ) : null}

        {preview ? (
          <section className="backup-preview" aria-label={`${preview.day} 的快照内容`}>
            <header className="backup-preview__head">
              <div>
                <span className="backup-preview__title">{preview.title}</span>
                <span className="backup-preview__meta">
                  {preview.day} · {preview.path}
                </span>
              </div>
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setPreview(null);
                  setConfirming(false);
                  setRestoreError(null);
                }}
                title="收起快照预览"
              >
                收起
              </button>
            </header>

            <div className="backup-preview__body">
              <Preview markdown={preview.body} onOpenWikilink={noop} onFilterTag={noop} />
            </div>

            {confirming ? (
              <div className="backup-confirm">
                <p>
                  {localSet.has(preview.path)
                    ? `将用 ${preview.day} 的版本覆盖《${preview.title}》`
                    : "这篇本地已删除，将按原路径恢复"}
                </p>
                <div className="backup-actions backup-actions--end">
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => setConfirming(false)}
                    disabled={restoring}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="btn btn--small btn--primary"
                    onClick={() => void restore()}
                    disabled={restoring}
                    title="把这一版写回本地（会先备份当前版本到 .history）"
                  >
                    {restoring ? "恢复中…" : "确认恢复"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="backup-preview__foot">
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => {
                    setConfirming(true);
                    setRestoreError(null);
                    setRestoreNotice(null);
                  }}
                  title="把这个快照版本写回本地"
                >
                  恢复这一篇
                </button>
              </div>
            )}

            {restoreError ? (
              <p className="backup-error" role="alert">
                {restoreError}
              </p>
            ) : null}
            {restoreNotice ? (
              <p className="backup-ok" role="status">
                {restoreNotice}
              </p>
            ) : null}
          </section>
        ) : null}
      </>
    );
  }

  return (
    <div className="overlay overlay--right" role="presentation" onMouseDown={onClose}>
      <div
        className="backup-panel"
        role="dialog"
        aria-modal="true"
        aria-label="WebDAV 备份"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="backup-panel__head">
          <div>
            <h2>WebDAV 备份</h2>
            <span className="backup-panel__sub">WebDAV · 单向备份 · 快照可恢复</span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭备份面板" title="关闭（Esc）">
            ×
          </button>
        </header>

        <div className="backup-tabs" role="tablist" aria-label="备份面板分段">
          {(
            [
              { key: "status", label: "状态" },
              { key: "config", label: "设置" },
              { key: "snapshots", label: "快照" },
            ] as Array<{ key: Tab; label: string }>
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              className={`backup-tab${tab === item.key ? " is-active" : ""}`}
              onClick={() => selectTab(item.key)}
              title={`${item.label}（${item.key === "status" ? "上次结果与立即备份" : item.key === "config" ? "账号与间隔" : "从快照恢复单篇"}）`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="backup-panel__body" role="tabpanel" aria-label={tab === "status" ? "状态" : tab === "config" ? "设置" : "快照"}>
          {tab === "status" ? renderStatus() : tab === "config" ? renderConfig() : renderSnapshots()}
        </div>
      </div>
    </div>
  );
}
