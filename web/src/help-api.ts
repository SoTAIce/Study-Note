import { request } from "./api.ts";
import type { ManualChapter } from "./lib/help.ts";

/** 使用手册（help-001）：章节 + 练习笔记装了几篇、是哪一版 */
export type ManualState = {
  version: string;
  chapters: ManualChapter[];
  installed: { count: number; version: string | null };
};

export function getManual(): Promise<ManualState> {
  return request("/help/manual");
}

export function installManual(): Promise<ManualState & { indexId: string; group: string }> {
  return request("/help/manual/install", { method: "POST", body: "{}" });
}

export function reinstallManual(): Promise<ManualState & { indexId: string; group: string; trashed: number; trashedIds: string[] }> {
  return request("/help/manual/reinstall", { method: "POST", body: "{}" });
}

export function deleteManual(): Promise<ManualState & { trashed: number; trashedIds: string[] }> {
  return request("/help/manual", { method: "DELETE", body: "{}" });
}
