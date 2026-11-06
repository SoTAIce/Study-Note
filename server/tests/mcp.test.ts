import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createSession } from "../../dsh-mcp/server.mjs";
import { openDb } from "../db.ts";
import { Indexer } from "../indexer.ts";
import { NoteStore } from "../store.ts";

type McpContent = { type: string; text: string };

type RpcResponse = {
  jsonrpc?: string;
  id?: number | string | null;
  // 手写 JSON-RPC，不同方法返回不同形状；测试里按需断言
  result?: any;
  error?: { code: number; message: string };
};

const EXPECTED_TOOLS = [
  "notes_search",
  "notes_read",
  "notes_create",
  "notes_append",
  "notes_capture",
];

let tmp: string;
let dataDir: string;
let notesRoot: string;
let session: ReturnType<typeof createSession>;
let server: http.Server;
let db: ReturnType<typeof openDb>;
let createdId = "";
let createdPath = "";
let capturePath = "";

function textOf(res: RpcResponse): string {
  const content = (res.result?.content ?? []) as McpContent[];
  return content.map((item) => item.text).join("\n");
}

async function call(
  method: string,
  params?: unknown,
  id: number | string = 1,
): Promise<RpcResponse> {
  const raw = await session.handle(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  assert.ok(raw, `${method} 应当有响应`);
  return JSON.parse(raw) as RpcResponse;
}

async function callTool(name: string, args: unknown): Promise<RpcResponse> {
  return call("tools/call", { name, arguments: args });
}

function listMarkdown(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listMarkdown(root, child));
    else if (entry.name.toLowerCase().endsWith(".md")) out.push(child);
  }
  return out.sort();
}

function readNote(relPath: string): string {
  return fs.readFileSync(path.join(notesRoot, relPath), "utf8");
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sn-mcp-"));
  dataDir = path.join(tmp, "data");
  notesRoot = path.join(dataDir, "notes");

  // 假的 App：只实现 MCP 会用到的 POST /api/index/file（真实实现由 server/api 负责）
  const store = new NoteStore({
    notesRoot,
    historyDir: path.join(dataDir, ".history"),
    trashDir: path.join(dataDir, ".trash"),
  });
  db = openDb(path.join(dataDir, "index.db"));
  const indexer = new Indexer({ db, store });
  server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/index/file") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        const body = JSON.parse(raw) as { path?: string };
        if (body.path) indexer.indexFile(body.path);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };

  session = createSession({
    root: tmp,
    dataDir,
    indexUrl: `http://127.0.0.1:${addr.port}/api/index/file`,
  });
});

after(async () => {
  db.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("initialize 回应 protocolVersion、tools 能力与 serverInfo", async () => {
  const res = await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp.test", version: "0.0.0" },
  });
  assert.equal(res.result.protocolVersion, "2024-11-05");
  assert.deepEqual(res.result.capabilities.tools, {});
  assert.equal(res.result.serverInfo.name, "study-notes");
  assert.equal(res.result.serverInfo.version, "0.1.0");
});

test("通知（没有 id）一律忽略、不回应", async () => {
  const initialized = await session.handle(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );
  assert.equal(initialized, null);
  const cancelled = await session.handle(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }),
  );
  assert.equal(cancelled, null);
});

test("tools/list 恰好返回五个工具，且每个都有 object 型 inputSchema", async () => {
  const res = await call("tools/list");
  const tools = res.result.tools as Array<{
    name: string;
    description?: string;
    inputSchema?: { type?: string };
  }>;
  assert.equal(tools.length, 5);
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [...EXPECTED_TOOLS].sort(),
  );
  for (const tool of tools) {
    assert.equal(tool.inputSchema?.type, "object", `${tool.name} 的 inputSchema 应为 object`);
    assert.ok(tool.description && tool.description.length > 0, `${tool.name} 应有描述`);
  }
});

test("未知方法返回 -32601，坏 JSON 返回 -32700", async () => {
  const unknown = await call("tools/nope");
  assert.equal(unknown.error?.code, -32601);

  const raw = await session.handle("{ 这不是合法 JSON");
  assert.ok(raw);
  const bad = JSON.parse(raw) as RpcResponse;
  assert.equal(bad.error?.code, -32700);
});

test("notes_create 在临时 notes 目录写入 .md", async () => {
  const body =
    "RoPE 用旋转矩阵把位置编码进 Query 和 Key，相对位置自然出现在点积里。";
  const res = await callTool("notes_create", {
    title: "位置编码的直觉",
    body,
    tags: ["深度学习", "位置编码"],
  });
  assert.ok(!res.result?.isError, textOf(res));

  const files = listMarkdown(notesRoot);
  assert.equal(files.length, 1, `应只新建一个文件，实际：${files.join(", ")}`);
  createdPath = files[0];
  assert.match(createdPath, /^\d{4}-\d{2}-\d{2}-.+\.md$/);

  const raw = readNote(createdPath);
  assert.match(raw, /^---\n/);
  assert.ok(raw.includes(body), "文件正文应包含传入的 body");
  assert.match(raw, /^tags: \[深度学习, 位置编码\]$/m);
  createdId = /^id:\s*(\S+)$/m.exec(raw)?.[1] ?? "";
  assert.ok(createdId.length >= 6, `应从 frontmatter 读到 id，实际：${createdId}`);

  const text = textOf(res);
  assert.ok(text.includes(createdId), `工具结果应包含 id，实际：${text}`);
  assert.ok(text.includes(createdPath), `工具结果应包含相对路径，实际：${text}`);
});

test("notes_search 三字以上查询走 trigram 能搜到刚创建的笔记", async () => {
  const res = await callTool("notes_search", { query: "位置编码", limit: 5 });
  const text = textOf(res);
  assert.ok(!res.result?.isError, text);
  assert.ok(text.includes("位置编码的直觉"), `应搜到标题，实际：${text}`);
  assert.ok(text.includes("旋转矩阵"), `片段应包含命中词周围正文，实际：${text}`);
  assert.ok(text.includes(createdId), `结果应包含 id，实际：${text}`);
  assert.ok(text.includes(createdPath), `结果应包含相对路径，实际：${text}`);
});

test("notes_search 两字查询走 LIKE 也能命中", async () => {
  const res = await callTool("notes_search", { query: "位置" });
  const text = textOf(res);
  assert.ok(!res.result?.isError, text);
  assert.ok(text.includes("位置编码的直觉"), `两字查询应命中，实际：${text}`);
});

test("notes_capture 把想法落进 inbox/", async () => {
  const res = await callTool("notes_capture", {
    text: "突然想到：稀疏注意力可能更省显存",
    tags: ["想法"],
  });
  assert.ok(!res.result?.isError, textOf(res));

  const inbox = listMarkdown(notesRoot).filter((file) => file.startsWith("inbox/"));
  assert.equal(inbox.length, 1, `inbox 下应恰好一个文件，实际：${inbox.join(", ")}`);
  capturePath = inbox[0];

  const raw = readNote(capturePath);
  assert.ok(raw.includes("稀疏注意力"));
  assert.match(raw, /^type: idea$/m);
  assert.ok(textOf(res).includes(capturePath), `工具结果应包含路径，实际：${textOf(res)}`);
});

test("notes_append 追加带本地时间小标题，且不改动已有正文", async () => {
  const before = readNote(createdPath);
  const appended = "补记：trigram 要三个字符才走 FTS，两个字只能 LIKE。";
  const res = await callTool("notes_append", { id: createdId, text: appended });
  assert.ok(!res.result?.isError, textOf(res));

  const after = readNote(createdPath);
  assert.ok(after.includes(appended), "追加内容应写入文件");
  assert.ok(after.includes("RoPE 用旋转矩阵"), "原有正文不应被改写");
  assert.ok(before.includes("RoPE 用旋转矩阵"));
  assert.match(after, /### \d{4}-\d{2}-\d{2} \d{2}:\d{2}/, "应加本地时间小标题");
  // 通过 path 追加同样可用
  const at = await callTool("notes_append", { path: createdPath, text: "第二次追加。" });
  assert.ok(!at.result?.isError, textOf(at));
  assert.ok(readNote(createdPath).includes("第二次追加。"));
});

test("notes_read 支持 id 与 path，返回正文与 frontmatter 摘要", async () => {
  const byId = await callTool("notes_read", { id: createdId });
  assert.ok(!byId.result?.isError, textOf(byId));
  const idText = textOf(byId);
  assert.ok(idText.includes("位置编码的直觉"));
  assert.ok(idText.includes("type: note"));
  assert.ok(idText.includes("第二次追加。"));

  const byPath = await callTool("notes_read", { path: capturePath });
  assert.ok(!byPath.result?.isError, textOf(byPath));
  assert.ok(textOf(byPath).includes("稀疏注意力"));
});

test("notes_read 不存在的 id 返回 isError", async () => {
  const res = await callTool("notes_read", { id: "no-such-note-id" });
  assert.equal(res.result?.isError, true);
  assert.ok(textOf(res).length > 0, "错误应带可读信息");
});


// ---- 分组（MCP） ----

test("notes_create 可以带上分组，notes_read 会回显组名", async () => {
  const created = await callTool("notes_create", {
    title: "MCP 带组",
    body: "正文",
    group: "Go 学习",
  });
  const text = textOf(created);
  assert.match(text, /Go 学习/);

  const relPath = /path: (.+)/.exec(text)?.[1]?.trim() ?? "";
  assert.ok(relPath, text);
  assert.match(readNote(relPath), /^---\n[\s\S]*group: Go 学习/);

  const read = await callTool("notes_read", { path: relPath });
  assert.match(textOf(read), /group: Go 学习/);
});

test("notes_append 不会把已有分组洗掉", async () => {
  const created = await callTool("notes_create", { title: "会被追加", body: "原文", group: "Agent 学习" });
  const text = textOf(created);
  const relPath = /path: (.+)/.exec(text)?.[1]?.trim() ?? "";
  assert.ok(relPath, text);

  const appended = await callTool("notes_append", { path: relPath, text: "追加一段" });
  assert.equal(appended.error, undefined, JSON.stringify(appended.error));

  const raw = readNote(relPath);
  assert.match(raw, /group: Agent 学习/);
  assert.match(raw, /追加一段/);
});
