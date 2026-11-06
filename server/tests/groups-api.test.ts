import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../app.ts";
import { createApi } from "../api.ts";
import { openDb } from "../db.ts";
import { Indexer } from "../indexer.ts";
import { NoteStore } from "../store.ts";
import { readGroups } from "../groups.ts";

let tmp: string;
let server: http.Server;
let base: string;
let store: NoteStore;
let db: ReturnType<typeof openDb>;
let indexer: Indexer;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sn-groups-api-"));
  const notesRoot = path.join(tmp, "notes");
  let clock = new Date(2026, 10, 2, 9, 0, 0).getTime();
  store = new NoteStore({
    notesRoot,
    historyDir: path.join(tmp, "history"),
    trashDir: path.join(tmp, "trash"),
    now: () => new Date((clock += 60000)),
  });
  db = openDb(path.join(tmp, "index.db"));
  indexer = new Indexer({ db, store });
  const api = createApi({ store, indexer, db });
  const app = createApp({ dataDir: tmp, notesRoot, distDir: path.join(tmp, "dist"), api });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function call(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function newNote(title: string, group?: string): { id: string; relPath: string } {
  const note = store.create({ title, body: `${title} 的正文`, group });
  indexer.indexFile(note.relPath);
  return { id: note.id, relPath: note.relPath };
}

test("POST /api/groups 建组，重复建是幂等的", async () => {
  const first = await call("POST", "/api/groups", { name: "Go 学习" });
  assert.equal(first.status, 200);
  assert.equal(first.json.created, true);
  assert.equal(first.json.name, "Go 学习");

  const again = await call("POST", "/api/groups", { name: "go  学习" });
  assert.equal(again.status, 200);
  assert.equal(again.json.created, false);
  assert.equal(again.json.name, "Go 学习");
});

test("POST /api/groups 拒绝非法组名，且不落盘", async () => {
  const bad = await call("POST", "/api/groups", { name: "Go/学习" });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /字符/);

  const empty = await call("POST", "/api/groups", { name: "   " });
  assert.equal(empty.status, 400);
  assert.equal(readGroups(tmp).some((group) => group.name === "Go/学习"), false);
});

test("GET /api/groups 带上计数、空组与未分组数", async () => {
  await call("POST", "/api/groups", { name: "Agent 学习" });
  newNote("策划案", "Agent 学习");
  newNote("没归组的");

  const res = await call("GET", "/api/groups");
  assert.equal(res.status, 200);
  const names = (res.json.items as Array<{ name: string; count: number; empty: boolean }>).map((g) => g.name);
  assert.ok(names.includes("Go 学习"));
  const agent = (res.json.items as Array<{ name: string; count: number; empty: boolean }>).find(
    (g) => g.name === "Agent 学习",
  );
  assert.equal(agent?.count, 1);
  assert.equal(agent?.empty, false);
  const go = (res.json.items as Array<{ name: string; count: number; empty: boolean }>).find(
    (g) => g.name === "Go 学习",
  );
  assert.equal(go?.empty, true);
  assert.ok((res.json.ungrouped as number) >= 1);
});

test("PATCH /api/groups/:name 批量改名，正文与 updated 都不变", async () => {
  const note = newNote("接口设计", "Go 学习");
  const before = store.read(note.relPath);

  const res = await call("PATCH", `/api/groups/${encodeURIComponent("Go 学习")}`, { name: "Golang" });
  assert.equal(res.status, 200);
  assert.equal(res.json.renamed, 1);
  assert.deepEqual(res.json.failed, []);

  const after = store.read(note.relPath);
  assert.equal(after.parsed.meta.group, "Golang");
  assert.equal(after.parsed.body, before.parsed.body);
  assert.equal(after.parsed.meta.updated, before.parsed.meta.updated);
  assert.ok(readGroups(tmp).some((group) => group.name === "Golang"));
});

test("改名时撞上已存在的组名 = 合并，不报错", async () => {
  newNote("并入用", "Golang");
  const res = await call("PATCH", `/api/groups/${encodeURIComponent("Golang")}`, { name: "Agent 学习" });
  assert.equal(res.status, 200);
  assert.ok((res.json.renamed as number) >= 1);

  const list = await call("GET", "/api/groups");
  const names = (list.json.items as Array<{ name: string }>).map((group) => group.name);
  assert.equal(
    names.filter((name) => name.toLowerCase() === "golang").length,
    0,
    JSON.stringify(names),
  );
});

test("改名时某篇笔记在磁盘上被改过 → 该篇跳过并报告，其余照改", async () => {
  const conflict = newNote("会冲突的", "临时组");
  const other = newNote("不冲突的", "临时组");
  const current = store.read(conflict.relPath);
  // 模拟别处改过这篇：正文变了但还没重新索引，索引里的 hash 已过期
  fs.writeFileSync(store.absPath(conflict.relPath), `${current.raw}\n外部追加一行`, "utf8");

  const res = await call("PATCH", `/api/groups/${encodeURIComponent("临时组")}`, { name: "新组" });
  assert.equal(res.status, 200);
  assert.equal(res.json.renamed, 1);
  assert.equal((res.json.failed as Array<{ id: string }>).length, 1);
  assert.equal(store.read(other.relPath).parsed.meta.group, "新组");
});

test("DELETE /api/groups/:name 把笔记退回未分组，但不删笔记", async () => {
  const note = newNote("要解散的", "散伙组");
  const res = await call("DELETE", `/api/groups/${encodeURIComponent("散伙组")}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.ungrouped, 1);

  const after = store.read(note.relPath);
  assert.equal(after.parsed.meta.group, undefined);
  assert.ok(fs.existsSync(store.absPath(note.relPath)));
  assert.equal(readGroups(tmp).some((group) => group.name === "散伙组"), false);
});

test("改不存在或删不存在的组返回 404", async () => {
  const rename = await call("PATCH", `/api/groups/${encodeURIComponent("没有这个组")}`, { name: "x" });
  assert.equal(rename.status, 404);
  const del = await call("DELETE", `/api/groups/${encodeURIComponent("没有这个组")}`);
  assert.equal(del.status, 404);
});


// ---- 笔记移动（单篇 / 批量）与按组过滤 ----

test("POST /api/notes/:id/move 移到不存在的组会自动建组", async () => {
  const note = newNote("要移走的");
  const res = await call("POST", `/api/notes/${note.id}/move`, { group: "自动建的组" });
  assert.equal(res.status, 200);
  assert.equal(res.json.group, "自动建的组");

  const groups = await call("GET", "/api/groups");
  assert.ok((groups.json.items as Array<{ name: string }>).some((group) => group.name === "自动建的组"));
});

test("POST /api/notes/:id/move 的 baseHash 过期返回 409 并带上当前 hash", async () => {
  const note = newNote("会冲突的移动");
  const current = store.read(note.relPath);
  const res = await call("POST", `/api/notes/${note.id}/move`, { group: "随便", baseHash: "deadbeef" });
  assert.equal(res.status, 409);
  assert.equal(res.json.hash, current.hash);
  assert.match(res.json.error, /已被/);
});

test("POST /api/notes/move 批量移动：成功的照做，被外部改过的那篇进 failed", async () => {
  const a = newNote("批量甲");
  const b = newNote("批量乙");
  const c = newNote("批量丙");
  const changed = store.read(c.relPath);
  fs.writeFileSync(store.absPath(c.relPath), `${changed.raw}\n后来又加了一行`, "utf8");

  const res = await call("POST", "/api/notes/move", { ids: [a.id, b.id, c.id], group: "批量组" });
  assert.equal(res.status, 200);
  assert.deepEqual([...res.json.moved].sort(), [a.id, b.id].sort());
  assert.equal((res.json.failed as Array<{ id: string }>).length, 1);
  assert.equal((res.json.failed as Array<{ id: string }>)[0].id, c.id);

  assert.equal(store.read(a.relPath).parsed.meta.group, "批量组");
  assert.equal(store.read(c.relPath).parsed.meta.group, undefined);
});

test("POST /api/notes/move 的组也自动创建，且 id 列表非法时报 400", async () => {
  const note = newNote("再来一篇");
  const ok = await call("POST", "/api/notes/move", { ids: [note.id], group: "另一个新组" });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.moved, [note.id]);

  const bad = await call("POST", "/api/notes/move", { ids: [], group: "x" });
  assert.equal(bad.status, 400);

  const tooMany = await call("POST", "/api/notes/move", { ids: Array.from({ length: 201 }, (_, i) => `id${i}`), group: "x" });
  assert.equal(tooMany.status, 400);
});

test("GET /api/notes?group= 过滤，none 表示未分组，大小写不敏感", async () => {
  newNote("组内一", "过滤组");
  newNote("组内二", "过滤组");
  const plain = newNote("没组的");

  const inGroup = await call("GET", `/api/notes?group=${encodeURIComponent("过滤组")}`);
  assert.equal(inGroup.status, 200);
  assert.equal((inGroup.json.items as unknown[]).length, 2);
  const lower = await call("GET", `/api/notes?group=${encodeURIComponent("过滤组".toLowerCase())}`);
  assert.equal((lower.json.items as unknown[]).length, 2);

  const none = await call("GET", "/api/notes?group=none");
  const ids = (none.json.items as Array<{ id: string }>).map((item) => item.id);
  assert.ok(ids.includes(plain.id));
  assert.equal((inGroup.json.items as Array<{ id: string }>).includes(ids[0] as never), false);
});

test("列表与单条读取都带 group 字段，新建时可以指定 group", async () => {
  const created = await call("POST", "/api/notes", { title: "带组新建", body: "正文", group: "新建组" });
  assert.equal(created.status, 201);
  assert.equal((created.json as { meta: { group?: string } }).meta.group, "新建组");

  const list = await call("GET", `/api/notes?group=${encodeURIComponent("新建组")}`);
  const item = (list.json.items as Array<{ id: string; group: string | null }>)[0];
  assert.equal(item.group, "新建组");

  const detail = await call("GET", `/api/notes/${created.json.id}`);
  assert.equal((detail.json as { group: string | null }).group, "新建组");
});


// ---- 审查发现的边界（批量必填、409 形状、none 哨兵、失败不建组） ----

test("批量移动缺 group 字段直接 400，且不动任何文件", async () => {
  const keep = newNote("批量缺字段", "原地不动");
  const before = fs.readFileSync(path.join(tmp, "notes", keep.relPath), "utf8");

  const res = await call("POST", "/api/notes/move", { ids: [keep.id], grop: "别的组" });
  assert.equal(res.status, 400);
  assert.equal(fs.readFileSync(path.join(tmp, "notes", keep.relPath), "utf8"), before);
});

test("批量移动显式传 null 才表示移出分组", async () => {
  const note = newNote("批量移出", "要移出的组");
  const res = await call("POST", "/api/notes/move", { ids: [note.id], group: null });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.moved, [note.id]);
  assert.equal(store.read(note.relPath).parsed.meta.group, undefined);
});

test("单篇移动 409 同时给 hash 与 currentHash，前端两种都能读", async () => {
  const note = newNote("冲突形状", "甲组");
  const res = await call("POST", `/api/notes/${note.id}/move`, { group: "乙组", baseHash: "deadbeef" });
  assert.equal(res.status, 409);
  assert.equal(typeof res.json.hash, "string");
  assert.equal(res.json.currentHash, res.json.hash);
  assert.equal(store.read(note.relPath).parsed.meta.group, "甲组");
});

test("移动失败不会凭空建出空组", async () => {
  const note = newNote("失败别建组", "甲组");
  const res = await call("POST", `/api/notes/${note.id}/move`, { group: "不该出现的组", baseHash: "deadbeef" });
  assert.equal(res.status, 409);
  const groups = await call("GET", "/api/groups");
  const names = (groups.json.items as Array<{ name: string }>).map((item) => item.name);
  assert.ok(!names.includes("不该出现的组"), `不该建组，实际有：${names.join(", ")}`);
});

test("?group=none 大小写都表示未分组；叫 none 的组被拒绝", async () => {
  const loose = newNote("没组的");
  const grouped = newNote("有组的", "Go 学习");

  const idsOf = (res: { json: any }) => (res.json.items as Array<{ id: string }>).map((item) => item.id);

  const lower = await call("GET", "/api/notes?group=none");
  assert.ok(idsOf(lower).includes(loose.id), "未分组的那篇应当出现");
  assert.ok(!idsOf(lower).includes(grouped.id), "有组的那篇不该出现");

  const upper = await call("GET", "/api/notes?group=NONE");
  assert.deepEqual(idsOf(upper), idsOf(lower), "none / NONE 应当同义");

  const created = await call("POST", "/api/groups", { name: "none" });
  assert.equal(created.status, 400);
  assert.ok(store.read(grouped.relPath).parsed.meta.group);
});
