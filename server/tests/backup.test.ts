import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createBackupService,
  isSafeRelPath,
  loadBackupConfig,
  maskBackupConfig,
  saveBackupConfig,
  scanNotes,
} from "../backup.ts";
import { createWebdavClient } from "../webdav.ts";

const tempDirs: string[] = [];

function makeDataDir(): { dataDir: string; notesRoot: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "study-backup-"));
  const notesRoot = path.join(dataDir, "notes");
  fs.mkdirSync(path.join(notesRoot, "backend-go"), { recursive: true });
  fs.writeFileSync(path.join(notesRoot, "a.md"), "# A\n\n第一篇\n", "utf8");
  fs.writeFileSync(path.join(notesRoot, "backend-go", "b.md"), "# B\n\n第二篇\n", "utf8");
  fs.writeFileSync(path.join(notesRoot, ".gitkeep"), "", "utf8");
  tempDirs.push(dataDir);
  return { dataDir, notesRoot };
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

type Call = { method: string; path: string; body?: string };

/** 内存版 WebDAV：够用来验证请求序列、增量与恢复。 */
function fakeWebdav() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const calls: Call[] = [];
  let authHeader = "";

  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const relPath = decodeURIComponent(url.pathname).replace(/^\/dav\/study-notes\/?/, "");
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (headers.authorization) authHeader = headers.authorization;
    calls.push({ method, path: relPath, body: typeof init.body === "string" ? init.body : undefined });

    if (method === "MKCOL") {
      if (dirs.has(relPath)) return new Response(null, { status: 405 });
      dirs.add(relPath);
      return new Response(null, { status: 201 });
    }
    if (method === "PROPFIND") return new Response(null, { status: 207 });
    if (method === "PUT") {
      const parent = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
      if (parent && !dirs.has(parent)) return new Response(null, { status: 409 });
      files.set(relPath, String(init.body ?? ""));
      return new Response(null, { status: 201 });
    }
    if (method === "GET") {
      const content = files.get(relPath);
      return content === undefined ? new Response(null, { status: 404 }) : new Response(content, { status: 200 });
    }
    if (method === "DELETE") {
      files.delete(relPath);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 500 });
  }) as typeof fetch;

  return { fetchImpl, calls, files, dirs, authHeader: () => authHeader };
}

function configure(dataDir: string): void {
  saveBackupConfig(dataDir, {
    url: "https://dav.test/dav/",
    account: "me@example.com",
    remoteRoot: "study-notes",
    password: "app-pass",
    intervalMinutes: 60,
    keepDays: 14,
  });
}

test("首次备份：建目录 + 上传全部 + 每日快照 + 月度归档 + manifest", async () => {
  const { dataDir, notesRoot } = makeDataDir();
  configure(dataDir);
  const dav = fakeWebdav();
  const service = createBackupService({ dataDir, notesRoot, fetchImpl: dav.fetchImpl });

  const result = await service.run();
  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.equal(result.uploaded, 2);

  assert.ok(dav.files.has("latest/a.md"));
  assert.ok(dav.files.has("latest/backend-go/b.md"));
  // .gitkeep 是隐藏文件，不该被扫进来
  assert.equal(scanNotes(notesRoot).length, 2);
  assert.equal(dav.files.has("latest/.gitkeep"), false);

  const day = result.snapshotDay!;
  assert.ok(dav.files.has(`snapshots/${day}/a.md`));
  assert.ok(dav.files.has(`monthly/${day.slice(0, 7)}/a.md`));
  assert.ok(dav.files.has("manifest.json"));

  // 授权头按 UTF-8 编 base64
  const expected = `Basic ${Buffer.from("me@example.com:app-pass", "utf8").toString("base64")}`;
  assert.equal(dav.authHeader(), expected);

  const manifest = JSON.parse(dav.files.get("manifest.json")!);
  assert.equal(Object.keys(manifest.uploaded).length, 2);
  assert.equal(manifest.snapshots.length, 1);
});

test("内容没变：一次请求都不发（免费额度靠这个省下来）", async () => {
  const { dataDir, notesRoot } = makeDataDir();
  configure(dataDir);
  const dav = fakeWebdav();
  const service = createBackupService({ dataDir, notesRoot, fetchImpl: dav.fetchImpl });

  await service.run();
  const before = dav.calls.length;
  const second = await service.run();
  assert.equal(second.skipped, true);
  assert.equal(dav.calls.length, before, "无变化时不应该有任何网络请求");
});

test("只改一篇：只上传那一篇，不重传快照", async () => {
  const { dataDir, notesRoot } = makeDataDir();
  configure(dataDir);
  const dav = fakeWebdav();
  const service = createBackupService({ dataDir, notesRoot, fetchImpl: dav.fetchImpl });
  await service.run();

  const before = dav.calls.length;
  fs.writeFileSync(path.join(notesRoot, "a.md"), "# A\n\n改过了\n", "utf8");
  const second = await service.run();
  assert.equal(second.uploaded, 1);

  const puts = dav.calls.slice(before).filter((call) => call.method === "PUT");
  const paths = puts.map((call) => call.path).sort();
  assert.deepEqual(paths, ["latest/a.md", "manifest.json"]);
});

test("本地删除：云端 latest 同步删除（快照保留）", async () => {
  const { dataDir, notesRoot } = makeDataDir();
  configure(dataDir);
  const dav = fakeWebdav();
  const service = createBackupService({ dataDir, notesRoot, fetchImpl: dav.fetchImpl });
  const first = await service.run();

  fs.rmSync(path.join(notesRoot, "backend-go", "b.md"));
  const second = await service.run();
  assert.equal(second.removed, 1);
  assert.equal(dav.files.has("latest/backend-go/b.md"), false);
  // 今天的快照里仍留着它 —— 这就是备份的意义
  assert.ok(dav.files.has(`snapshots/${first.snapshotDay}/backend-go/b.md`));
});

test("跨天：新增一份快照，超过 keepDays 的旧快照被清理", async () => {
  const { dataDir, notesRoot } = makeDataDir();
  configure(dataDir);
  saveBackupConfig(dataDir, { keepDays: 2 });
  const dav = fakeWebdav();
  let clock = new Date(2026, 9, 1, 10, 0, 0);
  const service = createBackupService({ dataDir, notesRoot, fetchImpl: dav.fetchImpl, now: () => clock });

  await service.run(); // 10-01 快照
  clock = new Date(2026, 9, 2, 10, 0, 0);
  await service.run(); // 10-02 快照
  clock = new Date(2026, 9, 5, 10, 0, 0);
  const third = await service.run(); // 10-05：10-01、10-02 都已过期

  assert.equal(third.snapshotDay, "2026-10-05");
  assert.ok(dav.files.has("snapshots/2026-10-05/a.md"));
  assert.equal(dav.files.has("snapshots/2026-10-01/a.md"), false);
  assert.equal(dav.files.has("snapshots/2026-10-02/a.md"), false);

  const manifest = JSON.parse(dav.files.get("manifest.json")!);
  assert.deepEqual(
    manifest.snapshots.map((entry: { day: string }) => entry.day),
    ["2026-10-05"],
  );
});

test("换了远端账号：本地清单作废，重传全量而不是谎报已完成", async () => {
  const { dataDir, notesRoot } = makeDataDir();
  configure(dataDir);
  const dav = fakeWebdav();
  const service = createBackupService({ dataDir, notesRoot, fetchImpl: dav.fetchImpl });
  await service.run();

  // 换成一个"空的"远端（同一份 manifest 却指向别处）
  saveBackupConfig(dataDir, { account: "other@example.com" });
  const second = await service.run();
  assert.equal(second.skipped, false);
  assert.equal(second.uploaded, 2, "新远端上什么都没有，必须重新上传全部笔记");
  assert.ok(dav.files.has("latest/a.md"));

  const manifest = JSON.parse(dav.files.get("manifest.json")!);
  assert.match(manifest.remote, /other@example\.com/);
});

test("当天新增的笔记会补进今天的快照（否则当天写坏就无从恢复）", async () => {
  const { dataDir, notesRoot } = makeDataDir();
  configure(dataDir);
  const dav = fakeWebdav();
  const service = createBackupService({ dataDir, notesRoot, fetchImpl: dav.fetchImpl });
  const first = await service.run();
  const day = first.snapshotDay!;

  // 同一天稍后新建一篇
  fs.writeFileSync(path.join(notesRoot, "late.md"), "# 迟到的一篇\n", "utf8");
  await service.run();

  assert.ok(dav.files.has(`snapshots/${day}/late.md`), "当天新建的笔记应当出现在今天的快照里");
  const manifest = JSON.parse(dav.files.get("manifest.json")!);
  const entry = manifest.snapshots.find((item: { day: string }) => item.day === day);
  assert.ok(entry.files.includes("late.md"));

  // 但已经拍过的那篇，快照里仍是当天首次备份时的内容
  assert.ok(String(dav.files.get(`snapshots/${day}/a.md`)).includes("第一篇"));
});

test("测试连接打的是 WebDAV 根，不是还没建出来的 study-notes 目录", async () => {
  const seen: string[] = [];
  const client = createWebdavClient(
    { url: "https://dav.test/dav/", account: "a", appPassword: "b", remoteRoot: "study-notes" },
    (async (input: string | URL | Request) => {
      seen.push(new URL(String(input)).pathname);
      return new Response(null, { status: 207 });
    }) as typeof fetch,
  );
  await client.probe();
  // 第一次点"测试连接"时 study-notes 还不存在，探它必然 404
  assert.deepEqual(seen, ["/dav/"]);
});

test("根目录 404：提示地址不对，而不是含糊的「连接失败」", async () => {
  const client = createWebdavClient(
    { url: "https://dav.test/dav/", account: "a", appPassword: "b", remoteRoot: "study-notes" },
    (async () => new Response(null, { status: 404 })) as typeof fetch,
  );
  await assert.rejects(() => client.probe(), /找不到 WebDAV 服务/);
});

test("鉴权失败：错误可读、状态里记下失败原因", async () => {
  const { dataDir, notesRoot } = makeDataDir();
  configure(dataDir);
  const fetchImpl = (async () => new Response(null, { status: 401 })) as typeof fetch;
  const service = createBackupService({ dataDir, notesRoot, fetchImpl });

  await assert.rejects(() => service.run(), /鉴权失败/);
  const status = service.status();
  assert.match(status.lastError ?? "", /鉴权失败/);
});

test("限流 429 被识别成 RATE_LIMIT", async () => {
  const { dataDir } = makeDataDir();
  configure(dataDir);
  const client = createWebdavClient(
    { url: "https://dav.test/dav/", account: "a", appPassword: "b", remoteRoot: "r" },
    (async () => new Response(null, { status: 429 })) as typeof fetch,
  );
  await assert.rejects(() => client.put("x.md", "hi"), (err: unknown) => {
    assert.equal((err as { code?: string }).code, "RATE_LIMIT");
    return true;
  });
});

test("未配置时备份直接报错，提示要填账号与应用密码", async () => {
  const { dataDir, notesRoot } = makeDataDir();
  const service = createBackupService({ dataDir, notesRoot, fetchImpl: fakeWebdav().fetchImpl });
  await assert.rejects(() => service.run(), /未配置/);
  assert.equal(service.status().configured, false);
});

test("未配置时不预填任何特定 WebDAV 服务地址", () => {
  const view = maskBackupConfig(null);
  assert.equal(view.url, "");
  assert.equal(view.configured, false);
});

test("配置：空密码不覆盖已存的应用密码，返回时掩码", () => {
  const { dataDir } = makeDataDir();
  configure(dataDir);
  const masked = maskBackupConfig(loadBackupConfig(dataDir));
  assert.equal(masked.configured, true);
  assert.equal(masked.account, "me@example.com");
  assert.equal(masked.passwordMasked.includes("app-pass"), false);
  assert.equal(loadBackupConfig(dataDir)?.appPassword, "app-pass");

  saveBackupConfig(dataDir, { intervalMinutes: 15, keepDays: 30, password: "" });
  const after = loadBackupConfig(dataDir)!;
  assert.equal(after.appPassword, "app-pass", "空密码不应清掉原密码");
  assert.equal(after.intervalMinutes, 15);
  assert.equal(after.keepDays, 30);
});

test("AI 配置与备份配置互不覆盖（同一个 config.json）", () => {
  const { dataDir } = makeDataDir();
  configure(dataDir);
  // 模拟保存 AI 设置
  patchAiLike(dataDir);
  const backup = loadBackupConfig(dataDir);
  assert.equal(backup?.appPassword, "app-pass", "保存 AI 设置不应冲掉 backup 段");
});

/** 直接写 AI 字段（等同 saveAiConfig 的浅合并行为），验证不破坏 backup 段。 */
function patchAiLike(dataDir: string): void {
  const file = path.join(dataDir, "config.json");
  const current = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(
    file,
    JSON.stringify({ ...current, baseUrl: "https://api.test", apiKey: "sk-x", model: "m" }, null, 2),
    "utf8",
  );
}

test("路径校验：拒绝穿越、绝对路径、反斜杠", () => {
  assert.equal(isSafeRelPath("backend-go/00-地图.md"), true);
  assert.equal(isSafeRelPath("../etc/passwd"), false);
  assert.equal(isSafeRelPath("a/../../b.md"), false);
  assert.equal(isSafeRelPath("/etc/passwd"), false);
  assert.equal(isSafeRelPath("C:\\Windows\\x.md"), false);
  assert.equal(isSafeRelPath("a//b.md"), false);
  assert.equal(isSafeRelPath(""), false);
});
