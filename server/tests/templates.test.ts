import { test, before, after, beforeEach } from "node:test";
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
import { scanBackupFiles, TEMPLATES_BACKUP_PATH } from "../backup.ts";
import { search } from "../search.ts";
import { BUILTIN_TEMPLATES, templateSkeleton } from "../../web/src/lib/templates.ts";

let tmp: string;
let notesRoot: string;
let server: http.Server;
let base: string;
let store: NoteStore;
let db: ReturnType<typeof openDb>;
let indexer: Indexer;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sn-tpl-"));
  notesRoot = path.join(tmp, "notes");
  let clock = new Date(2026, 10, 19, 9, 0, 0).getTime();
  store = new NoteStore({
    notesRoot,
    historyDir: path.join(tmp, "history"),
    trashDir: path.join(tmp, "trash"),
    now: () => new Date((clock += 60000)),
  });
  db = openDb(path.join(tmp, "index.db"));
  indexer = new Indexer({ db, store });
  const api = createApi({ store, indexer, db, dataDir: tmp });
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

// 每个用例从「没有 templates.json」开始
beforeEach(() => {
  fs.rmSync(path.join(tmp, "templates.json"), { force: true });
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

const file = () => path.join(tmp, "templates.json");
const rawOf = (id: string) => {
  const row = db.prepare("SELECT path FROM notes WHERE id = ?").get(id) as { path: string };
  return fs.readFileSync(path.join(notesRoot, row.path), "utf8");
};

test("GET /api/templates：没有文件时给内置两种，version 0，不写盘", async () => {
  const res = await call("GET", "/api/templates");
  assert.equal(res.status, 200);
  assert.equal(res.json.version, 0);
  assert.deepEqual(res.json.templates, BUILTIN_TEMPLATES);
  assert.deepEqual(res.json.groupDefaults, {});
  assert.equal(fs.existsSync(file()), false);
});

test("PUT /api/templates：带 version 整体保存；版本不对 409 并带回最新；校验不过 400", async () => {
  const mine = { name: "会议纪要", sections: [{ title: "结论", hint: "定了什么" }, { title: "跟进" }] };
  const saved = await call("PUT", "/api/templates", { version: 0, templates: [...BUILTIN_TEMPLATES, mine] });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.version, 1);
  assert.deepEqual(saved.json.templates[2], { name: "会议纪要", sections: [{ title: "结论", hint: "定了什么" }, { title: "跟进", hint: "" }] });
  const onDisk = JSON.parse(fs.readFileSync(file(), "utf8"));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.templates.length, 3);

  const stale = await call("PUT", "/api/templates", { version: 0, templates: BUILTIN_TEMPLATES });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.current.version, 1);
  assert.equal(stale.json.current.templates.length, 3);

  const dup = await call("PUT", "/api/templates", { version: 1, templates: [mine, { ...mine, name: "会议纪要" }] });
  assert.equal(dup.status, 400);
  assert.match(dup.json.error, /两个叫「会议纪要」/);
  const none = await call("PUT", "/api/templates", { version: 1, templates: [] });
  assert.equal(none.status, 400);
  assert.equal(JSON.parse(fs.readFileSync(file(), "utf8")).version, 1, "失败的请求不写盘");
});

test("templates.json 写坏了：GET 报 500 说明怎么办，不悄悄当成内置的", async () => {
  fs.writeFileSync(file(), "{ 坏了", "utf8");
  const res = await call("GET", "/api/templates");
  assert.equal(res.status, 500);
  assert.match(res.json.error, /不是合法的 JSON/);
  const put = await call("PUT", "/api/templates", { version: 0, templates: BUILTIN_TEMPLATES });
  assert.equal(put.status, 500);
  assert.equal(fs.readFileSync(file(), "utf8"), "{ 坏了");
});

test("PUT /api/templates/default：设、清子项目默认模板；模板不存在、组名不合法 400", async () => {
  const set = await call("PUT", "/api/templates/default", { group: " agent / looprun ", template: "实现详情" });
  assert.equal(set.status, 200);
  assert.deepEqual(set.json.groupDefaults, { "agent/looprun": "实现详情" });
  const swap = await call("PUT", "/api/templates/default", { group: "AGENT/looprun", template: "学习笔记" });
  assert.deepEqual(swap.json.groupDefaults, { "agent/looprun": "学习笔记" });
  assert.equal((await call("PUT", "/api/templates/default", { group: "x", template: "没有" })).status, 400);
  assert.equal((await call("PUT", "/api/templates/default", { group: "a/b/c", template: "实现详情" })).status, 400);
  const cleared = await call("PUT", "/api/templates/default", { group: "agent/looprun", template: null });
  assert.deepEqual(cleared.json.groupDefaults, {});
});

test("删掉模板：子项目默认值跟着清掉，笔记文件头里的旧名字不动", async () => {
  await call("PUT", "/api/templates/default", { group: "删模板组", template: "学习笔记" });
  const made = await call("POST", "/api/notes", { title: "删模板前", group: "删模板组" });
  const state = (await call("GET", "/api/templates")).json;
  const res = await call("PUT", "/api/templates", { version: state.version, templates: [BUILTIN_TEMPLATES[0]] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.groupDefaults, {});
  assert.match(rawOf(made.json.id), /^template: 学习笔记$/m);
});

test("POST /api/notes：组里有默认模板就预填骨架、写 template:；显式 null 不用；指定别的用别的；不存在 400 且不留空组", async () => {
  await call("PUT", "/api/templates/default", { group: "agent/looprun", template: "实现详情" });

  const auto = await call("POST", "/api/notes", { title: "主循环", group: "agent/looprun" });
  assert.equal(auto.status, 201);
  assert.equal(auto.json.meta.template, "实现详情");
  assert.equal(auto.json.body, templateSkeleton(BUILTIN_TEMPLATES[0]));
  assert.match(rawOf(auto.json.id), /^group: agent\/looprun\ntemplate: 实现详情$/m);
  // 索引里有 template 列，摘要里没有提示语
  const row = db.prepare("SELECT template, excerpt FROM notes WHERE id = ?").get(auto.json.id) as { template: string; excerpt: string };
  assert.equal(row.template, "实现详情");
  assert.equal(row.excerpt, "背景 设计 关键代码 踩坑 待办");
  // 全文索引也不含提示语：搜提示里的字搜不到骨架笔记
  assert.ok(!search(db, "要解决什么问题").some((hit) => hit.id === auto.json.id));
  assert.ok(search(db, "关键代码").some((hit) => hit.id === auto.json.id));

  const off = await call("POST", "/api/notes", { title: "不用模板", group: "agent/looprun", template: null, body: "" });
  assert.equal(off.json.meta.template, undefined);
  assert.equal(off.json.body, "");

  const other = await call("POST", "/api/notes", { title: "学一下", group: "agent/looprun", template: "学习笔记" });
  assert.equal(other.json.meta.template, "学习笔记");
  assert.match(other.json.body, /^## 要点\n/);

  // 显式指定、正文已经写了（新建页预填后又改过）：照用给的正文，记下模板名
  const written = await call("POST", "/api/notes", { title: "自己写", group: "agent/looprun", body: "## 背景\n自己写的\n", template: "实现详情" });
  assert.equal(written.json.body, "## 背景\n自己写的\n");
  assert.equal(written.json.meta.template, "实现详情");
  // 没指定、正文不空（别处来的内容）：不自动套用，文件头不写 template
  const pasted = await call("POST", "/api/notes", { title: "别处来的", group: "agent/looprun", body: "# 别处来的\n" });
  assert.equal(pasted.json.body, "# 别处来的\n");
  assert.equal(pasted.json.meta.template, undefined);

  // 想法不自动套用
  const idea = await call("POST", "/api/notes", { title: "灵感", group: "agent/looprun", type: "idea" });
  assert.equal(idea.json.meta.template, undefined);

  const bad = await call("POST", "/api/notes", { title: "x", group: "不该出现的组", template: "没有这个" });
  assert.equal(bad.status, 400);
  const groups = (await call("GET", "/api/groups")).json.items.map((item: { name: string }) => item.name);
  assert.ok(!groups.includes("不该出现的组"));
});

test("POST /api/book/chapters：默认模板的骨架代替 # 标题；显式 null 照旧写 # 标题", async () => {
  await call("PUT", "/api/templates/default", { group: "连读组", template: "实现详情" });
  const first = await call("POST", "/api/book/chapters", { group: "连读组", title: "第一章" });
  assert.equal(first.status, 200);
  const raw = rawOf(first.json.note.id);
  assert.match(raw, /^template: 实现详情$/m);
  assert.ok(raw.endsWith(`\n\n${templateSkeleton(BUILTIN_TEMPLATES[0])}`));
  assert.ok(!raw.includes("# 第一章\n"));

  const plain = await call("POST", "/api/book/chapters", { group: "连读组", title: "第二章", template: null, after: first.json.note.id });
  assert.equal(plain.status, 200);
  assert.ok(rawOf(plain.json.note.id).endsWith("\n\n# 第二章\n"));
  assert.doesNotMatch(rawOf(plain.json.note.id), /^template:/m);

  const bad = await call("POST", "/api/book/chapters", { group: "连读组", title: "第三章", template: "没有" });
  assert.equal(bad.status, 400);
  const titles = (db.prepare("SELECT title FROM notes WHERE group_name = '连读组'").all() as Array<{ title: string }>).map((r) => r.title);
  assert.ok(!titles.includes("第三章"), "模板不对时什么都不建");
});

test("PUT /api/notes/:id：template 字符串记下、null 去掉这一行；正文照存", async () => {
  const made = await call("POST", "/api/notes", { title: "换模板", body: "正文\n" });
  const one = await call("PUT", `/api/notes/${made.json.id}`, { body: "正文\n", baseHash: made.json.hash, template: "学习笔记" });
  assert.equal(one.status, 200);
  assert.equal(one.json.meta.template, "学习笔记");
  assert.match(rawOf(made.json.id), /^template: 学习笔记$/m);
  // 不传 template：保持原样
  const keep = await call("PUT", `/api/notes/${made.json.id}`, { body: "正文 2\n", baseHash: one.json.hash });
  assert.equal(keep.json.meta.template, "学习笔记");
  const off = await call("PUT", `/api/notes/${made.json.id}`, { body: "正文 2\n", baseHash: keep.json.hash, template: null });
  assert.equal(off.json.meta.template, undefined);
  assert.doesNotMatch(rawOf(made.json.id), /^template:/m);
});

test("POST /api/templates/rename：改名，默认值跟着改；updateNotes 时逐篇只改文件头那一行；重名 400", async () => {
  await call("PUT", "/api/templates/default", { group: "改名组", template: "学习笔记" });
  const a = await call("POST", "/api/notes", { title: "改名甲", group: "改名组" });
  const b = await call("POST", "/api/notes", { title: "改名乙", group: "改名组" });
  const before = rawOf(b.json.id);
  let state = (await call("GET", "/api/templates")).json;
  assert.ok(state.usage["学习笔记"] >= 2);

  const clash = await call("POST", "/api/templates/rename", { version: state.version, from: "学习笔记", to: "实现详情" });
  assert.equal(clash.status, 400);
  const stale = await call("POST", "/api/templates/rename", { version: state.version - 1, from: "学习笔记", to: "读书笔记" });
  assert.equal(stale.status, 409);

  const res = await call("POST", "/api/templates/rename", {
    version: state.version,
    from: "学习笔记",
    to: "读书笔记",
    updateNotes: true,
  });
  assert.equal(res.status, 200);
  assert.ok(res.json.renamed >= 2);
  assert.deepEqual(res.json.failed, []);
  assert.equal(res.json.groupDefaults["改名组"], "读书笔记");
  assert.ok(res.json.templates.some((t: { name: string }) => t.name === "读书笔记"));
  assert.equal(rawOf(b.json.id), before.replace("template: 学习笔记", "template: 读书笔记"), "只改这一行");
  assert.equal((await call("GET", `/api/notes/${a.json.id}`)).json.meta.template, "读书笔记");

  // 不连带：笔记里还是旧名字
  state = (await call("GET", "/api/templates")).json;
  const quiet = await call("POST", "/api/templates/rename", { version: state.version, from: "读书笔记", to: "学习笔记" });
  assert.equal(quiet.json.renamed, 0);
  assert.match(rawOf(a.json.id), /^template: 读书笔记$/m);
});

test("分组改名 / 删除：子项目默认模板跟着改 / 清掉", async () => {
  await call("PUT", "/api/templates/default", { group: "老项目/子", template: "实现详情" });
  await call("PUT", "/api/templates/default", { group: "别的", template: "学习笔记" });
  await call("POST", "/api/notes", { title: "子项目的笔记", group: "老项目/子" });

  const renamed = await call("PATCH", `/api/groups/${encodeURIComponent("老项目")}`, { name: "新项目" });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  let state = (await call("GET", "/api/templates")).json;
  assert.deepEqual(state.groupDefaults, { "别的": "学习笔记", "新项目/子": "实现详情" });

  const removed = await call("DELETE", `/api/groups/${encodeURIComponent("新项目")}`);
  assert.equal(removed.status, 200);
  state = (await call("GET", "/api/templates")).json;
  assert.deepEqual(state.groupDefaults, { "别的": "学习笔记" });
});

test("备份带上 templates.json（_templates/），没改过模板时没有这一项", async () => {
  assert.ok(!scanBackupFiles(notesRoot, tmp).some((f) => f.relPath === TEMPLATES_BACKUP_PATH));
  await call("PUT", "/api/templates/default", { group: "备份组", template: "实现详情" });
  const entry = scanBackupFiles(notesRoot, tmp).find((f) => f.relPath === TEMPLATES_BACKUP_PATH);
  assert.ok(entry);
  assert.equal(entry.abs, file());
});
