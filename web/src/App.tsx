import { useEffect, useRef, useState } from "react";
import * as api from "./api.ts";
import type {
  BacklinksResult,
  BackupStatus,
  CaptureResult,
  ConflictInfo,
  NoteDetail,
  NoteSummary,
  TagCount,
  TimelineItem,
} from "./api.ts";
import Sidebar from "./components/Sidebar.tsx";
import EditorPane from "./components/EditorPane.tsx";
import type { SaveStatus } from "./components/EditorPane.tsx";
import RightRail from "./components/RightRail.tsx";
import SearchPalette from "./components/SearchPalette.tsx";
import CaptureModal from "./components/CaptureModal.tsx";
import TrashView from "./components/TrashView.tsx";
import ComposeView from "./components/ComposeView.tsx";
import AiChatPage from "./components/AiChatPage.tsx";
import PreviewOverlay from "./components/PreviewOverlay.tsx";
import BackupPanel from "./components/BackupPanel.tsx";
import HistoryPanel from "./components/HistoryPanel.tsx";
import NoteTabs from "./components/NoteTabs.tsx";
import * as groupsApi from "./groups-api.ts";
import type { GroupView } from "./groups-api.ts";
import { resolveKey } from "./lib/keyboard.ts";
import { filterLabel, type Filter } from "./lib/nav.ts";
import { closeNoteTab, renameNoteTab, upsertNoteTab, type NoteTab } from "./lib/note-tabs.ts";
import { isScreenVisible } from "./lib/screen-visibility.ts";
import { relativeTime } from "./lib/time.ts";
import {
  applyThemePref,
  nextThemePref,
  readThemePref,
  readViewMode,
  saveViewMode,
  THEME_LABEL,
  type ThemePref,
  type ViewMode,
} from "./lib/theme.ts";
import Icon from "./components/Icon.tsx";
import "./styles/app.css";

type Screen = "notes" | "trash" | "compose" | "ai";
type ToastKind = "info" | "ok" | "error";
type Toast = { id: number; text: string; kind: ToastKind };

const SAVE_DEBOUNCE_MS = 800;

export default function App() {
  // —— 左栏数据 ——
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [screen, setScreen] = useState<Screen>("notes");
  const [aiMounted, setAiMounted] = useState(false);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [ungroupedCount, setUngroupedCount] = useState(0);
  const [listsLoading, setListsLoading] = useState(true);
  const [listsError, setListsError] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);

  // —— 当前笔记与草稿 ——
  const [current, setCurrent] = useState<NoteDetail | null>(null);
  const [noteTabs, setNoteTabs] = useState<NoteTab[]>([]);
  const [draft, setDraft] = useState<{ title: string; body: string }>({ title: "", body: "" });
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [loadingNote, setLoadingNote] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  // —— 右栏 ——
  const [railOpen, setRailOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.innerWidth >= 1100;
  });
  const [backlinks, setBacklinks] = useState<BacklinksResult | null>(null);
  const [backlinksLoading, setBacklinksLoading] = useState(false);
  const [backlinksError, setBacklinksError] = useState<string | null>(null);
  const [selectionLength, setSelectionLength] = useState(0);
  const [aiFocusSignal, setAiFocusSignal] = useState(0);

  // —— 弹层 / 提示 ——
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  // —— WebDAV 备份（侧栏只显示一行状态，面板自己再拉详细状态） ——
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);

  // —— 新建页 / AI 整篇替换的撤销 ——
  const [composeBusy, setComposeBusy] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [aiUndoAvailable, setAiUndoAvailable] = useState(false);
  const aiUndoRef = useRef<string | null>(null);
  const composeReturnRef = useRef<Screen>("notes");

  // —— 全屏预览 ——
  const [previewFull, setPreviewFull] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // —— 外观：主题 / 编辑视图 / 窄屏导航抽屉 ——
  const [themePref, setThemePref] = useState<ThemePref>(() => readThemePref());
  const [viewMode, setViewMode] = useState<ViewMode>(() => readViewMode());
  const [navOpen, setNavOpen] = useState(false);

  // —— refs（自动保存与异步竞态） ——
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const saveTimer = useRef<number | null>(null);
  const savingRef = useRef(false);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const dirtyRef = useRef(false);
  const hashRef = useRef("");
  const noteIdRef = useRef<string | null>(null);
  const draftRef = useRef(draft);
  const conflictRef = useRef(false);
  /** 下一次保存要不要强制存一份历史版本：打开笔记后第一次保存 = edit，AI 改写后 = ai */
  const checkpointRef = useRef<"edit" | "ai" | null>(null);
  const listSeq = useRef(0);
  const navigateSeq = useRef(0);
  const toastTimer = useRef<number | null>(null);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    conflictRef.current = conflict !== null;
  }, [conflict]);

  useEffect(() => {
    document.title = current ? `${draft.title || current.meta.title} · Study Notes` : "Study Notes";
  }, [current, draft.title]);

  function cycleTheme(): void {
    const next = nextThemePref(themePref);
    applyThemePref(next);
    setThemePref(next);
    showToast(`主题：${THEME_LABEL[next]}`, "info");
  }

  function changeViewMode(mode: ViewMode): void {
    setViewMode(mode);
    saveViewMode(mode);
  }

  /** 窄屏下，左栏里点了东西就把抽屉收起来。 */
  function fromNav<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
    return (...args: A) => {
      setNavOpen(false);
      fn(...args);
    };
  }

  // —— 提示 ——
  function showToast(text: string, kind: ToastKind = "info"): void {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), text, kind });
    toastTimer.current = window.setTimeout(() => {
      toastTimer.current = null;
      setToast(null);
    }, 2400);
  }
  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, []);

  // —— 列表加载 ——
  async function loadList(target: Filter): Promise<void> {
    if (target.kind === "timeline" || target.kind === "day") {
      setNotes([]);
      setListsLoading(false);
      return;
    }
    const seq = ++listSeq.current;
    setListsLoading(true);
    setListsError(null);
    try {
      const opts =
        target.kind === "tag"
          ? { tag: target.tag }
          : target.kind === "inbox"
            ? { type: "idea" as const }
            : target.kind === "group"
              ? { group: target.name }
              : target.kind === "none"
                ? { group: "none" }
                : {};
      const res = await api.listNotes(opts);
      if (seq !== listSeq.current) return;
      setNotes(res.items);
    } catch (err) {
      if (seq !== listSeq.current) return;
      setListsError(api.errorMessage(err));
    } finally {
      if (seq === listSeq.current) setListsLoading(false);
    }
  }

  async function refreshSidebar(): Promise<void> {
    try {
      const [tagRes, timelineRes, groupRes] = await Promise.all([
        api.getTags(),
        api.getTimeline(),
        groupsApi.listGroups(),
      ]);
      setTags(tagRes.items);
      setTimeline(timelineRes.items);
      setGroups(groupRes.items);
      setUngroupedCount(groupRes.ungrouped);
    } catch (err) {
      setListsError(api.errorMessage(err));
    }
  }

  useEffect(() => {
    void loadList(filter);
    void refreshSidebar();
  }, [filter]);

  // —— 备份状态：只喂侧栏那一行字，读不到就当没有（不拿它打扰使用者） ——
  async function refreshBackupStatus(): Promise<void> {
    try {
      setBackupStatus(await api.getBackupStatus());
    } catch {
      setBackupStatus(null);
    }
  }

  useEffect(() => {
    void refreshBackupStatus();
  }, []);

  // —— 自动保存 ——
  function scheduleSave(delay = SAVE_DEBOUNCE_MS): void {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void doSave();
    }, delay);
  }

  async function doSave(): Promise<boolean> {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    // 已有保存在飞行中：等它结束再判断是否还有新改动。
    if (savingRef.current) {
      await savePromiseRef.current;
    }

    const id = noteIdRef.current;
    if (!id || !dirtyRef.current) return true;

    savingRef.current = true;
    const snapshot = {
      id,
      body: draftRef.current.body,
      title: draftRef.current.title,
      baseHash: hashRef.current,
      checkpoint: checkpointRef.current,
    };
    checkpointRef.current = null;
    setSaveStatus("saving");
    setSaveError(null);

    const task = (async (): Promise<boolean> => {
      try {
        const saved = await api.saveNote(snapshot.id, {
          body: snapshot.body,
          baseHash: snapshot.baseHash,
          title: snapshot.title.trim() ? snapshot.title.trim() : undefined,
          ...(snapshot.checkpoint ? { checkpoint: snapshot.checkpoint } : {}),
        });

        // 期间已经切换了笔记：这次结果只更新列表，不碰当前草稿。
        if (noteIdRef.current === snapshot.id) {
          hashRef.current = saved.hash;
          const stillDirty =
            draftRef.current.body !== snapshot.body || draftRef.current.title !== snapshot.title;
          dirtyRef.current = stillDirty;
          setCurrent((prev) =>
            prev && prev.id === saved.id
              ? { ...prev, meta: saved.meta, body: saved.body, hash: saved.hash, relPath: saved.relPath }
              : prev,
          );
          setDraft((prev) => ({
            title: prev.title.trim() ? prev.title : saved.meta.title,
            body: prev.body,
          }));
          setSaveStatus(stillDirty ? "dirty" : "saved");
          setNotes((prev) =>
            prev.map((note) =>
              note.id === saved.id
                ? { ...note, title: saved.meta.title, updated: saved.meta.updated, tags: saved.meta.tags }
                : note,
            ),
          );
          void refreshSidebar();
          void loadBacklinks(saved.id);
          if (stillDirty) scheduleSave(0);
        }
        return true;
      } catch (err) {
        if (noteIdRef.current === snapshot.id) {
          const info = api.conflictInfo(err);
          if (info) {
            setConflict(info);
            setSaveStatus("conflict");
            dirtyRef.current = false;
          } else {
            setSaveError(api.errorMessage(err));
            setSaveStatus("error");
            dirtyRef.current = true;
            // 没存成功：存档点要留给下一次重试
            if (snapshot.checkpoint && checkpointRef.current === null) checkpointRef.current = snapshot.checkpoint;
          }
        }
        return false;
      } finally {
        savingRef.current = false;
        savePromiseRef.current = null;
      }
    })();

    savePromiseRef.current = task;
    return task;
  }

  function applyDraftPatch(patch: Partial<{ title: string; body: string }>): void {
    setDraft((prev) => ({ ...prev, ...patch }));
    draftRef.current = { ...draftRef.current, ...patch };
    if (patch.title !== undefined && noteIdRef.current) {
      setNoteTabs((tabs) => renameNoteTab(tabs, noteIdRef.current!, patch.title!));
    }
    dirtyRef.current = true;
    setSaveError(null);
    if (conflictRef.current) return; // 冲突未决：不再自动覆盖
    setSaveStatus((prev) => (prev === "saving" ? prev : "dirty"));
    scheduleSave();
  }

  // —— 打开 / 关闭笔记 ——
  async function loadBacklinks(id: string): Promise<void> {
    if (noteIdRef.current !== id) return;
    setBacklinksLoading(true);
    setBacklinksError(null);
    try {
      const res = await api.getBacklinks(id);
      if (noteIdRef.current === id) setBacklinks(res);
    } catch (err) {
      if (noteIdRef.current === id) setBacklinksError(api.errorMessage(err));
    } finally {
      if (noteIdRef.current === id) setBacklinksLoading(false);
    }
  }

  function clearEditor(): void {
    noteIdRef.current = null;
    hashRef.current = "";
    dirtyRef.current = false;
    aiUndoRef.current = null;
    setAiUndoAvailable(false);
    setPreviewFull(false);
    setHistoryOpen(false);
    checkpointRef.current = null;
    setCurrent(null);
    setDraft({ title: "", body: "" });
    setSaveStatus("idle");
    setSaveError(null);
    setConflict(null);
    setBacklinks(null);
    setSelectionLength(0);
  }

  async function openNote(id: string): Promise<void> {
    if (noteIdRef.current === id) {
      setScreen("notes");
      return;
    }
    // 保存没成功（冲突/出错）就不切换：否则当前草稿会被覆盖，改动既没落盘也没提示
    if (!(await doSave())) {
      showToast("当前笔记还没保存成功，先处理冲突再切换", "error");
      return;
    }
    const seq = ++navigateSeq.current;
    setLoadingNote(true);
    setNoteError(null);
    setSelectionLength(0);
    try {
      const detail = await api.getNote(id);
      if (seq !== navigateSeq.current) return;
      noteIdRef.current = detail.id;
      hashRef.current = detail.hash;
      dirtyRef.current = false;
      checkpointRef.current = "edit";
      setHistoryOpen(false);
      aiUndoRef.current = null;
      setAiUndoAvailable(false);
      setCurrent(detail);
      setDraft({ title: detail.meta.title, body: detail.body });
      setNoteTabs((tabs) => upsertNoteTab(tabs, { id: detail.id, title: detail.meta.title }));
      setSaveStatus("saved");
      setSaveError(null);
      setConflict(null);
      setScreen("notes");
      void loadBacklinks(detail.id);
    } catch (err) {
      if (seq !== navigateSeq.current) return;
      setNoteError(api.errorMessage(err));
      setCurrent(null);
      setDraft({ title: "", body: "" });
    } finally {
      if (seq === navigateSeq.current) setLoadingNote(false);
    }
  }

  /** 回到首页（欢迎界面）：那里是「新建笔记」的入口，不再一进来就困在编辑器里。 */
  async function goHome(): Promise<void> {
    if (!(await doSave())) {
      showToast("当前笔记还没保存成功，先处理冲突再离开", "error");
      return;
    }
    clearEditor();
    setScreen("notes");
  }

  async function closeTab(id: string): Promise<void> {
    const currentId = noteIdRef.current;
    const visibleActiveId = screen === "notes" ? currentId : null;
    if (currentId === id && !(await doSave())) {
      showToast("当前笔记还没保存成功，先处理冲突再关闭", "error");
      return;
    }

    const result = closeNoteTab(noteTabs, id, visibleActiveId);
    setNoteTabs(result.tabs);
    if (currentId !== id) return;

    if (visibleActiveId !== id) {
      clearEditor();
      return;
    }

    if (result.nextActiveId) {
      await openNote(result.nextActiveId);
    } else {
      clearEditor();
      setScreen("notes");
    }
  }

  /** 打开「新建笔记」页：不落盘，取消就什么都不留。 */
  async function openCompose(): Promise<void> {
    if (!(await doSave())) {
      showToast("当前笔记还没保存成功，先处理冲突再新建", "error");
      return;
    }
    composeReturnRef.current = screen;
    setComposeError(null);
    setScreen("compose");
  }

  function cancelCompose(): void {
    setScreen(composeReturnRef.current);
    setComposeError(null);
  }

  async function createFromCompose(input: { title: string; body: string; group: string | null }): Promise<void> {
    if (composeBusy) return;
    setComposeBusy(true);
    setComposeError(null);
    const nextFilter: Filter = { kind: "all" };
    try {
      const created = await api.createNote({
        title: input.title || undefined,
        body: input.body,
        tags: [],
        ...(input.group ? { group: input.group } : {}),
      });
      setFilter(nextFilter);
      setScreen("notes");
      await Promise.all([loadList(nextFilter), refreshSidebar()]);
      await openNote(created.id);
      showToast(input.group ? `已创建，放进「${input.group}」` : "已创建，开始写吧", "ok");
      window.requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (err) {
      setComposeError(api.errorMessage(err));
    } finally {
      setComposeBusy(false);
    }
  }

  // —— 分组：新建 / 改名 / 删除 / 把当前笔记移进去 ——
  async function handleCreateGroup(name: string): Promise<void> {
    try {
      const res = await groupsApi.createGroup(name);
      await refreshSidebar();
      showToast(res.created ? `已建分组「${name}」` : `分组「${name}」已经有了`, "ok");
    } catch (err) {
      showToast(`新建分组失败：${api.errorMessage(err)}`, "error");
    }
  }

  async function handleRenameGroup(from: string, to: string): Promise<void> {
    try {
      const res = await groupsApi.renameGroup(from, to);
      const failed = res.failed.length;
      // 当前正开着这个组里的笔记：跟着改筛选，别让用户看着空列表
      const followUp: Filter =
        filter.kind === "group" && filter.name.toLowerCase() === from.toLowerCase() ? { kind: "group", name: to } : filter;
      if (followUp !== filter) setFilter(followUp);
      await Promise.all([loadList(followUp), refreshSidebar()]);
      if (current) await refreshCurrentNote();
      showToast(
        failed === 0 ? `已改名为「${to}」` : `已改名，但有 ${failed} 篇没改成功（可能刚被外部改过）`,
        failed === 0 ? "ok" : "error",
      );
    } catch (err) {
      showToast(`改名失败：${api.errorMessage(err)}`, "error");
    }
  }

  async function handleDeleteGroup(name: string): Promise<void> {
    try {
      const res = await groupsApi.deleteGroup(name);
      const followUp: Filter =
        filter.kind === "group" && filter.name.toLowerCase() === name.toLowerCase() ? { kind: "all" } : filter;
      if (followUp !== filter) setFilter(followUp);
      await Promise.all([loadList(followUp), refreshSidebar()]);
      if (current) await refreshCurrentNote();
      showToast(
        res.failed.length === 0
          ? `已删除分组「${name}」，${res.ungrouped} 篇笔记退回未分组`
          : `分组已删，但 ${res.failed.length} 篇没改成功`,
        res.failed.length === 0 ? "ok" : "error",
      );
    } catch (err) {
      showToast(`删除分组失败：${api.errorMessage(err)}`, "error");
    }
  }

  /** 重新读当前笔记的元信息（移动/改名会改磁盘 hash，不刷新会让下次保存撞冲突）。 */
  async function refreshCurrentNote(): Promise<void> {
    const id = noteIdRef.current;
    if (!id) return;
    try {
      const detail = await api.getNote(id);
      if (noteIdRef.current !== id) return;
      hashRef.current = detail.hash;
      setCurrent(detail);
      setNotes((prev) =>
        prev.map((note) => (note.id === detail.id ? { ...note, group: detail.meta.group ?? detail.group ?? null } : note)),
      );
    } catch (err) {
      // 读不到就别装作同步好了：告诉用户，下一次保存可能撞冲突，好过他莫名其妙失败
      showToast(`刷新笔记状态失败：${api.errorMessage(err)}`, "error");
    }
  }

  /** 把当前笔记移到某个组（null = 移出分组）。组织动作不改 updated，也不写历史。 */
  async function handleMoveToGroup(group: string | null): Promise<boolean> {
    const note = current;
    if (!note) return false;
    const before = note.meta.group ?? null;
    // 大小写不同算同一个组（服务端也不区分大小写），别再发一次没用的移动
    if ((before ?? "").toLowerCase() === (group ?? "").toLowerCase()) return true;
    if (!(await doSave())) {
      showToast("当前笔记还没保存成功，先处理冲突再分组", "error");
      return false;
    }
    try {
      // 带上 baseHash：移动前如果有人改过磁盘上的文件，这里会 409 而不是覆盖掉
      await groupsApi.moveNote(note.id, group, hashRef.current ?? undefined);
      // hash 变了，先刷新当前笔记，再刷列表/侧栏，免得下次保存用旧 hash 撞冲突
      await refreshCurrentNote();
      const followUp: Filter = filter.kind === "group" || filter.kind === "none" ? { kind: "all" } : filter;
      if (followUp !== filter) setFilter(followUp);
      await Promise.all([loadList(followUp), refreshSidebar()]);
      showToast(group ? `已移到「${group}」` : "已移出分组", "ok");
      return true;
    } catch (err) {
      showToast(`分组失败：${api.errorMessage(err)}`, "error");
      return false;
    }
  }

  /** AI 整篇替换：记下旧正文，编辑页会出现「撤销 AI 改写」。 */
  function replaceWholeBody(next: string): void {
    const prev = draftRef.current.body;
    aiUndoRef.current = prev;
    checkpointRef.current = "ai";
    setAiUndoAvailable(true);
    setDraft((currentDraft) => ({ ...currentDraft, body: next }));
    draftRef.current = { ...draftRef.current, body: next };
    dirtyRef.current = true;
    setSaveError(null);
    if (!conflictRef.current) {
      setSaveStatus((prevStatus) => (prevStatus === "saving" ? prevStatus : "dirty"));
      scheduleSave();
    }
    showToast("已整篇替换，可用「撤销 AI 改写」还原", "ok");
  }

  function undoReplace(): void {
    const prev = aiUndoRef.current;
    if (prev === null) return;
    aiUndoRef.current = null;
    setAiUndoAvailable(false);
    setDraft((currentDraft) => ({ ...currentDraft, body: prev }));
    draftRef.current = { ...draftRef.current, body: prev };
    dirtyRef.current = true;
    setSaveError(null);
    if (!conflictRef.current) {
      setSaveStatus((prevStatus) => (prevStatus === "saving" ? prevStatus : "dirty"));
      scheduleSave();
    }
    showToast("已还原到 AI 改写前", "ok");
  }

  /** 双链 / 出链里点到不存在的标题：按标题建一条。 */
  async function openTitle(title: string): Promise<void> {
    const found =
      timeline.find((item) => item.title === title) ?? notes.find((item) => item.title === title);
    if (found) {
      await openNote(found.id);
      return;
    }
    try {
      const created = await api.createNote({ title, body: `# ${title}\n`, tags: [] });
      await Promise.all([refreshSidebar(), loadList(filter)]);
      await openNote(created.id);
      showToast(`已新建「${title}」`, "ok");
    } catch (err) {
      showToast(`新建「${title}」失败：${api.errorMessage(err)}`, "error");
    }
  }

  async function deleteCurrent(): Promise<void> {
    const note = current;
    if (!note) return;
    const ok = window.confirm(`删除「${note.meta.title}」？会先移入回收站。`);
    if (!ok) return;
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    dirtyRef.current = false;
    try {
      await api.deleteNote(note.id);
      const result = closeNoteTab(noteTabs, note.id, note.id);
      setNoteTabs(result.tabs);
      if (noteIdRef.current === note.id) {
        clearEditor();
        if (result.nextActiveId) await openNote(result.nextActiveId);
      }
      await Promise.all([loadList(filter), refreshSidebar()]);
      showToast("已移入回收站", "ok");
    } catch (err) {
      showToast(`删除失败：${api.errorMessage(err)}`, "error");
    }
  }

  // —— 409 冲突处理 ——
  async function resolveOverwrite(): Promise<void> {
    const info = conflict;
    const id = noteIdRef.current;
    if (!info || !id) return;
    hashRef.current = info.currentHash; // 以磁盘 hash 作为 baseHash，强制覆盖
    setConflict(null);
    dirtyRef.current = true;
    await doSave();
  }

  async function resolveReload(message = "已重新加载磁盘版本"): Promise<void> {
    const id = noteIdRef.current;
    if (!id) return;
    const seq = ++navigateSeq.current;
    setLoadingNote(true);
    try {
      const detail = await api.getNote(id);
      if (seq !== navigateSeq.current) return;
      hashRef.current = detail.hash;
      dirtyRef.current = false;
      setCurrent(detail);
      setDraft({ title: detail.meta.title, body: detail.body });
      setConflict(null);
      setSaveError(null);
      setSaveStatus("saved");
      setSelectionLength(0);
      void loadBacklinks(detail.id);
      showToast(message, "ok");
    } catch (err) {
      showToast(`重新加载失败：${api.errorMessage(err)}`, "error");
    } finally {
      if (seq === navigateSeq.current) setLoadingNote(false);
    }
  }

  // —— 历史版本 ——
  function openHistory(): void {
    if (screen !== "notes" || !noteIdRef.current) return;
    // 打开前先把手上的改动落盘，列表才包含这次保存拍下的那一份
    void doSave().finally(() => setHistoryOpen(true));
  }

  async function restoreFromHistory(versionId: string, label: string): Promise<boolean> {
    const id = noteIdRef.current;
    if (!id) return false;
    if (!(await doSave())) {
      showToast("当前笔记还没保存成功，先处理冲突再恢复", "error");
      return false;
    }
    try {
      await api.restoreHistoryVersion(id, versionId, hashRef.current);
    } catch (err) {
      const info = api.conflictInfo(err);
      showToast(
        info ? "文件刚被外部改过，先关掉面板确认最新内容再恢复" : `恢复失败：${api.errorMessage(err)}`,
        "error",
      );
      return false;
    }
    aiUndoRef.current = null;
    setAiUndoAvailable(false);
    await resolveReload(`已恢复到 ${label} 的版本；恢复前的内容在历史版本里`);
    void Promise.all([loadList(filter), refreshSidebar()]);
    return true;
  }

  // —— 捕获 / 回收站 / 重建索引 ——
  async function handleCaptured(result: CaptureResult): Promise<void> {
    await Promise.all([loadList(filter), refreshSidebar()]);
    showToast(`已收进 inbox：${result.title || "新想法"}`, "ok");
  }

  async function handleRestored(relPath: string): Promise<void> {
    await Promise.all([loadList(filter), refreshSidebar()]);
    showToast(`已恢复：${relPath}`, "ok");
  }

  /**
   * 备份面板恢复单篇之后：刷新列表；如果恢复的正是编辑器里这篇，重载它，
   * 否则编辑器里还握着恢复前的 hash，下一次自动保存会撞出一个莫名其妙的 409。
   */
  async function handleBackupRestored(relPath: string): Promise<void> {
    await Promise.all([loadList(filter), refreshSidebar()]);
    void refreshBackupStatus();
    if (current && current.relPath === relPath) {
      void resolveReload();
      return;
    }
    showToast(`已从备份恢复：${relPath}`, "ok");
  }

  async function reindexNow(): Promise<void> {
    setReindexing(true);
    try {
      const res = await api.reindex();
      await Promise.all([loadList(filter), refreshSidebar()]);
      const failed = res.failed ?? 0;
      showToast(
        failed > 0
          ? `索引重建完成：${res.indexed} 条，但有 ${failed} 篇读不了（文件被占用或编码异常）`
          : `索引重建完成：${res.indexed} 条`,
        failed > 0 ? "error" : "ok",
      );
    } catch (err) {
      showToast(`重建索引失败：${api.errorMessage(err)}`, "error");
    } finally {
      setReindexing(false);
    }
  }

  // —— 编辑器选区 / AI 插入 ——
  function getSelection(): string {
    const textarea = textareaRef.current;
    if (!textarea) return "";
    const body = draftRef.current.body;
    return body.slice(textarea.selectionStart ?? 0, textarea.selectionEnd ?? 0);
  }

  function insertAiText(text: string, where: "cursor" | "end" | "replace"): void {
    const body = draftRef.current.body;
    const textarea = textareaRef.current;
    const start = textarea ? (textarea.selectionStart ?? body.length) : body.length;
    const end = textarea ? (textarea.selectionEnd ?? body.length) : body.length;

    let insertAt = start;
    let removeTo = end;
    let payload = text;
    if (where === "end") {
      insertAt = body.length;
      removeTo = body.length;
      payload = `${body && !body.endsWith("\n") ? "\n\n" : ""}${text}\n`;
    } else if (where === "cursor") {
      removeTo = start;
    }

    const next = body.slice(0, insertAt) + payload + body.slice(removeTo);
    checkpointRef.current = "ai";
    setDraft((prev) => ({ ...prev, body: next }));
    draftRef.current = { ...draftRef.current, body: next };
    dirtyRef.current = true;
    setSaveError(null);
    if (!conflictRef.current) {
      setSaveStatus((prev) => (prev === "saving" ? prev : "dirty"));
      scheduleSave();
    }

    const caret = insertAt + payload.length;
    window.requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(caret, caret);
      setSelectionLength(0);
    });
    showToast("已插入 AI 建议", "ok");
  }

  // —— 快捷键 ——
  const keyContext = useRef({
    modalOpen: false,
    openPalette: () => undefined as void,
    openCapture: () => undefined as void,
    createNote: () => undefined as void,
    saveNow: () => undefined as void,
    focusAi: () => undefined as void,
    togglePreview: () => undefined as void,
    openHistory: () => undefined as void,
  });
  keyContext.current = {
    modalOpen: paletteOpen || captureOpen || previewFull || backupOpen || historyOpen || screen === "ai",
    openPalette: () => setPaletteOpen(true),
    openCapture: () => setCaptureOpen(true),
    createNote: () => void openCompose(),
    saveNow: () => void doSave(),
    focusAi: () => {
      setRailOpen(true);
      setAiFocusSignal((value) => value + 1);
    },
    togglePreview: () => {
      if (screen !== "notes" || !current) return;
      setPreviewFull((value) => !value);
    },
    openHistory: () => {
      if (!current) return;
      openHistory();
    },
  };

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const action = resolveKey(event);
      if (!action) return;
      const context = keyContext.current;
      if (context.modalOpen) return;
      event.preventDefault();
      switch (action) {
        case "search":
          context.openPalette();
          break;
        case "new":
          context.createNote();
          break;
        case "save":
          context.saveNow();
          break;
        case "ai":
          context.focusAi();
          break;
        case "capture":
          context.openCapture();
          break;
        case "preview":
          context.togglePreview();
          break;
        case "history":
          context.openHistory();
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!navOpen) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") setNavOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent): void {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // —— 渲染 ——
  const railVisible = railOpen && screen === "notes" && current !== null;
  const aiVisible = isScreenVisible(screen, "ai");
  // 时间流按创建时间排序；「最近更新」要按 updated 重新排一次
  const recent = [...timeline].sort((x, y) => (x.updated < y.updated ? 1 : x.updated > y.updated ? -1 : 0)).slice(0, 6);
  const ideaCount = timeline.filter((item) => item.type === "idea").length;
  const hour = new Date().getHours();
  const greeting = hour < 5 ? "夜深了" : hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
  const todayLabel = new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
  const mobileTitle =
    screen === "ai"
      ? "AI 对话"
      : screen === "trash"
        ? "回收站"
        : screen === "compose"
          ? "新建笔记"
          : current
            ? draft.title || current.meta.title || "未命名"
            : "Study Notes";

  return (
    <div className={`app${railVisible ? " app--rail" : ""}`}>
      <Sidebar
        filter={filter}
        notes={notes}
        tags={tags}
        timeline={timeline}
        loading={listsLoading}
        error={listsError}
        activeNoteId={current?.id ?? null}
        trashActive={screen === "trash"}
        reindexing={reindexing}
        groups={groups}
        ungroupedCount={ungroupedCount}
        backupStatus={backupStatus}
        onFilter={fromNav((next: Filter) => {
          setScreen("notes");
          setFilter(next);
        })}
        onOpenNote={fromNav((id: string) => void openNote(id))}
        onOpenTrash={fromNav(() => {
          void doSave();
          setScreen("trash");
          setBacklinks(null);
        })}
        onOpenSearch={fromNav(() => setPaletteOpen(true))}
        onOpenCapture={fromNav(() => setCaptureOpen(true))}
        onNewNote={fromNav(() => void openCompose())}
        onReindex={() => void reindexNow()}
        onReload={() => {
          void loadList(filter);
          void refreshSidebar();
        }}
        onOpenBackup={fromNav(() => setBackupOpen(true))}
        onOpenAi={fromNav(() => {
          setAiMounted(true);
          setScreen("ai");
          setRailOpen(false);
        })}
        aiActive={screen === "ai"}
        onCreateGroup={(name) => void handleCreateGroup(name)}
        onRenameGroup={(from, to) => void handleRenameGroup(from, to)}
        onDeleteGroup={(name) => void handleDeleteGroup(name)}
        open={navOpen}
        onClose={() => setNavOpen(false)}
        themePref={themePref}
        onCycleTheme={cycleTheme}
      />

      {navOpen ? (
        <button type="button" className="nav-backdrop" aria-label="关闭导航" onClick={() => setNavOpen(false)} />
      ) : null}

      <main className="main" aria-label="编辑区">
        <div className="mobilebar">
          <button type="button" className="icon-btn" onClick={() => setNavOpen(true)} aria-label="打开导航">
            <Icon name="menu" size={18} />
          </button>
          <span className="mobilebar__title">{mobileTitle}</span>
          <button type="button" className="icon-btn" onClick={() => setPaletteOpen(true)} aria-label="搜索">
            <Icon name="search" size={17} />
          </button>
          <button type="button" className="icon-btn" onClick={() => void openCompose()} aria-label="新建笔记">
            <Icon name="plus" size={18} />
          </button>
        </div>
        <NoteTabs
          tabs={noteTabs}
          activeId={screen === "notes" ? current?.id ?? null : null}
          onActivate={(id) => void openNote(id)}
          onClose={(id) => void closeTab(id)}
        />
        {aiMounted ? (
          <div className="screen-host" hidden={!aiVisible} aria-hidden={!aiVisible || undefined}>
            <AiChatPage
              onNotesChanged={() => {
                void loadList(filter);
                void refreshSidebar();
              }}
            />
          </div>
        ) : null}
        <div className="screen-host" hidden={aiVisible} aria-hidden={aiVisible || undefined}>
          {screen === "compose" ? (
            <ComposeView
              busy={composeBusy}
              error={composeError}
              groups={groups.map((group) => group.name)}
              onCancel={cancelCompose}
              onCreate={(input) => void createFromCompose(input)}
            />
          ) : screen === "trash" ? (
            <TrashView onBack={() => setScreen("notes")} onRestored={(relPath) => void handleRestored(relPath)} />
          ) : loadingNote && !current ? (
            <div className="pane-state">
              <p>正在读取笔记…</p>
            </div>
          ) : noteError ? (
            <div className="pane-state pane-state--error" role="alert">
              <p>打开笔记失败：{noteError}</p>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => {
                  setNoteError(null);
                  setScreen("notes");
                }}
              >
                返回列表
              </button>
            </div>
          ) : current ? (
            <EditorPane
              note={current}
              title={draft.title}
              body={draft.body}
              tags={current.tags}
              groups={groups.map((group) => group.name)}
              onMoveToGroup={(group) => handleMoveToGroup(group)}
              status={saveStatus}
              saveError={saveError}
              conflict={conflict}
              textareaRef={textareaRef}
              railOpen={railOpen}
              onChangeTitle={(value) => applyDraftPatch({ title: value })}
              onChangeBody={(value) => applyDraftPatch({ body: value })}
              onSaveNow={() => void doSave()}
              onRetrySave={() => void doSave()}
              onDelete={() => void deleteCurrent()}
              onToggleRail={() => setRailOpen((value) => !value)}
              onResolveOverwrite={() => void resolveOverwrite()}
              onResolveReload={() => void resolveReload()}
              onOpenWikilink={(target) => void openTitle(target)}
              onFilterTag={(tag) => {
                setScreen("notes");
                setFilter({ kind: "tag", tag });
              }}
              onSelectionChange={setSelectionLength}
              onGoHome={() => void goHome()}
              onOpenPreviewFull={() => setPreviewFull(true)}
              aiUndoAvailable={aiUndoAvailable}
              onUndoAiReplace={undoReplace}
              viewMode={viewMode}
              onViewMode={changeViewMode}
              onOpenHistory={openHistory}
            />
          ) : (
            <section className="welcome">
              <div className="welcome__inner">
                <p className="welcome__kicker">
                  <span className="welcome__kicker-dot">
                    <Icon name="check" size={11} strokeWidth={2.6} />
                  </span>
                  Markdown 是唯一真源 · 数据只在本机
                </p>
                <p className="welcome__greet">
                  {greeting}，今天是{todayLabel}
                </p>
                <h1>
                  记下来，<em>再说整理。</em>
                </h1>
                <p className="welcome__lede">
                  左栏是笔记、分组与标签，中间写，右边是双链和 AI。所有内容都保存在 <code>data/notes</code> 里的
                  .md 文件中，随时能用别的编辑器打开。
                </p>

                <div className="welcome__stats">
                  <button type="button" className="stat-card" onClick={() => setFilter({ kind: "all" })}>
                    <span className="stat-card__label">
                      <Icon name="notes" size={14} />
                      全部笔记
                    </span>
                    <span className="stat-card__value">{timeline.length}</span>
                  </button>
                  <button
                    type="button"
                    className="stat-card"
                    style={{ ["--stat-tone" as string]: "var(--warn)" }}
                    onClick={() => setFilter({ kind: "inbox" })}
                  >
                    <span className="stat-card__label">
                      <Icon name="lightbulb" size={14} />
                      收件箱想法
                    </span>
                    <span className="stat-card__value">{ideaCount}</span>
                  </button>
                  <div
                    className="stat-card"
                    style={{ ["--stat-tone" as string]: "var(--ok)" }}
                  >
                    <span className="stat-card__label">
                      <Icon name="hash" size={14} />
                      标签
                    </span>
                    <span className="stat-card__value">{tags.length}</span>
                  </div>
                  <div
                    className="stat-card"
                    style={{ ["--stat-tone" as string]: "var(--accent)" }}
                  >
                    <span className="stat-card__label">
                      <Icon name="folder" size={14} />
                      分组
                    </span>
                    <span className="stat-card__value">{groups.length}</span>
                  </div>
                </div>

                <div className="welcome__actions">
                  <button type="button" className="action-card action-card--primary" onClick={() => void openCompose()}>
                    <span className="action-card__icon">
                      <Icon name="plus" size={18} strokeWidth={2.2} />
                    </span>
                    <span className="action-card__title">新建笔记</span>
                    <span className="action-card__desc">从一个标题开始，Markdown 实时预览</span>
                    <kbd>Ctrl N</kbd>
                  </button>
                  <button
                    type="button"
                    className="action-card action-card--capture"
                    onClick={() => setCaptureOpen(true)}
                  >
                    <span className="action-card__icon">
                      <Icon name="zap" size={18} />
                    </span>
                    <span className="action-card__title">快速捕获</span>
                    <span className="action-card__desc">一闪而过的想法先丢进收件箱</span>
                    <kbd>Ctrl ⇧ Space</kbd>
                  </button>
                  <button type="button" className="action-card" onClick={() => setPaletteOpen(true)}>
                    <span className="action-card__icon">
                      <Icon name="search" size={18} />
                    </span>
                    <span className="action-card__title">全文搜索</span>
                    <span className="action-card__desc">标题、正文、标签一起搜</span>
                    <kbd>Ctrl K</kbd>
                  </button>
                </div>

                {recent.length > 0 ? (
                  <div className="welcome__recent">
                    <h2>
                      最近更新
                      <span>{filterLabel(filter)}</span>
                    </h2>
                    <ul>
                      {recent.map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            className="welcome__recentitem"
                            onClick={() => void openNote(item.id)}
                          >
                            <span className="welcome__recenthead">
                              <Icon name={item.type === "idea" ? "lightbulb" : "notes"} size={15} />
                              <span className="welcome__recenttitle">{item.title || "未命名"}</span>
                            </span>
                            <span className="welcome__recentmeta">
                              {item.type === "idea" ? <span className="badge badge--idea">idea</span> : null}
                              <Icon name="clock" size={11} />
                              {relativeTime(item.updated)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="welcome__empty">
                    <Icon name="lightbulb" size={18} />
                    还没有笔记。新建一条，或者按 Ctrl+Shift+Space 先把想法收进收件箱。
                  </p>
                )}

                {listsError ? (
                  <p className="welcome__error" role="alert">
                    加载失败：{listsError}
                  </p>
                ) : null}
              </div>
            </section>
          )}
        </div>
      </main>

      {railVisible ? (
        <>
          <button
            type="button"
            className="rail-backdrop"
            aria-label="关闭关联面板"
            onClick={() => setRailOpen(false)}
          />
          <RightRail
            backlinks={backlinks}
            loading={backlinksLoading}
            error={backlinksError}
            onReload={() => {
              if (current) void loadBacklinks(current.id);
            }}
            onOpenNote={(id) => void openNote(id)}
            onOpenTitle={(title) => void openTitle(title)}
            onClose={() => setRailOpen(false)}
            ai={{
              noteId: current?.id ?? null,
              noteTitle: draft.title,
              noteBody: draft.body,
              selectionLength,
              getSelection,
              onInsert: insertAiText,
              onReplaceAll: replaceWholeBody,
              focusSignal: aiFocusSignal,
              beforeRun: async () => {
                await doSave();
              },
            }}
          />
        </>
      ) : null}

      <SearchPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenNote={(id) => void openNote(id)}
      />

      {previewFull && current ? (
        <PreviewOverlay
          title={draft.title || current.meta.title}
          body={draft.body}
          onExit={() => setPreviewFull(false)}
          onOpenWikilink={(target) => void openTitle(target)}
          onFilterTag={(tag) => {
            setPreviewFull(false);
            setFilter({ kind: "tag", tag });
          }}
        />
      ) : null}

      {current ? (
        <HistoryPanel
          open={historyOpen && screen === "notes"}
          noteId={current.id}
          noteTitle={draft.title || current.meta.title}
          currentBody={draft.body}
          onClose={() => setHistoryOpen(false)}
          onRestore={restoreFromHistory}
        />
      ) : null}

      <CaptureModal
        open={captureOpen}
        onClose={() => setCaptureOpen(false)}
        onCaptured={(result) => void handleCaptured(result)}
      />

      <BackupPanel
        open={backupOpen}
        onClose={() => {
          setBackupOpen(false);
          // 面板里可能刚备份过或改过设置，关掉时把侧栏那行字对齐一次
          void refreshBackupStatus();
        }}
        localPaths={timeline.map((item) => item.relPath)}
        openNote={
          current
            ? {
                relPath: current.relPath,
                hash: current.hash,
                dirty: saveStatus !== "saved" && saveStatus !== "idle",
              }
            : null
        }
        onRestored={(relPath) => void handleBackupRestored(relPath)}
      />

      {toast ? (
        <div className={`toast toast--${toast.kind}`} role="status" key={toast.id}>
          <span className="toast__icon" aria-hidden="true">
            <Icon name={toast.kind === "error" ? "x" : toast.kind === "ok" ? "check" : "sparkles"} size={12} strokeWidth={2.4} />
          </span>
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}
