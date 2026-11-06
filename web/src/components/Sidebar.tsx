import { useEffect, useMemo, useRef, useState } from "react";
import type { BackupStatus, NoteSummary, TagCount, TimelineItem } from "../api.ts";
import type { GroupView } from "../groups-api.ts";
import { dayKey, groupByDay, relativeTime } from "../lib/time.ts";
import { filterLabel, sameFilter, type Filter } from "../lib/nav.ts";

type Props = {
  filter: Filter;
  notes: NoteSummary[];
  tags: TagCount[];
  timeline: TimelineItem[];
  loading: boolean;
  error: string | null;
  activeNoteId: string | null;
  trashActive: boolean;
  reindexing: boolean;
  /** 分组列表（含空组与未分组计数） */
  groups: GroupView[];
  ungroupedCount: number;
  /** WebDAV 备份的一行状态；null 表示还没读到（或读失败）。 */
  backupStatus: BackupStatus | null;
  onFilter: (filter: Filter) => void;
  onOpenNote: (id: string) => void;
  onOpenTrash: () => void;
  onOpenSearch: () => void;
  onOpenCapture: () => void;
  onNewNote: () => void;
  onReindex: () => void;
  onReload: () => void;
  onOpenBackup: () => void;
  onOpenAi: () => void;
  aiActive: boolean;
  onCreateGroup: (name: string) => void;
  onRenameGroup: (from: string, to: string) => void;
  onDeleteGroup: (name: string) => void;
};

function TypeBadge({ type }: { type: NoteSummary["type"] }) {
  if (type === "note") return null;
  return <span className={`badge badge--${type}`}>{type === "idea" ? "idea" : "source"}</span>;
}

export default function Sidebar({
  filter,
  notes,
  tags,
  timeline,
  loading,
  error,
  activeNoteId,
  trashActive,
  reindexing,
  groups,
  ungroupedCount,
  backupStatus,
  onFilter,
  onOpenNote,
  onOpenTrash,
  onOpenSearch,
  onOpenCapture,
  onNewNote,
  onReindex,
  onReload,
  onOpenBackup,
  onOpenAi,
  aiActive,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
}: Props) {
  const [groupsOpen, setGroupsOpen] = useState(true);
  const [editing, setEditing] = useState<{ mode: "create" } | { mode: "rename"; from: string } | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // 内联输入框出现就聚焦（不用 window.prompt：Electron 壳里 prompt 是禁用的）
  useEffect(() => {
    if (editing) nameInputRef.current?.focus();
  }, [editing]);

  function commitEdit(): void {
    const value = nameDraft.trim();
    const current = editing;
    setEditing(null);
    if (!current || !value) return;
    if (current.mode === "create") onCreateGroup(value);
    else if (value !== current.from) onRenameGroup(current.from, value);
  }
  const dayGroups = useMemo(() => groupByDay(timeline), [timeline]);
  const ideaCount = useMemo(() => timeline.filter((item) => item.type === "idea").length, [timeline]);
  const activeTag = filter.kind === "tag" ? filter.tag : null;

  // 备份入口要压成一行，所以只留最关键的信息：未设置 / 上次失败 / 上次成功多久以前
  const backupLabel = !backupStatus
    ? "状态未知"
    : !backupStatus.configured
      ? "未设置"
      : backupStatus.lastError
        ? "上次失败"
        : backupStatus.lastSuccessAt
          ? relativeTime(backupStatus.lastSuccessAt)
          : "还没备份过";
  const backupModifier = !backupStatus || !backupStatus.configured
    ? " is-unset"
    : backupStatus.lastError
      ? " is-error"
      : " is-ok";
  const backupTitle = !backupStatus
    ? "WebDAV 备份：读不到状态，点开看看"
    : !backupStatus.configured
      ? "WebDAV 备份：还没设置服务"
      : `WebDAV 备份 · 待备份 ${backupStatus.pending} 篇 · 点开看详情`;

  function renderRow(note: { id: string; title: string; type: NoteSummary["type"]; updated: string }) {
    return (
      <button
        key={note.id}
        type="button"
        className={`note-row${activeNoteId === note.id ? " is-active" : ""}`}
        onClick={() => onOpenNote(note.id)}
        aria-current={activeNoteId === note.id ? "page" : undefined}
      >
        <span className="note-row__title">
          <span className="note-row__text">{note.title || "未命名"}</span>
          <TypeBadge type={note.type} />
        </span>
        <span className="note-row__meta">{relativeTime(note.updated)}</span>
      </button>
    );
  }

  function renderList() {
    if (loading && notes.length === 0) {
      return (
        <div className="skeleton-list" aria-label="正在加载笔记">
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton skeleton--short" />
        </div>
      );
    }

    if (error) {
      return (
        <div className="sidebar-error" role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn--small" onClick={onReload}>
            重试
          </button>
        </div>
      );
    }

    if (filter.kind === "timeline") {
      if (dayGroups.length === 0) return <p className="empty-hint">时间流还是空的。</p>;
      return dayGroups.map((group) => (
        <section key={group.key} className="daygroup">
          <button
            type="button"
            className="daygroup__head"
            onClick={() => onFilter({ kind: "day", day: group.key })}
            title="只看这一天"
          >
            {group.label}
            <span className="daygroup__count">{group.items.length}</span>
          </button>
          {group.items.map((item) => renderRow(item))}
        </section>
      ));
    }

    if (filter.kind === "day") {
      const items = timeline.filter((item) => dayKey(item.created) === filter.day);
      return (
        <>
          <button type="button" className="back-link" onClick={() => onFilter({ kind: "timeline" })}>
            ← 返回时间流
          </button>
          {items.length === 0 ? <p className="empty-hint">这一天没有笔记。</p> : items.map((item) => renderRow(item))}
        </>
      );
    }

    if (notes.length === 0) {
      if (filter.kind === "inbox") return <p className="empty-hint">收件箱是空的，按 Ctrl+Shift+Space 随手记一条。</p>;
      if (filter.kind === "tag") return <p className="empty-hint">#{filter.tag} 下还没有笔记。</p>;
      if (filter.kind === "group") return <p className="empty-hint">「{filter.name}」里还没有笔记。</p>;
      if (filter.kind === "none") return <p className="empty-hint">所有笔记都归好组了。</p>;
      return <p className="empty-hint">还没有笔记，按 Ctrl+N 新建第一条。</p>;
    }

    return notes.map((note) => renderRow(note));
  }

  return (
    <aside className="sidebar" aria-label="笔记导航">
      <div className="sidebar__brand">
        <div>
          <span className="sidebar__name">Study Notes</span>
          <span className="sidebar__sub">本地 Markdown 笔记</span>
        </div>
        <button type="button" className="icon-btn" onClick={onOpenCapture} title="快速捕获（Ctrl+Shift+Space）" aria-label="快速捕获">
          +
        </button>
      </div>

      <button type="button" className="search-entry" onClick={onOpenSearch}>
        <span className="search-entry__label">搜索笔记</span>
        <kbd>Ctrl K</kbd>
      </button>

      <button type="button" className="new-note-entry" onClick={onNewNote} title="新建笔记（Ctrl+N）">
        <span aria-hidden="true">＋</span>
        <span>新建笔记</span>
        <kbd>Ctrl N</kbd>
      </button>

      <nav className="sidebar__nav" aria-label="导航">
        <button
          type="button"
          className={`nav-item${filter.kind === "all" && !trashActive ? " is-active" : ""}`}
          onClick={() => onFilter({ kind: "all" })}
          aria-current={filter.kind === "all" && !trashActive ? "page" : undefined}
        >
          <span>全部笔记</span>
          <span className="nav-item__count">{timeline.length}</span>
        </button>
        <button
          type="button"
          className={`nav-item${filter.kind === "inbox" && !trashActive ? " is-active" : ""}`}
          onClick={() => onFilter({ kind: "inbox" })}
          aria-current={filter.kind === "inbox" && !trashActive ? "page" : undefined}
        >
          <span>收件箱</span>
          <span className="nav-item__count">{ideaCount}</span>
        </button>
        <button
          type="button"
          className={`nav-item${filter.kind === "timeline" && !trashActive ? " is-active" : ""}`}
          onClick={() => onFilter({ kind: "timeline" })}
          aria-current={filter.kind === "timeline" && !trashActive ? "page" : undefined}
        >
          <span>时间流</span>
        </button>
        <button
          type="button"
          className={`nav-item${trashActive ? " is-active" : ""}`}
          onClick={onOpenTrash}
          aria-current={trashActive ? "page" : undefined}
        >
          <span>回收站</span>
        </button>
      </nav>

      <section className="sidebar__groups" aria-label="分组">
        <div className="section-head">
          <button
            type="button"
            className="link-btn section-head__toggle"
            aria-expanded={groupsOpen}
            onClick={() => setGroupsOpen((value) => !value)}
            title={groupsOpen ? "收起分组" : "展开分组"}
          >
            <span aria-hidden="true">{groupsOpen ? "▾" : "▸"}</span> 分组
          </button>
          <button
            type="button"
            className="link-btn"
            title="新建一个分组"
            onClick={() => {
              setNameDraft("");
              setEditing({ mode: "create" });
            }}
          >
            ＋ 新建
          </button>
        </div>
        {editing ? (
          <form
            className="group-edit"
            onSubmit={(event) => {
              event.preventDefault();
              commitEdit();
            }}
          >
            <input
              ref={nameInputRef}
              className="group-edit__input"
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setEditing(null);
                }
              }}
              placeholder={editing.mode === "create" ? "新分组名，例如 Go 学习" : "新的分组名"}
              aria-label={editing.mode === "create" ? "新分组名" : "新的分组名"}
              spellCheck={false}
            />
            <button type="submit" className="icon-btn" title="确定" aria-label="确定">
              ✓
            </button>
            <button
              type="button"
              className="icon-btn"
              title="取消"
              aria-label="取消"
              onClick={() => setEditing(null)}
            >
              ✕
            </button>
          </form>
        ) : null}
        {groupsOpen ? (
          <ul className="group-list">
            {groups.length === 0 ? (
              <li className="empty-hint empty-hint--tiny">还没有分组。建一个，比如「Go 学习」。</li>
            ) : (
              groups.map((group) => {
                const active = filter.kind === "group" && sameFilter(filter, { kind: "group", name: group.name });
                return (
                  <li key={group.name} className={`group-row${active ? " is-active" : ""}`}>
                    <button
                      type="button"
                      className="group-row__main"
                      onClick={() => onFilter({ kind: "group", name: group.name })}
                      title={`${group.name}：${group.count} 篇${group.empty ? "（空组）" : ""}`}
                    >
                      <span className="group-row__name">{group.name}</span>
                      <span className="group-row__count">{group.count}</span>
                    </button>
                    <span className="group-row__actions">
                      <button
                        type="button"
                        className="icon-btn"
                        title="改分组名"
                        aria-label={`改分组名：${group.name}`}
                        onClick={() => {
                          setNameDraft(group.name);
                          setEditing({ mode: "rename", from: group.name });
                        }}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="删除分组（笔记退回未分组，不会被删）"
                        aria-label={`删除分组：${group.name}`}
                        onClick={() => {
                          const ok = window.confirm(
                            `删除分组「${group.name}」？组里的 ${group.count} 篇笔记会退回「未分组」，笔记本身不会被删除。`,
                          );
                          if (ok) onDeleteGroup(group.name);
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  </li>
                );
              })
            )}
            <li className={`group-row group-row--none${filter.kind === "none" ? " is-active" : ""}`}>
              <button type="button" className="group-row__main" onClick={() => onFilter({ kind: "none" })}>
                <span className="group-row__name">未分组</span>
                <span className="group-row__count">{ungroupedCount}</span>
              </button>
            </li>
          </ul>
        ) : null}
      </section>

      <section className="sidebar__tags" aria-label="标签云">
        <div className="section-head">
          <span>标签</span>
          {activeTag ? (
            <button type="button" className="link-btn" onClick={() => onFilter({ kind: "all" })}>
              清除
            </button>
          ) : null}
        </div>
        {tags.length === 0 ? (
          <p className="empty-hint empty-hint--tiny">正文里写 #标签 就会出现在这里。</p>
        ) : (
          <div className="tag-cloud">
            {tags.slice(0, 24).map((tag) => (
              <button
                key={tag.tag}
                type="button"
                className={`tag-chip${activeTag === tag.tag ? " is-active" : ""}`}
                onClick={() => onFilter(activeTag === tag.tag ? { kind: "all" } : { kind: "tag", tag: tag.tag })}
                title={`${tag.count} 条笔记`}
              >
                #{tag.tag}
                <span className="tag-chip__count">{tag.count}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="sidebar__list" aria-label={filterLabel(filter)}>
        <div className="section-head section-head--sticky">
          <span>{trashActive ? "回收站" : filterLabel(filter)}</span>
          {loading && notes.length > 0 ? <span className="section-head__hint">刷新中…</span> : null}
        </div>
        <div className="sidebar__scroller">{trashActive ? null : renderList()}</div>
      </section>

      <button
        type="button"
        className={`backup-entry${aiActive ? " is-active" : ""}`}
        onClick={onOpenAi}
        title="和 AI 对话：它能搜/读笔记，改笔记前会先给计划让你审批"
        aria-label="AI 对话"
      >
        <span className="backup-entry__dot" aria-hidden="true" />
        <span className="backup-entry__text">✨ AI 对话</span>
      </button>

      <button
        type="button"
        className={`backup-entry${backupModifier}`}
        onClick={onOpenBackup}
        title={backupTitle}
        aria-label={`WebDAV 备份：${backupLabel}`}
      >
        <span className="backup-entry__dot" aria-hidden="true" />
        <span className="backup-entry__text">备份 · {backupLabel}</span>
      </button>

      <footer className="sidebar__foot">
        <span className="muted">{timeline.length} 条笔记</span>
        <button type="button" className="link-btn" onClick={onReindex} disabled={reindexing}>
          {reindexing ? "重建中…" : "重建索引"}
        </button>
      </footer>
    </aside>
  );
}
