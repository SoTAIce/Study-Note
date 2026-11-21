import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../app.ts";
import { createApi } from "../api.ts";
import { createBackupService } from "../backup.ts";
import { openDb } from "../db.ts";
import { Indexer } from "../indexer.ts";
import { NoteStore } from "../store.ts";
import { secretKeyPath } from "../secrets.ts";

// hooks 放在 describe 里：测试用 --test-isolation=none 同进程跑，顶层 hooks 会挂到所有文件上
describe("密钥接口（sec-001）", () => {
  let tmp: string;
  let server: http.Server;
  let base: string;
  let db: ReturnType<typeof openDb>;
  let previousDir: string | undefined;
  // 别的测试文件会设 STUDY_AI_KEY（同一进程跑），这里清掉，免得它被首次启动的逻辑记进 config.json、多出一处密文
  const AI_ENV = ["STUDY_AI_KEY", "STUDY_AI_BASE_URL", "STUDY_AI_MODEL"] as const;
  let previousAiEnv: Array<string | undefined> = [];

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sn-secrets-api-"));
    previousDir = process.env.STUDY_SECRET_DIR;
    process.env.STUDY_SECRET_DIR = path.join(tmp, "key");
    previousAiEnv = AI_ENV.map((name) => process.env[name]);
    for (const name of AI_ENV) delete process.env[name];
    const notesRoot = path.join(tmp, "notes");
    const store = new NoteStore({ notesRoot, historyDir: path.join(tmp, "history"), trashDir: path.join(tmp, "trash") });
    db = openDb(path.join(tmp, "index.db"));
    const backup = createBackupService({ dataDir: tmp, notesRoot });
    const api = createApi({ store, indexer: new Indexer({ db, store }), db, dataDir: tmp, backup });
    server = http.createServer(createApp({ dataDir: tmp, notesRoot, distDir: path.join(tmp, "dist"), api }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    if (previousDir === undefined) delete process.env.STUDY_SECRET_DIR;
    else process.env.STUDY_SECRET_DIR = previousDir;
    AI_ENV.forEach((name, index) => {
      if (previousAiEnv[index] === undefined) delete process.env[name];
      else process.env[name] = previousAiEnv[index];
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  test("GET /api/secrets/status：没存过密钥时钥匙还不存在、0 处解不开", async () => {
    const { status, json } = await call("GET", "/api/secrets/status");
    assert.equal(status, 200);
    assert.deepEqual(json, { keyPath: secretKeyPath(), keyExists: false, unreadable: 0 });
  });

  test("经接口保存服务商 Key 和备份密码：文件里是密文，接口只回打码值；钥匙删掉后状态报 2 处解不开", async () => {
    const providers = await call("GET", "/api/agent/providers");
    assert.equal(providers.status, 200);
    const items = (providers.json.items as Array<Record<string, unknown> & { id: string }>).map((item, index) => ({
      ...item,
      apiKey: index === 0 ? "sk-from-api-test-0001" : "",
    }));
    const saved = await call("PUT", "/api/agent/providers", { activeId: items[0].id, items });
    assert.equal(saved.status, 200);
    const first = (saved.json.items as Array<{ apiKeyMasked: string; configured: boolean }>)[0];
    assert.equal(first.configured, true);
    assert.equal(first.apiKeyMasked.includes("from-api-test"), false);

    const backup = await call("PUT", "/api/backup/config", {
      url: "https://dav.example.com/dav/",
      account: "me@example.com",
      password: "app-pass-from-api-02",
    });
    assert.equal(backup.status, 200);
    assert.equal(JSON.stringify(backup.json).includes("app-pass-from-api"), false);

    const raw = fs.readFileSync(path.join(tmp, "config.json"), "utf8");
    assert.equal(raw.includes("sk-from-api-test-0001"), false);
    assert.equal(raw.includes("app-pass-from-api-02"), false);
    assert.equal((raw.match(/enc:v1:/g) ?? []).length, 2);
    assert.deepEqual((await call("GET", "/api/secrets/status")).json, { keyPath: secretKeyPath(), keyExists: true, unreadable: 0 });

    fs.rmSync(secretKeyPath());
    assert.deepEqual((await call("GET", "/api/secrets/status")).json, { keyPath: secretKeyPath(), keyExists: false, unreadable: 2 });
    const after = await call("GET", "/api/agent/providers");
    assert.equal((after.json.items as Array<{ configured: boolean }>)[0].configured, false, "解不开就是没填");
    assert.equal((await call("GET", "/api/backup/config")).json.configured, false);
  });
});
