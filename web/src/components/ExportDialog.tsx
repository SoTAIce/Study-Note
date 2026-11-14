import { useEffect, useState } from "react";
import { parseExportPrefs, type ExportLayout, type ExportPrefs } from "../lib/export.ts";

const PREFS_KEY = "study.exportPrefs";

function loadPrefs(): ExportPrefs {
  try {
    return parseExportPrefs(window.localStorage.getItem(PREFS_KEY));
  } catch {
    return parseExportPrefs(null);
  }
}

function savePrefs(prefs: ExportPrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 记不住就算了，下次用默认值
  }
}

const LAYOUTS: Array<{ value: ExportLayout; label: string; hint: string }> = [
  { value: "phone", label: "手机阅读", hint: "100 × 178 mm，大字号，手机上不用放大" },
  { value: "a4", label: "A4", hint: "打印到纸上" },
];

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  /** 导出；成功返回 null，失败返回要显示的原因 */
  onExport: (prefs: ExportPrefs) => Promise<string | null>;
};

/** 导出 PDF 的小面板（export-001）：版式、深色、是否带标题信息；记住上次的选择 */
export default function ExportDialog({ open, title, onClose, onExport }: Props) {
  const [prefs, setPrefs] = useState<ExportPrefs>(loadPrefs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, busy, onClose]);

  if (!open) return null;

  function update(patch: Partial<ExportPrefs>): void {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      savePrefs(next);
      return next;
    });
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const failure = await onExport(prefs);
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  }

  return (
    <div
      className="overlay overlay--center overlay--above"
      role="presentation"
      onMouseDown={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="export-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="导出 PDF"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="export-dialog__title">导出 PDF</h2>
        <p className="export-dialog__note" title={title}>
          {title || "无标题"}
        </p>

        <fieldset className="export-dialog__group">
          <legend>版式</legend>
          {LAYOUTS.map((option) => (
            <label key={option.value} className={`export-option${prefs.layout === option.value ? " is-active" : ""}`}>
              <input
                type="radio"
                name="export-layout"
                checked={prefs.layout === option.value}
                onChange={() => update({ layout: option.value })}
              />
              <span className="export-option__label">{option.label}</span>
              <span className="export-option__hint">{option.hint}</span>
            </label>
          ))}
        </fieldset>

        <label className="export-dialog__check">
          <input type="checkbox" checked={prefs.meta} onChange={(event) => update({ meta: event.target.checked })} />
          标题下显示更新日期、分组、标签
        </label>
        <label className="export-dialog__check">
          <input type="checkbox" checked={prefs.dark} onChange={(event) => update({ dark: event.target.checked })} />
          深色（适合夜里读）
        </label>

        {error ? (
          <p className="export-dialog__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="export-dialog__foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "生成中…" : "导出"}
          </button>
        </div>
      </div>
    </div>
  );
}
