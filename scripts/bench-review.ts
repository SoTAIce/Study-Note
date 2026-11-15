/**
 * 复习日志重放基准（srs-001）：5000 张卡、5 万条打分记录，量启动时重放 + 出今日队列的耗时。
 *
 * 用法：node scripts/bench-review.ts [卡数=5000] [记录数=50000]
 *   BENCH_MAX_MS=300  超过就以非 0 退出
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildQueue, ReviewLog, reviewLogPath } from "../server/review.ts";

const cardCount = Number(process.argv[2] ?? 5000);
const eventCount = Number(process.argv[3] ?? 50000);
const maxMs = Number(process.env.BENCH_MAX_MS ?? 300);

let seed = 7;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-bench-review-"));
const file = reviewLogPath(dataDir);
fs.mkdirSync(path.dirname(file), { recursive: true });
const start = Date.parse("2025-01-01T00:00:00Z");
const span = 300 * 86_400_000;
const lines: string[] = [];
for (let i = 0; i < eventCount; i += 1) {
  const t = new Date(start + Math.floor((i / eventCount) * span)).toISOString();
  const card = `c_${Math.floor(rand() * cardCount)}`;
  const grade = 1 + Math.floor(rand() * 4);
  lines.push(JSON.stringify({ t, card, note: "n", grade }));
  if (i % 500 === 0) lines.push(JSON.stringify({ t, undo: card }));
}
fs.writeFileSync(file, `${lines.join("\n")}\n`);

const cards = Array.from({ length: cardCount }, (_, i) => ({ id: `c_${i}` }));
const times: number[] = [];
let queueLength = 0;
for (let run = 0; run < 5; run += 1) {
  const t0 = performance.now();
  const log = new ReviewLog({ dataDir, now: () => start + span + 86_400_000 });
  queueLength = buildQueue(log, cards, { newPerDay: 20 }).queue.length;
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`${median <= maxMs ? "✔" : "✖"} 重放 ${lines.length} 行日志 + ${cardCount} 张卡出队列：中位数 ${median.toFixed(1)}ms（队列 ${queueLength} 张）`);
if (median > maxMs) {
  console.error(`超过 ${maxMs}ms`);
  process.exit(1);
}
