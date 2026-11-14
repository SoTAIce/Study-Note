import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Icon from "./Icon.tsx";
import Preview from "./Preview.tsx";
import { relativeTime } from "../lib/time.ts";
import {
  activeOutlineIndex,
  buildOutline,
  parsePositions,
  parseWidth,
  READING_WIDTHS,
  rememberPosition,
  scrollRatio,
  type OutlineItem,
  type ReadingWidth,
} from "../lib/reading.ts";

type Neighbor = { id: string; title: string } | null;

type Props = {
  noteId: string;
  /** 库内路径：换算图片地址用 */
  notePath: string;
  title: string;
  body: string;
  meta: { updated: string; group: string | null; tags: string[] };
  prev: Neighbor;
  next: Neighbor;
  onNavigate: (id: string) => void;
  onExit: () => void;
  onOpenWikilink: (target: string) => void;
  onFilterTag: (tag: string) => void;
  onExport: () => void;
  /** 上面又开了弹窗（导出面板）：键盘先让给它 */
  paused?: boolean;
};

const FONT_KEY = "study.previewFont";
const WIDTH_KEY = "study.readWidth";
const POSITIONS_KEY = "study.readPositions";
const FONT_MIN = 14;
const FONT_MAX = 28;
const FONT_STEP = 2;
const FONT_DEFAULT = 18;
/** 窗口比这窄时目录默认收起，打开时盖在正文上 */
const TOC_INLINE_MIN = 1000;

const WIDTH_LABELS: Array<{ value: ReadingWidth; label: string }> = [
  { value: "narrow", label: "窄" },
  { value: "medium", label: "中" },
  { value: "wide", label: "宽" },
];

/** localStorage 只存本机的阅读偏好：读写失败（隐私模式等）就用默认值 */
function load(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 记不住就算了，不影响本次阅读
  }
}

function readFont(): number {
  const value = Number.parseInt(load(FONT_KEY) ?? "", 10);
  return Number.isFinite(value) ? Math.min(FONT_MAX, Math.max(FONT_MIN, value)) : FONT_DEFAULT;
}

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);
}

/**
 * 阅览模式（reading-001）：只读、铺满窗口。
 * - 左侧目录（h1–h3），读到哪一节高亮哪一节；窄屏收进抽屉
 * - 顶部阅读进度；A− / A+ 字号；窄 / 中 / 宽 行宽
 * - ← / → 或 [ / ] 上一篇 / 下一篇（中间列表的顺序）；Esc 或 E 回到编辑
 * - 每篇读到的位置记在本机，下次回到那里
 */
export default function ReadingMode(props: Props) {
  const { noteId, notePath, title, body, meta, prev, next, onNavigate, onExit, onOpenWikilink, onFilterTag, onExport, paused } = props;
  const [fontSize, setFontSize] = useState(readFont);
  const [width, setWidth] = useState<ReadingWidth>(() => parseWidth(load(WIDTH_KEY)));
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [active, setActive] = useState(-1);
  const [progress, setProgress] = useState(0);
  const [tocOpen, setTocOpen] = useState(() => window.innerWidth >= TOC_INLINE_MIN);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const paperRef = useRef<HTMLDivElement | null>(null);
  const headingsRef = useRef<HTMLElement[]>([]);
  const ratioRef = useRef(0);
  const saveTimer = useRef<number | null>(null);

  // 背后的页面不要跟着滚
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const changeFont = useCallback((delta: number) => {
    setFontSize((value) => {
      const nextSize = Math.min(FONT_MAX, Math.max(FONT_MIN, value + delta));
      store(FONT_KEY, String(nextSize));
      return nextSize;
    });
  }, []);

  function changeWidth(value: ReadingWidth): void {
    setWidth(value);
    store(WIDTH_KEY, value);
  }

  /** 正文变了（切篇、外部修改载入）就重新收集标题 */
  useLayoutEffect(() => {
    const paper = paperRef.current;
    const elements = paper ? Array.from(paper.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) : [];
    const items = buildOutline(elements.map((el) => ({ level: Number(el.tagName.slice(1)), text: el.textContent ?? "" })));
    headingsRef.current = items.map((item) => elements[item.index]);
    setOutline(items);
  }, [body]);

  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const tops = headingsRef.current.map((el) => el.getBoundingClientRect().top - base);
    setActive(activeOutlineIndex(tops, scroller.scrollTop));
    const ratio = scrollRatio(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight);
    ratioRef.current = ratio;
    setProgress(ratio);
  }, []);

  useEffect(() => {
    measure();
  }, [outline, fontSize, width, measure]);

  /** 切到这一篇：回到上次读到的位置；离开时记下读到哪里 */
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) {
      const ratio = parsePositions(load(POSITIONS_KEY))[noteId] ?? 0;
      scroller.scrollTop = ratio * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      ratioRef.current = ratio;
    }
    measure();
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
      store(POSITIONS_KEY, JSON.stringify(rememberPosition(parsePositions(load(POSITIONS_KEY)), noteId, ratioRef.current)));
    };
  }, [noteId, measure]);

  function onScroll(): void {
    measure();
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      store(POSITIONS_KEY, JSON.stringify(rememberPosition(parsePositions(load(POSITIONS_KEY)), noteId, ratioRef.current)));
    }, 400);
  }

  function jumpTo(position: number): void {
    const scroller = scrollRef.current;
    const target = headingsRef.current[position];
    if (!scroller || !target) return;
    const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 16;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    scroller.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
    if (window.innerWidth < TOC_INLINE_MIN) setTocOpen(false);
  }

  // 键盘：Esc / E 退出，← → [ ] 切篇；带修饰键或正在输入时放行
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (paused || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      const key = event.key;
      if (key === "Escape" || key === "e" || key === "E") {
        event.preventDefault();
        event.stopPropagation();
        onExit();
      } else if ((key === "ArrowLeft" || key === "[") && prev) {
        event.preventDefault();
        onNavigate(prev.id);
      } else if ((key === "ArrowRight" || key === "]") && next) {
        event.preventDefault();
        onNavigate(next.id);
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onExit, onNavigate, prev, next, paused]);

  const hasToc = outline.length > 1;
  const metaParts = [`更新于 ${relativeTime(meta.updated)}`, meta.group ? `分组 ${meta.group}` : null].filter(Boolean);

  return (
    <div className="reader" role="dialog" aria-modal="true" aria-label={`阅览：${title || "无标题"}`}>
      <div className="reader__progress" style={{ transform: `scaleX(${progress})` }} aria-hidden="true" />
      <div className="reader__bar">
        {hasToc ? (
          <button
            type="button"
            className="icon-btn"
            onClick={() => setTocOpen((open) => !open)}
            title={tocOpen ? "收起目录" : "显示目录"}
            aria-label="目录"
            aria-pressed={tocOpen}
          >
            <Icon name="menu" size={16} />
          </button>
        ) : null}
        <div className="reader__title" title={title}>
          {title || "无标题"}
        </div>
        <div className="reader__tools">
          <div className="segmented" role="group" aria-label="行宽">
            {WIDTH_LABELS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`segmented__btn segmented__btn--text${width === option.value ? " is-active" : ""}`}
                onClick={() => changeWidth(option.value)}
                aria-pressed={width === option.value}
                title={`行宽：${option.label}`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => changeFont(-FONT_STEP)}
            disabled={fontSize <= FONT_MIN}
            title="缩小字号"
          >
            A−
          </button>
          <span className="reader__size">{fontSize}px</span>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => changeFont(FONT_STEP)}
            disabled={fontSize >= FONT_MAX}
            title="放大字号"
          >
            A+
          </button>
          <button type="button" className="icon-btn" onClick={onExport} title="导出 PDF" aria-label="导出 PDF">
            <Icon name="download" size={16} />
          </button>
          <button type="button" className="btn btn--small btn--primary" onClick={onExit} title="回到编辑（Esc 或 E）">
            编辑 <kbd>Esc</kbd>
          </button>
        </div>
      </div>

      <div className="reader__body">
        {hasToc && tocOpen ? (
          <nav className="reader__toc" aria-label="目录">
            {outline.map((item, position) => (
              <button
                key={`${item.index}-${item.text}`}
                type="button"
                className={`reader__toc-item${position === active ? " is-active" : ""}`}
                style={{ paddingLeft: `${12 + item.depth * 14}px` }}
                onClick={() => jumpTo(position)}
                aria-current={position === active ? "location" : undefined}
              >
                {item.text}
              </button>
            ))}
          </nav>
        ) : null}

        <div className="reader__scroll" ref={scrollRef} onScroll={onScroll}>
          <article
            className="reader__paper"
            ref={paperRef}
            style={{ fontSize: `${fontSize}px`, maxWidth: `${READING_WIDTHS[width]}px` }}
          >
            <p className="reader__meta">
              {metaParts.join(" · ")}
              {meta.tags.map((tag) => (
                <button key={tag} type="button" className="reader__tag" onClick={() => onFilterTag(tag)}>
                  #{tag}
                </button>
              ))}
            </p>
            <Preview
              markdown={body}
              notePath={notePath}
              onOpenWikilink={onOpenWikilink}
              onFilterTag={onFilterTag}
              className="reading"
            />

            {prev || next ? (
              <nav className="reader__pager" aria-label="上一篇 / 下一篇">
                {prev ? (
                  <button type="button" className="reader__pager-link" onClick={() => onNavigate(prev.id)}>
                    <span className="reader__pager-hint">
                      <Icon name="chevronLeft" size={12} /> 上一篇
                    </span>
                    <span className="reader__pager-title">{prev.title}</span>
                  </button>
                ) : (
                  <span />
                )}
                {next ? (
                  <button
                    type="button"
                    className="reader__pager-link reader__pager-link--next"
                    onClick={() => onNavigate(next.id)}
                  >
                    <span className="reader__pager-hint">
                      下一篇 <Icon name="chevronRight" size={12} />
                    </span>
                    <span className="reader__pager-title">{next.title}</span>
                  </button>
                ) : null}
              </nav>
            ) : null}
          </article>
        </div>
      </div>
    </div>
  );
}
