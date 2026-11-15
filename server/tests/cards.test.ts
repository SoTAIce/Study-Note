import assert from "node:assert/strict";
import { test } from "node:test";
import { indexCards, matchRenamed, parseCards, similarity } from "../cards.ts";

test("callout 简卡：标题是正面，后面的引用行是背面；折叠写法也认", () => {
  const body = [
    "# 机器学习",
    "",
    "> [!card] 梯度下降",
    "> - 沿负梯度方向更新参数",
    "> - 公式：w ← w − η·∇L(w)",
    "",
    "> [!CARD]- 过拟合",
    "> 训练集好、测试集差",
    "正文继续",
  ].join("\n");
  const cards = parseCards(body);
  assert.deepEqual(cards, [
    { kind: "callout", title: "梯度下降", body: "- 沿负梯度方向更新参数\n- 公式：w ← w − η·∇L(w)", line: 2 },
    { kind: "callout", title: "过拟合", body: "训练集好、测试集差", line: 6 },
  ]);
});

test("一行简卡：` :: ` 分隔，列表项里也认，任务框和编号去掉", () => {
  const body = ["过拟合 :: 学进了噪声", "- 偏差 :: 模型太简单", "1. [ ] 方差 :: 对数据太敏感"].join("\n");
  assert.deepEqual(
    parseCards(body).map((c) => [c.title, c.body, c.line]),
    [
      ["过拟合", "学进了噪声", 0],
      ["偏差", "模型太简单", 1],
      ["方差", "对数据太敏感", 2],
    ],
  );
});

test("不误认：普通引用、std::vector、代码块、行内代码、没标题的 callout、标题行", () => {
  const body = [
    "> 普通引用 :: 不算",
    "用 std::vector 存",
    "a::b 也不算",
    "```cpp",
    "x :: y",
    "> [!card] 代码里的",
    "```",
    "行内 `a :: b` 不算",
    "> [!card]",
    "> 没有标题",
    "## 标题 :: 也不算",
    "左边 :: ",
  ].join("\n");
  assert.deepEqual(parseCards(body), []);
});

test("卡片 id：同一篇同名卡加序号；改要点不变；换笔记会变", () => {
  const a = indexCards("note1", parseCards("> [!card] 梯度下降\n> 旧要点"));
  const b = indexCards("note1", parseCards("> [!card]  梯度下降 \n> 新要点"));
  assert.equal(a[0].id, b[0].id);
  assert.notEqual(indexCards("note2", parseCards("> [!card] 梯度下降"))[0].id, a[0].id);
  const dup = indexCards("note1", parseCards("甲 :: 一\n甲 :: 二"));
  assert.notEqual(dup[0].id, dup[1].id);
  assert.match(a[0].id, /^c_[0-9a-f]{10}$/);
});

test("相似度：相同为 1，小改动 ≥ 0.6，完全不同很低", () => {
  assert.equal(similarity("梯度下降", " 梯度下降 "), 1);
  assert.ok(similarity("梯度下降法", "梯度下降") >= 0.6);
  assert.ok(similarity("梯度下降", "贝叶斯公式") < 0.2);
});

test("改标题认回原卡：同位置、相似才配对；删了、换了完全不同的标题不配", () => {
  const before = indexCards("n", parseCards("梯度下降 :: x\n贝叶斯 :: y\n位置编码 :: z"));
  const after = indexCards("n", parseCards("梯度下降法 :: x\n完全不同的概念 :: y\n位置编码 :: z"));
  const pairs = matchRenamed(before, after);
  assert.deepEqual(pairs, [[after[0].id, before[0].id]]);
  assert.deepEqual(matchRenamed(before, before), []);
});
