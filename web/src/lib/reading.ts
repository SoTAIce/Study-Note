/**
 * 阅览模式（reading-001）的纯逻辑：目录、当前小节、上一篇 / 下一篇、阅读位置。
 * 不碰 DOM，便于单测；组件负责把 DOM 里的标题和位置喂进来。
 */

export type OutlineItem = {
  /** 在传入的标题数组里的下标（组件按它找到对应的 DOM 元素） */
  index: number;
  /** 相对缩进：最浅的那级是 0 */
  depth: number;
  text: string;
};

/** 由正文里的标题生成目录：只取 h1–h3，空标题跳过，缩进从最浅那级算起 */
export function buildOutline(headings: Array<{ level: number; text: string }>, maxLevel = 3): OutlineItem[] {
  const picked = headings
    .map((heading, index) => ({ index, level: heading.level, text: heading.text.replace(/\s+/g, " ").trim() }))
    .filter((heading) => heading.level <= maxLevel && heading.text);
  if (picked.length === 0) return [];
  const min = Math.min(...picked.map((heading) => heading.level));
  return picked.map((heading) => ({ index: heading.index, depth: heading.level - min, text: heading.text }));
}

/**
 * 当前读到第几个目录项：最后一个「顶端已经滚过阅读线」的标题。
 * tops 是各标题相对滚动内容顶端的位置；还没读到第一个标题时返回 0，没有标题返回 -1。
 */
export function activeOutlineIndex(tops: number[], scrollTop: number, readingLine = 96): number {
  if (tops.length === 0) return -1;
  let active = 0;
  for (let i = 0; i < tops.length; i += 1) {
    if (tops[i] <= scrollTop + readingLine) active = i;
    else break;
  }
  return active;
}

/** 在当前列表顺序里的上一篇 / 下一篇；不在列表里时两个都没有 */
export function neighbors(ids: string[], id: string | null): { prev: string | null; next: string | null } {
  const at = id === null ? -1 : ids.indexOf(id);
  if (at === -1) return { prev: null, next: null };
  return { prev: at > 0 ? ids[at - 1] : null, next: at < ids.length - 1 ? ids[at + 1] : null };
}

/** 读到的比例（0–1）；内容不够一屏时算 0 */
export function scrollRatio(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  const room = scrollHeight - clientHeight;
  if (room <= 0) return 0;
  return Math.min(1, Math.max(0, scrollTop / room));
}

export type Positions = Record<string, number>;

/** localStorage 里读出的位置表；坏数据当没有 */
export function parsePositions(raw: string | null): Positions {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Positions = {};
    for (const [id, ratio] of Object.entries(value as Record<string, unknown>)) {
      if (typeof ratio === "number" && Number.isFinite(ratio)) out[id] = Math.min(1, Math.max(0, ratio));
    }
    return out;
  } catch {
    return {};
  }
}

/** 记住一篇读到的位置：最近读的排在最后，超过上限丢掉最早的 */
export function rememberPosition(positions: Positions, id: string, ratio: number, cap = 200): Positions {
  const next: Positions = {};
  for (const [key, value] of Object.entries(positions)) if (key !== id) next[key] = value;
  // 读到最开头或几乎读完就不必记：下次从头开始
  if (ratio > 0.01 && ratio < 0.99) next[id] = Math.round(ratio * 1000) / 1000;
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - cap))) delete next[key];
  return next;
}

/** 固定档的版心宽度（px） */
export const READING_WIDTHS = { narrow: 600, medium: 700, wide: 840 } as const;
/**
 * 行宽档位（read-003）：固定三档，加「自动」（随窗口变宽、宽屏字号略放大）和「满宽」（铺满窗口）。
 * 默认「自动」。
 */
export type ReadingWidth = keyof typeof READING_WIDTHS | "auto" | "full";

export function parseWidth(raw: string | null): ReadingWidth {
  return raw === "narrow" || raw === "medium" || raw === "wide" || raw === "full" ? raw : "auto";
}

/** 自动档：一行大约多少个字（版心 = 字号 × 这个数）。中文 40～50 字一行读起来最舒服 */
export const AUTO_LINE_CHARS = 48;
/** 自动档：正文区比这宽才开始放大字号；放大到这个倍数为止 */
export const AUTO_SCALE_FROM = 1100;
export const AUTO_SCALE_MAX = 1.25;
/** 版心两边至少留的空白（px） */
export const READING_GUTTER = 28;

/**
 * 阅览排版（read-003）：available = 正文滚动区的宽度（不含左侧目录），baseFont = 用户选的字号。
 * 返回实际字号和版心最大宽度（null = 不限，铺满）。
 * - 固定档：版心固定，字号就是用户选的；
 * - 满宽：版心铺满（两边留边距），字号不变；
 * - 自动：正文区越宽字号越大（最多 ×1.25），版心 = 字号 × 48 个字，但不超过正文区。
 */
export function readingLayout(
  width: ReadingWidth,
  available: number,
  baseFont: number,
): { fontSize: number; maxWidth: number | null } {
  if (width === "full") return { fontSize: baseFont, maxWidth: null };
  if (width !== "auto") return { fontSize: baseFont, maxWidth: READING_WIDTHS[width] };
  const room = Math.max(0, available - READING_GUTTER * 2);
  const scale = Math.min(AUTO_SCALE_MAX, Math.max(1, available / AUTO_SCALE_FROM));
  const fontSize = Math.round(baseFont * scale);
  return { fontSize, maxWidth: Math.max(320, Math.min(room, fontSize * AUTO_LINE_CHARS)) };
}
