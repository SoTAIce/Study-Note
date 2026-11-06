import type { DatabaseSync } from "node:sqlite";
import {
  mergeGroupList,
  readGroups,
  removeGroupEntry,
  renameGroupEntry,
  sameGroup,
  upsertGroup,
  validateGroupName,
  type MergedGroup,
} from "./groups.ts";
import { ConflictError, type NoteStore } from "./store.ts";

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

export type GroupCount = MergedGroup & { count: number };

type NoteGroupRow = { id: string; path: string; group: string | null; hash: string | null };

function noteRows(deps: GroupsDeps): NoteGroupRow[] {
  return deps.db
    .prepare("SELECT id, path, group_name AS \"group\", content_hash AS hash FROM notes")
    .all() as unknown as NoteGroupRow[];
}

function rowsOf(deps: GroupsDeps, name: string): NoteGroupRow[] {
  return noteRows(deps).filter((row) => sameGroup(row.group, name));
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
  const items = mergeGroupList(readGroups(deps.dataDir), names).map((group) => ({
    ...group,
    count: byKey.get(group.name.toLowerCase())?.count ?? 0,
  }));
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
  const known = readGroups(deps.dataDir).some((group) => sameGroup(group.name, from));
  if (rows.length === 0 && !known) throw new GroupsHttpError(404, `没有这个分组：${from}`);

  const failed: Array<{ id: string; reason: string }> = [];
  let renamed = 0;

  for (const row of rows) {
    try {
      // 索引里的 hash 是上次索引时的：如果文件被外部改过，这里就会抛 ConflictError 并跳过
      deps.store.setGroup(row.path, check.name, { baseHash: row.hash ?? undefined });
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
  if (failed.length > 0) upsertGroup(deps.dataDir, from);
  renameGroupEntry(deps.dataDir, from, check.name);
  return { renamed, failed };
}

export function deleteGroup(
  deps: GroupsDeps,
  name: string,
): { ungrouped: number; failed: Array<{ id: string; reason: string }> } {
  const rows = rowsOf(deps, name);
  const known = readGroups(deps.dataDir).some((group) => sameGroup(group.name, name));
  if (rows.length === 0 && !known) throw new GroupsHttpError(404, `没有这个分组：${name}`);

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

  // 只在整组都清空成功时才把分组条目删掉；有失败就让组留着，别让 UI 报「已删除」
  if (failed.length === 0) removeGroupEntry(deps.dataDir, name);
  return { ungrouped, failed };
}
