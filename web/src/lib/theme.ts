/**
 * 主题偏好：system（跟随系统）/ light / dark。
 * 写在 <html data-theme> 上；system 时去掉属性，交给 prefers-color-scheme。
 * index.html 里有一段同逻辑的内联脚本，首帧前就设好，避免闪白/闪黑。
 */
export type ThemePref = "system" | "light" | "dark";

const KEY = "study-notes:theme";

export function readThemePref(): ThemePref {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyThemePref(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
  try {
    if (pref === "system") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, pref);
  } catch {
    // 隐私模式等读写不了 localStorage：只影响「记住」，不影响本次切换
  }
}

export function nextThemePref(pref: ThemePref): ThemePref {
  return pref === "system" ? "light" : pref === "light" ? "dark" : "system";
}

export const THEME_LABEL: Record<ThemePref, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

/** 编辑区视图：分栏 / 只写 / 只看。 */
export type ViewMode = "split" | "write" | "preview";
const VIEW_KEY = "study-notes:view";

export function readViewMode(): ViewMode {
  try {
    const value = window.localStorage.getItem(VIEW_KEY);
    if (value === "write" || value === "preview" || value === "split") return value;
  } catch {
    // 读不到就用默认
  }
  return typeof window !== "undefined" && window.innerWidth < 900 ? "write" : "split";
}

export function saveViewMode(mode: ViewMode): void {
  try {
    window.localStorage.setItem(VIEW_KEY, mode);
  } catch {
    // 同上
  }
}
