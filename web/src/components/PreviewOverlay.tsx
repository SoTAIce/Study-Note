import { useCallback, useEffect, useRef, useState } from "react";
import Preview from "./Preview.tsx";

type Props = {
  title: string;
  body: string;
  onExit: () => void;
  onOpenWikilink: (target: string) => void;
  onFilterTag: (tag: string) => void;
};

const FONT_KEY = "study.previewFont";
const FONT_MIN = 14;
const FONT_MAX = 28;
const FONT_STEP = 2;
const FONT_DEFAULT = 17;

function readFont(): number {
  try {
    const raw = window.localStorage.getItem(FONT_KEY);
    const value = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isFinite(value)) return Math.min(FONT_MAX, Math.max(FONT_MIN, value));
  } catch {
    // localStorage 被禁用时忽略，用默认字号。
  }
  return FONT_DEFAULT;
}

/**
 * 全屏阅读：预览铺满整个窗口，只留一条细窄的顶栏。
 * - Esc 退出（唯一必需的出口）
 * - A− / A+ 调字号，记在 localStorage 里，下次还是这个大小
 * - 双链/标签点击仍然可用，导航时不退出全屏
 */
export default function PreviewOverlay({ title, body, onExit, onOpenWikilink, onFilterTag }: Props) {
  const [fontSize, setFontSize] = useState(readFont);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const changeFont = useCallback((delta: number) => {
    setFontSize((prev) => {
      const next = Math.min(FONT_MAX, Math.max(FONT_MIN, prev + delta));
      try {
        window.localStorage.setItem(FONT_KEY, String(next));
      } catch {
        // 记不住就算了，不影响本次阅读。
      }
      return next;
    });
  }, []);

  // 覆盖式全屏要让背后的页面不要跟着滚动。
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Esc 退出；其余按键放行（Ctrl+K 之类仍然好用）。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onExit();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onExit]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [title]);

  return (
    <div className="pv-full" role="dialog" aria-modal="true" aria-label="全屏预览">
      <div className="pv-full__bar">
        <div className="pv-full__title" title={title}>
          {title || "无标题"}
        </div>
        <div className="pv-full__tools">
          <button
            type="button"
            className="btn btn--small"
            onClick={() => changeFont(-FONT_STEP)}
            disabled={fontSize <= FONT_MIN}
            title="缩小字号"
          >
            A−
          </button>
          <span className="pv-full__size">{fontSize}px</span>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => changeFont(FONT_STEP)}
            disabled={fontSize >= FONT_MAX}
            title="放大字号"
          >
            A+
          </button>
          <button type="button" className="btn btn--small btn--primary" onClick={onExit} title="退出全屏（Esc）">
            退出 <kbd>Esc</kbd>
          </button>
        </div>
      </div>

      <div className="pv-full__scroll" ref={scrollRef}>
        <div className="pv-full__paper" style={{ fontSize: `${fontSize}px` }}>
          <Preview markdown={body} onOpenWikilink={onOpenWikilink} onFilterTag={onFilterTag} />
        </div>
      </div>
    </div>
  );
}
