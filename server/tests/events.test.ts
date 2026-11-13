import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeBatcher, type ChangeMessage } from "../events.ts";

/** 手动推进的计时器：flush 时机完全由测试控制 */
function fakeTimers() {
  let pending: Array<{ fn: () => void; handle: number }> = [];
  let seq = 0;
  return {
    timers: {
      setTimeout: (fn: () => void) => {
        seq += 1;
        pending.push({ fn, handle: seq });
        return seq;
      },
      clearTimeout: (handle: unknown) => {
        pending = pending.filter((t) => t.handle !== handle);
      },
    },
    fire() {
      const due = pending;
      pending = [];
      for (const t of due) t.fn();
    },
    get count() {
      return pending.length;
    },
  };
}

function setup(maxBatch?: number) {
  const sent: ChangeMessage[] = [];
  const clock = fakeTimers();
  const batcher = new ChangeBatcher({ send: (m) => sent.push(m), timers: clock.timers, maxBatch });
  return { sent, clock, batcher };
}

test("窗口内的多次变化合并成一条消息", () => {
  const { sent, clock, batcher } = setup();
  batcher.push({ kind: "changed", id: "a", path: "a.md", hash: "h1" });
  batcher.push({ kind: "changed", id: "b", path: "b.md", hash: "h2" });
  assert.equal(sent.length, 0, "窗口结束前不发");
  assert.equal(clock.count, 1, "只开一个计时器");
  clock.fire();
  assert.deepEqual(sent, [
    {
      changes: [
        { kind: "changed", id: "a", path: "a.md", hash: "h1" },
        { kind: "changed", id: "b", path: "b.md", hash: "h2" },
      ],
    },
  ]);
});

test("同一路径只保留最后一次变化", () => {
  const { sent, clock, batcher } = setup();
  batcher.push({ kind: "changed", id: "a", path: "a.md", hash: "h1" });
  batcher.push({ kind: "changed", id: "b", path: "b.md", hash: "x" });
  batcher.push({ kind: "removed", id: "a", path: "a.md" });
  clock.fire();
  assert.deepEqual(sent, [
    {
      changes: [
        { kind: "changed", id: "b", path: "b.md", hash: "x" },
        { kind: "removed", id: "a", path: "a.md" },
      ],
    },
  ]);
});

test("超过上限就只发 resync", () => {
  const { sent, clock, batcher } = setup(3);
  for (let i = 0; i < 4; i += 1) batcher.push({ kind: "changed", id: `n${i}`, path: `n${i}.md`, hash: "h" });
  batcher.push({ kind: "changed", id: "late", path: "late.md", hash: "h" });
  clock.fire();
  assert.deepEqual(sent, [{ resync: true }]);
});

test("收到 resync 事件时整体刷新，丢弃已攒的逐条变化", () => {
  const { sent, clock, batcher } = setup();
  batcher.push({ kind: "changed", id: "a", path: "a.md", hash: "h" });
  batcher.push({ kind: "resync" });
  clock.fire();
  assert.deepEqual(sent, [{ resync: true }]);
});

test("下一个窗口重新开始计数", () => {
  const { sent, clock, batcher } = setup();
  batcher.push({ kind: "changed", id: "a", path: "a.md", hash: "1" });
  clock.fire();
  batcher.push({ kind: "changed", id: "a", path: "a.md", hash: "2" });
  clock.fire();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], { changes: [{ kind: "changed", id: "a", path: "a.md", hash: "2" }] });
});

test("关闭后不再发送，也不留计时器", () => {
  const { sent, clock, batcher } = setup();
  batcher.push({ kind: "changed", id: "a", path: "a.md", hash: "1" });
  batcher.close();
  assert.equal(clock.count, 0);
  batcher.push({ kind: "changed", id: "b", path: "b.md", hash: "1" });
  clock.fire();
  assert.deepEqual(sent, []);
});
