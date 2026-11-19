import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ArrangeError,
  arrangeMessages,
  assemble,
  extractJsonObject,
  parsePlan,
  splitBlocks,
  type Block,
} from "./arrange.ts";
import { templateSkeleton, type NoteTemplate } from "./templates.ts";

const TPL: NoteTemplate = {
  name: "实现详情",
  sections: [
    { title: "背景", hint: "为什么做" },
    { title: "设计", hint: "" },
    { title: "待办", hint: "还没做的" },
  ],
};

const kinds = (blocks: Block[]) => blocks.map((block) => block.kind);

test("切块：段落、列表（含空行续项）、代码块里的 ##、表格、引用、标题", () => {
  const body = [
    "# 1. 背景介绍",
    "",
    "第一段第一行",
    "第一段第二行",
    "",
    "- 甲",
    "- 乙",
    "",
    "- 丙（空行后还是同一个列表）",
    "  续行",
    "",
    "```ts",
    "## 这不是标题",
    "",
    "const a = 1;",
    "```",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "> 引用一",
    "> 引用二",
    "### 小标题",
    "段落紧跟标题",
  ].join("\n");
  const blocks = splitBlocks(body, TPL);
  assert.deepEqual(kinds(blocks), ["heading", "paragraph", "list", "code", "table", "quote", "heading", "paragraph"]);
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[1].text, "第一段第一行\n第一段第二行");
  assert.equal(blocks[2].text, "- 甲\n- 乙\n\n- 丙（空行后还是同一个列表）\n  续行");
  assert.equal(blocks[3].text, "```ts\n## 这不是标题\n\nconst a = 1;\n```");
  assert.equal(blocks[6].level, 3);
  assert.deepEqual(
    blocks.map((block) => block.index),
    blocks.map((_, at) => at),
  );
});

test("切块：先拿掉模板骨架、「## 其他」和单独一段「待补」，其它 ## 标题保留", () => {
  const body = `${templateSkeleton(TPL)}\n粘进来的第一段\n\n## 其他\n\n待补\n\n## 性能对比\n\n结论`;
  const blocks = splitBlocks(body, TPL);
  assert.deepEqual(
    blocks.map((block) => block.text),
    ["粘进来的第一段", "## 性能对比", "结论"],
  );
});

test("切块：CRLF 统一成 LF；没闭合的代码块吃到末尾；多行注释是一块", () => {
  const blocks = splitBlocks("段一\r\n\r\n<!-- 多行\r\n注释 -->\r\n\r\n```\r\n没闭合\r\n## 还在代码里", TPL);
  assert.deepEqual(kinds(blocks), ["paragraph", "comment", "code"]);
  assert.equal(blocks[1].text, "<!-- 多行\n注释 -->");
  assert.ok(blocks[2].text.endsWith("## 还在代码里"));
});

test("解析模型回复：代码块包着、前后有废话都能取出 JSON；坏 JSON 报错", () => {
  assert.deepEqual(extractJsonObject('好的：\n```json\n{"背景": [0]}\n```\n以上'), { 背景: [0] });
  assert.deepEqual(extractJsonObject('方案如下 {"背景": [1], "drop": []} 完'), { 背景: [1], drop: [] });
  assert.throws(() => extractJsonObject("我觉得应该放到背景里"), ArrangeError);
  assert.throws(() => extractJsonObject('{"背景": [0,}'), ArrangeError);
});

function sample(): Block[] {
  return splitBlocks(["## 1. 背景", "", "起因", "", "### 方案 A", "", "细节", "", "顺手一提", "", "- 待做一", "- 待做二"].join("\n"), TPL);
}

test("校验并拼接：逐字来自原文、小节内按原文顺序、没分配的进「其他」、空小节写「待补」", () => {
  const blocks = sample();
  assert.equal(blocks.length, 6);
  const plan = parsePlan({ 背景: [1], " 设计 ": [3, 2], drop: [0], 待办: [5] }, TPL, blocks);
  assert.deepEqual(plan.sections.map((section) => section.blocks), [[1], [2, 3], [5]]);
  assert.deepEqual(plan.drop, [0]);
  assert.deepEqual(plan.other, [4]);
  const body = assemble(TPL, blocks, plan);
  assert.equal(
    body,
    [
      "## 背景",
      "<!-- 为什么做 -->",
      "",
      "起因",
      "",
      "## 设计",
      "",
      "### 方案 A",
      "",
      "细节",
      "",
      "## 待办",
      "<!-- 还没做的 -->",
      "",
      "- 待做一\n- 待做二",
      "",
      "## 其他",
      "",
      "顺手一提",
      "",
    ].join("\n"),
  );
  // 除了丢掉的标题，原文每一块都原样出现在结果里
  for (const block of blocks) {
    if (plan.drop.includes(block.index)) continue;
    assert.ok(body.includes(block.text), `缺了块 ${block.index}`);
  }
  // 再规整一次：骨架被识别，剩下的正是原来那些块（顺序跟着新结构走）
  const again = splitBlocks(body, TPL);
  assert.deepEqual(
    again.map((block) => block.text).sort(),
    blocks.filter((block) => block.index !== 0).map((block) => block.text).sort(),
  );
});

test("空方案：全部进「其他」，每个小节写「待补」", () => {
  const blocks = sample();
  const body = assemble(TPL, blocks, parsePlan({}, TPL, blocks));
  assert.equal((body.match(/^待补$/gm) ?? []).length, 3);
  // 「其他」里的 ## 标题同样降成 ###，免得多出一个小节
  assert.ok(body.includes("## 其他\n\n### 1. 背景"));
});

test("放进小节的 # / ## 标题降成 ###，文字不动；### 及以下不动", () => {
  const blocks = splitBlocks("# 大标题\n\n## 性能对比\n\n#### 很细的标题", TPL);
  const body = assemble(TPL, blocks, parsePlan({ 设计: [0, 1, 2] }, TPL, blocks));
  assert.ok(body.includes("### 大标题\n\n### 性能对比\n\n#### 很细的标题"));
});

test("模型自己写「其他」：当作没分配", () => {
  const blocks = sample();
  const plan = parsePlan({ 其他: [4], 背景: [1] }, TPL, blocks);
  assert.ok(plan.other.includes(4));
});

test("非法方案一律报错：未知小节、编号重复、越界、不是编号、把非标题放进 drop、不是对象", () => {
  const blocks = sample();
  const bad: unknown[] = [
    { 结论: [1] },
    { 背景: [1], 设计: [1] },
    { 背景: [99] },
    { 背景: [-1] },
    { 背景: [1.5] },
    { 背景: ["起因"] },
    { 背景: "1" },
    { drop: [1] },
    [1, 2],
    null,
  ];
  for (const plan of bad) {
    assert.throws(() => parsePlan(plan, TPL, blocks), ArrangeError, JSON.stringify(plan));
  }
});

test("发给模型的消息：带小节名、编号块，长块只给开头", () => {
  const long = "字".repeat(1000);
  const blocks = splitBlocks(`## 标题\n\n${long}`, TPL);
  const [system, user] = arrangeMessages(TPL, blocks, "某笔记");
  assert.equal(system.role, "system");
  assert.match(system.content, /只回一个 JSON/);
  assert.match(user.content, /- 背景：为什么做/);
  assert.match(user.content, /\[0\]（标题）\n## 标题/);
  assert.match(user.content, /后面省略/);
  assert.ok(user.content.length < 1000);
});
