/**
 * 笔记变化事件：索引层发出，SSE（GET /api/events）推给浏览器。
 * 只说「哪篇变了」，不带正文；浏览器需要内容时再走 GET /api/notes/:id。
 */

export type NoteChange =
  | { kind: "changed"; id: string; path: string; hash: string }
  | { kind: "removed"; id: string; path: string };

/** 一条推送消息：要么是合并后的变化列表，要么让前端整体刷新一次。 */
export type ChangeMessage = { changes: NoteChange[] } | { resync: true };

export type ChangeEvent = NoteChange | { kind: "resync" };

export const BATCH_WINDOW_MS = 300;
/** 一个窗口里变化超过这个数（git pull、同步盘一次落一大批）就不逐条推了 */
export const MAX_BATCH = 100;

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * 每条 SSE 连接一个：把 windowMs 内的变化攒起来一次发出。
 * 同一路径只留最后一次；超过 maxBatch 条或收到 resync 就只发 { resync: true }。
 */
export class ChangeBatcher {
  private readonly send: (message: ChangeMessage) => void;
  private readonly windowMs: number;
  private readonly maxBatch: number;
  private readonly timers: Timers;
  private pending = new Map<string, NoteChange>();
  private resync = false;
  private timer: unknown = null;
  private closed = false;

  constructor(opts: {
    send: (message: ChangeMessage) => void;
    windowMs?: number;
    maxBatch?: number;
    timers?: Timers;
  }) {
    this.send = opts.send;
    this.windowMs = opts.windowMs ?? BATCH_WINDOW_MS;
    this.maxBatch = opts.maxBatch ?? MAX_BATCH;
    this.timers = opts.timers ?? realTimers;
  }

  push(event: ChangeEvent): void {
    if (this.closed) return;
    if (event.kind === "resync") {
      this.resync = true;
      this.pending.clear();
    } else if (!this.resync) {
      // 先删再设：同一路径的最后一次变化排到队尾，顺序反映发生的先后
      this.pending.delete(event.path);
      this.pending.set(event.path, event);
      if (this.pending.size > this.maxBatch) {
        this.resync = true;
        this.pending.clear();
      }
    }
    if (this.timer === null) {
      this.timer = this.timers.setTimeout(() => this.flush(), this.windowMs);
    }
  }

  flush(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.closed) return;
    if (this.resync) {
      this.resync = false;
      this.send({ resync: true });
      return;
    }
    if (this.pending.size === 0) return;
    const changes = [...this.pending.values()];
    this.pending.clear();
    this.send({ changes });
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}
