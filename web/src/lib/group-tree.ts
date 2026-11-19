/**
 * 子项目（group-002）：组名 `agent/looprun` = 父分组 agent 下的子项目 looprun。
 * 与 server/groups.ts 的规则一致：最多两层，比较不区分大小写。
 */

export const GROUP_SEP = "/";

export type GroupLike = { name: string; count: number; total?: number; empty: boolean };

export type GroupNode<G extends GroupLike> = {
  group: G;
  children: G[];
};

/** 父分组名；顶层分组返回 null。 */
export function parentOf(name: string): string | null {
  const at = name.indexOf(GROUP_SEP);
  return at > 0 ? name.slice(0, at) : null;
}

/** 两个组名是否同一个组：空白规整（含 `/` 两边）、不区分大小写，与 server/groups.ts 的 sameGroup 同义。 */
export function sameGroupName(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (name: string | null | undefined) =>
    (name ?? "")
      .replace(/[\s\u3000]+/g, " ")
      .split(GROUP_SEP)
      .map((part) => part.trim())
      .join(GROUP_SEP)
      .trim()
      .toLowerCase();
  return norm(a) === norm(b);
}

/** 子项目在树里显示的短名（`agent/looprun` → `looprun`）；顶层分组原样返回。 */
export function leafName(name: string): string {
  const at = name.indexOf(GROUP_SEP);
  return at > 0 ? name.slice(at + 1) : name;
}

/** `name` 是否就是 `ancestor`，或是它的子项目。 */
export function isInGroup(name: string | null | undefined, ancestor: string): boolean {
  if (!name) return false;
  const left = name.toLowerCase();
  const right = ancestor.toLowerCase();
  return left === right || left.startsWith(right + GROUP_SEP);
}

/** 改父分组名时，子项目名跟着换前缀；不在 `from` 下的原样返回。 */
export function replacePrefix(name: string, from: string, to: string): string {
  if (!isInGroup(name, from)) return name;
  return to + name.slice(from.length);
}

/**
 * 平铺的分组列表 → 两层树。
 * - 父分组保持服务端给的顺序；子项目跟在各自父分组下，也按服务端顺序；
 * - 服务端会补出只有子项目的父分组，万一没补（旧接口），这里也补一个空壳，免得子项目丢失。
 */
export function buildGroupTree<G extends GroupLike>(groups: G[]): GroupNode<G>[] {
  const roots: GroupNode<G>[] = [];
  const byKey = new Map<string, GroupNode<G>>();
  for (const group of groups) {
    if (parentOf(group.name)) continue;
    const node = { group, children: [] as G[] };
    roots.push(node);
    byKey.set(group.name.toLowerCase(), node);
  }
  for (const group of groups) {
    const parent = parentOf(group.name);
    if (!parent) continue;
    let node = byKey.get(parent.toLowerCase());
    if (!node) {
      const shell = { name: parent, count: 0, total: 0, empty: false } as G;
      node = { group: shell, children: [] };
      roots.push(node);
      byKey.set(parent.toLowerCase(), node);
    }
    node.children.push(group);
  }
  return roots;
}

/** 左栏里折叠起来的父分组（只存本机浏览器，丢了就全部展开）。 */
export const GROUP_TREE_KEY = "study.groupTreeCollapsed";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function readCollapsedGroups(storage: StorageLike | null): Set<string> {
  try {
    const raw = storage?.getItem(GROUP_TREE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeCollapsedGroups(storage: StorageLike | null, collapsed: Set<string>): void {
  try {
    storage?.setItem(GROUP_TREE_KEY, JSON.stringify([...collapsed]));
  } catch {
    // 记不住就算了
  }
}
