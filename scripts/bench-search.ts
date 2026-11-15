/**
 * 全文搜索基准（perf-003）：在临时目录造一个大库，量几种典型查询的耗时。
 *
 * 用法：node scripts/bench-search.ts [篇数=10000]
 *   BENCH_MAX_MS=200  任一查询的中位数超过它就以非 0 退出（默认 200）
 *
 * 直接往索引表里写数据（不经过 md 文件），只量 search() 本身。
 * 正文用一组中文学习笔记的句子随机拼成，每篇约 1500 字；常用词会命中大部分笔记，是最坏情况。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/db.ts";
import { search } from "../server/search.ts";

const count = Number(process.argv[2] ?? 10000);
const maxMs = Number(process.env.BENCH_MAX_MS ?? 200);

const SENTENCES = [
  "梯度下降沿着损失函数的负梯度方向更新参数，学习率决定每一步走多远。",
  "Transformer 用自注意力机制建模序列中任意两个位置之间的关系。",
  "位置编码给模型注入顺序信息，常见做法是正弦函数或可学习的向量。",
  "向量数据库用 HNSW 这类近似最近邻索引加速相似度检索。",
  "条件概率与贝叶斯公式是理解朴素贝叶斯分类器的基础。",
  "矩阵乘法的第 i 行 j 列等于左矩阵第 i 行点乘右矩阵第 j 列。",
  "复习时先回忆再对照笔记，比反复阅读更能记住。",
  "Go 的接口是隐式实现的，只要方法集合匹配就满足接口。",
  "Rust 的所有权规则保证同一时间只有一个可变引用。",
  "today we reviewed the attention mechanism and the softmax function.",
];

// 固定种子的伪随机数，结果可重复
let seed = 42;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sn-bench-"));
const db = openDb(path.join(root, "index.db"));
const started = Date.now();
db.exec("BEGIN");
const insNote = db.prepare(
  "INSERT INTO notes (id, path, title, excerpt, type, created, updated, content_hash, chars, indexed_at, group_name) VALUES (?, ?, ?, '', 'note', ?, ?, '', 0, '', NULL)",
);
const insFts = db.prepare("INSERT INTO notes_fts (note_id, title, body) VALUES (?, ?, ?)");
const insTag = db.prepare("INSERT INTO tags (note_id, tag) VALUES (?, ?)");
const base = Date.parse("2026-01-01T00:00:00Z");
for (let i = 0; i < count; i += 1) {
  const id = `n${i}`;
  const parts: string[] = [];
  while (parts.join("").length < 1500) parts.push(SENTENCES[Math.floor(rand() * SENTENCES.length)]);
  if (i % 997 === 0) parts.push("罕见词稀有标记");
  const title = `学习笔记 ${i} ${SENTENCES[i % SENTENCES.length].slice(0, 8)}`;
  const updated = new Date(base + i * 60_000).toISOString();
  insNote.run(id, `${id}.md`, title, updated, updated);
  insFts.run(id, title, parts.join("\n"));
  insTag.run(id, i % 3 === 0 ? "机器学习" : "数学");
  if (i % 10 === 0) insTag.run(id, "复习");
}
db.exec("COMMIT");
console.log(`造库：${count} 篇，${Date.now() - started}ms`);

const cases: Array<{ name: string; q: string; tag?: string }> = [
  { name: "常用词（几乎每篇都有）", q: "梯度下降" },
  { name: "英文常用词", q: "attention" },
  { name: "两个字（LIKE 兜底）", q: "矩阵" },
  { name: "罕见词", q: "稀有标记" },
  { name: "常用词 + 标签筛选", q: "位置编码", tag: "复习" },
  { name: "查不到", q: "完全不存在的词组" },
];

let failed = false;
for (const c of cases) {
  const times: number[] = [];
  let hits = 0;
  for (let run = 0; run < 7; run += 1) {
    const t0 = performance.now();
    hits = search(db, c.q, { tag: c.tag, limit: 20 }).length;
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const ok = median <= maxMs;
  if (!ok) failed = true;
  console.log(`${ok ? "✔" : "✖"} ${c.name}「${c.q}」${c.tag ? ` #${c.tag}` : ""}：中位数 ${median.toFixed(1)}ms，返回 ${hits} 条`);
}

db.close();
fs.rmSync(root, { recursive: true, force: true });
if (failed) {
  console.error(`有查询超过 ${maxMs}ms`);
  process.exit(1);
}
