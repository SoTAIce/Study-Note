import { jsonBody, request } from "./api.ts";

export type GroupView = { name: string; count: number; empty: boolean };

export type GroupsOverview = { items: GroupView[]; ungrouped: number };

export type MoveFailure = { id: string; reason: string };

export function listGroups(): Promise<GroupsOverview> {
  return request("/groups");
}

export function createGroup(name: string): Promise<{ name: string; created: boolean }> {
  return request("/groups", { method: "POST", body: jsonBody({ name }) });
}

export function renameGroup(
  name: string,
  next: string,
): Promise<{ renamed: number; failed: MoveFailure[] }> {
  return request(`/groups/${encodeURIComponent(name)}`, { method: "PATCH", body: jsonBody({ name: next }) });
}

export function deleteGroup(name: string): Promise<{ ungrouped: number; failed: MoveFailure[] }> {
  return request(`/groups/${encodeURIComponent(name)}`, { method: "DELETE" });
}

/** 把一篇笔记移到某个组；group 传 null 表示移出分组。 */
export function moveNote(
  id: string,
  group: string | null,
  baseHash?: string,
): Promise<{ ok: boolean; group: string | null; hash: string }> {
  return request(`/notes/${encodeURIComponent(id)}/move`, {
    method: "POST",
    body: jsonBody({ group, ...(baseHash ? { baseHash } : {}) }),
  });
}

export function moveNotes(
  ids: string[],
  group: string | null,
): Promise<{ moved: string[]; failed: MoveFailure[] }> {
  return request("/notes/move", { method: "POST", body: jsonBody({ ids, group }) });
}
