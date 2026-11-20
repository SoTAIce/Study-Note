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

let tmp: string;
let notesRoot: string;
let server: http.Server;
let base: string;
let db: ReturnType<typeof openDb>;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sn-import-"));
  notesRoot = path.join(tmp, "notes");
  const store = new NoteStore({ notesRoot, historyDir: path.join(tmp, "history"), trashDir: path.join(tmp, "trash") });
  db = openDb(path.join(tmp, "index.db"));
  const indexer = new Indexer({ db, store });
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

async function importMd(payload: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/notes/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("导入：文件写进 notes/、进了索引、文件头保留未知键并补上缺的；分组登记", async () => {
  const content = "---\ntitle: 外来笔记\naliases:\n  - 别名\ntags:\n  - 读书\ncssclass: wide\n---\n\n# 外来笔记\n\n第一段，参见 [[别的]]。\n";
  const { status, body } = await importMd({ fileName: "外来笔记.md", content, group: "导入测试/子项目" });
  assert.equal(status, 201, JSON.stringify(body));
  const relPath = body.relPath as string;
  const raw = fs.readFileSync(path.join(notesRoot, relPath), "utf8");
  for (const part of ["aliases:\n  - 别名", "tags:\n  - 读书", "cssclass: wide", "group: 导入测试/子项目", `id: ${body.id}`]) {
    assert.ok(raw.includes(part), `文件里应有「${part}」：\n${raw}`);
  }
  assert.ok(raw.endsWith("\n# 外来笔记\n\n第一段，参见 [[别的]]。\n"));
  assert.match(relPath, /^\d{4}-\d{2}-\d{2}-.+\.md$/);
  // 索引：列表、标签、分组都能查到
  const list = (await (await fetch(`${base}/api/notes?group=${encodeURIComponent("导入测试/子项目")}`)).json()) as { items: Array<{ id: string; title: string; tags: string[] }> };
  const item = list.items.find((note) => note.id === body.id);
  assert.ok(item, "按分组应能查到");
  assert.equal(item.title, "外来笔记");
  assert.deepEqual(item.tags, ["读书"]);
  const groups = JSON.parse(fs.readFileSync(path.join(tmp, "groups.json"), "utf8")) as unknown;
  assert.ok(JSON.stringify(groups).includes("导入测试/子项目"), "分组应登记进 groups.json");
});

test("同名导入两次：不覆盖，文件名自动加后缀；id 和库里已有的冲突时换新", async () => {
  const content = "---\nid: dupid001\ntitle: 同名\n---\n正文\n";
  const first = await importMd({ fileName: "同名.md", content, group: null });
  const second = await importMd({ fileName: "同名.md", content, group: null });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.body.id, "dupid001");
  assert.notEqual(second.body.id, "dupid001", "第二篇的 id 应换新");
  assert.notEqual(first.body.relPath, second.body.relPath);
  assert.match(second.body.relPath as string, /-2\.md$/);
  assert.ok(fs.readFileSync(path.join(notesRoot, first.body.relPath as string), "utf8").includes("id: dupid001"), "第一篇不被覆盖");
});

test("框里改的标题优先；不分组时去掉文件里原来的 group", async () => {
  const { status, body } = await importMd({ fileName: "a.md", content: "---\ngroup: 原来的组\n---\n# 文件里的标题\n", title: "改过的标题", group: null });
  assert.equal(status, 201);
  assert.equal((body.meta as { title: string }).title, "改过的标题");
  assert.equal((body.meta as { group?: string }).group, undefined);
  assert.equal(fs.readFileSync(path.join(notesRoot, body.relPath as string), "utf8").includes("group:"), false);
});

test("参数不对：不是 .md 400、没内容 400、分组名非法 400、乱码 400、超过 2MB 413；都不写文件", async () => {
  const before = fs.readdirSync(notesRoot).length;
  const cases: Array<[Record<string, unknown>, number]> = [
    [{ fileName: "a.txt", content: "x", group: null }, 400],
    [{ fileName: "", content: "x", group: null }, 400],
    [{ fileName: "a.md", group: null }, 400],
    [{ fileName: "a.md", content: "x", group: "坏:组" }, 400],
    [{ fileName: "a.md", content: "乱码�", group: null }, 400],
    [{ fileName: "a.md", content: "x", title: "t".repeat(201), group: null }, 400],
    [{ fileName: "a.md", content: "字".repeat(700_000), group: null }, 413],
  ];
  for (const [payload, expected] of cases) {
    const { status, body } = await importMd(payload);
    assert.equal(status, expected, `${JSON.stringify(payload).slice(0, 60)} → ${JSON.stringify(body)}`);
  }
  assert.equal(fs.readdirSync(notesRoot).length, before);
});
