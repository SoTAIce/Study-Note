/**
 * 导出 PDF（export-001）前端的纯逻辑：选项记忆、下载文件名。
 */

export type ExportLayout = "phone" | "a4";
export type ExportPrefs = { layout: ExportLayout; dark: boolean; meta: boolean };

export const DEFAULT_EXPORT_PREFS: ExportPrefs = { layout: "phone", dark: false, meta: true };

/** localStorage 里记住的上次选项；坏数据当没有 */
export function parseExportPrefs(raw: string | null): ExportPrefs {
  if (!raw) return DEFAULT_EXPORT_PREFS;
  try {
    const value = JSON.parse(raw) as Partial<ExportPrefs> | null;
    if (!value || typeof value !== "object") return DEFAULT_EXPORT_PREFS;
    return {
      layout: value.layout === "a4" ? "a4" : "phone",
      dark: value.dark === true,
      meta: value.meta !== false,
    };
  } catch {
    return DEFAULT_EXPORT_PREFS;
  }
}

/** 从 Content-Disposition 里取文件名（优先 filename*=UTF-8''…） */
export function fileNameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // 编码坏了就看下面的普通 filename
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain ? plain[1] : fallback;
}
