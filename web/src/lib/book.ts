/**
 * 连读（book-001）的纯逻辑：章节正文去掉重复标题、目录项、按标题找章节。
 * 组件负责把 DOM 里的标题喂进来。
 */

/** 正文开头的 `# 标题` 和章节标题一样时去掉，免得每章标题出现两次。 */
export function stripLeadingTitle(body: string, title: string): string {
  const match = /^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(\r?\n|$)/.exec(body);
  if (!match || match[1].trim() !== title.trim()) return body;
  return body.slice(match[0].length).replace(/^(\s*\r?\n)+/, "");
}

export type BookTocItem = {
  /** 在传入数组里的下标（组件按它找 DOM 元素） */
  index: number;
  /** 0 = 章，1 = 章里的 # / ##，2 = ### */
  depth: number;
  text: string;
};

/** 章节标题（chapter）与章内标题（h1–h3）→ 左侧目录；更深的标题不进目录。 */
export function buildBookToc(entries: Array<{ kind: "chapter" | "heading"; level: number; text: string }>): BookTocItem[] {
  const out: BookTocItem[] = [];
  entries.forEach((entry, index) => {
    const text = entry.text.replace(/\s+/g, " ").trim();
    if (!text) return;
    if (entry.kind === "chapter") out.push({ index, depth: 0, text });
    else if (entry.level <= 2) out.push({ index, depth: 1, text });
    else if (entry.level === 3) out.push({ index, depth: 2, text });
  });
  return out;
}

/** 本书里标题为 target 的章节下标：先精确，再不区分大小写；不在书里返回 -1。 */
export function findChapter(titles: Array<string | null>, target: string): number {
  const want = target.trim();
  const exact = titles.findIndex((title) => title !== null && title === want);
  if (exact >= 0) return exact;
  const lower = want.toLowerCase();
  return titles.findIndex((title) => title !== null && title.toLowerCase() === lower);
}

/** 当前位置所在章的上一章 / 下一章（`[` / `]`）。chapterTops 升序；没有就返回 -1。 */
export function stepChapter(chapterTops: number[], scrollTop: number, dir: 1 | -1, readingLine = 96): number {
  if (chapterTops.length === 0) return -1;
  let current = -1;
  for (let i = 0; i < chapterTops.length; i += 1) {
    if (chapterTops[i] <= scrollTop + readingLine) current = i;
    else break;
  }
  const next = current + dir;
  if (dir === -1 && current === -1) return -1;
  return next >= 0 && next < chapterTops.length ? next : -1;
}
