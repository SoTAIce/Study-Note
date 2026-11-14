import { useEffect, type RefObject } from "react";
import { focusableIn, isTopDialog, nextFocusIndex, popDialog, pushDialog } from "./focus-trap.ts";

/**
 * 弹窗焦点管理（a11y-001）：
 * - 打开时如果焦点不在弹窗里，移到第一个可聚焦元素（组件自己聚焦输入框的不受影响）；
 * - Tab / Shift+Tab 只在最上层弹窗里循环，焦点被点到背景上也拉回来；
 * - 关闭时焦点回到打开前的元素。
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    const dialog = ref.current;
    if (!active || !dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pushDialog(dialog);
    if (!dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1");

    // 等组件自己的聚焦（常用 setTimeout 0）先跑
    const timer = window.setTimeout(() => {
      if (!dialog.contains(document.activeElement)) (focusableIn(dialog)[0] ?? dialog).focus();
    }, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !isTopDialog(dialog)) return;
      const items = focusableIn(dialog);
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next = nextFocusIndex(items.length, current, event.shiftKey);
      // 中间的元素交给浏览器自己走，只管两头和焦点跑出去的情况
      const atEdge = current < 0 || (event.shiftKey ? current === 0 : current === items.length - 1);
      if (!atEdge) return;
      event.preventDefault();
      (next >= 0 ? items[next] : dialog).focus();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!isTopDialog(dialog)) return;
      const target = event.target as Node | null;
      if (target && !dialog.contains(target)) (focusableIn(dialog)[0] ?? dialog).focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
      popDialog(dialog);
      if (previous && previous.isConnected && !dialog.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [ref, active]);
}
