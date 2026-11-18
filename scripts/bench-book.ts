/**
 * 连读基准（book-001）：一个 100 章、每章约 3000 字的项目，
 * 量「GET /api/book 组装整本」+「把每章渲染成 HTML」（前端首屏的主要开销）的总耗时。
 *
 * 用法：node scripts/bench-book.ts [章数=100] [每章字数=3000]
 *   BENCH_MAX_MS=1000  中位数超过就以非 0 退出
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBookRoutes, type Book } from "../server/book.ts";
import { openDb } from "../server/db.ts";
import { Indexer } from "../server/indexer.ts";
import { NoteStore } from "../server/store.ts";
import { renderMarkdown } from "../web/src/lib/markdown.ts";

const chapterCount = Number(process.argv[2] ?? 100);
const charsPerChapter = Number(process.argv[3] ?? 3000);
const maxMs = Number(process.env.BENCH_MAX_MS ?? 1000);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sn-bench-book-"));
const store = new NoteStore({
  notesRoot: path.join(tmp, "notes"),
  historyDir: path.join(tmp, "history"),
  trashDir: path.join(tmp, "trash"),
});
const db = openDb(path.join(tmp, "index.db"));
const indexer = new Indexer({ db, store });
const group = "bench/project";

function chapterBody(n: number): string {
  const parts: string[] = [`# 第 ${n} 章`];
  let size = 0;
  let k = 0;
  while (size < charsPerChapter) {
    k += 1;
    const block =
      k % 5 === 0
        ? "```ts\nfor (const step of plan) {\n  await run(step);\n}\n```"
        : k % 4 === 0
          ? `- 要点一：第 ${n} 章第 ${k} 节\n- 要点二：[[第 ${Math.max(1, n - 1)} 章]]\n- [ ] 待办`
          : k % 3 === 0
            ? `## 小节 ${k}\n\n这一节讲实现细节，包括 \`retry\`、**退避**、*超时* 与 trace 的写入顺序。`
            : `这是第 ${n} 章的第 ${k} 段正文，用来撑开篇幅，模拟一份真实的开发笔记，记录设计取舍与踩过的坑。`;
    parts.push(block);
    size += block.length;
  }
  return parts.join("\n\n");
}

const titles: string[] = [];
for (let i = 1; i <= chapterCount; i += 1) {
  const title = `第 ${i} 章`;
  titles.push(title);
  const note = store.create({ title, body: chapterBody(i), group });
  indexer.indexFile(note.relPath);
}
const index = store.create({
  title: "project 目录",
  type: "index",
  group,
  body: `项目总览。\n\n${titles.map((title) => `- [[${title}]]`).join("\n")}\n`,
});
indexer.indexFile(index.relPath);

const handle = createBookRoutes({ db, store, reindex: (rel) => indexer.indexFile(rel) });
const url = new URL(`http://x/api/book?group=${encodeURIComponent(group)}`);

const total: number[] = [];
const server: number[] = [];
let chapters = 0;
let chars = 0;
for (let run = 0; run < 5; run += 1) {
  const t0 = performance.now();
  const book = (await handle("GET", ["book"], url, async () => ({}))) as Book;
  const t1 = performance.now();
  chars = 0;
  for (const chapter of book.chapters) {
    if (chapter.kind !== "note") continue;
    // 与连读页一致：带源码行号（双击就地编辑定位用，book-002）、任务框可点
    chars += renderMarkdown(chapter.body, { images: { notePath: chapter.path }, sourceLines: true, interactiveTasks: true }).length;
  }
  if (book.index) renderMarkdown(book.index.body, {});
  total.push(performance.now() - t0);
  server.push(t1 - t0);
  chapters = book.chapters.length;
}
const median = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
db.close();
fs.rmSync(tmp, { recursive: true, force: true });

const ok = median(total) <= maxMs && chapters === chapterCount;
console.log(
  `${ok ? "✔" : "✖"} 连读 ${chapters} 章（每章约 ${charsPerChapter} 字）：组装 + 渲染中位数 ${median(total).toFixed(1)}ms（其中组装 ${median(server).toFixed(1)}ms，HTML ${Math.round(chars / 1024)}KB）`,
);
if (!ok) {
  console.error(chapters !== chapterCount ? `章数不对：${chapters}` : `超过 ${maxMs}ms`);
  process.exit(1);
}
