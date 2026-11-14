/** 回收站（trash-001）：条目还剩几天会被自动清理 */

const DAY = 24 * 60 * 60 * 1000;

/** 还剩几天（向上取整，最少 0）；deletedAt 读不懂返回 null */
export function daysLeft(deletedAt: string, retentionDays: number, now = new Date()): number | null {
  const at = Date.parse(deletedAt);
  if (!Number.isFinite(at)) return null;
  const left = at + retentionDays * DAY - now.getTime();
  return Math.max(0, Math.ceil(left / DAY));
}

/** 「12 天后自动清理」/「即将自动清理」；读不懂时间时不显示 */
export function purgeLabel(deletedAt: string, retentionDays: number, now = new Date()): string | null {
  const left = daysLeft(deletedAt, retentionDays, now);
  if (left === null) return null;
  return left === 0 ? "即将自动清理" : `${left} 天后自动清理`;
}
