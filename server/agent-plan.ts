import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NoteStore } from "./store.ts";
import { validateGroupName } from "./groups.ts";

export type Op =
  | { kind: "create"; path?: string; title: string; body: string; tags?: string[]; type?: "note" | "idea" | "source"; group?: string }
  | { kind: "append"; path: string; text: string; group?: string }
  | { kind: "rewrite"; path: string; body: string; group?: string }
  | { kind: "trash"; path: string };

export type NormalizedOp = {
  index: number;
  kind: Op["kind"];
  path: string;
  title: string;
  /** 计划生成时的磁盘状态，执行时用来判断"期间有没有被别人改过" */
  before: { exists: boolean; raw: string; hash: string };
  after: string;
  add: number;
  del: number;
  tags?: string[];
  type?: "note" | "idea" | "source";
  /** 计划里指定的分组；缺省表示不动这一项 */
  group?: string;
  /** 只改分组、正文不动（执行时走 setGroup，不顶 updated、不写历史） */
  groupOnly?: boolean;
};

export type NormalizedPlan = { id: string; summary: string; ops: NormalizedOp[]; createdAt: string };

export class PlanError extends Error {
  readonly code: "BAD_OP" | "BAD_PATH" | "MISSING_FILE" | "CONFLICT" | "TOO_MANY";

  constructor(code: PlanError["code"], message: string) {
    super(message);
    this.name = "PlanError";
    this.code = code;
  }
}

const MAX_OPS = 20;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 笔记库内的相对路径校验。故意允许中文、空格、#、%、括号——用户的文件名本来就这样。
 * 拒绝：绝对路径、盘符、`..`、前导点目录、控制字符、Windows 保留名、非 .md。
 */
export function isSafeNotePath(rel: string): boolean {
  if (typeof rel !== "string" || !rel.trim()) return false;
  if (rel.includes("\0")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(rel)) return false;
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return false;
  const normalized = rel.split("\\").join("/");
  if (!normalized.toLowerCase().endsWith(".md")) return false;
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return false;
  for (const segment of segments) {
    if (segment === "." || segment === "..") return false;
    if (segment.startsWith(".")) return false;
    // Windows 上 `a:b.md` 会被当成 NTFS 备用数据流（ADS）：写入报错还会留下空壳文件
    if (/[:*?"<>|]/.test(segment)) return false;
    const base = segment.replace(/\.md$/i, "");
    if (WINDOWS_RESERVED.test(base)) return false;
  }
  return true;
}

function normalizeRelPath(rel: string): string {
  return rel.split("\\").join("/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}

function slug(title: string): string {
  return (
    title
      .trim()
      .replace(/[\\/:*?"<>|#%]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "未命名"
  );
}

function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 多集合差：added/removed 的行数。够用且不会像 LCS 那样在长文上炸时间。 */
function diffStat(before: string, after: string): { add: number; del: number } {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const counts = new Map<string, number>();
  for (const line of beforeLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let add = 0;
  for (const line of afterLines) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else add += 1;
  }
  let del = 0;
  for (const left of counts.values()) del += left;
  return { add, del };
}

function readNote(store: NoteStore, rel: string): { raw: string; hash: string; body: string; group: string } {
  let note;
  try {
    note = store.read(rel);
  } catch {
    throw new PlanError("MISSING_FILE", `笔记不存在：${rel}`);
  }
  const parsed = note.parsed as { body?: string; meta?: { group?: string } };
  return { raw: note.raw, hash: note.hash, body: parsed.body ?? "", group: parsed.meta?.group ?? "" };
}

/** 计划里的 group：缺省就不动，给了就必须合法（否则方案阶段就拒掉）。 */
function readGroup(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") throw new PlanError("BAD_OP", "group 必须是字符串");
  const check = validateGroupName(raw);
  if (!check.ok) throw new PlanError("BAD_OP", `分组名不合法：${check.error}`);
  return check.name;
}
export function normalizePlan(
  raw: unknown,
  deps: { store: NoteStore; notesRoot: string; now?: () => Date },
): NormalizedPlan {
  const now = deps.now ?? (() => new Date());
  const input = (raw ?? {}) as { summary?: unknown; ops?: unknown };
  const summary = typeof input.summary === "string" && input.summary.trim() ? input.summary.trim() : "（无说明）";

  if (!Array.isArray(input.ops)) throw new PlanError("BAD_OP", "ops 必须是数组");
  if (input.ops.length > MAX_OPS) throw new PlanError("TOO_MANY", `一次最多 ${MAX_OPS} 个动作，收到 ${input.ops.length}`);
  if (input.ops.length === 0) throw new PlanError("BAD_OP", "计划里没有任何动作");

  const ops: NormalizedOp[] = [];
  const seenPaths = new Set<string>();

  for (const item of input.ops) {
    const op = (item ?? {}) as Record<string, unknown>;
    const kind = op.kind;
    if (kind !== "create" && kind !== "append" && kind !== "rewrite" && kind !== "trash") {
      throw new PlanError("BAD_OP", `不认识的动作类型：${String(kind)}`);
    }

    if (kind === "create") {
      const title = typeof op.title === "string" && op.title.trim() ? op.title.trim() : "";
      if (!title) throw new PlanError("BAD_OP", "create 缺少标题");
      const body = typeof op.body === "string" ? op.body : "";
      const rel = typeof op.path === "string" && op.path.trim()
        ? normalizeRelPath(op.path.trim())
        : `${localDate(now())}-${slug(title)}.md`;
      if (!isSafeNotePath(rel)) throw new PlanError("BAD_PATH", `路径不合法：${rel}`);
      if (seenPaths.has(rel)) throw new PlanError("CONFLICT", `同一个计划里重复创建：${rel}`);
      if (fs.existsSync(deps.store.absPath(rel))) throw new PlanError("CONFLICT", `文件已存在：${rel}`);
      seenPaths.add(rel);
      const tags = Array.isArray(op.tags) ? op.tags.map(String) : undefined;
      const type = op.type === "idea" || op.type === "source" || op.type === "note" ? op.type : undefined;
      const group = readGroup(op.group);
      ops.push({
        index: 0,
        kind,
        path: rel,
        title,
        before: { exists: false, raw: "", hash: "" },
        after: body,
        ...diffStat("", body),
        ...(tags ? { tags } : {}),
        ...(type ? { type } : {}),
        ...(group ? { group } : {}),
      });
      continue;
    }

    const relRaw = typeof op.path === "string" ? normalizeRelPath(op.path.trim()) : "";
    if (!relRaw) throw new PlanError("BAD_OP", `${kind} 缺少 path`);
    if (!isSafeNotePath(relRaw)) throw new PlanError("BAD_PATH", `路径不合法：${relRaw}`);
    const current = readNote(deps.store, relRaw);

    if (kind === "trash") {
      ops.push({
        index: 0,
        kind,
        path: relRaw,
        title: path.posix.basename(relRaw, ".md"),
        before: { exists: true, raw: current.raw, hash: current.hash },
        after: "",
        add: 0,
        del: current.body.split(/\r?\n/).length,
      });
      continue;
    }

    const group = readGroup(op.group);

    if (kind === "append") {
      const text = typeof op.text === "string" ? op.text : "";
      if (!text.trim()) continue; // 空追加 = 空操作，剔除
      const after = current.body.trimEnd() ? `${current.body.trimEnd()}\n\n${text}` : text;
      const stat = diffStat(current.body, after);
      ops.push({
        index: 0,
        kind,
        path: relRaw,
        title: path.posix.basename(relRaw, ".md"),
        before: { exists: true, raw: current.raw, hash: current.hash },
        after,
        ...stat,
        ...(group ? { group } : {}),
      });
      continue;
    }

    // rewrite
    const body = typeof op.body === "string" ? op.body : "";
    if (!body.trim()) throw new PlanError("BAD_OP", `rewrite 的正文为空：${relRaw}`);
    if (body.trim() === current.body.trim()) {
      // 正文没变但要改组：仍然是一条有效动作，交给 setGroup（整理不算编辑）
      const currentGroup = current.group;
      const groupChanged = (group ?? "").trim().toLowerCase() !== currentGroup.trim().toLowerCase();
      if (group && groupChanged) {
        ops.push({
          index: 0,
          kind,
          path: relRaw,
          title: path.posix.basename(relRaw, ".md"),
          before: { exists: true, raw: current.raw, hash: current.hash },
          after: current.body,
          add: 0,
          del: 0,
          group,
          groupOnly: true,
        });
      }
      continue; // 正文与原文相同 = 空操作
    }
    ops.push({
      index: 0,
      kind,
      path: relRaw,
      title: path.posix.basename(relRaw, ".md"),
      before: { exists: true, raw: current.raw, hash: current.hash },
      after: body,
      ...diffStat(current.body, body),
      ...(group ? { group } : {}),
    });
  }

  if (ops.length === 0) throw new PlanError("BAD_OP", "计划里没有实际改动（动作都被判定为空操作）");

  return {
    id: `p_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
    summary,
    ops: ops.map((op, index) => ({ ...op, index })),
    createdAt: now().toISOString(),
  };
}
