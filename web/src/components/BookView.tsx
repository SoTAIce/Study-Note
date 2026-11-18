import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as api from "../api.ts";
import { getBook, writeBookIndex, type Book, type BookNote } from "../book-api.ts";
import { activeOutlineIndex } from "../lib/reading.ts";
import { buildBookToc, findChapter, stepChapter, stripLeadingTitle, type BookTocItem } from "../lib/book.ts";
import { leafName } from "../lib/group-tree.ts";
import Icon from "./Icon.tsx";
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

const TOC_SELECTOR = ".book__chapter-title, .book__chapter .preview h1, .book__chapter .preview h2, .book__chapter .preview h3";

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/**
 * 连读（book-001）：目录笔记的正文作总览，链接顺序就是章节顺序，整个项目上下连成一篇。
 * 本期只读；就地编辑在 book-002。
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

  const load = useCallback(async () => {
    try {
      const next = await getBook(group);
      setBook(next);
      setError(null);
    } catch (err) {
      setError(api.errorMessage(err));
    }
  }, [group]);

  // 换了项目：从头读
  useEffect(() => {
    setBook(null);
    setError(null);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [group]);

  useEffect(() => {
    void load();
  }, [load, tick]);

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
  }, [sections, book]);

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

          {book && sections.length === 0 ? <p className="book__notice">这个分组里还没有笔记。</p> : null}

          {sections.map((section, i) => {
            const firstUnlisted = section.unlisted && (i === 0 || !sections[i - 1].unlisted);
            const titleId = `book-ch-${i}`;
            const number = section.unlisted ? null : i + 1;
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
                  className={`book__chapter${section.note ? "" : " is-missing"}`}
                  data-section={i}
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
                  {section.note ? (
                    section.note.body.trim() && stripLeadingTitle(section.note.body, section.title).trim() ? (
                      <Preview
                        markdown={stripLeadingTitle(section.note.body, section.title)}
                        notePath={section.note.path}
                        knownTitles={knownTitles}
                        onOpenWikilink={openLink}
                        onFilterTag={onFilterTag}
                      />
                    ) : (
                      <p className="book__empty">这一章还是空的。</p>
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
              </div>
            );
          })}
        </article>
      </div>
    </div>
  );
}
