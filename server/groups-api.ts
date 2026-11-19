import type { DatabaseSync } from "node:sqlite";
import {
  GROUP_SEP,
  isInGroup,
  mergeGroupList,
  normalizeGroupName,
  parentGroup,
  readGroups,
  removeGroupEntry,
  renameGroupEntry,
  replaceGroupPrefix,
  sameGroup,
  upsertGroup,
  validateGroupName,
  type MergedGroup,
} from "./groups.ts";
import { ConflictError, type NoteStore } from "./store.ts";
import { removeGroupDefaults, renameGroupDefaults } from "./templates.ts";

export class GroupsHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type GroupsDeps = {
  db: DatabaseSync;
  store: NoteStore;
  dataDir: string;
  reindex: (relPath: string) => void;
};

/** count：直接属于该组的篇数；total：连同子项目的篇数（父分组在左栏显示 total）。 */
export type GroupCount = MergedGroup & { count: number; total: number };

type NoteGroupRow = { id: string; path: string; group: string | null; hash: string | null };

function noteRows(deps: GroupsDeps): NoteGroupRow[] {
  return deps.db
    .prepare("SELECT id, path, group_name AS \"group\", content_hash AS hash FROM notes")
    .all() as unknown as NoteGroupRow[];
}

/** 属于该组的笔记，连同子项目里的（改名 / 删除父分组时子项目跟着变）。 */
function rowsOf(deps: GroupsDeps, name: string): NoteGroupRow[] {
  return noteRows(deps).filter((row) => isInGroup(row.group, name));
}

/** groups.json 里该组及其子项目的条目名。 */
function entriesOf(deps: GroupsDeps, name: string): string[] {
  return readGroups(deps.dataDir)
    .map((entry) => entry.name)
    .filter((entry) => isInGroup(entry, name));
}

/** 分组总览：groups.json 的顺序 ∪ 笔记里的组名，带上每组的篇数与未分组篇数。 */
export function groupsOverview(deps: GroupsDeps): { items: GroupCount[]; ungrouped: number } {
  const byKey = new Map<string, { name: string; count: number }>();
  let ungrouped = 0;

  for (const row of noteRows(deps)) {
    if (!row.group) {
      ungrouped += 1;
      continue;
    }
    const key = row.group.toLowerCase();
    const hit = byKey.get(key);
    if (hit) hit.count += 1;
    else byKey.set(key, { name: row.group, count: 1 });
  }

  const names = [...byKey.values()].map((entry) => entry.name);
  const merged = mergeGroupList(readGroups(deps.dataDir), names);
  // 只有子项目、自己没登记也没有直接笔记的父分组：补出来，否则左栏的树挂不上
  for (const group of [...merged]) {
    const parent = parentGroup(group.name);
    if (parent && !merged.some((item) => sameGroup(item.name, parent))) {
      merged.push({ name: parent, order: merged.length + 1, empty: false });
    }
  }
  const items = merged.map((group) => {
    let total = 0;
    for (const [key, entry] of byKey) if (isInGroup(key, group.name)) total += entry.count;
    return {
      ...group,
      // 父分组自己没有笔记、但子项目有：不算空组
      empty: group.empty && total === 0,
      count: byKey.get(group.name.toLowerCase())?.count ?? 0,
      total,
    };
  });
  return { items, ungrouped };
}

export function createGroup(deps: GroupsDeps, rawName: string): { name: string; created: boolean } {
  const check = validateGroupName(rawName);
  if (!check.ok) throw new GroupsHttpError(400, `参数错误：${check.error}`);
  const { entry, created } = upsertGroup(deps.dataDir, check.name);
  return { name: entry.name, created };
}

export function renameGroup(
  deps: GroupsDeps,
  from: string,
  rawTo: string,
): { renamed: number; failed: Array<{ id: string; reason: string }> } {
  const check = validateGroupName(rawTo);
  if (!check.ok) throw new GroupsHttpError(400, `参数错误：${check.error}`);

  const rows = rowsOf(deps, from);
  const entries = entriesOf(deps, from);
  if (rows.length === 0 && entries.length === 0) throw new GroupsHttpError(404, `没有这个分组：${from}`);

  // 子项目跟着改名：agent → ai-agent 时 agent/looprun → ai-agent/looprun。改完不能超过两层
  const hasChildren = [...rows.map((row) => row.group ?? ""), ...entries].some(
    (name) => !sameGroup(name, from),
  );
  if (hasChildren && check.name.includes(GROUP_SEP)) {
    throw new GroupsHttpError(400, "参数错误：这个分组下面有子项目，不能再改成子项目（最多两层）");
  }
  if (isInGroup(check.name, from) && !sameGroup(check.name, from)) {
    throw new GroupsHttpError(400, "参数错误：不能把分组改成它自己的子项目");
  }

  const failed: Array<{ id: string; reason: string }> = [];
  let renamed = 0;

  for (const row of rows) {
    try {
      const target = replaceGroupPrefix(row.group ?? from, from, check.name);
      // 索引里的 hash 是上次索引时的：如果文件被外部改过，这里就会抛 ConflictError 并跳过
      deps.store.setGroup(row.path, target, { baseHash: row.hash ?? undefined });
      deps.reindex(row.path);
      renamed += 1;
    } catch (err) {
      failed.push({
        id: row.id,
        reason: err instanceof ConflictError ? "文件已被改动，请刷新后重试" : (err as Error).message,
      });
    }
  }

  // 还有笔记没改成功时，旧组名要留在 groups.json 里（否则那些笔记的组会「复活」成没有顺序的新组）
  for (const item of failed) {
    upsertGroup(deps.dataDir, normalizeGroupName(rows.find((row) => row.id === item.id)?.group ?? from));
  }
  // 父分组自己一定要有条目（没登记过也补上），子项目条目各自改名
  const names = new Set([normalizeGroupName(from), ...entries.map(normalizeGroupName)]);
  for (const name of names) renameGroupEntry(deps.dataDir, name, replaceGroupPrefix(name, from, check.name));
  // 子项目的默认模板（tpl-001）跟着改名：有笔记没改成功时也改，默认值属于「这个项目」，不属于某篇笔记
  renameGroupDefaults(deps.dataDir, from, check.name);
  return { renamed, failed };
}

export function deleteGroup(
  deps: GroupsDeps,
  name: string,
): { ungrouped: number; failed: Array<{ id: string; reason: string }> } {
  const rows = rowsOf(deps, name);
  const entries = entriesOf(deps, name);
  if (rows.length === 0 && entries.length === 0) throw new GroupsHttpError(404, `没有这个分组：${name}`);

  const failed: Array<{ id: string; reason: string }> = [];
  let ungrouped = 0;

  for (const row of rows) {
    try {
      deps.store.setGroup(row.path, null, { baseHash: row.hash ?? undefined });
      deps.reindex(row.path);
      ungrouped += 1;
    } catch (err) {
      failed.push({
        id: row.id,
        reason: err instanceof ConflictError ? "文件已被改动，请刷新后重试" : (err as Error).message,
      });
    }
  }

  // 只在整组（含子项目）都清空成功时才把分组条目删掉；有失败就让组留着，别让 UI 报「已删除」
  if (failed.length === 0) {
    removeGroupEntry(deps.dataDir, name);
    for (const entry of entries) removeGroupEntry(deps.dataDir, entry);
    removeGroupDefaults(deps.dataDir, name);
  }
  return { ungrouped, failed };
}
