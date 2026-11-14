/** 输入 [[ 时补全笔记标题（editor-003）：纯函数部分 */
import type { Edit } from "./edit-ops.ts";

export type WikilinkQuery = { start: number; query: string };

const MAX_QUERY = 60;

/**
 * 光标前面是不是一个还没写完的 [[...：返回 [[ 的位置和已经打的字。
 * 同一行里、中间没有 ] [ | 和换行时才算（写到 | 后面是在写别名，不再提示）。
 */
export function wikilinkQuery(value: string, caret: number): WikilinkQuery | null {
  if (caret < 2) return null;
  // 以最靠右的 [[ 为准（[[[ 也从最后两个算起）
  const open = value.lastIndexOf("[[", caret - 2);
  if (open < 0) return null;
  const query = value.slice(open + 2, caret);
  if (query.length > MAX_QUERY || /[\]\[|\n]/.test(query)) return null;
  return { start: open, query };
}

/**
 * 候选标题：包含所打文字（不分大小写），整题相同 > 开头相同 > 出现越靠前；同档里短的在前，
 * 再按传入顺序（调用方按最近更新排好）。不提示当前这篇；没打字时按最近更新列前几篇。
 */
export function rankTitles(titles: string[], query: string, exclude: string | null, limit = 8): string[] {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const scored: Array<{ title: string; score: number; order: number }> = [];
  titles.forEach((title, order) => {
    const clean = title.trim();
    if (!clean || clean === exclude || seen.has(clean)) return;
    seen.add(clean);
    const lower = clean.toLowerCase();
    if (!q) {
      scored.push({ title: clean, score: 0, order });
      return;
    }
    const at = lower.indexOf(q);
    if (at < 0) return;
    const score = lower === q ? 0 : at === 0 ? 1 : 2 + at / 1000;
    scored.push({ title: clean, score, order });
  });
  scored.sort((a, b) => a.score - b.score || (q ? a.title.length - b.title.length : 0) || a.order - b.order);
  return scored.slice(0, limit).map((item) => item.title);
}

/** 用选中的标题补全：[[已打的字 → [[标题]]；后面本来就有 ]] 的就不再多加 */
export function completeWikilink(value: string, query: WikilinkQuery, caret: number, title: string): Edit {
  const closing = value.startsWith("]]", caret) ? 2 : 0;
  const insert = `[[${title}]]`;
  const to = caret + closing;
  const after = query.start + insert.length;
  return { from: query.start, to, insert, selStart: after, selEnd: after };
}
