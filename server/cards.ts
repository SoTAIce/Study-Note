/**
 * 知识简卡解析（srs-001），纯函数。
 *
 * 两种写法：
 * - callout：`> [!card] 概念名`（或 `> [!card]- 概念名`），后面连续的 `>` 行是要点；
 * - 一行：`概念 :: 解释`（` :: ` 两边必须有空格，列表项里也可以写）。
 * 代码块、行内代码里的内容不算；普通 `>` 引用不算。
 *
 * 卡片 id 不写进笔记：由「笔记 id + 规范化标题 + 同名序号」算出。改要点 id 不变；
 * 改了标题由 matchRenamed 按位置和相似度认回原来的卡（复习日志里记一条别名）。
 */
import crypto from "node:crypto";
import { stripHtmlComments } from "./parse.ts";

export type ParsedCard = {
  kind: "callout" | "line";
  title: string;
  /** 背面：callout 的要点（去掉 `> ` 前缀的 Markdown）；一行简卡的解释 */
  body: string;
  /** 在正文里的行号（从 0 开始） */
  line: number;
};

export type IndexedCard = ParsedCard & { id: string; ord: number };

const FENCE = /^ {0,3}(```|~~~)/;
const CALLOUT = /^ {0,3}>[ \t]?\[!card\][-+]?[ \t]*(.*)$/i;
const QUOTE = /^ {0,3}>/;
const LIST_MARK = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/;

/** 把行内代码换成同长度的占位，判断 ` :: ` 时不看代码里的内容 */
function maskInlineCode(line: string): string {
  return line.replace(/`[^`\n]*`/g, (m) => "\u0000".repeat(m.length));
}

export function parseCards(body: string): ParsedCard[] {
  // 模板提示注释（tpl-001）里的「问题 :: 答案」只是示例，不算卡；去注释时行号不变
  const lines = stripHtmlComments(body).split(/\r?\n/);
  const out: ParsedCard[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const callout = CALLOUT.exec(line);
    if (callout) {
      const title = callout[1].trim();
      const back: string[] = [];
      let j = i + 1;
      while (j < lines.length && QUOTE.test(lines[j])) {
        back.push(lines[j].replace(/^ {0,3}>[ \t]?/, ""));
        j += 1;
      }
      if (title) out.push({ kind: "callout", title, body: back.join("\n").trim(), line: i });
      i = j - 1;
      continue;
    }
    if (QUOTE.test(line)) continue;

    const masked = maskInlineCode(line);
    const at = masked.indexOf(" :: ");
    if (at < 0) continue;
    const marker = LIST_MARK.exec(line)?.[0].length ?? 0;
    const term = line.slice(marker, at).trim();
    const def = line.slice(at + 4).trim();
    if (term && def && !/^#{1,6}\s/.test(term)) out.push({ kind: "line", title: term, body: def, line: i });
  }
  return out;
}

export function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

/** 卡片 id：同一篇里同名的卡按出现顺序加序号 */
export function indexCards(noteId: string, cards: ParsedCard[]): IndexedCard[] {
  const seen = new Map<string, number>();
  return cards.map((card, ord) => {
    const norm = normalizeTitle(card.title);
    const dup = seen.get(norm) ?? 0;
    seen.set(norm, dup + 1);
    const hash = crypto.createHash("sha256").update(`${noteId}\n${norm}\n${dup}`).digest("hex").slice(0, 10);
    return { ...card, id: `c_${hash}`, ord };
  });
}

/** 两段文字的相似度（字符二元组的 Dice 系数，0~1） */
export function similarity(a: string, b: string): number {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (x === y) return 1;
  const grams = (s: string): Map<string, number> => {
    const chars = [...s];
    const m = new Map<string, number>();
    if (chars.length === 1) m.set(s, 1);
    for (let i = 0; i < chars.length - 1; i += 1) {
      const g = chars[i] + chars[i + 1];
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(x);
  const gb = grams(y);
  let both = 0;
  let total = 0;
  for (const n of ga.values()) total += n;
  for (const n of gb.values()) total += n;
  for (const [g, n] of ga) both += Math.min(n, gb.get(g) ?? 0);
  return total === 0 ? 0 : (2 * both) / total;
}

export const RENAME_SIMILARITY = 0.6;

/**
 * 改了标题的卡认回原来的卡：新出现的卡和消失的卡，在卡片序号相同、标题相似度 ≥ 0.6 时配成一对。
 * 返回 [新 id, 旧 id] 列表。
 */
export function matchRenamed(before: IndexedCard[], after: IndexedCard[]): Array<[string, string]> {
  const afterIds = new Set(after.map((c) => c.id));
  const beforeIds = new Set(before.map((c) => c.id));
  const gone = before.filter((c) => !afterIds.has(c.id));
  const added = after.filter((c) => !beforeIds.has(c.id));
  const pairs: Array<[string, string]> = [];
  const used = new Set<string>();
  for (const card of added) {
    const old = gone.find(
      (g) => !used.has(g.id) && g.ord === card.ord && g.kind === card.kind && similarity(g.title, card.title) >= RENAME_SIMILARITY,
    );
    if (old) {
      used.add(old.id);
      pairs.push([card.id, old.id]);
    }
  }
  return pairs;
}
