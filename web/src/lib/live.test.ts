import assert from "node:assert/strict";
import test from "node:test";
import {
  connectLive,
  decideExternalChange,
  shouldResyncOnVisible,
  touchesNote,
  type NoteChange,
  type ResyncReason,
} from "./live.ts";

const base = { found: true, diskHash: "disk", localHash: "local", dirty: false, inConflict: false };

test("决策：磁盘和编辑器一致（自己保存的回声）时什么都不做", () => {
  assert.equal(decideExternalChange({ ...base, diskHash: "same", localHash: "same", dirty: true }), "ignore");
});

test("决策：没有未保存修改时自动重载", () => {
  assert.equal(decideExternalChange(base), "reload");
});

test("决策：有未保存修改时出冲突，绝不重载覆盖", () => {
  assert.equal(decideExternalChange({ ...base, dirty: true }), "conflict");
});

test("决策：已经在冲突里只刷新冲突信息", () => {
  assert.equal(decideExternalChange({ ...base, inConflict: true, dirty: true }), "refresh-conflict");
  assert.equal(decideExternalChange({ ...base, inConflict: true }), "refresh-conflict");
});

test("决策：读不到这篇就是被删了（不管有没有未保存修改）", () => {
  assert.equal(decideExternalChange({ ...base, found: false }), "deleted");
  assert.equal(decideExternalChange({ ...base, found: false, dirty: true }), "deleted");
});

test("touchesNote 按 id 或路径匹配", () => {
  const changes: NoteChange[] = [
    { kind: "changed", id: "a", path: "a.md", hash: "1" },
    { kind: "removed", id: "old", path: "b.md" },
  ];
  assert.equal(touchesNote(changes, "a", null), true);
  assert.equal(touchesNote(changes, "x", "b.md"), true);
  assert.equal(touchesNote(changes, "x", "c.md"), false);
  assert.equal(touchesNote(changes, null, null), false);
});

test("页面隐藏 30 秒以上再回来才整体刷新", () => {
  assert.equal(shouldResyncOnVisible(null, 100_000), false);
  assert.equal(shouldResyncOnVisible(0, 29_999), false);
  assert.equal(shouldResyncOnVisible(0, 30_000), true);
});

function fakeSource() {
  const listeners = new Map<string, (event: MessageEvent) => void>();
  const source = {
    onerror: null as ((event: Event) => void) | null,
    closed: false,
    addEventListener(type: string, fn: (event: MessageEvent) => void) {
      listeners.set(type, fn);
    },
    close() {
      this.closed = true;
    },
    emit(type: string, data: unknown) {
      listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
    },
  };
  return source;
}

function fakeVisibility() {
  let fn: (() => void) | null = null;
  return {
    visibilityState: "visible",
    addEventListener(_type: "visibilitychange", listener: () => void) {
      fn = listener;
    },
    removeEventListener() {
      fn = null;
    },
    set(state: string) {
      this.visibilityState = state;
      fn?.();
    },
    get attached() {
      return fn !== null;
    },
  };
}

function setup() {
  const source = fakeSource();
  const visibility = fakeVisibility();
  let clock = 0;
  const changes: NoteChange[][] = [];
  const resyncs: ResyncReason[] = [];
  const stop = connectLive(
    { onChanges: (c) => changes.push(c), onResync: (r) => resyncs.push(r) },
    { createEventSource: () => source, visibility, now: () => clock },
  );
  return {
    source,
    visibility,
    changes,
    resyncs,
    stop,
    advance(ms: number) {
      clock += ms;
    },
  };
}

test("连接：首次 hello 不刷新；notes 事件转给 onChanges；resync 转给 onResync", () => {
  const t = setup();
  t.source.emit("hello", { bootId: "b1" });
  assert.deepEqual(t.resyncs, []);
  t.source.emit("notes", { changes: [{ kind: "changed", id: "a", path: "a.md", hash: "1" }] });
  t.source.emit("notes", { resync: true });
  assert.equal(t.changes.length, 1);
  assert.deepEqual(t.resyncs, ["server"]);
});

test("连接：断线重连后整体刷新一次；服务重启（bootId 变了）也整体刷新", () => {
  const t = setup();
  t.source.emit("hello", { bootId: "b1" });
  t.source.onerror?.({} as Event);
  t.source.emit("hello", { bootId: "b1" });
  assert.deepEqual(t.resyncs, ["reconnect"]);
  t.source.emit("hello", { bootId: "b2" });
  assert.deepEqual(t.resyncs, ["reconnect", "restart"]);
});

test("连接：隐藏超过 30 秒再回来整体刷新，短暂切走不刷新；取消订阅后关闭连接", () => {
  const t = setup();
  t.visibility.set("hidden");
  t.advance(5_000);
  t.visibility.set("visible");
  assert.deepEqual(t.resyncs, []);
  t.visibility.set("hidden");
  t.advance(31_000);
  t.visibility.set("visible");
  assert.deepEqual(t.resyncs, ["visible"]);
  t.stop();
  assert.equal(t.source.closed, true);
  assert.equal(t.visibility.attached, false);
});

test("连接：坏 JSON 不抛错", () => {
  const t = setup();
  const source = t.source as unknown as { emit: (type: string, data: unknown) => void };
  assert.doesNotThrow(() => source.emit("notes", undefined));
});
