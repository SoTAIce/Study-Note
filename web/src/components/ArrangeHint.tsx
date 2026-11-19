import { useEffect, useState } from "react";
import { ARRANGE_HINT_MS } from "../lib/arrange.ts";

/**
 * 粘贴大段后的提示条（tpl-002）：「要按『X』规整刚粘贴的内容吗？［规整］［不用］」。
 * 这篇没有模板时可以在条里选一个。10 秒不理就自己消失；鼠标停在上面或在里面操作时不计时。
 */
type Props = {
  template: string | null;
  templateNames: string[];
  onArrange: (template: string) => void;
  onDismiss: () => void;
};

export default function ArrangeHint({ template, templateNames, onArrange, onDismiss }: Props) {
  const [choice, setChoice] = useState(template ?? templateNames[0] ?? "");
  const [hold, setHold] = useState(false);

  useEffect(() => {
    if (hold) return;
    const timer = window.setTimeout(onDismiss, ARRANGE_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [hold, choice, onDismiss]);

  return (
    <div
      className="arrange-hint"
      role="status"
      onMouseEnter={() => setHold(true)}
      onMouseLeave={() => setHold(false)}
      onFocus={() => setHold(true)}
      onBlur={() => setHold(false)}
    >
      {template ? (
        <span>要按「{template}」规整刚粘贴的内容吗？</span>
      ) : (
        <>
          <span>要按模板规整刚粘贴的内容吗？</span>
          <select
            className="arrange-hint__select"
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
            aria-label="规整用的模板"
          >
            {templateNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </>
      )}
      <div className="arrange-hint__actions">
        <button type="button" className="btn btn--small btn--primary" disabled={!choice} onClick={() => onArrange(choice)}>
          规整
        </button>
        <button type="button" className="btn btn--small" onClick={onDismiss}>
          不用
        </button>
      </div>
    </div>
  );
}
