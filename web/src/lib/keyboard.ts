/**
 * 快捷键映射（纯函数，便于单测）。
 *
 * 约定：只有精确的修饰键组合才触发动作，避免误触
 * （例如 Ctrl+Alt+K 是浏览器的「复制链接」类组合，必须放行）。
 */
export type Action = "search" | "new" | "save" | "ai" | "capture" | "preview" | "history" | "sidebar" | "review";

export type KeyInput = {
  key: string;
  /** 物理按键位置；Ctrl+\ 在部分键盘布局下 key 不是 "\\"，按 code 认 */
  code?: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
};

export function resolveKey(ev: KeyInput): Action | null {
  const ctrl = Boolean(ev.ctrlKey || ev.metaKey);
  const shift = Boolean(ev.shiftKey);
  const alt = Boolean(ev.altKey);

  // 必须有 Ctrl/Cmd；带 Alt 的组合一律不接管。
  if (!ctrl || alt) return null;

  const key = ev.key.toLowerCase();

  // Space 在浏览器里 key === " "；兼容旧浏览器的 "Spacebar"。
  if (key === " " || key === "space" || key === "spacebar") {
    return shift ? "capture" : null;
  }

  // 全屏预览 / 历史版本 / 今日复习（srs-001）：只有这几个带 Shift 的字母组合，其余 Shift 组合一律放行。
  if (shift) return key === "f" ? "preview" : key === "h" ? "history" : key === "r" ? "review" : null;

  switch (key) {
    case "k":
      return "search";
    case "n":
      return "new";
    case "s":
      return "save";
    case "j":
      return "ai";
    // 收起 / 展开左栏（ui-009）；Ctrl+B 留给正文加粗
    case "\\":
      return "sidebar";
    default:
      return ev.code === "Backslash" ? "sidebar" : null;
  }
}
