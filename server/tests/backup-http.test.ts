import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createBackupService, saveBackupConfig } from "../backup.ts";
import { NoteStore } from "../store.ts";

/**
 * 端到端：真起一个 WebDAV 服务（node:http），走真实 fetch、真实 HTTP 方法，
 * 验证「备份 → 拉快照 → 恢复」整条链路。用假 fetch 单测盖不到的部分全在这里。
 */
function startWebdav(): Promise<{
  url: string;
  files: Map<string, string>;
  dirs: Set<string>;
  calls: string[];
  close: () => Promise<void>;
}> {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const calls: string[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
      const relPath = urlPath.replace(/^\/dav\/study-notes\/?/, "");
      const method = (req.method ?? "GET").toUpperCase();
      calls.push(`${method} ${urlPath}`);

      if (!req.headers.authorization?.startsWith("Basic ")) {
        res.writeHead(401).end();
        return;
      }
      if (method === "MKCOL") {
        if (dirs.has(relPath)) {
          res.writeHead(405).end();
          return;
        }
        dirs.add(relPath);
        res.writeHead(201).end();
        return;
      }
      if (method === "PROPFIND") {
        res.writeHead(207, { "content-type": "application/xml" }).end("<multistatus/>");
        return;
      }
      if (method === "PUT") {
        const parent = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
        if (parent && !dirs.has(parent)) {
          res.writeHead(409).end();
          return;
        }
        files.set(relPath, Buffer.concat(chunks).toString("utf8"));
        res.writeHead(201).end();
        return;
      }
      if (method === "GET") {
        const content = files.get(relPath);
        if (content === undefined) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }).end(content);
        return;
      }
      if (method === "DELETE") {
        files.delete(relPath);
        res.writeHead(204).end();
        return;
      }
      res.writeHead(500).end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/dav/`,
        files,
        dirs,
        calls,
        close: () =>
          new Promise<void>((done) => {
            // undici 的 keep-alive 会把测试进程挂住，必须先掐连接
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

test("端到端：备份到真 HTTP WebDAV，再从快照恢复一篇（保留原 frontmatter）", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "study-e2e-"));
  const notesRoot = path.join(dataDir, "notes");
  fs.mkdirSync(notesRoot, { recursive: true });
  const store = new NoteStore({
    notesRoot,
    historyDir: path.join(dataDir, ".history"),
    trashDir: path.join(dataDir, ".trash"),
  });
  const created = store.create({ title: "位置编码", body: "第一版正文\n" });
  const originalId = created.parsed.meta.id;

  const dav = await startWebdav();
  try {
    saveBackupConfig(dataDir, {
      url: dav.url,
      account: "me@example.com",
      password: "app-pass",
      remoteRoot: "study-notes",
      intervalMinutes: 60,
      keepDays: 14,
    });
    const service = createBackupService({ dataDir, notesRoot });
    const result = await service.run();
    assert.equal(result.ok, true);
    assert.equal(result.uploaded, 1);
    assert.ok(dav.files.has(`latest/${created.relPath}`));
    const day = result.snapshotDay!;
    assert.ok(dav.files.has(`snapshots/${day}/${created.relPath}`));

    // 改坏它
    const current = store.read(created.relPath);
    store.save(created.relPath, "被改坏的正文\n", current.hash);

    // 备份里那份还捏着第一版：从快照读回来，按原路径恢复
    const snapshot = await service.readSnapshotFile(day, created.relPath);
    assert.ok(snapshot && snapshot.includes("第一版正文"));

    const restored = store.restoreFromSnapshot(created.relPath, snapshot!, store.read(created.relPath).hash);
    assert.equal(restored.parsed.body.trim(), "第一版正文");
    assert.equal(restored.parsed.meta.id, originalId, "恢复要保留原来的 id");
    assert.equal(restored.parsed.meta.created, created.parsed.meta.created, "created 也要保留");
  } finally {
    await dav.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("端到端：父目录不存在时 409 会被自动补建后重试成功", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "study-e2e2-"));
  const notesRoot = path.join(dataDir, "notes");
  fs.mkdirSync(path.join(notesRoot, "deep", "nested"), { recursive: true });
  fs.writeFileSync(path.join(notesRoot, "deep", "nested", "x.md"), "# X\n", "utf8");

  const dav = await startWebdav();
  try {
    saveBackupConfig(dataDir, {
      url: dav.url,
      account: "a@b.c",
      password: "p",
      remoteRoot: "study-notes",
      intervalMinutes: 60,
      keepDays: 14,
    });
    const service = createBackupService({ dataDir, notesRoot });
    const result = await service.run();
    assert.equal(result.uploaded, 1);
    assert.ok(dav.files.has("latest/deep/nested/x.md"));
    assert.ok(dav.calls.includes("MKCOL /dav/study-notes"), "远端根目录本身也要建");
    assert.ok(dav.calls.includes("MKCOL /dav/study-notes/latest"), "父级子目录也要建");
  } finally {
    await dav.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
