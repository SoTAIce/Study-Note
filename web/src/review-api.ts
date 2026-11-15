import { jsonBody, request } from "./api.ts";

/** 知识简卡（srs-001），字段与 server/review-api.ts 对齐 */
export type Mastery = "new" | "learning" | "mastered";
export type Grade = 1 | 2 | 3 | 4;

export type KCard = {
  id: string;
  noteId: string;
  notePath: string;
  noteTitle: string;
  group: string | null;
  kind: "callout" | "line";
  title: string;
  body: string;
  line: number;
  mastery: Mastery;
  due: number | null;
  stability: number | null;
  reps: number;
  lapses: number;
};

export type QueueCard = KCard & { next: Record<Grade, number> };

export type CardFilters = { group?: string; tag?: string; note?: string; q?: string };
export type CardSort = "recent" | "due" | "weak";
export type ReviewCounts = { total: number; due: number; fresh: number; tomorrow: number };

function query(filters: CardFilters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...filters, ...extra })) if (v) params.set(k, v);
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function listCards(filters: CardFilters, sort: CardSort): Promise<{ items: KCard[] } & ReviewCounts> {
  return request(`/cards${query(filters, { sort })}`);
}

export function reviewQueue(filters: CardFilters): Promise<{ items: QueueCard[]; due: number; fresh: number; total: number; newPerDay: number }> {
  return request(`/review/queue${query(filters)}`);
}

export function reviewSummary(): Promise<ReviewCounts> {
  return request("/review/summary");
}

export function gradeCard(card: string, grade: Grade): Promise<{ ok: true; due: number; mastery: Mastery }> {
  return request("/review/grade", { method: "POST", body: jsonBody({ card, grade }) });
}

export function undoGrade(card: string): Promise<{ ok: boolean }> {
  return request("/review/undo", { method: "POST", body: jsonBody({ card }) });
}

export function getReviewSettings(): Promise<{ newPerDay: number }> {
  return request("/review/settings");
}

export function saveReviewSettings(newPerDay: number): Promise<{ newPerDay: number }> {
  return request("/review/settings", { method: "PUT", body: jsonBody({ newPerDay }) });
}
