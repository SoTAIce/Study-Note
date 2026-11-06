import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../app.ts";

let server: http.Server;
let base: string;
let tmp: string;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sn-health-"));
  const app = createApp({ dataDir: tmp, notesRoot: path.join(tmp, "notes") });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("GET /api/health 返回 ok", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; version: string };
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, "string");
});

test("未知的 /api 路径返回 404 JSON", async () => {
  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.equal(typeof body.error, "string");
});
