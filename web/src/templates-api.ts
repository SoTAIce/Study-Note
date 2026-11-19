import { jsonBody, request } from "./api.ts";
import type { NoteTemplate } from "./lib/templates.ts";

/** 笔记模板（tpl-001）。usage：每个模板名（小写）有几篇笔记在用 */
export type TemplatesState = {
  version: number;
  templates: NoteTemplate[];
  groupDefaults: Record<string, string>;
  usage: Record<string, number>;
};

export function getTemplates(): Promise<TemplatesState> {
  return request("/templates");
}

/** 整体保存；version 对不上时 409，错误里带 current（最新的） */
export function saveTemplates(input: {
  version: number;
  templates: NoteTemplate[];
  groupDefaults?: Record<string, string>;
}): Promise<TemplatesState> {
  return request("/templates", { method: "PUT", body: jsonBody(input) });
}

export function renameTemplate(input: {
  version: number;
  from: string;
  to: string;
  updateNotes: boolean;
}): Promise<TemplatesState & { renamed: number; failed: Array<{ id: string; reason: string }> }> {
  return request("/templates/rename", { method: "POST", body: jsonBody(input) });
}

/** 设或清（template: null）某个分组 / 子项目的默认模板 */
export function setGroupDefault(group: string, template: string | null): Promise<TemplatesState> {
  return request("/templates/default", { method: "PUT", body: jsonBody({ group, template }) });
}
