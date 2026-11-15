/**
 * 左栏收起状态（ui-009）：只存在本机浏览器里，读写失败（隐私模式等）就当展开。
 */
export const SIDEBAR_KEY = "study.sidebarCollapsed";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function readSidebarCollapsed(storage: StorageLike | null): boolean {
  try {
    return storage?.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(storage: StorageLike | null, collapsed: boolean): void {
  try {
    storage?.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  } catch {
    // 记不住就算了，本次照样生效
  }
}
