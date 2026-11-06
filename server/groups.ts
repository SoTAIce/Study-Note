import fs from "node:fs";
import path from "node:path";

/** 分组名上限（字符数，按中文也算 1 个）。 */
export const MAX_GROUP_NAME = 40;

/** 仅用于界面展示的「未分组」标签，不是真实的组名。 */
export const UNGROUPED_LABEL = "未分组";

/** 组名里不允许出现的字符（跨平台文件名保留字符 + 分隔符）。 */
const BAD_CHARS = /[/\\:*?"<>|]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type GroupEntry = { name: string; order: number };
export type MergedGroup = { name: string; order: number; empty: boolean };

/** 去首尾空白，内部连续空白（含全角空格）压成一个半角空格。 */
export function normalizeGroupName(raw: string): string {
  return raw.replace(/[\s\u3000]+/g, " ").trim();
}

export function validateGroupName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = normalizeGroupName(raw);
  if (!name) return { ok: false, error: "分组名不能为空" };
  if (name === UNGROUPED_LABEL) return { ok: false, error: `「${UNGROUPED_LABEL}」是保留名字，换一个吧` };
  // `?group=none` 是「只看未分组」的哨兵，叫 none 的组永远筛不出来，所以禁掉
  if (name.toLowerCase() === "none") return { ok: false, error: "「none」是保留名字（表示未分组），换一个吧" };
  if ([...name].length > MAX_GROUP_NAME) {
    return { ok: false, error: `分组名太长，最多 ${MAX_GROUP_NAME} 个字` };
  }
  if (BAD_CHARS.test(name)) return { ok: false, error: '分组名里不能有 / \\ : * ? " < > | 这些字符' };
  if (CONTROL_CHARS.test(name)) return { ok: false, error: "分组名里有不可见控制字符" };
  return { ok: true, name };
}

/** 两个组名是否指同一个组：不区分大小写，空值/空串都算「未分组」。 */
export function sameGroup(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeGroupName(a ?? "");
  const right = normalizeGroupName(b ?? "");
  if (!left || !right) return left === right;
  return left.toLowerCase() === right.toLowerCase();
}

function groupsFile(dataDir: string): string {
  return path.join(dataDir, "groups.json");
}

function isEntry(value: unknown): value is GroupEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.name === "string" && typeof entry.order === "number" && Number.isFinite(entry.order);
}

/** 读 groups.json：缺失、坏 JSON、形状不对一律当成空列表，笔记库不能被一个坏文件卡住。 */
export function readGroups(dataDir: string): GroupEntry[] {
  try {
    const raw = fs.readFileSync(groupsFile(dataDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return [];
    const groups = (parsed as Record<string, unknown>).groups;
    if (!Array.isArray(groups)) return [];
    return groups.filter(isEntry).map((entry) => ({ name: entry.name, order: entry.order }));
  } catch {
    return [];
  }
}

export function writeGroups(dataDir: string, list: GroupEntry[]): void {
  const ordered = [...list].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(groupsFile(dataDir), `${JSON.stringify({ version: 1, groups: ordered }, null, 2)}\n`, "utf8");
}

function nextOrder(list: GroupEntry[]): number {
  return list.reduce((max, entry) => Math.max(max, entry.order), 0) + 1;
}

/** 建组：已存在（不区分大小写）则原样返回，不重复造。 */
export function upsertGroup(dataDir: string, rawName: string): { entry: GroupEntry; created: boolean } {
  const list = readGroups(dataDir);
  const existing = list.find((entry) => sameGroup(entry.name, rawName));
  if (existing) return { entry: existing, created: false };

  const name = normalizeGroupName(rawName);
  const entry: GroupEntry = { name, order: nextOrder(list) };
  writeGroups(dataDir, [...list, entry]);
  return { entry, created: true };
}

/**
 * 改名（或撞名时合并）。
 * 合并时保留目标条目的顺序，但拼写统一成 `to`——因为笔记里也已经写成 `to` 了，
 * 两处不一致会让侧栏显示的名字和文件里对不上。
 */
export function renameGroupEntry(dataDir: string, from: string, to: string): void {
  const list = readGroups(dataDir);
  const name = normalizeGroupName(to);
  const source = list.find((entry) => sameGroup(entry.name, from));
  const target = list.find((entry) => entry !== source && sameGroup(entry.name, to));

  if (source && target) {
    writeGroups(
      dataDir,
      list.filter((entry) => entry !== source).map((entry) => (entry === target ? { ...entry, name } : entry)),
    );
    return;
  }

  if (source) {
    writeGroups(
      dataDir,
      list.map((entry) => (entry === source ? { ...entry, name } : entry)),
    );
    return;
  }

  // 源只存在于笔记里（groups.json 没有它）：把目标名补登进去
  if (!target) writeGroups(dataDir, [...list, { name, order: nextOrder(list) }]);
}

export function removeGroupEntry(dataDir: string, name: string): void {
  const list = readGroups(dataDir);
  const kept = list.filter((entry) => !sameGroup(entry.name, name));
  if (kept.length !== list.length) writeGroups(dataDir, kept);
}

/**
 * 有效分组列表 = groups.json 的顺序 ∪ 笔记里实际出现的组名。
 * json 丢了或者笔记被外部加了新组，都不会出现「幽灵组」或丢组。
 */
export function mergeGroupList(stored: GroupEntry[], namesInNotes: string[]): MergedGroup[] {
  const used = new Set<string>();
  const out: MergedGroup[] = [];

  for (const entry of [...stored].sort((a, b) => a.order - b.order)) {
    const key = normalizeGroupName(entry.name).toLowerCase();
    if (used.has(key)) continue;
    used.add(key);
    out.push({ name: entry.name, order: entry.order, empty: true });
  }

  for (const rawName of namesInNotes) {
    const name = normalizeGroupName(rawName);
    if (!name) continue;
    const key = name.toLowerCase();
    const hit = out.find((group) => group.name.toLowerCase() === key);
    if (hit) {
      hit.empty = false;
      continue;
    }
    used.add(key);
    out.push({ name, order: out.length + 1, empty: false });
  }

  return out;
}
