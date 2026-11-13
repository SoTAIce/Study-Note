/**
 * 外部编辑同步（sync-001）的前端部分：连接 GET /api/events，以及「当前这篇在外面变了怎么办」的决策。
 * 不依赖 React，决策是纯函数，便于单测。
 */

export type NoteChange =
  | { kind: "changed"; id: string; path: string; hash: string }
  | { kind: "removed"; id: string; path: string };

/** 页面隐藏超过这么久再回来，就整体刷新一次（兜住 fs.watch 在网络盘、同步盘上漏事件） */
export const HIDDEN_RESYNC_MS = 30_000;
/** 当前这篇读不到（404）时，隔这么久再确认一次：外部「移动」常被拆成先删后建两个事件 */
export const DELETE_CONFIRM_MS = 1_500;

export type ExternalDecision =
  /** 磁盘和编辑器一致（多半是自己刚保存的回声），什么都不做 */
  | "ignore"
  /** 没有未保存修改：直接载入磁盘版本 */
  | "reload"
  /** 有未保存修改：立刻出冲突提示，暂停自动保存 */
  | "conflict"
  /** 已经在冲突里：只更新提示里的磁盘版本信息 */
  | "refresh-conflict"
  /** 磁盘上没有这篇了：编辑器内容存进回收站后关闭 */
  | "deleted";

export function decideExternalChange(input: {
  found: boolean;
  diskHash: string;
  localHash: string;
  dirty: boolean;
  inConflict: boolean;
}): ExternalDecision {
  if (!input.found) return "deleted";
  if (input.diskHash === input.localHash) return "ignore";
  if (input.inConflict) return "refresh-conflict";
  if (input.dirty) return "conflict";
  return "reload";
}

/** 这批变化里有没有涉及当前打开的这篇（按 id，或按路径：删除事件里的 id 可能是旧索引的） */
export function touchesNote(changes: NoteChange[], id: string | null, relPath: string | null): boolean {
  if (!id && !relPath) return false;
  return changes.some((change) => (id !== null && change.id === id) || (relPath !== null && change.path === relPath));
}

export function shouldResyncOnVisible(hiddenAt: number | null, now: number, threshold = HIDDEN_RESYNC_MS): boolean {
  return hiddenAt !== null && now - hiddenAt >= threshold;
}

export type ResyncReason = "server" | "reconnect" | "restart" | "visible";

type EventSourceLike = {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  onerror: ((event: Event) => void) | null;
  close(): void;
};

type VisibilityTarget = {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

/**
 * 订阅笔记变化。断线由浏览器自动重连；重连后（或服务重启后）通知整体刷新，补上断线期间漏掉的变化。
 * 返回取消订阅函数。
 */
export function connectLive(
  handlers: {
    onChanges: (changes: NoteChange[]) => void;
    onResync: (reason: ResyncReason) => void;
  },
  opts: {
    url?: string;
    createEventSource?: (url: string) => EventSourceLike;
    visibility?: VisibilityTarget | null;
    now?: () => number;
  } = {},
): () => void {
  const create = opts.createEventSource ?? ((url: string) => new EventSource(url) as unknown as EventSourceLike);
  const visibility = opts.visibility === undefined ? (typeof document === "undefined" ? null : document) : opts.visibility;
  const now = opts.now ?? (() => Date.now());

  const source = create(opts.url ?? "/api/events");
  let bootId: string | null = null;
  let lostConnection = false;

  source.addEventListener("hello", (event) => {
    let next: string | null = null;
    try {
      next = (JSON.parse(event.data) as { bootId?: string }).bootId ?? null;
    } catch {
      next = null;
    }
    if (bootId !== null && next !== bootId) handlers.onResync("restart");
    else if (lostConnection) handlers.onResync("reconnect");
    bootId = next;
    lostConnection = false;
  });

  source.addEventListener("notes", (event) => {
    let message: { changes?: NoteChange[]; resync?: boolean };
    try {
      message = JSON.parse(event.data) as typeof message;
    } catch {
      return;
    }
    if (message.resync) handlers.onResync("server");
    else if (Array.isArray(message.changes) && message.changes.length > 0) handlers.onChanges(message.changes);
  });

  source.onerror = () => {
    lostConnection = true;
  };

  let hiddenAt: number | null = null;
  const onVisibility = (): void => {
    if (!visibility) return;
    if (visibility.visibilityState === "hidden") {
      hiddenAt = now();
      return;
    }
    if (shouldResyncOnVisible(hiddenAt, now())) handlers.onResync("visible");
    hiddenAt = null;
  };
  visibility?.addEventListener("visibilitychange", onVisibility);

  return () => {
    source.close();
    visibility?.removeEventListener("visibilitychange", onVisibility);
  };
}
