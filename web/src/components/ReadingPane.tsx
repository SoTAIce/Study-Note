import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { relativeTime } from "../lib/time.ts";
import {
  activeOutlineIndex,
  buildOutline,
  parsePositions,
  readingLayout,
  rememberPosition,
  scrollRatio,
  type OutlineItem,
  type ReadingWidth,
} from "../lib/reading.ts";
import Icon from "./Icon.tsx";
import Preview from "./Preview.tsx";

export type Neighbor = { id: string; title: string } | null;

/**
 * 阅览模式的一栏（read-002 从 ReadingMode 里抽出来）：目录、滚动、读到的位置、版心、正文、上一篇 / 下一篇。
 * - 单栏（split = false）：目录常驻左侧（窄窗口时盖在正文上），由 ReadingMode 顶栏的按钮开合；
 *   DOM 和以前一样（.reader__toc / .reader__scroll 直接放在 .reader__body 里）。
 * - 分屏（split = true）：每栏有自己的标题条，目录是标题条上点开的浮层。
 * 版心按这一栏自己的宽度算（沿用 read-003 的自动档），所以半屏时字号不会被放大。
 */
type Props = {
  noteId: string;
  notePath: string;
  knownTitles?: ReadonlySet<string>;
  title: string;
  body: string;
  meta: { updated: string; group: string | null; tags: string[] };
  prev: Neighbor;
  next: Neighbor;
  onNavigate: (id: string) => void;
  /** split：按住 Ctrl / ⌘ 点的，要在另一栏打开 */
  onOpenWikilink: (target: string, split: boolean) => void;
  onFilterTag: (tag: string) => void;
  fontSize: number;
  width: ReadingWidth;
  /** 读到的比例、实际字号变了：顶栏的进度条和字号显示用 */
  onMetrics?: (metrics: { ratio: number; fontSize: number }) => void;
  split: boolean;
  /** 单栏时目录开合由顶栏控制 */
  tocOpen?: boolean;
  /** 单栏、窄窗口：点了目录项后收起抽屉 */
  onTocJumped?: () => void;
  /** 分屏时：这一栏是不是当前栏；点、滚、聚焦都会让它变成当前栏 */
  active?: boolean;
  onActivate?: () => void;
  /** 分屏时标题条右边多出的按钮（⇄、×） */
  headExtra?: ReactNode;
  /** 分屏时这一栏叫什么（读屏用） */
  label?: string;
};

const POSITIONS_KEY = "study.readPositions";

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
    // 记不住就算了
  }
}

export default function ReadingPane(props: Props) {
  const { noteId, notePath, knownTitles, title, body, meta, prev, next, onNavigate, onOpenWikilink, onFilterTag } = props;
  const { fontSize, width, onMetrics, split, tocOpen = false, onTocJumped, active = false, onActivate, headExtra, label } = props;
  const [available, setAvailable] = useState(() => window.innerWidth);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [current, setCurrent] = useState(-1);
  const [popover, setPopover] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const paperRef = useRef<HTMLDivElement | null>(null);
  const headingsRef = useRef<HTMLElement[]>([]);
  const ratioRef = useRef(0);
  const saveTimer = useRef<number | null>(null);
  const metricsRef = useRef(onMetrics);
  metricsRef.current = onMetrics;

  const layout = readingLayout(width, available, fontSize);

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
    setCurrent(activeOutlineIndex(tops, scroller.scrollTop));
    const ratio = scrollRatio(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight);
    ratioRef.current = ratio;
    metricsRef.current?.({ ratio, fontSize: layout.fontSize });
  }, [layout.fontSize]);

  // 窗口大小、目录开合、分隔条拖动都会改变这一栏的宽度。
  // 单栏 ↔ 分屏切换时滚动区是新换的元素（外面多了一层），要重新观察；被移走的旧元素会量出 0，不能再听它的
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const update = () => {
      if (scroller.isConnected && scroller.clientWidth > 0) setAvailable(scroller.clientWidth);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [split]);

  useEffect(() => {
    measure();
  }, [outline, layout.fontSize, layout.maxWidth, measure]);

  /** 切到这一篇：回到上次读到的位置；离开时记下读到哪里 */
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) {
      const ratio = parsePositions(load(POSITIONS_KEY))[noteId] ?? 0;
      scroller.scrollTop = ratio * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      ratioRef.current = ratio;
    }
    measure();
    setPopover(false);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
      store(POSITIONS_KEY, JSON.stringify(rememberPosition(parsePositions(load(POSITIONS_KEY)), noteId, ratioRef.current)));
    };
    // measure 只随字号变；这里只在换篇时跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  // 版心宽度或字号变了：按读到的比例回到原处，不让位置跳走
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.scrollTop = ratioRef.current * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    measure();
  }, [layout.fontSize, layout.maxWidth, measure]);

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
    setPopover(false);
    onTocJumped?.();
  }

  const hasToc = outline.length > 1;
  const metaParts = [`更新于 ${relativeTime(meta.updated)}`, meta.group ? `分组 ${meta.group}` : null].filter(Boolean);

  const tocItems = outline.map((item, position) => (
    <button
      key={`${item.index}-${item.text}`}
      type="button"
      className={`reader__toc-item${position === current ? " is-active" : ""}`}
      style={{ paddingLeft: `${12 + item.depth * 14}px` }}
      onClick={() => jumpTo(position)}
      aria-current={position === current ? "location" : undefined}
    >
      {item.text}
    </button>
  ));

  const scroller = (
    <div className="reader__scroll" ref={scrollRef} onScroll={onScroll}>
      <article
        className={`reader__paper${width === "full" ? " reader__paper--full" : ""}`}
        ref={paperRef}
        style={{ fontSize: `${layout.fontSize}px`, maxWidth: layout.maxWidth === null ? "none" : `${layout.maxWidth}px` }}
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
          knownTitles={knownTitles}
          onOpenWikilink={(target, options) => onOpenWikilink(target, Boolean(options?.split))}
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
              <button type="button" className="reader__pager-link reader__pager-link--next" onClick={() => onNavigate(next.id)}>
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
  );

  if (!split) {
    return (
      <>
        {hasToc && tocOpen ? (
          <nav className="reader__toc" aria-label="目录">
            {tocItems}
          </nav>
        ) : null}
        {scroller}
      </>
    );
  }

  return (
    <section
      className={`reader-pane${active ? " is-active" : ""}`}
      aria-label={label}
      onPointerDown={onActivate}
      onWheel={onActivate}
      onTouchStart={onActivate}
      onFocus={onActivate}
    >
      <header className="reader-pane__head">
        <span className="reader-pane__title" title={title}>
          {title || "无标题"}
        </span>
        {hasToc ? (
          <button
            type="button"
            className="btn btn--small reader-pane__toc-btn"
            onClick={() => setPopover((open) => !open)}
            aria-expanded={popover}
            aria-label={`《${title || "无标题"}》的目录`}
          >
            目录 <Icon name={popover ? "chevronUp" : "chevronDown"} size={11} />
          </button>
        ) : null}
        {headExtra}
      </header>
      <div className="reader-pane__body">
        {hasToc && popover ? (
          <nav className="reader-pane__toc" aria-label={`《${title || "无标题"}》的目录`}>
            {tocItems}
          </nav>
        ) : null}
        {scroller}
      </div>
    </section>
  );
}
