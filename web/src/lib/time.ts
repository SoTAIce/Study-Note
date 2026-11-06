/** 时间显示与按天分组（界面用，不在单测范围）。 */

export function toDate(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 本地时区的 YYYY-MM-DD；解析失败则退化为原字符串前 10 位。 */
export function dayKey(iso: string): string {
  const d = toDate(iso);
  if (!d) return iso.slice(0, 10);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayKey(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function shiftKey(now: Date, days: number): string {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 今天 / 昨天 / 2026-10-28 */
export function dayLabel(iso: string, now = new Date()): string {
  const key = dayKey(iso);
  if (key === todayKey(now)) return "今天";
  if (key === shiftKey(now, -1)) return "昨天";
  return key;
}

/** HH:mm（本地时区） */
export function clockTime(iso: string): string {
  const d = toDate(iso);
  if (!d) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 刚刚 / 12 分钟前 / 3 小时前 / 昨天 / 2026-10-28 */
export function relativeTime(iso: string, now = new Date()): string {
  const d = toDate(iso);
  if (!d) return iso.slice(0, 10);
  const diff = now.getTime() - d.getTime();
  if (diff < 0) return clockTime(iso);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 2 * day) return "昨天";
  return dayKey(iso);
}

export type DayGroup<T> = { key: string; label: string; items: T[] };

/** 输入需已按 created 倒序；同一天合并成一组。 */
export function groupByDay<T extends { created: string }>(items: T[], now = new Date()): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const key = dayKey(item.created);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(item);
    } else {
      groups.push({ key, label: dayLabel(item.created, now), items: [item] });
    }
  }
  return groups;
}
