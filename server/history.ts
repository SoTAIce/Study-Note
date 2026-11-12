/**
 * 笔记历史版本：命名、解析与保留策略。
 *
 * 文件：data/.history/<笔记id>/<拍摄时间>-<序号>-<4位随机>.<来源>.md，内容是当时的整篇原文。
 * 旧格式（没有 .<来源>，时间戳是 17 位数字）照样能读，来源当作 edit。
 * 设计见 docs/superpowers/specs/2026-11-12-note-history-design.md。
 */

export type HistoryReason = "edit" | "ai" | "restore" | "backup-restore" | "agent";

export const HISTORY_REASONS: readonly HistoryReason[] = ["edit", "ai", "restore", "backup-restore", "agent"];

/** 平时自动保存：距上一份快照超过这个间隔才再存一份。 */
export const COALESCE_MS = 10 * 60 * 1000;
export const MAX_VERSIONS = 200;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** 这些来源的版本是「撤销恢复」的依据，7 天内不参与稀疏。 */
const PROTECTED: ReadonlySet<HistoryReason> = new Set(["restore", "backup-restore", "agent"]);

/** 版本 ID = 文件名去掉 .md。新旧两种格式都接受；挡住 ../ 之类。 */
const VERSION_ID_RE = /^(\d{8}T\d{6}|\d{14,17})-(\d{3,})-([0-9a-f]{4})(?:\.([a-z-]+))?$/;
const NOTE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidVersionId(versionId: string): boolean {
  if (!VERSION_ID_RE.test(versionId)) return false;
  const reason = VERSION_ID_RE.exec(versionId)?.[4];
  return reason === undefined || (HISTORY_REASONS as readonly string[]).includes(reason);
}

export function isValidNoteId(noteId: string): boolean {
  return NOTE_ID_RE.test(noteId);
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

function localStamp(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export function makeVersionId(takenAt: Date, seq: number, rand4: string, reason: HistoryReason): string {
  return `${localStamp(takenAt)}-${pad(seq, 3)}-${rand4}.${reason}`;
}

export type ParsedVersionId = { versionId: string; takenAt: number; reason: HistoryReason };

/** 从文件名解析拍摄时间（本地时间）与来源；不认识的返回 null。 */
export function parseVersionId(versionId: string): ParsedVersionId | null {
  const m = VERSION_ID_RE.exec(versionId);
  if (!m) return null;
  const digits = m[1].replace("T", "");
  const takenAt = new Date(
    Number(digits.slice(0, 4)),
    Number(digits.slice(4, 6)) - 1,
    Number(digits.slice(6, 8)),
    Number(digits.slice(8, 10)),
    Number(digits.slice(10, 12)),
    Number(digits.slice(12, 14)),
  ).getTime();
  if (Number.isNaN(takenAt)) return null;
  const reason = (m[4] ?? "edit") as HistoryReason;
  if (!HISTORY_REASONS.includes(reason)) return null;
  return { versionId, takenAt, reason };
}

/** 版本按拍摄时间倒序（同一秒内按序号倒序）。 */
export function compareNewestFirst(a: ParsedVersionId, b: ParsedVersionId): number {
  if (a.takenAt !== b.takenAt) return b.takenAt - a.takenAt;
  return b.versionId.localeCompare(a.versionId);
}

function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * 分层稀疏：返回要删除的版本 ID。
 * - 24 小时内全留；受保护来源 7 天内全留
 * - 7 天内每小时留最新一份；90 天内每天一份；更早每周一份
 * - 兜底：最多 MAX_VERSIONS 份、总大小 MAX_TOTAL_BYTES，超出从最旧的删
 */
export function planPrune(
  versions: Array<ParsedVersionId & { bytes: number }>,
  now: number,
  limits: { maxVersions?: number; maxBytes?: number } = {},
): string[] {
  const maxVersions = limits.maxVersions ?? MAX_VERSIONS;
  const maxBytes = limits.maxBytes ?? MAX_TOTAL_BYTES;
  const sorted = [...versions].sort(compareNewestFirst);
  const seen = new Set<string>();
  const kept: typeof sorted = [];
  const drop: string[] = [];

  for (const v of sorted) {
    const age = now - v.takenAt;
    if (age < DAY || (PROTECTED.has(v.reason) && age < 7 * DAY)) {
      kept.push(v);
      continue;
    }
    const bucket =
      age < 7 * DAY
        ? `h:${Math.floor(v.takenAt / HOUR)}`
        : age < 90 * DAY
          ? `d:${localDayKey(v.takenAt)}`
          : `w:${Math.floor(v.takenAt / (7 * DAY))}`;
    if (seen.has(bucket)) {
      drop.push(v.versionId);
    } else {
      seen.add(bucket);
      kept.push(v);
    }
  }

  // 兜底上限：kept 已是新→旧，从尾部（最旧）开始砍
  let total = kept.reduce((sum, v) => sum + v.bytes, 0);
  while (kept.length > 0 && (kept.length > maxVersions || total > maxBytes)) {
    const oldest = kept.pop()!;
    total -= oldest.bytes;
    drop.push(oldest.versionId);
  }
  return drop;
}
