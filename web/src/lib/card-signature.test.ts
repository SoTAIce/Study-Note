import assert from "node:assert/strict";
import test from "node:test";
import { cardSignature } from "./card-signature.ts";

test("cardSignature：只看简卡标题行和一行简卡，改普通正文不变", () => {
  const a = "# 标题\n正文\n> [!card] 梯度下降\n> - 要点\n过拟合 :: 噪声";
  assert.equal(cardSignature(a), "> [!card] 梯度下降\n过拟合 :: 噪声");
  assert.equal(cardSignature(a.replace("正文", "改过的正文").replace("- 要点", "- 新要点")), cardSignature(a));
  assert.notEqual(cardSignature(`${a}\n新卡 :: 新解释`), cardSignature(a));
  assert.equal(cardSignature("没有简卡"), "");
});
