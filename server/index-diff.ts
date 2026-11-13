/**
 * 一篇笔记重新索引前后，「别处显示的东西」有没有变（perf-001）。
 * 只改正文时左栏（标签、时间线、分组）和反链都不用重新拉。
 */

/** 索引里会影响左栏 / 反链的那部分 */
export type IndexedShape = {
  title: string;
  type: string;
  group: string | null;
  /** frontmatter 标签 + 正文 #标签 */
  tags: string[];
  /** 正文里 [[链接]] 的目标标题 */
  links: string[];
};

export type IndexChanges = {
  /** 标题变了：左栏、标签页、反链（按标题匹配）都要更新 */
  title: boolean;
  tags: boolean;
  /** 类型或分组变了 */
  meta: boolean;
  links: boolean;
};

function sameSet(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const item of left) if (!right.has(item)) return false;
  return true;
}

export function diffIndexed(before: IndexedShape | null, after: IndexedShape): IndexChanges {
  if (!before) return { title: true, tags: true, meta: true, links: true };
  return {
    title: before.title !== after.title,
    tags: !sameSet(before.tags, after.tags),
    meta: before.type !== after.type || before.group !== after.group,
    links: !sameSet(before.links, after.links),
  };
}
