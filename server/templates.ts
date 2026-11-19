/**
 * 笔记模板（tpl-001）：data/templates.json 的读写、子项目默认模板、模板改名连带改笔记。
 * 校验、骨架、提示词这些纯函数在 web/src/lib/templates.ts，前后端共用。
 *
 * 模板只决定新建时预填什么；笔记照旧是普通 Markdown，删掉 templates.json 笔记一个字都不受影响。
 */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  BUILTIN_TEMPLATES,
  findTemplate,
  sameTemplate,
  validateTemplateList,
  validateTemplateName,
  type NoteTemplate,
} from "../web/src/lib/templates.ts";
import { isInGroup, replaceGroupPrefix, sameGroup, validateGroupName } from "./groups.ts";
import { ConflictError, type NoteStore } from "./store.ts";

export class TemplatesHttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** version：每写一次加一；文件不存在时是 0（用内置模板，第一次修改才写盘） */
export type TemplatesState = {
  version: number;
  templates: NoteTemplate[];
  groupDefaults: Record<string, string>;
};

export const TEMPLATES_FILE = "templates.json";

export function templatesPath(dataDir: string): string {
  return path.join(dataDir, TEMPLATES_FILE);
}

function builtinState(): TemplatesState {
  return { version: 0, templates: structuredClone(BUILTIN_TEMPLATES), groupDefaults: {} };
}

/** 只留指向现有模板的默认值；键规整成组名的标准写法、值规整成模板的现名 */
function cleanDefaults(raw: unknown, templates: NoteTemplate[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [group, name] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof name !== "string") continue;
    const check = validateGroupName(group);
    const template = findTemplate(templates, name);
    if (!check.ok || !template) continue;
    const key = Object.keys(out).find((existing) => sameGroup(existing, check.name)) ?? check.name;
    out[key] = template.name;
  }
  return out;
}

/**
 * 读 templates.json。文件不存在 → 内置两种。
 * 坏 JSON 或形状不对时抛错（不能悄悄当成内置的：用户一保存就会把手改坏的文件整个覆盖掉）。
 */
export function readTemplates(dataDir: string): TemplatesState {
  let raw: string;
  try {
    raw = fs.readFileSync(templatesPath(dataDir), "utf8");
  } catch {
    return builtinState();
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, "")) as Record<string, unknown>;
  } catch {
    throw new TemplatesHttpError(500, `${TEMPLATES_FILE} 不是合法的 JSON，先手动修好或删掉它（删掉会恢复内置的两种模板）`);
  }
  const check = validateTemplateList(parsed?.templates);
  if (!check.ok) throw new TemplatesHttpError(500, `${TEMPLATES_FILE} 内容不对：${check.error}`);
  const version = typeof parsed.version === "number" && Number.isInteger(parsed.version) ? parsed.version : 1;
  return { version, templates: check.templates, groupDefaults: cleanDefaults(parsed.groupDefaults, check.templates) };
}

/** 写盘（原子：先写临时文件再改名），version 加一 */
function writeTemplates(dataDir: string, state: Omit<TemplatesState, "version">, previous: number): TemplatesState {
  const next: TemplatesState = { version: previous + 1, templates: state.templates, groupDefaults: state.groupDefaults };
  fs.mkdirSync(dataDir, { recursive: true });
  const file = templatesPath(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return next;
}

/** 某个组的默认模板（只认这个组自己的，不往父分组找） */
export function defaultTemplateFor(state: TemplatesState, group: string | null | undefined): NoteTemplate | null {
  if (!group) return null;
  const key = Object.keys(state.groupDefaults).find((name) => sameGroup(name, group));
  return key ? (findTemplate(state.templates, state.groupDefaults[key]) ?? null) : null;
}

/**
 * 新建笔记 / 章节时用哪个模板：
 * - 请求里 `template` 是字符串：用它（必须是现有模板）；
 * - 显式 null 或空串：不用模板；
 * - 没传：所在组有默认模板就自动套用。
 */
export function resolveNewNoteTemplate(dataDir: string, group: string | null, requested: unknown): NoteTemplate | null {
  if (requested === null || requested === "") return null;
  const state = readTemplates(dataDir);
  if (requested === undefined) return defaultTemplateFor(state, group);
  if (typeof requested !== "string") throw new TemplatesHttpError(400, "参数错误：template 必须是字符串");
  const template = findTemplate(state.templates, requested);
  if (!template) throw new TemplatesHttpError(400, `参数错误：没有叫「${requested.trim()}」的模板`);
  return template;
}

/** 分组改名时子项目默认值跟着改（agent → ai-agent 时 agent/looprun 的也改） */
export function renameGroupDefaults(dataDir: string, from: string, to: string): void {
  if (!fs.existsSync(templatesPath(dataDir))) return;
  const state = readTemplatesQuiet(dataDir);
  if (!state) return;
  let changed = false;
  const next: Record<string, string> = {};
  for (const [group, template] of Object.entries(state.groupDefaults)) {
    if (isInGroup(group, from)) {
      next[replaceGroupPrefix(group, from, to)] = template;
      changed = true;
    } else if (!Object.keys(next).some((name) => sameGroup(name, group))) {
      next[group] = template;
    }
  }
  if (changed) writeTemplates(dataDir, { templates: state.templates, groupDefaults: next }, state.version);
}

/** 分组删除时清掉它和子项目的默认值 */
export function removeGroupDefaults(dataDir: string, name: string): void {
  if (!fs.existsSync(templatesPath(dataDir))) return;
  const state = readTemplatesQuiet(dataDir);
  if (!state) return;
  const kept = Object.fromEntries(Object.entries(state.groupDefaults).filter(([group]) => !isInGroup(group, name)));
  if (Object.keys(kept).length !== Object.keys(state.groupDefaults).length) {
    writeTemplates(dataDir, { templates: state.templates, groupDefaults: kept }, state.version);
  }
}

/** 分组改名 / 删除连带时用：templates.json 坏了就跳过，不能让分组操作因此失败 */
function readTemplatesQuiet(dataDir: string): TemplatesState | null {
  try {
    return readTemplates(dataDir);
  } catch {
    return null;
  }
}

export type TemplatesDeps = {
  db: DatabaseSync;
  store: NoteStore;
  dataDir: string;
  reindex: (relPath: string) => void;
};

type TemplateRow = { id: string; path: string; template: string | null; hash: string | null };

/** 每个模板名（按小写）有几篇笔记在用：模板面板显示、改名时问「要一起改吗」 */
function usage(db: DatabaseSync): Record<string, number> {
  const rows = db
    .prepare("SELECT template FROM notes WHERE template IS NOT NULL AND template != ''")
    .all() as Array<{ template: string }>;
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = row.template.trim().toLowerCase();
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export function createTemplatesRoutes(deps: TemplatesDeps) {
  const { db, store, dataDir } = deps;

  function view(state: TemplatesState) {
    return { ...state, usage: usage(db) };
  }

  function checkVersion(payload: Record<string, unknown>, state: TemplatesState): void {
    if (payload.version !== state.version) {
      throw new TemplatesHttpError(409, "模板刚在别处改过，已载入最新的，请再改一次", { current: view(state) });
    }
  }

  function save(payload: Record<string, unknown>) {
    const state = readTemplates(dataDir);
    checkVersion(payload, state);
    const check = validateTemplateList(payload.templates);
    if (!check.ok) throw new TemplatesHttpError(400, `参数错误：${check.error}`);
    if (check.templates.length === 0) throw new TemplatesHttpError(400, "参数错误：至少留一个模板");
    // 没传 groupDefaults 就沿用原来的；删掉的模板对应的默认值一并清掉
    const groupDefaults = cleanDefaults(payload.groupDefaults ?? state.groupDefaults, check.templates);
    return view(writeTemplates(dataDir, { templates: check.templates, groupDefaults }, state.version));
  }

  function rename(payload: Record<string, unknown>) {
    const state = readTemplates(dataDir);
    checkVersion(payload, state);
    const from = typeof payload.from === "string" ? payload.from : "";
    const source = findTemplate(state.templates, from);
    if (!source) throw new TemplatesHttpError(404, `没有这个模板：${from}`);
    const to = validateTemplateName(payload.to);
    if (!to.ok) throw new TemplatesHttpError(400, `参数错误：${to.error}`);
    const clash = state.templates.find((item) => item !== source && sameTemplate(item.name, to.name));
    if (clash) throw new TemplatesHttpError(400, `参数错误：已经有叫「${clash.name}」的模板了`);

    const oldName = source.name;
    const templates = state.templates.map((item) => (item === source ? { ...item, name: to.name } : item));
    const groupDefaults = Object.fromEntries(
      Object.entries(state.groupDefaults).map(([group, name]) => [group, sameTemplate(name, oldName) ? to.name : name]),
    );
    const saved = writeTemplates(dataDir, { templates, groupDefaults }, state.version);

    let renamed = 0;
    const failed: Array<{ id: string; reason: string }> = [];
    if (payload.updateNotes === true) {
      const rows = db
        .prepare("SELECT id, path, template, content_hash AS hash FROM notes WHERE template IS NOT NULL")
        .all() as unknown as TemplateRow[];
      for (const row of rows.filter((item) => sameTemplate(item.template, oldName))) {
        try {
          // 只改文件头 template: 一行；索引里的 hash 对不上（被外部改过）就跳过，不覆盖
          store.setTemplate(row.path, to.name, { baseHash: row.hash ?? undefined });
          deps.reindex(row.path);
          renamed += 1;
        } catch (err) {
          failed.push({
            id: row.id,
            reason: err instanceof ConflictError ? "文件已被改动，请刷新后重试" : (err as Error).message,
          });
        }
      }
    }
    return { ...view(saved), renamed, failed };
  }

  function setDefault(payload: Record<string, unknown>) {
    const state = readTemplates(dataDir);
    const group = validateGroupName(typeof payload.group === "string" ? payload.group : "");
    if (!group.ok) throw new TemplatesHttpError(400, `参数错误：${group.error}`);
    // 已经设过的组沿用原来的拼写（组名不区分大小写）
    const existing = Object.keys(state.groupDefaults).find((name) => sameGroup(name, group.name));
    const groupDefaults = Object.fromEntries(Object.entries(state.groupDefaults).filter(([name]) => name !== existing));
    if (payload.template !== null && payload.template !== "") {
      const template = typeof payload.template === "string" ? findTemplate(state.templates, payload.template) : undefined;
      if (!template) throw new TemplatesHttpError(400, `参数错误：没有叫「${String(payload.template)}」的模板`);
      groupDefaults[existing ?? group.name] = template.name;
    }
    return view(writeTemplates(dataDir, { templates: state.templates, groupDefaults }, state.version));
  }

  return async function handle(
    method: string,
    route: string[],
    body: () => Promise<Record<string, unknown>>,
  ): Promise<unknown | undefined> {
    if (route[0] !== "templates") return undefined;
    if (route.length === 1 && method === "GET") return view(readTemplates(dataDir));
    if (route.length === 1 && method === "PUT") return save(await body());
    if (route.length === 2 && route[1] === "rename" && method === "POST") return rename(await body());
    if (route.length === 2 && route[1] === "default" && method === "PUT") return setDefault(await body());
    return undefined;
  };
}
