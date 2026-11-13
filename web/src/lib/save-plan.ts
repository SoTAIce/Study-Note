/**
 * 自动保存的节奏，以及保存后要不要刷新左栏 / 反链（perf-001）。纯函数，便于单测。
 */
import type { NoteChange } from "./live.ts";

/** 停手这么久才自动保存（习惯按 Ctrl+S 的人不需要更频繁） */
export const AUTOSAVE_IDLE_MS = 5_000;
/** 一直在打字时，最多隔这么久也要存一次 */
export const AUTOSAVE_MAX_WAIT_MS = 30_000;
/** AI 改写、插入片段这类一次性动作：很快就存 */
export const QUICK_SAVE_MS = 800;

/**
 * 距离下一次自动保存还要等多久。
 * firstDirtyAt：上次保存之后第一次改动的时间；null 表示刚开始改。
 */
export function autosaveDelay(
  now: number,
  firstDirtyAt: number | null,
  idle = AUTOSAVE_IDLE_MS,
  maxWait = AUTOSAVE_MAX_WAIT_MS,
): number {
  if (firstDirtyAt === null) return idle;
  return Math.max(0, Math.min(idle, firstDirtyAt + maxWait - now));
}

/** 与服务端 server/index-diff.ts 的 IndexChanges 一致 */
export type IndexChanges = { title: boolean; tags: boolean; meta: boolean; links: boolean };

/**
 * 保存后要刷新什么。
 * - 左栏（标签数、时间线、分组）：标题、标签、类型 / 分组变了才刷新；
 * - 反链面板：标题变了（别人按标题链到我）或我的链接变了才刷新。
 * 老服务端不返回 changes 时按「全变了」处理。
 */
export function refreshAfterSave(changes: IndexChanges | undefined): { sidebar: boolean; backlinks: boolean } {
  if (!changes) return { sidebar: true, backlinks: true };
  return {
    sidebar: changes.title || changes.tags || changes.meta,
    backlinks: changes.title || changes.links,
  };
}

/** 自己保存过的版本，用于认出推送通道里的回声 */
export function echoKey(id: string, hash: string): string {
  return `${id}:${hash}`;
}

/** 去掉「自己刚保存的那一版」的回声；剩下的才是别处来的变化 */
export function dropOwnEchoes(changes: NoteChange[], own: ReadonlySet<string>): NoteChange[] {
  return changes.filter((change) => change.kind !== "changed" || !own.has(echoKey(change.id, change.hash)));
}

/** 把刚保存的结果就地更新进时间线（首页「最近」靠 updated 排序），省掉一次重新拉取 */
export function patchTimeline<T extends { id: string; title: string; updated: string; relPath: string }>(
  items: T[],
  saved: { id: string; title: string; updated: string; relPath: string },
): T[] {
  let touched = false;
  const next = items.map((item) => {
    if (item.id !== saved.id) return item;
    if (item.title === saved.title && item.updated === saved.updated && item.relPath === saved.relPath) return item;
    touched = true;
    return { ...item, title: saved.title, updated: saved.updated, relPath: saved.relPath };
  });
  return touched ? next : items;
}
