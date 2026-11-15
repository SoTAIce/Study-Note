import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PARAMETERS, mastery, preview, retrievability, review, type CardState, type Grade } from "../fsrs.ts";

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
const DAY = 86_400_000;
const days = (c: CardState, at: number) => (c.due - at) / DAY;

test("新卡：忘了 10 分钟、困难 15 分钟（都还在学习步）、记得 2 天、简单 8 天", () => {
  const p = preview(null, T0);
  assert.equal(p[1].state, "learning");
  assert.equal(p[1].due - T0, 10 * MIN);
  assert.equal(p[2].state, "learning");
  assert.equal(p[2].due - T0, 15 * MIN);
  // 初始稳定性就是公开默认参数 w0~w3；目标记住率 90% 时间隔 = round(稳定性)
  assert.equal(p[3].state, "review");
  assert.equal(p[3].stability, DEFAULT_PARAMETERS[2]);
  assert.equal(days(p[3], T0), Math.round(DEFAULT_PARAMETERS[2]));
  assert.equal(days(p[4], T0), Math.round(DEFAULT_PARAMETERS[3]));
});

test("初始难度：D0(g) = w4 − e^(w5·(g−1)) + 1，限制在 1~10；越简单难度越低", () => {
  const w = DEFAULT_PARAMETERS;
  for (const g of [1, 2, 3, 4] as Grade[]) {
    const expected = Math.min(10, Math.max(1, w[4] - Math.exp(w[5] * (g - 1)) + 1));
    assert.ok(Math.abs(review(null, g, T0).difficulty - expected) < 1e-12);
  }
  const d = ([1, 2, 3, 4] as Grade[]).map((g) => review(null, g, T0).difficulty);
  assert.ok(d[0] >= d[1] && d[1] >= d[2] && d[2] >= d[3], JSON.stringify(d));
});

test("到期按时复习都答「记得」：间隔一次比一次长", () => {
  let card = review(null, 3, T0);
  let prev = days(card, T0);
  for (let i = 0; i < 6; i += 1) {
    const at = card.due;
    card = review(card, 3, at);
    const gap = days(card, at);
    assert.ok(gap > prev, `第 ${i + 2} 次间隔 ${gap} 应大于 ${prev}`);
    prev = gap;
  }
  assert.equal(mastery(card), "mastered");
});

test("复习卡：四档的间隔 忘了 < 困难 ≤ 记得 ≤ 简单，忘了进重学且 lapses+1", () => {
  let card = review(null, 3, T0);
  card = review(card, 3, card.due);
  const at = card.due;
  const p = preview(card, at);
  assert.equal(p[1].state, "relearning");
  assert.equal(p[1].due - at, 10 * MIN);
  assert.equal(p[1].lapses, card.lapses + 1);
  assert.ok(p[1].stability < card.stability, "忘了之后稳定性应下降");
  assert.ok(days(p[2], at) <= days(p[3], at) && days(p[3], at) <= days(p[4], at));
  assert.ok(days(p[2], at) >= 1);
});

test("重学：10 分钟后答「记得」回到按天复习", () => {
  let card = review(null, 3, T0);
  card = review(card, 1, card.due);
  assert.equal(card.state, "relearning");
  const back = review(card, 3, card.due);
  assert.equal(back.state, "review");
  assert.ok(days(back, card.due) >= 1);
});

test("同一天内再复习用短期公式：答「记得」稳定性不下降", () => {
  const card = review(null, 1, T0); // 学习中，10 分钟后到期
  const again = review(card, 3, card.due);
  assert.ok(again.stability >= card.stability);
});

test("结果只由输入决定（没有随机抖动），日志重放可复现", () => {
  const run = () => {
    let c = review(null, 3, T0);
    for (const g of [3, 2, 4, 1, 3] as Grade[]) c = review(c, g, c.due + 3 * DAY);
    return c;
  };
  assert.deepEqual(run(), run());
});

test("记住概率：刚复习完是 1，到期时约 90%", () => {
  const card = review(null, 3, T0);
  assert.equal(retrievability(card, T0), 1);
  const r = retrievability(card, card.due);
  assert.ok(Math.abs(r - 0.9) < 0.03, `到期时记住概率 ${r}`);
});

test("熟练度：新卡 / 学习中 / 熟练", () => {
  assert.equal(mastery(null), "new");
  assert.equal(mastery(review(null, 3, T0)), "learning");
  assert.equal(mastery({ ...review(null, 3, T0), stability: 30 }), "mastered");
});
