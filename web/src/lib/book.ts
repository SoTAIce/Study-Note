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

/**
 * 双击渲染好的一章进入编辑时，光标放在哪（book-002）。
 * 预览渲染的是去掉开头标题后的正文（stripLeadingTitle），块上的 data-line 是那段文字里的行号；
 * 换算回整篇正文里的字符位置。行号不合法时放在正文末尾。
 */
export function caretForLine(body: string, shown: string, line: number | null): number {
  if (line === null || !Number.isInteger(line) || line < 0) return body.length;
  const skipped = body.length - shown.length;
  let offset = 0;
  for (let i = 0; i < line; i += 1) {
    const next = shown.indexOf("\n", offset);
    if (next < 0) return body.length;
    offset = next + 1;
  }
  return Math.min(body.length, skipped + offset);
}

export type EditingSync = "keep" | "adopt" | "conflict";

/**
 * 连读整本重取后，正在就地编辑的那一章怎么办（book-002）：
 * - 磁盘版本就是编辑起点，或是自己刚存的：keep；
 * - 别处改了、而这里还没动过：adopt（换成磁盘上的新内容，继续编辑）；
 * - 别处改了、这里也改了：conflict（走冲突提示，不自动覆盖任何一边）。
 */
export function syncEditing(
  editing: { baseHash: string; draft: string; original: string },
  disk: { hash: string },
  ownHashes: ReadonlySet<string>,
): EditingSync {
  if (disk.hash === editing.baseHash || ownHashes.has(disk.hash)) return "keep";
  return editing.draft === editing.original ? "adopt" : "conflict";
}
