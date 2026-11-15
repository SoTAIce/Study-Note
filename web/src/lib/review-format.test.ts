import assert from "node:assert/strict";
import test from "node:test";
import { dueLabel, formatSpan } from "./review-format.ts";

const MIN = 60_000;
const DAY = 86_400_000;

test("formatSpan：分钟 / 小时 / 天 / 月 / 年", () => {
  assert.equal(formatSpan(10 * MIN), "10 分钟");
  assert.equal(formatSpan(15 * MIN), "15 分钟");
  assert.equal(formatSpan(20 * 1000), "1 分钟");
  assert.equal(formatSpan(3 * 60 * MIN), "3 小时");
  assert.equal(formatSpan(2 * DAY), "2 天");
  assert.equal(formatSpan(45 * DAY), "1.5 个月");
  assert.equal(formatSpan(60 * DAY), "2 个月");
  assert.equal(formatSpan(730 * DAY), "2 年");
});

test("dueLabel：没学过 / 到期了 / 今天 / 几天后", () => {
  const now = new Date(2026, 10, 15, 9, 0, 0).getTime();
  assert.equal(dueLabel(null, now), "还没学");
  assert.equal(dueLabel(now - MIN, now), "该复习了");
  assert.equal(dueLabel(now + 10 * MIN, now), "今天");
  assert.equal(dueLabel(now + 3 * DAY, now), "3 天后");
});
