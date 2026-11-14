import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { createApi } from "./api.ts";
import { createBackupService } from "./backup.ts";
import { openDb } from "./db.ts";
import { Indexer } from "./indexer.ts";
import { NoteStore, TRASH_RETENTION_DAYS } from "./store.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.STUDY_DATA ?? path.join(root, "data");
const notesRoot = path.join(dataDir, "notes");
fs.mkdirSync(notesRoot, { recursive: true });

const store = new NoteStore({
  notesRoot,
  historyDir: path.join(dataDir, ".history"),
  trashDir: path.join(dataDir, ".trash"),
});
const db = openDb(path.join(dataDir, "index.db"));
const indexer = new Indexer({ db, store });
const built = indexer.reindexAll();
indexer.watch();

const backup = createBackupService({ dataDir, notesRoot });

// 回收站自动清理（trash-001）：启动时一次，之后每 6 小时一次，删掉超过保留天数的条目
function purgeTrash(): void {
  try {
    const { removed } = store.purgeTrash();
    if (removed > 0) console.log(`回收站：清理了 ${removed} 篇超过 ${TRASH_RETENTION_DAYS} 天的笔记`);
  } catch (err) {
    console.warn(`回收站自动清理失败：${(err as Error).message}`);
  }
}
purgeTrash();
const trashTick = setInterval(purgeTrash, 6 * 60 * 60 * 1000);

const port = Number(process.env.STUDY_PORT ?? 7777);
const app = createApp({ dataDir, notesRoot, api: createApi({ store, indexer, db, dataDir, backup }) });
const server = http.createServer(app);

// 备份定时器：每分钟醒一次做纯本地判断（不发请求），真正到点才备份。
// 免费 WebDAV 额度是每 30 分钟 600 次请求，所以默认 60 分钟一轮。
const backupTick = setInterval(() => {
  void backup.autoRun();
}, 60_000);
// 启动 15 秒后先探一次（避免和服务启动抢资源）
const backupKickoff = setTimeout(() => {
  void backup.autoRun();
}, 15_000);

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`端口 ${port} 已被占用。换一个端口再启动，例如：set STUDY_PORT=7788 && node server/main.ts`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Study Notes 已启动：http://127.0.0.1:${port}`);
  console.log(`数据目录：${dataDir}`);
  console.log(`索引：${built.indexed} 条笔记，清理 ${built.removed} 条陈旧记录`);
  if (built.failed > 0) console.warn(`有 ${built.failed} 个文件没能索引，见上方警告`);
});

const shutdown = (): void => {
  try {
    clearInterval(backupTick);
    clearTimeout(backupKickoff);
    clearInterval(trashTick);
    server.close();
    db.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
