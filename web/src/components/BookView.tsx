import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import * as api from "../api.ts";
import { createBookChapter, getBook, writeBookIndex, type Book, type BookNote } from "../book-api.ts";
import { activeOutlineIndex } from "../lib/reading.ts";
import {
  buildBookToc,
  caretForLine,
  findChapter,
  stepChapter,
  stripLeadingTitle,
  syncEditing,
  type BookTocItem,
} from "../lib/book.ts";
import { caretCoords } from "../lib/caret-coords.ts";
import { leafName } from "../lib/group-tree.ts";
import { toggleTask } from "../lib/markdown.ts";
import { autosaveDelay } from "../lib/save-plan.ts";
import Icon from "./Icon.tsx";
import MarkdownTextarea from "./MarkdownTextarea.tsx";
import Preview from "./Preview.tsx";

type Props = {
  /** 要连读的分组（通常是子项目 `agent/looprun`） */
  group: string;
  /** 外部改了笔记（SSE）时 App 递增它，这里整本重取 */
  tick: number;
  knownTitles?: ReadonlySet<string>;
  onOpenNote: (id: string) => void;
  /** 书外的 [[链接]]：交给 App 照常打开 / 新建 */
  onOpenTitle: (title: string) => void;
  onFilterTag: (tag: string) => void;
  /** 生成目录、新建缺章等写入之后，App 刷新左栏 */
  onChanged: () => void;
  onToast: (text: string, kind: "ok" | "error" | "info") => void;
};

const EDIT_STATUS_TEXT = { saving: "保存中…", dirty: "未保存", saved: "已保存", conflict: "有冲突", error: "保存失败" } as const;

function editStatus(editing: Editing): keyof typeof EDIT_STATUS_TEXT {
  if (editing.status !== "editing") return editing.status;
  return editing.draft === editing.original ? "saved" : "dirty";
}

const TOC_SELECTOR = ".book__chapter-title, .book__chapter .preview h1, .book__chapter .preview h2, .book__chapter .preview h3";

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/** 正在就地编辑的那一章（book-002） */
type Editing = {
  id: string;
  title: string;
  /** 编辑起点（或上次保存后）的正文 */
  original: string;
  draft: string;
  baseHash: string;
  status: "editing" | "saving" | "conflict" | "error";
  /** 冲突时磁盘上的版本 */
  diskHash?: string;
  error?: string;
};

/** 「在此后新建一章」的输入框挂在哪一章下面 */
type Adding = { after: string | null; title: string };

function isDirty(editing: Editing | null): boolean {
  return editing !== null && editing.draft !== editing.original;
}

/**
 * 连读（book-001）：目录笔记的正文作总览，链接顺序就是章节顺序，整个项目上下连成一篇。
 * book-002：双击或点「编辑」让一章原地变成编辑框；同一时间只编辑一章；「在此后新建一章」。
 */
export default function BookView({ group, tick, knownTitles, onOpenNote, onOpenTitle, onFilterTag, onChanged, onToast }: Props) {
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tocOpen, setTocOpen] = useState(() => typeof window === "undefined" || window.innerWidth >= 900);
  const [toc, setToc] = useState<BookTocItem[]>([]);
  const [active, setActive] = useState(-1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const paperRef = useRef<HTMLElement | null>(null);
  const tocElements = useRef<HTMLElement[]>([]);

  // —— 就地编辑（book-002）——
  const [editing, setEditingState] = useState<Editing | null>(null);
  const editingRef = useRef<Editing | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** 自己刚存过的版本：整本重取时认出来，不当成外部修改 */
  const ownHashes = useRef<Set<string>>(new Set());
  const savePromise = useRef<Promise<boolean> | null>(null);
  const autosaveTimer = useRef<number | null>(null);
  const firstDirtyAt = useRef<number | null>(null);
  /** 进入编辑后把光标放到这里并滚到可见处 */
  const pendingCaret = useRef<number | null>(null);
  const [adding, setAdding] = useState<Adding | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const setEditing = useCallback((next: Editing | null | ((prev: Editing | null) => Editing | null)) => {
    const value = typeof next === "function" ? next(editingRef.current) : next;
    editingRef.current = value;
    setEditingState(value);
  }, []);

  /** 整本重取后：正在编辑的那章如果在别处被改了，没动过就换新，动过就进冲突 */
  const reconcile = useCallback(
    (next: Book) => {
      const current = editingRef.current;
      if (!current) return;
      const all = [...next.chapters, ...next.unlisted];
      const disk = all.find((chapter): chapter is BookNote & { kind?: "note" } => "id" in chapter && chapter.id === current.id);
      if (!disk) {
        // 被移出项目或删掉了：编辑框没有地方放了
        if (isDirty(current)) onToast(`《${current.title}》已不在这个项目里，没保存的修改留在了编辑框外，请到「单独打开」里处理`, "error");
        setEditing(null);
        return;
      }
      if (current.status === "saving") return;
      const verdict = syncEditing(current, disk, ownHashes.current);
      if (verdict === "adopt") {
        setEditing({ ...current, original: disk.body, draft: disk.body, baseHash: disk.hash, status: "editing" });
      } else if (verdict === "conflict" && current.status !== "conflict") {
        setEditing({ ...current, status: "conflict", diskHash: disk.hash });
      }
    },
    [onToast, setEditing],
  );

  const load = useCallback(async () => {
    try {
      const next = await getBook(group);
      setBook(next);
      setError(null);
      reconcile(next);
    } catch (err) {
      setError(api.errorMessage(err));
    }
  }, [group, reconcile]);

  // 换了项目：从头读
  useEffect(() => {
    setBook(null);
    setError(null);
    setAdding(null);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [group]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  /** 保存成功后就地更新书里那一章，不必整本重取 */
  const patchNote = useCallback((id: string, body: string, hash: string) => {
    setBook((prev) => {
      if (!prev) return prev;
      const fix = <T extends { id: string; body: string; hash: string }>(note: T): T =>
        note.id === id ? { ...note, body, hash } : note;
      return {
        ...prev,
        index: prev.index ? fix(prev.index) : prev.index,
        chapters: prev.chapters.map((chapter) => (chapter.kind === "note" ? fix(chapter) : chapter)),
        unlisted: prev.unlisted.map(fix),
      };
    });
  }, []);

  /**
   * 保存正在编辑的那章。close = 存完恢复成渲染状态（Esc、点别处、Ctrl+S、点「完成」）。
   * 冲突或失败时停在编辑状态，返回 false。
   */
  const saveEdit = useCallback(
    async (close: boolean): Promise<boolean> => {
      if (autosaveTimer.current !== null) {
        window.clearTimeout(autosaveTimer.current);
        autosaveTimer.current = null;
      }
      if (savePromise.current) await savePromise.current;
      const snapshot = editingRef.current;
      if (!snapshot) return true;
      if (snapshot.status === "conflict") return false;
      if (snapshot.draft === snapshot.original) {
        if (close) setEditing(null);
        return true;
      }
      firstDirtyAt.current = null;
      setEditing({ ...snapshot, status: "saving", error: undefined });
      const task = (async (): Promise<boolean> => {
        try {
          const saved = await api.saveNote(snapshot.id, { body: snapshot.draft, baseHash: snapshot.baseHash });
          ownHashes.current.add(saved.hash);
          patchNote(snapshot.id, saved.body, saved.hash);
          const latest = editingRef.current;
          if (!latest || latest.id !== snapshot.id) return true;
          const stillDirty = latest.draft !== snapshot.draft;
          if (close && !stillDirty) setEditing(null);
          else setEditing({ ...latest, original: snapshot.draft, baseHash: saved.hash, status: "editing" });
          onChanged();
          return true;
        } catch (err) {
          const info = api.conflictInfo(err);
          const latest = editingRef.current;
          if (latest && latest.id === snapshot.id) {
            setEditing(
              info
                ? { ...latest, status: "conflict", diskHash: info.currentHash }
                : { ...latest, status: "error", error: api.errorMessage(err) },
            );
          }
          if (!info) onToast(`保存失败：${api.errorMessage(err)}`, "error");
          return false;
        } finally {
          savePromise.current = null;
        }
      })();
      savePromise.current = task;
      return task;
    },
    [onChanged, onToast, patchNote, setEditing],
  );

  /** 进入编辑：先把正在编辑的另一章存好（存不上就不切换） */
  async function startEdit(note: BookNote, caret: number | null = null): Promise<void> {
    const current = editingRef.current;
    if (current?.id === note.id) {
      textareaRef.current?.focus();
      return;
    }
    if (current && !(await saveEdit(true))) {
      onToast(`《${current.title}》还没保存成功，先处理它再编辑别的章`, "error");
      return;
    }
    setAdding(null);
    pendingCaret.current = caret ?? note.body.length;
    firstDirtyAt.current = null;
    setEditing({ id: note.id, title: note.title, original: note.body, draft: note.body, baseHash: note.hash, status: "editing" });
  }

  function changeDraft(value: string): void {
    const current = editingRef.current;
    if (!current) return;
    setEditing({ ...current, draft: value, status: current.status === "error" ? "editing" : current.status });
    if (current.status === "conflict") return; // 冲突未决：不自动覆盖
    if (autosaveTimer.current !== null) window.clearTimeout(autosaveTimer.current);
    const now = Date.now();
    if (firstDirtyAt.current === null) firstDirtyAt.current = now;
    autosaveTimer.current = window.setTimeout(() => {
      autosaveTimer.current = null;
      void saveEdit(false);
    }, autosaveDelay(now, firstDirtyAt.current));
  }

  /** 冲突：以我的覆盖（基于磁盘上的新版本再存一次） */
  async function overwriteConflict(): Promise<void> {
    const current = editingRef.current;
    if (!current || current.status !== "conflict" || !current.diskHash) return;
    setEditing({ ...current, baseHash: current.diskHash, status: "editing", diskHash: undefined });
    await saveEdit(true);
  }

  /** 冲突：丢掉这里的修改，换成磁盘上的版本 */
  async function discardEdit(): Promise<void> {
    setEditing(null);
    await load();
  }

  // 编辑框出现后：把光标放到双击的位置，并滚到看得见的地方
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const caret = pendingCaret.current;
    if (!editing || !textarea || caret === null) return;
    pendingCaret.current = null;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(caret, caret);
    const scroller = scrollRef.current;
    if (!scroller) return;
    const box = textarea.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const y = box.top + caretCoords(textarea, caret).top;
    if (y < view.top + 40 || y > view.bottom - 80) {
      scroller.scrollTop += y - (view.top + view.height / 3);
    }
  }, [editing]);

  // 点编辑框以外（本页正文里）：保存并恢复成渲染状态。滚动条、左侧目录不算。
  useEffect(() => {
    if (!editing) return;
    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node | null;
      const paper = paperRef.current;
      if (!target || !paper || !paper.contains(target)) return;
      const section = paper.querySelector("[data-editing]");
      if (section?.contains(target)) return;
      void saveEdit(true);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [editing !== null, saveEdit]);

  // 切走窗口 / 标签页：把没存的存掉
  useEffect(() => {
    function onHide(): void {
      if (document.visibilityState === "hidden" && isDirty(editingRef.current)) void saveEdit(false);
    }
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [saveEdit]);

  // 离开连读 / 换到别的项目：没存的直接存（不再等界面）
  useEffect(
    () => () => {
      const current = editingRef.current;
      if (autosaveTimer.current !== null) window.clearTimeout(autosaveTimer.current);
      editingRef.current = null;
      setEditingState(null);
      if (current && isDirty(current) && current.status !== "conflict") {
        void api.saveNote(current.id, { body: current.draft, baseHash: current.baseHash }).catch((err) => {
          onToast(`《${current.title}》没保存上：${api.errorMessage(err)}；到「单独打开」里看看`, "error");
        });
      }
    },
    [group],
  );

  function onEditorKey(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    const ctrl = event.ctrlKey || event.metaKey;
    if (event.key === "Escape" || (ctrl && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s")) {
      event.preventDefault();
      event.stopPropagation();
      void saveEdit(true);
    }
  }

  /** 双击渲染好的正文：进入编辑，光标落在双击的那一块 */
  function onChapterDoubleClick(event: ReactMouseEvent<HTMLDivElement>, note: BookNote, shown: string): void {
    const target = event.target as HTMLElement;
    if (target.closest("a, button, input, textarea")) return;
    const block = target.closest<HTMLElement>("[data-line]");
    const line = block ? Number(block.dataset.line) : null;
    window.getSelection()?.removeAllRanges();
    void startEdit(note, caretForLine(note.body, shown, line));
  }

  /** 连读里点任务复选框：改那一章的源文件 */
  async function toggleChapterTask(note: BookNote, index: number): Promise<void> {
    if (toggling) return;
    const next = toggleTask(note.body, index);
    if (next === null) return;
    setToggling(note.id);
    try {
      const saved = await api.saveNote(note.id, { body: next, baseHash: note.hash });
      ownHashes.current.add(saved.hash);
      patchNote(note.id, saved.body, saved.hash);
      onChanged();
    } catch (err) {
      onToast(api.conflictInfo(err) ? `《${note.title}》刚在别处改过，已刷新，再点一次` : api.errorMessage(err), "error");
      await load();
    } finally {
      setToggling(null);
    }
  }

  /** 在此后新建一章：建好后直接进入编辑 */
  async function submitAdding(): Promise<void> {
    if (!adding || busy) return;
    const title = adding.title.trim();
    if (!title) return;
    if (editingRef.current && !(await saveEdit(true))) return;
    setBusy(true);
    try {
      const res = await createBookChapter({
        group,
        title,
        after: adding.after ?? undefined,
        baseHash: book?.index?.hash,
      });
      setAdding(null);
      const next = await getBook(group);
      setBook(next);
      onChanged();
      onToast(res.index.created ? `已新建《${title}》，并生成了目录` : `已新建《${title}》`, "ok");
      const made = [...next.chapters, ...next.unlisted].find(
        (chapter): chapter is BookNote & { kind?: "note" } => "id" in chapter && chapter.id === res.note.id,
      );
      if (made) void startEdit(made);
    } catch (err) {
      onToast(api.errorMessage(err), "error");
      await load();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  /** 书里的章节（含未排入目录的），按显示顺序；缺章为 null */
  const sections = useMemo(() => {
    if (!book) return [] as Array<{ key: string; note: BookNote | null; title: string; foreign: boolean; unlisted: boolean }>;
    const listed = book.chapters.map((chapter, i) =>
      chapter.kind === "note"
        ? { key: chapter.id, note: chapter as BookNote, title: chapter.title, foreign: chapter.foreign, unlisted: false }
        : { key: `missing-${i}-${chapter.title}`, note: null, title: chapter.title, foreign: false, unlisted: false },
    );
    const extra = book.unlisted.map((note) => ({ key: note.id, note, title: note.title, foreign: false, unlisted: true }));
    return [...listed, ...extra];
  }, [book]);

  // 渲染后从 DOM 收集目录（章标题 + 章内 h1–h3）
  useLayoutEffect(() => {
    const paper = paperRef.current;
    const elements = paper ? Array.from(paper.querySelectorAll<HTMLElement>(TOC_SELECTOR)) : [];
    tocElements.current = elements;
    setToc(
      buildBookToc(
        elements.map((el) =>
          el.classList.contains("book__chapter-title")
            ? { kind: "chapter" as const, level: 0, text: el.dataset.title ?? el.textContent ?? "" }
            : { kind: "heading" as const, level: Number(el.tagName.slice(1)), text: el.textContent ?? "" },
        ),
      ),
    );
  }, [sections, book, editing?.id]);

  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || toc.length === 0) {
      setActive(-1);
      return;
    }
    const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const tops = toc.map((item) => (tocElements.current[item.index]?.getBoundingClientRect().top ?? 0) - base);
    setActive(activeOutlineIndex(tops, scroller.scrollTop));
  }, [toc]);

  useEffect(() => {
    measure();
  }, [measure]);

  function scrollToElement(el: HTMLElement | undefined): void {
    const scroller = scrollRef.current;
    if (!scroller || !el) return;
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 16;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    scroller.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
  }

  function scrollToSection(index: number): void {
    const el = paperRef.current?.querySelector<HTMLElement>(`[data-section="${index}"]`);
    scrollToElement(el ?? undefined);
    el?.querySelector<HTMLElement>(".book__chapter-title")?.focus({ preventScroll: true });
  }

  /** 正文里的 [[链接]]：指向本书的章节就在本页滚过去，书外的照常打开 */
  function openLink(target: string): void {
    const at = findChapter(
      sections.map((section) => (section.note ? section.title : null)),
      target,
    );
    if (at >= 0) scrollToSection(at);
    else onOpenTitle(target);
  }

  // [ / ] 上一章 / 下一章
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "[" && event.key !== "]") return;
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      if (document.querySelector("[aria-modal='true']")) return;
      const scroller = scrollRef.current;
      const paper = paperRef.current;
      if (!scroller || !paper) return;
      const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
      const heads = Array.from(paper.querySelectorAll<HTMLElement>("[data-section]"));
      const tops = heads.map((el) => el.getBoundingClientRect().top - base);
      const next = stepChapter(tops, scroller.scrollTop, event.key === "]" ? 1 : -1);
      if (next < 0) return;
      event.preventDefault();
      scrollToSection(Number(heads[next].dataset.section));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  async function run(task: () => Promise<string>): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const message = await task();
      await load();
      onChanged();
      onToast(message, "ok");
    } catch (err) {
      onToast(api.errorMessage(err), "error");
      await load();
    } finally {
      setBusy(false);
    }
  }

  const generateIndex = () =>
    run(async () => {
      await writeBookIndex({ group });
      return "已生成目录，按现在的顺序写好了链接";
    });

  const addToIndex = (titles: string[]) =>
    run(async () => {
      if (!book?.index) throw new Error("还没有目录");
      await writeBookIndex({ group, titles, baseHash: book.index.hash });
      return titles.length === 1 ? `已把「${titles[0]}」加入目录` : `已把 ${titles.length} 篇加入目录`;
    });

  const createMissing = (title: string) =>
    run(async () => {
      await api.createNote({ title, body: `# ${title}\n`, tags: [], group });
      return `已新建「${title}」`;
    });

  function renderAdding() {
    if (!adding) return null;
    return (
      <form
        className="book__adding"
        onSubmit={(event) => {
          event.preventDefault();
          void submitAdding();
        }}
      >
        <input
          className="input book__adding-input"
          value={adding.title}
          onChange={(event) => setAdding({ ...adding, title: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setAdding(null);
            }
          }}
          placeholder="新一章的标题"
          aria-label="新一章的标题"
          autoFocus
          spellCheck={false}
        />
        <button type="submit" className="btn btn--small btn--primary" disabled={busy || !adding.title.trim()}>
          新建
        </button>
        <button type="button" className="btn btn--small" onClick={() => setAdding(null)}>
          取消
        </button>
      </form>
    );
  }

  const name = leafName(group);
  const chapterCount = book ? book.chapters.length : 0;
  const listedCount = book ? book.chapters.length : 0;

  return (
    <div className="book">
      {tocOpen && toc.length > 0 ? (
        <nav className="reader__toc book__toc" aria-label="连读目录">
          {toc.map((item, position) => (
            <button
              key={`${item.index}-${item.text}`}
              type="button"
              className={`reader__toc-item${item.depth === 0 ? " book__toc-chapter" : ""}${position === active ? " is-active" : ""}`}
              style={{ paddingLeft: `${10 + item.depth * 14}px` }}
              onClick={() => scrollToElement(tocElements.current[item.index])}
              aria-current={position === active ? "location" : undefined}
            >
              {item.text}
            </button>
          ))}
        </nav>
      ) : null}

      <div className="book__scroll" ref={scrollRef} onScroll={measure}>
        <article className="book__paper" ref={paperRef}>
          <header className="book__head">
            <div className="book__heading">
              <h1 className="book__title">{name}</h1>
              <p className="book__sub">
                {group}
                {book ? ` · ${chapterCount} 章${book.unlisted.length ? ` · ${book.unlisted.length} 篇未排入目录` : ""}` : ""}
              </p>
            </div>
            <div className="book__tools">
              <button
                type="button"
                className="icon-btn"
                onClick={() => setTocOpen((open) => !open)}
                title={tocOpen ? "收起目录" : "显示目录"}
                aria-label="连读目录"
                aria-pressed={tocOpen}
              >
                <Icon name="menu" size={16} />
              </button>
              {book?.index ? (
                <button type="button" className="btn btn--small" onClick={() => onOpenNote(book.index!.id)}>
                  编辑目录
                </button>
              ) : book ? (
                <button type="button" className="btn btn--small btn--primary" disabled={busy} onClick={() => void generateIndex()}>
                  生成目录
                </button>
              ) : null}
            </div>
          </header>

          {error ? <p className="book__notice book__notice--error">读取失败：{error}</p> : null}
          {!book && !error ? <p className="book__notice">正在读取…</p> : null}

          {book && !book.index ? (
            <p className="book__notice">
              还没有目录，现在按创建时间连读。点「生成目录」会新建一篇目录笔记，在里面调整 [[链接]] 的顺序就是调整章节顺序。
            </p>
          ) : null}
          {book && book.otherIndexes.length > 0 ? (
            <p className="book__notice">
              这个项目有 {book.otherIndexes.length + 1} 篇目录，用的是《{book.index?.title}》；其余：
              {book.otherIndexes.map((title) => `《${title}》`).join("")}
            </p>
          ) : null}

          {book?.index && book.index.body.trim() ? (
            <section className="book__overview" aria-label="总览">
              <Preview
                markdown={stripLeadingTitle(book.index.body, book.index.title)}
                notePath={book.index.path}
                knownTitles={knownTitles}
                onOpenWikilink={openLink}
                onFilterTag={onFilterTag}
              />
            </section>
          ) : null}

          {book && sections.length === 0 ? (
            <>
              <p className="book__notice">
                这个分组里还没有笔记。
                <button type="button" className="link-btn" onClick={() => setAdding({ after: null, title: "" })}>
                  新建第一章
                </button>
              </p>
              {adding && adding.after === null ? renderAdding() : null}
            </>
          ) : null}

          {sections.map((section, i) => {
            const firstUnlisted = section.unlisted && (i === 0 || !sections[i - 1].unlisted);
            const titleId = `book-ch-${i}`;
            const number = section.unlisted ? null : i + 1;
            const isEditing = Boolean(section.note && editing?.id === section.note.id);
            const shown = section.note ? stripLeadingTitle(section.note.body, section.title) : "";
            return (
              <div key={section.key}>
                {firstUnlisted ? (
                  <div className="book__divider">
                    <span>未排入目录</span>
                    {book?.index ? (
                      <button
                        type="button"
                        className="link-btn"
                        disabled={busy}
                        onClick={() => void addToIndex(book.unlisted.map((note) => note.title))}
                      >
                        全部加入目录
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <section
                  className={`book__chapter${section.note ? "" : " is-missing"}${isEditing ? " is-editing" : ""}`}
                  data-section={i}
                  data-editing={isEditing || undefined}
                  aria-labelledby={titleId}
                >
                  <header className="book__chapter-head">
                    {number !== null && listedCount > 0 ? <span className="book__chapter-num">{number}</span> : null}
                    <h2 className="book__chapter-title" id={titleId} data-title={section.title} tabIndex={-1}>
                      {section.title}
                    </h2>
                    {section.foreign && section.note?.group ? (
                      <span className="book__from" title="这一章属于别的分组">
                        来自 {section.note.group}
                      </span>
                    ) : null}
                    <span className="book__chapter-actions">
                      {isEditing && editing ? (
                        <>
                          <span className={`save-state save-state--${editStatus(editing)}`} aria-live="polite">
                            <span className="save-state__dot" aria-hidden="true" />
                            {EDIT_STATUS_TEXT[editStatus(editing)]}
                          </span>
                          <button
                            type="button"
                            className="btn btn--small btn--primary"
                            disabled={editing.status === "saving" || editing.status === "conflict"}
                            onClick={() => void saveEdit(true)}
                            title="保存并恢复成阅读（Esc / Ctrl+S）"
                          >
                            完成
                          </button>
                        </>
                      ) : null}
                      {section.unlisted ? (
                        <button
                          type="button"
                          className="btn btn--small"
                          disabled={busy}
                          onClick={() => void addToIndex([section.title])}
                        >
                          加入目录
                        </button>
                      ) : null}
                      {section.note && !isEditing ? (
                        <button
                          type="button"
                          className="icon-btn"
                          title="就地编辑这一章（也可以双击正文）"
                          aria-label={`编辑：${section.title}`}
                          onClick={() => void startEdit(section.note!)}
                        >
                          <Icon name="pen" size={14} />
                        </button>
                      ) : null}
                      {section.note && !section.unlisted ? (
                        <button
                          type="button"
                          className="icon-btn"
                          title="在此后新建一章"
                          aria-label={`在《${section.title}》之后新建一章`}
                          onClick={() => setAdding({ after: section.note!.id, title: "" })}
                        >
                          <Icon name="plus" size={14} />
                        </button>
                      ) : null}
                      {section.note ? (
                        <button
                          type="button"
                          className="icon-btn"
                          title="单独打开这一章"
                          aria-label={`单独打开：${section.title}`}
                          onClick={() => onOpenNote(section.note!.id)}
                        >
                          <Icon name="external" size={14} />
                        </button>
                      ) : null}
                    </span>
                  </header>
                  {isEditing && editing && section.note ? (
                    <>
                      {editing.status === "conflict" ? (
                        <div className="conflict book__conflict" role="alert">
                          <div className="conflict__text">
                            <strong>这一章在别处被改过了</strong>
                            <span>你在这里的修改还没保存。要以这里的为准覆盖，还是放弃这里的修改、换成磁盘上的版本？</span>
                          </div>
                          <div className="conflict__actions">
                            <button type="button" className="btn btn--small btn--warn" onClick={() => void overwriteConflict()}>
                              以我的覆盖
                            </button>
                            <button type="button" className="btn btn--small" onClick={() => void discardEdit()}>
                              放弃我的修改
                            </button>
                          </div>
                        </div>
                      ) : null}
                      {editing.status === "error" && editing.error ? (
                        <div className="error-bar book__conflict" role="alert">
                          <span>保存失败：{editing.error}</span>
                          <button type="button" className="btn btn--small" onClick={() => void saveEdit(false)}>
                            重试
                          </button>
                        </div>
                      ) : null}
                      <MarkdownTextarea
                        textareaRef={textareaRef}
                        className="book__editor"
                        value={editing.draft}
                        onChange={changeDraft}
                        noteId={editing.id}
                        selfTitle={editing.title}
                        onNotify={onToast}
                        autoSize
                        onKeyDown={onEditorKey}
                        ariaLabel={`编辑：${section.title}`}
                        placeholder="在这里写。Esc 或点别处保存。"
                      />
                    </>
                  ) : section.note ? (
                    section.note.body.trim() && shown.trim() ? (
                      <div
                        className="book__body"
                        onDoubleClick={(event) => onChapterDoubleClick(event, section.note!, shown)}
                        aria-busy={toggling === section.note.id || undefined}
                      >
                        <Preview
                          markdown={shown}
                          sourceLines
                          notePath={section.note.path}
                          knownTitles={knownTitles}
                          onOpenWikilink={openLink}
                          onFilterTag={onFilterTag}
                          onToggleTask={(taskIndex) => void toggleChapterTask(section.note!, taskIndex)}
                        />
                      </div>
                    ) : (
                      <p className="book__empty">
                        这一章还是空的。
                        <button type="button" className="link-btn" onClick={() => void startEdit(section.note!)}>
                          开始写
                        </button>
                      </p>
                    )
                  ) : (
                    <p className="book__empty">
                      还没有这篇。
                      <button type="button" className="link-btn" disabled={busy} onClick={() => void createMissing(section.title)}>
                        新建
                      </button>
                    </p>
                  )}
                </section>
                {section.note && adding?.after === section.note.id ? renderAdding() : null}
              </div>
            );
          })}
        </article>
      </div>
    </div>
  );
}
