/**
 * 启动索引基准（perf-006）：在临时目录写 N 篇真 .md，量 reindexAll 三种情况的耗时。
 *
 * 用法：node scripts/bench-index.ts [篇数=10000]
 *   BENCH_MAX_WARM_MS=5000  二次启动（内容都没变）超过它就以非 0 退出
 *
 * - 首次建库：索引是空的，每篇都要写
 * - 二次启动：索引已有、文件都没变——这是平时每次启动的情况，应该很快
 * - 改了 20 篇后启动：只有这 20 篇要重写
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/db.ts";
import { Indexer } from "../server/indexer.ts";
import { NoteStore } from "../server/store.ts";

const count = Number(process.argv[2] ?? 10000);
const maxWarm = Number(process.env.BENCH_MAX_WARM_MS ?? 5000);

const SENTENCES = [
  "梯度下降沿着损失函数的负梯度方向更新参数，学习率决定每一步走多远。",
  "Transformer 用自注意力机制建模序列中任意两个位置之间的关系。",
  "向量数据库用 HNSW 这类近似最近邻索引加速相似度检索。",
  "条件概率与贝叶斯公式是理解朴素贝叶斯分类器的基础。",
  "复习时先回忆再对照笔记，比反复阅读更能记住。",
];

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sn-bench-index-"));
const notesRoot = path.join(root, "notes");
fs.mkdirSync(path.join(notesRoot, "inbox"), { recursive: true });
for (let i = 0; i < count; i += 1) {
  const body = Array.from({ length: 25 }, (_, k) => SENTENCES[(i + k) % SENTENCES.length]).join("\n");
  const links = i > 0 ? `\n\n见 [[笔记 ${i - 1}]] #复习` : "";
  const raw = `---\nid: b${i}\ntitle: 笔记 ${i}\ntags: [学习]\ncreated: 2026-01-01T00:00:00+00:00\nupdated: 2026-01-01T00:00:00+00:00\n---\n${body}${links}\n`;
  fs.writeFileSync(path.join(notesRoot, i % 50 === 0 ? `inbox/n${i}.md` : `n${i}.md`), raw);
}

const store = new NoteStore({ notesRoot, historyDir: path.join(root, "history"), trashDir: path.join(root, "trash") });
const dbFile = path.join(root, "index.db");

function timed(label: string): number {
  const db = openDb(dbFile);
  const indexer = new Indexer({ db, store });
  const t0 = performance.now();
  const result = indexer.reindexAll();
  const ms = performance.now() - t0;
  db.close();
  console.log(`${label}：${ms.toFixed(0)}ms（${JSON.stringify(result)}）`);
  return ms;
}

timed(`首次建库（${count} 篇）`);
const warm = timed("二次启动（都没变）");
for (let i = 0; i < 20; i += 1) {
  const file = path.join(notesRoot, `n${i * 37 + 1}.md`);
  fs.appendFileSync(file, `\n外部改了一句 ${i}\n`);
}
timed("改了 20 篇后启动");

// 结果核对：二次启动后索引里的篇数、全文行数都对
const db = openDb(dbFile);
const notes = (db.prepare("SELECT count(*) AS n FROM notes").get() as { n: number }).n;
const fts = (db.prepare("SELECT count(*) AS n FROM notes_fts").get() as { n: number }).n;
db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`索引：notes ${notes} 行，notes_fts ${fts} 行`);
if (notes !== count || fts !== count) {
  console.error("索引行数不对");
  process.exit(1);
}
if (warm > maxWarm) {
  console.error(`二次启动超过 ${maxWarm}ms`);
  process.exit(1);
}
