/** 知识简卡的显示文案（srs-001）：间隔、到期、熟练度 */
import type { Grade, Mastery } from "../review-api.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const GRADE_LABEL: Record<Grade, string> = { 1: "忘了", 2: "困难", 3: "记得", 4: "简单" };
export const MASTERY_LABEL: Record<Mastery, string> = { new: "新卡", learning: "学习中", mastered: "熟练" };

const trim = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ""));

/** 一段时长的说法：10 分钟 / 3 小时 / 2 天 / 1.5 个月 / 2 年 */
export function formatSpan(ms: number): string {
  const span = Math.max(0, ms);
  if (span < HOUR) return `${Math.max(1, Math.round(span / MIN))} 分钟`;
  if (span < DAY) return `${Math.round(span / HOUR)} 小时`;
  const days = Math.round(span / DAY);
  if (days < 30) return `${days} 天`;
  if (days < 365) return `${trim(Math.round((days / 30) * 10) / 10)} 个月`;
  return `${trim(Math.round((days / 365) * 10) / 10)} 年`;
}

/** 下次复习时间的说法（卡片墙上用） */
export function dueLabel(due: number | null, now: number): string {
  if (due === null) return "还没学";
  const end = new Date(now);
  end.setHours(24, 0, 0, 0);
  if (due <= now) return "该复习了";
  if (due < end.getTime()) return "今天";
  return `${formatSpan(due - now)}后`;
}
