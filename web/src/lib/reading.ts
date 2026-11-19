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

// —— 分屏阅读（read-002） ——

export type Pane = "left" | "right";

/** 窗口比这窄就放不下两栏：「分屏」按钮变灰；已经分屏时只显示当前栏 */
export const SPLIT_MIN_WIDTH = 900;
/** 左栏占比的范围和默认值；拖动分隔条、用键盘调都夹在这里面 */
export const SPLIT_MIN_RATIO = 0.3;
export const SPLIT_MAX_RATIO = 0.7;
export const SPLIT_DEFAULT_RATIO = 0.5;
/** 焦点在分隔条上按一次 ← / → 调多少 */
export const SPLIT_KEY_STEP = 0.05;

export function canSplit(windowWidth: number): boolean {
  return windowWidth >= SPLIT_MIN_WIDTH;
}

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return SPLIT_DEFAULT_RATIO;
  return Math.round(Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, ratio)) * 1000) / 1000;
}

/** localStorage 里存的比例；坏数据用默认值 */
export function parseSplitRatio(raw: string | null): number {
  if (raw === null || raw.trim() === "") return SPLIT_DEFAULT_RATIO;
  return clampSplitRatio(Number(raw));
}

/** 拖动分隔条：指针在两栏区域里的位置 → 左栏占比 */
export function ratioFromPointer(pointerX: number, areaLeft: number, areaWidth: number): number {
  if (areaWidth <= 0) return SPLIT_DEFAULT_RATIO;
  return clampSplitRatio((pointerX - areaLeft) / areaWidth);
}

/** 键盘调分隔条：方向 -1（←）或 +1（→） */
export function nudgeSplitRatio(ratio: number, direction: -1 | 1): number {
  return clampSplitRatio(ratio + direction * SPLIT_KEY_STEP);
}

/**
 * 翻篇（← → [ ]）作用到哪一栏、换成哪一篇：作用于当前栏，按中间列表的顺序。
 * 没分屏时永远是左栏；当前栏这一篇不在列表里或已经到头时返回 null。
 */
export function paneNavigation(input: {
  split: boolean;
  active: Pane;
  leftId: string;
  rightId: string | null;
  ids: string[];
  direction: -1 | 1;
}): { pane: Pane; id: string } | null {
  const pane: Pane = input.split && input.active === "right" && input.rightId ? "right" : "left";
  const from = pane === "right" ? input.rightId : input.leftId;
  const around = neighbors(input.ids, from);
  const id = input.direction < 0 ? around.prev : around.next;
  return id ? { pane, id } : null;
}

/** 打开另一栏时的去向：在左栏 Ctrl+点双链 → 右栏；在右栏 Ctrl+点 → 左栏 */
export function otherPane(pane: Pane): Pane {
  return pane === "left" ? "right" : "left";
}
