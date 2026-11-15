import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { review } from "../fsrs.ts";
import { buildQueue, ReviewLog, reviewLogPath } from "../review.ts";

const DAY = 86_400_000;

function mk(start = new Date(2026, 10, 15, 9, 0, 0).getTime()) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-review-"));
  let t = start;
  const clock = { now: () => t, advance: (ms: number) => (t += ms), set: (ms: number) => (t = ms) };
  const open = () => new ReviewLog({ dataDir, now: clock.now });
  return { dataDir, clock, open };
}

test("打分写进 log.jsonl，状态与逐次调用 FSRS 一致；重开后从日志恢复", () => {
  const { dataDir, clock, open } = mk();
  const log = open();
  const t1 = clock.now();
  log.grade("c_a", "n1", 3);
  clock.set(log.stateOf("c_a")!.due);
  const t2 = clock.now();
  log.grade("c_a", "n1", 4);

  const expected = review(review(null, 3, t1), 4, t2);
  // 时间戳按秒写进日志，比较到秒
  assert.equal(Math.round(log.stateOf("c_a")!.stability * 1e6), Math.round(expected.stability * 1e6));

  const lines = fs.readFileSync(reviewLogPath(dataDir), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), ["card", "grade", "note", "t"]);

  const reopened = open();
  assert.deepEqual(reopened.stateOf("c_a"), log.stateOf("c_a"));
});

test("撤回：撤掉这张卡最近一次打分，重开后仍是撤回后的状态", () => {
  const { open } = mk();
  const log = open();
  log.grade("c_a", "n1", 3);
  const afterFirst = log.stateOf("c_a");
  log.grade("c_a", "n1", 1);
  assert.equal(log.undo("c_a"), true);
  assert.deepEqual(log.stateOf("c_a"), afterFirst);
  assert.equal(log.undo("c_a"), true);
  assert.equal(log.stateOf("c_a"), null);
  assert.equal(log.undo("c_a"), false, "没有可撤的");
  assert.equal(open().stateOf("c_a"), null);
});

test("别名：改了标题的新卡接着用原卡的记录；新卡下已有的记录也并过去", () => {
  const { open } = mk();
  const log = open();
  log.grade("c_old", "n1", 3);
  const before = log.stateOf("c_old");
  log.alias("c_new", "c_old");
  assert.deepEqual(log.stateOf("c_new"), before);
  log.grade("c_new", "n1", 3);
  assert.equal(log.stateOf("c_old")!.reps, 2);
  // 再改一次名：链式别名
  log.alias("c_newer", "c_new");
  assert.equal(open().stateOf("c_newer")!.reps, 2);
  // 自己指向自己、成环都不记
  log.alias("c_old", "c_newer");
  assert.equal(open().stateOf("c_old")!.reps, 2);
});

test("坏行跳过不影响其他记录", () => {
  const { dataDir, open } = mk();
  fs.mkdirSync(path.dirname(reviewLogPath(dataDir)), { recursive: true });
  fs.writeFileSync(
    reviewLogPath(dataDir),
    '{"t":"2026-11-15T09:00:00+08:00","card":"c_a","note":"n","grade":3}\n不是 JSON\n{"t":"x","card":"c_b","note":"n","grade":9}\n',
  );
  const log = open();
  assert.ok(log.stateOf("c_a"));
  assert.equal(log.stateOf("c_b"), null);
  assert.equal(log.skipped, 2);
});

test("今日队列：先到期旧卡再新卡；新卡每天上限；明天到期的不在今天", () => {
  const { clock, open } = mk();
  const log = open();
  const cards = ["a", "b", "c", "d", "e"].map((x) => ({ id: `c_${x}` }));
  // 昨天学过 a（记得 → 2 天后到期）、b（忘了 → 10 分钟，昨天就到期了）
  clock.advance(-DAY);
  log.grade("c_a", "n", 3);
  log.grade("c_b", "n", 1);
  clock.advance(DAY);

  const first = buildQueue(log, cards, { newPerDay: 2 });
  assert.deepEqual(first.queue.map((c) => c.id), ["c_b", "c_c", "c_d"]);
  assert.equal(first.due, 1);
  assert.equal(first.fresh, 2);

  // 今天学了 c、d 两张新卡：新卡额度用完
  log.grade("c_c", "n", 3);
  log.grade("c_d", "n", 3);
  const second = buildQueue(log, cards, { newPerDay: 2 });
  assert.deepEqual(second.queue.map((c) => c.id), ["c_b"]);
  // 旧卡上限
  assert.equal(buildQueue(log, cards, { newPerDay: 2, maxReviews: 0 }).queue.length, 0);
});

test("今日队列：刚答「忘了」的卡排在新卡后面，不会马上又出现", () => {
  const { clock, open } = mk();
  const log = open();
  const cards = ["a", "b", "c"].map((x) => ({ id: `c_${x}` }));
  log.grade("c_a", "n", 1); // 10 分钟后再来
  const q = buildQueue(log, cards, { newPerDay: 20 });
  assert.deepEqual(q.queue.map((c) => c.id), ["c_b", "c_c", "c_a"]);
  clock.advance(11 * 60_000);
  assert.deepEqual(buildQueue(log, cards, { newPerDay: 20 }).queue.map((c) => c.id), ["c_a", "c_b", "c_c"]);
});

test("明天到期数：只数明天（本地时间）到期的", () => {
  const { clock, open } = mk();
  const log = open();
  clock.advance(-DAY);
  log.grade("c_c", "n", 3); // 昨天学的，2 天后 = 明天到期
  clock.advance(DAY);
  log.grade("c_a", "n", 2); // 学习步，今天
  log.grade("c_b", "n", 3); // 2 天后 = 后天
  assert.equal(log.dueTomorrow(["c_a", "c_b", "c_c", "c_x"]), 1);
});
