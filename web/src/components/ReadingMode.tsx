import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { NoteDetail } from "../api.ts";
import { useDialogFocus } from "../lib/use-dialog-focus.ts";
import { touchesNote, type NoteChange } from "../lib/live.ts";
import {
  SPLIT_DEFAULT_RATIO,
  SPLIT_MAX_RATIO,
  SPLIT_MIN_RATIO,
  canSplit,
  nudgeSplitRatio,
  paneNavigation,
  parseSplitRatio,
  parseWidth,
  ratioFromPointer,
  type Pane,
  type ReadingWidth,
} from "../lib/reading.ts";
import Icon from "./Icon.tsx";
import ReadingPane, { type Neighbor } from "./ReadingPane.tsx";
import SearchPalette from "./SearchPalette.tsx";

type Props = {
  noteId: string;
  /** 库内路径：换算图片地址用 */
  notePath: string;
  /** 已有笔记的标题（ui-006） */
  knownTitles?: ReadonlySet<string>;
  title: string;
  body: string;
  meta: { updated: string; group: string | null; tags: string[] };
  prev: Neighbor;
  next: Neighbor;
  /** 左栏（App 里打开的那篇）换成别的 */
  onNavigate: (id: string) => void;
  onExit: () => void;
  onOpenWikilink: (target: string) => void;
  onFilterTag: (tag: string) => void;
  /** 导出 PDF：导出的是当前栏那篇 */
  onExport: (id: string, title: string) => void;
  /** 上面又开了弹窗（导出面板）：键盘先让给它 */
  paused?: boolean;
  // —— 分屏阅读（read-002）：右栏那篇由这里自己读、自己跟着外部修改刷新 ——
  /** 中间列表当前的顺序：翻篇用 */
  listIds: string[];
  neighborsOf: (id: string) => { prev: Neighbor; next: Neighbor };
  /** 双链标题 → 笔记 id（找不到返回 null） */
  resolveTitle: (title: string) => Promise<string | null>;
  loadNote: (id: string) => Promise<NoteDetail>;
  /** 推送通道：笔记有变化时通知；null = 整体重新同步 */
  subscribeChanges: (listener: (changes: NoteChange[] | null) => void) => () => void;
  /** 在编辑页打开某一篇（右栏那篇按 E / 「编辑」时） */
  onOpenInEditor: (id: string) => void;
  onNotify: (text: string, kind?: "ok" | "info" | "error") => void;
};

const FONT_KEY = "study.previewFont";
const WIDTH_KEY = "study.readWidth";
const SPLIT_RATIO_KEY = "study.splitRatio";
const SPLIT_RIGHT_KEY = "study.splitRight";
const FONT_MIN = 14;
const FONT_MAX = 28;
const FONT_STEP = 2;
const FONT_DEFAULT = 18;
/** 窗口比这窄时目录默认收起，打开时盖在正文上 */
const TOC_INLINE_MIN = 1000;

const WIDTH_LABELS: Array<{ value: ReadingWidth; label: string; hint: string }> = [
  { value: "auto", label: "自动", hint: "随窗口变宽，宽屏时字号略放大" },
  { value: "narrow", label: "窄", hint: "600px" },
  { value: "medium", label: "中", hint: "700px" },
  { value: "wide", label: "宽", hint: "840px" },
  { value: "full", label: "满宽", hint: "铺满窗口" },
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

type RightPane = { id: string; note: NoteDetail | null };

/** 上次在右栏看的那篇（id + 标题），分屏选篇时排在最前 */
function parseLastRight(raw: string | null): { id: string; title: string } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { id?: unknown; title?: unknown };
    return typeof value.id === "string" && value.id ? { id: value.id, title: typeof value.title === "string" ? value.title : "" } : null;
  } catch {
    return null;
  }
}

/**
 * 阅览模式（reading-001）：只读、铺满窗口。
 * - 目录（h1–h3），读到哪一节高亮哪一节；顶部阅读进度；A− / A+ 字号；行宽档位
 * - ← / → 或 [ / ] 上一篇 / 下一篇（中间列表的顺序）；Esc 回到编辑，E 编辑当前栏那篇
 * - 每篇读到的位置记在本机，下次回到那里
 * - 分屏（read-002）：「分屏」选一篇放右边，或按住 Ctrl / ⌘ 点双链在另一栏打开；
 *   中间分隔条可拖（30%～70%，记在本机，双击恢复一半）；翻篇、导出、编辑都作用于当前栏
 */
export default function ReadingMode(props: Props) {
  const { noteId, notePath, knownTitles, title, body, meta, prev, next, onNavigate, onExit, onOpenWikilink, onFilterTag, onExport, paused } = props;
  const { listIds, neighborsOf, resolveTitle, loadNote, subscribeChanges, onOpenInEditor, onNotify } = props;
  const dialogFocusRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogFocusRef);
  const [fontSize, setFontSize] = useState(readFont);
  const [width, setWidth] = useState<ReadingWidth>(() => parseWidth(load(WIDTH_KEY)));
  const [tocOpen, setTocOpen] = useState(() => window.innerWidth >= TOC_INLINE_MIN);
  const [metrics, setMetrics] = useState<Record<Pane, { ratio: number; fontSize: number }>>({
    left: { ratio: 0, fontSize: 0 },
    right: { ratio: 0, fontSize: 0 },
  });
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [right, setRight] = useState<RightPane | null>(null);
  const [active, setActive] = useState<Pane>("left");
  const [ratio, setRatio] = useState(() => parseSplitRatio(load(SPLIT_RATIO_KEY)));
  const [picking, setPicking] = useState(false);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number } | null>(null);
  const rightRef = useRef<RightPane | null>(null);
  rightRef.current = right;

  const split = right !== null;
  const roomForTwo = canSplit(windowWidth);
  /** 分屏但窗口太窄：只显示当前栏 */
  const collapsed = split && !roomForTwo;
  const activePane: Pane = split ? active : "left";

  // 背后的页面不要跟着滚
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
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

  // —— 右栏：读这一篇；外部改了自动刷新，被删了就关掉 ——
  const fetchRight = useCallback(
    async (id: string) => {
      try {
        const note = await loadNote(id);
        setRight((current) => (current && current.id === id ? { id, note } : current));
        store(SPLIT_RIGHT_KEY, JSON.stringify({ id, title: note.meta.title }));
      } catch {
        const gone = rightRef.current;
        if (!gone || gone.id !== id) return;
        setRight(null);
        setActive("left");
        onNotify(`《${gone.note?.meta.title || "这篇笔记"}》已被删除，右栏已关闭`, "info");
      }
    },
    [loadNote, onNotify],
  );

  const openRight = useCallback(
    (id: string) => {
      setRight((current) => (current && current.id === id ? current : { id, note: null }));
      setActive("right");
      void fetchRight(id);
    },
    [fetchRight],
  );

  useEffect(
    () =>
      subscribeChanges((changes) => {
        const current = rightRef.current;
        if (!current) return;
        if (changes === null || touchesNote(changes, current.id, current.note?.relPath ?? null)) void fetchRight(current.id);
      }),
    [subscribeChanges, fetchRight],
  );

  function closeRight(): void {
    setRight(null);
    setActive("left");
  }

  function swap(): void {
    const current = rightRef.current;
    if (!current) return;
    const leftId = noteId;
    onNavigate(current.id);
    openRight(leftId);
    setActive("left");
  }

  /** 在某一栏点了双链：Ctrl / ⌘ → 另一栏打开；不按 → 在这一栏跳过去 */
  async function openLink(from: Pane, target: string, inOther: boolean): Promise<void> {
    const to: Pane = inOther ? (from === "left" ? "right" : "left") : from;
    if (to === "left") {
      if (from === "right") {
        const id = await resolveTitle(target);
        if (id) onNavigate(id);
        else onNotify(`没有叫《${target}》的笔记`, "info");
      } else {
        onOpenWikilink(target);
      }
      return;
    }
    // 去右栏：窗口放不下两栏时，退回在当前栏跳转
    const id = await resolveTitle(target);
    if (!id) {
      if (from === "left") onOpenWikilink(target);
      else onNotify(`没有叫《${target}》的笔记`, "info");
      return;
    }
    if (from === "left" && !split && !roomForTwo) {
      onNavigate(id);
      return;
    }
    openRight(id);
  }

  function navigate(direction: -1 | 1): void {
    const move = paneNavigation({ split, active: activePane, leftId: noteId, rightId: right?.id ?? null, ids: listIds, direction });
    if (!move) return;
    if (move.pane === "left") onNavigate(move.id);
    else openRight(move.id);
  }

  function editActive(): void {
    if (activePane === "right" && right) onOpenInEditor(right.id);
    else onExit();
  }

  function exportActive(): void {
    if (activePane === "right" && right?.note) onExport(right.id, right.note.meta.title);
    else onExport(noteId, title);
  }

  // 键盘：Esc 退出，E 编辑当前栏，← → [ ] 当前栏翻篇；带修饰键、正在输入、焦点在分隔条上时放行
  const keysRef = useRef({ navigate, editActive, onExit });
  keysRef.current = { navigate, editActive, onExit };
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (paused || picking || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      if ((event.target as HTMLElement | null)?.getAttribute?.("role") === "separator") return;
      const key = event.key;
      if (key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        keysRef.current.onExit();
      } else if (key === "e" || key === "E") {
        event.preventDefault();
        event.stopPropagation();
        keysRef.current.editActive();
      } else if (key === "ArrowLeft" || key === "[") {
        event.preventDefault();
        keysRef.current.navigate(-1);
      } else if (key === "ArrowRight" || key === "]") {
        event.preventDefault();
        keysRef.current.navigate(1);
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [paused, picking]);

  // —— 分隔条：拖动、双击恢复一半、焦点在上面时 ← → 调 ——
  function saveRatio(value: number): void {
    store(SPLIT_RATIO_KEY, String(value));
  }
  function onDividerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function onDividerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const area = areaRef.current;
    if (!dragRef.current || !area) return;
    const rect = area.getBoundingClientRect();
    setRatio(ratioFromPointer(event.clientX, rect.left, rect.width));
  }
  function onDividerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setRatio((value) => {
      saveRatio(value);
      return value;
    });
  }
  function onDividerKey(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const nextRatio = nudgeSplitRatio(ratio, event.key === "ArrowLeft" ? -1 : 1);
    setRatio(nextRatio);
    saveRatio(nextRatio);
  }
  function resetRatio(): void {
    setRatio(SPLIT_DEFAULT_RATIO);
    saveRatio(SPLIT_DEFAULT_RATIO);
  }

  const lastRight = parseLastRight(load(SPLIT_RIGHT_KEY));

  const shown = metrics[activePane];
  const progress = shown.ratio;
  const actualFont = shown.fontSize || fontSize;
  const leftNeighbors = { prev, next };
  const rightNeighbors = right ? neighborsOf(right.id) : { prev: null, next: null };
  const barTitle = split && activePane === "right" ? right?.note?.meta.title ?? "" : title;
  const showLeft = !collapsed || activePane === "left";
  const showRight = split && (!collapsed || activePane === "right");

  const leftPane = (
    <ReadingPane
      noteId={noteId}
      notePath={notePath}
      knownTitles={knownTitles}
      title={title}
      body={body}
      meta={meta}
      prev={leftNeighbors.prev}
      next={leftNeighbors.next}
      onNavigate={onNavigate}
      onOpenWikilink={(target, other) => void openLink("left", target, other)}
      onFilterTag={onFilterTag}
      fontSize={fontSize}
      width={width}
      onMetrics={(value) => setMetrics((all) => ({ ...all, left: value }))}
      split={split}
      tocOpen={tocOpen}
      onTocJumped={() => {
        if (window.innerWidth < TOC_INLINE_MIN) setTocOpen(false);
      }}
      active={activePane === "left"}
      onActivate={() => setActive("left")}
      label="左栏"
    />
  );

  return (
    <div className="reader" ref={dialogFocusRef} role="dialog" aria-modal="true" aria-label={`阅览：${title || "无标题"}`}>
      <div className="reader__progress" style={{ transform: `scaleX(${progress})` }} aria-hidden="true" />
      <div className="reader__bar">
        {!split ? (
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
        <div className="reader__title" title={barTitle}>
          {split ? `分屏 · 当前：${barTitle || "无标题"}` : title || "无标题"}
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
                title={`行宽：${option.label}（${option.hint}）`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn--small" onClick={() => changeFont(-FONT_STEP)} disabled={fontSize <= FONT_MIN} title="缩小字号">
            A−
          </button>
          <span className="reader__size" title={actualFont !== fontSize ? `设定 ${fontSize}px，宽屏自动放大` : undefined}>
            {actualFont}px
          </span>
          <button type="button" className="btn btn--small" onClick={() => changeFont(FONT_STEP)} disabled={fontSize >= FONT_MAX} title="放大字号">
            A+
          </button>
          {split ? null : (
            <button
              type="button"
              className="btn btn--small"
              onClick={() => setPicking(true)}
              disabled={!roomForTwo}
              aria-disabled={!roomForTwo}
              title={roomForTwo ? "左右并排读两篇：选一篇放右边（也可以按住 Ctrl 点双链）" : "窗口太窄，放不下两栏"}
            >
              <Icon name="columns" size={13} /> 分屏
            </button>
          )}
          <button type="button" className="icon-btn" onClick={exportActive} title="导出 PDF（当前栏那篇）" aria-label="导出 PDF">
            <Icon name="download" size={16} />
          </button>
          <button type="button" className="btn btn--small btn--primary" onClick={editActive} title="编辑当前栏那篇（E）；Esc 回到编辑">
            编辑 <kbd>Esc</kbd>
          </button>
        </div>
      </div>

      {!split ? (
        <div className="reader__body">{leftPane}</div>
      ) : (
        <div
          className={`reader__body reader__body--split${collapsed ? " is-collapsed" : ""}`}
          ref={areaRef}
          style={collapsed ? undefined : { gridTemplateColumns: `minmax(0, ${ratio}fr) 6px minmax(0, ${1 - ratio}fr)` }}
        >
          {showLeft ? leftPane : null}
          {!collapsed ? (
            <div
              className="reader__divider"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整左右两栏的比例"
              aria-valuemin={SPLIT_MIN_RATIO * 100}
              aria-valuemax={SPLIT_MAX_RATIO * 100}
              aria-valuenow={Math.round(ratio * 100)}
              tabIndex={0}
              title="拖动调整比例；双击恢复各一半；焦点在这里时按 ← → 调"
              onPointerDown={onDividerDown}
              onPointerMove={onDividerMove}
              onPointerUp={onDividerUp}
              onPointerCancel={onDividerUp}
              onDoubleClick={resetRatio}
              onKeyDown={onDividerKey}
            />
          ) : null}
          {showRight && right ? (
            right.note ? (
              <ReadingPane
                noteId={right.id}
                notePath={right.note.relPath}
                knownTitles={knownTitles}
                title={right.note.meta.title}
                body={right.note.body}
                meta={{ updated: right.note.meta.updated, group: right.note.meta.group ?? null, tags: right.note.meta.tags }}
                prev={rightNeighbors.prev}
                next={rightNeighbors.next}
                onNavigate={openRight}
                onOpenWikilink={(target, other) => void openLink("right", target, other)}
                onFilterTag={onFilterTag}
                fontSize={fontSize}
                width={width}
                onMetrics={(value) => setMetrics((all) => ({ ...all, right: value }))}
                split
                active={activePane === "right"}
                onActivate={() => setActive("right")}
                label="右栏"
                headExtra={
                  <>
                    <button type="button" className="icon-btn" onClick={swap} aria-label="左右交换" title="左右交换">
                      <Icon name="swap" size={14} />
                    </button>
                    <button type="button" className="icon-btn" onClick={closeRight} aria-label="关闭右栏" title="关闭右栏，回到单篇">
                      <Icon name="x" size={14} />
                    </button>
                  </>
                }
              />
            ) : (
              <section className="reader-pane" aria-label="右栏">
                <p className="reader-pane__loading">正在读取…</p>
              </section>
            )
          ) : null}
          {collapsed ? (
            <p className="reader__split-hint" role="status">
              还有另一栏，窗口加宽后恢复
              <button type="button" className="link-btn" onClick={() => setActive(activePane === "left" ? "right" : "left")}>
                切到另一栏
              </button>
            </p>
          ) : null}
        </div>
      )}

      <SearchPalette
        open={picking}
        onClose={() => setPicking(false)}
        onOpenNote={(id) => openRight(id)}
        label="选一篇放到右边"
        placeholder="搜索要放到右边的笔记…"
        suggestions={lastRight && lastRight.id !== noteId ? [{ id: lastRight.id, title: lastRight.title || "上次在右边看的那篇", hint: "上次在右边" }] : []}
      />
    </div>
  );
}
