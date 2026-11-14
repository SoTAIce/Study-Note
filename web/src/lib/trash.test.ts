import { test } from "node:test";
import assert from "node:assert/strict";
import { daysLeft, purgeLabel } from "./trash.ts";

const now = new Date("2026-11-14T12:00:00+08:00");

test("daysLeft：按保留天数向上取整", () => {
  assert.equal(daysLeft("2026-11-14T12:00:00+08:00", 30, now), 30);
  assert.equal(daysLeft("2026-11-14T08:00:00+08:00", 30, now), 30);
  assert.equal(daysLeft("2026-10-20T12:00:00+08:00", 30, now), 5);
  assert.equal(daysLeft("2026-10-15T13:00:00+08:00", 30, now), 1);
});

test("daysLeft：已过期返回 0，读不懂返回 null", () => {
  assert.equal(daysLeft("2026-09-01T00:00:00+08:00", 30, now), 0);
  assert.equal(daysLeft("", 30, now), null);
  assert.equal(daysLeft("不是时间", 30, now), null);
});

test("purgeLabel", () => {
  assert.equal(purgeLabel("2026-10-20T12:00:00+08:00", 30, now), "5 天后自动清理");
  assert.equal(purgeLabel("2026-10-15T13:00:00+08:00", 30, now), "1 天后自动清理");
  assert.equal(purgeLabel("2026-09-01T00:00:00+08:00", 30, now), "即将自动清理");
  assert.equal(purgeLabel("", 30, now), null);
});
