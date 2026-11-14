/**
 * 弹窗焦点陷阱（a11y-001）：打开弹窗后 Tab / Shift+Tab 只在弹窗里转，关掉后焦点回到打开前的位置。
 * 纯函数部分（算下一个落点）放在这里方便测试；挂到 DOM 上的是 useDialogFocus。
 */

export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(",");

/**
 * Tab 之后焦点该落在第几个元素上。
 * current 是当前焦点的下标（-1 表示焦点不在弹窗里）；count 为 0 时返回 -1（让弹窗本身拿焦点）。
 * 在最后一个上 Tab 回到第一个，在第一个上 Shift+Tab 去最后一个。
 */
export function nextFocusIndex(count: number, current: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return backwards ? count - 1 : 0;
  if (backwards) return current === 0 ? count - 1 : current - 1;
  return current === count - 1 ? 0 : current + 1;
}

/** 当前打开着的弹窗，后打开的在最后；只有最上面那个拦 Tab */
const stack: HTMLElement[] = [];

export function pushDialog(el: HTMLElement): void {
  stack.push(el);
}

export function popDialog(el: HTMLElement): void {
  const i = stack.lastIndexOf(el);
  if (i >= 0) stack.splice(i, 1);
}

export function isTopDialog(el: HTMLElement): boolean {
  return stack[stack.length - 1] === el;
}

/** 弹窗里能拿焦点、而且看得见的元素 */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0 && !el.closest("[inert]"),
  );
}
