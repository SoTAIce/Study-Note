import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useDialogFocus } from "../lib/use-dialog-focus.ts";

/**
 * 应用内确认框（ui-002）：替换浏览器自带的 window.confirm，样式跟主题走。
 * 用法：const confirm = useConfirm(); if (await confirm({ title, message, confirmLabel, danger: true })) ...
 * Esc / 点背景 = 取消；默认焦点在「取消」上（回车按的是聚焦的按钮），免得手快误删。
 */
export type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 确认按钮用危险色 */
  danger?: boolean;
};

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm 需要放在 ConfirmProvider 里");
  return confirm;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    // 上一个还没回答就来了新的：旧的按取消处理
    pendingRef.current?.resolve(false);
    return new Promise<boolean>((resolve) => {
      const next = { ...options, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(ok);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending ? <ConfirmDialog options={pending} onSettle={settle} /> : null}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({ options, onSettle }: { options: ConfirmOptions; onSettle: (ok: boolean) => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useDialogFocus(dialogRef);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onSettle(false);
      }
    };
    // 捕获阶段拦下 Esc：别让下面的弹窗或阅览模式也跟着关
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onSettle]);

  return (
    <div className="overlay overlay--center overlay--top" role="presentation" onMouseDown={() => onSettle(false)}>
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={options.message ? "confirm-dialog-message" : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="confirm-dialog-title" className="confirm-dialog__title">
          {options.title}
        </h2>
        {options.message ? (
          <p id="confirm-dialog-message" className="confirm-dialog__message">
            {options.message}
          </p>
        ) : null}
        <div className="confirm-dialog__foot">
          <button ref={cancelRef} type="button" className="btn" onClick={() => onSettle(false)}>
            {options.cancelLabel ?? "取消"}
          </button>
          <button
            type="button"
            className={`btn ${options.danger ? "btn--danger-solid" : "btn--primary"}`}
            onClick={() => onSettle(true)}
          >
            {options.confirmLabel ?? "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}
