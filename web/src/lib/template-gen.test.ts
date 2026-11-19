import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GEN_NOTE_CHARS,
  GEN_TOTAL_CHARS,
  TemplateGenError,
  clipNotes,
  normalizeGenerated,
  normalizeGeneratedPrompt,
  templateGenMessages,
  uniqueTemplateName,
} from "./template-gen.ts";
import { BUILTIN_TEMPLATES } from "./templates.ts";

const GOOD = {
  name: "论文阅读",
  sections: [
    { title: "问题", hint: "论文要解决什么" },
    { title: "方法", hint: "怎么做的" },
    { title: "结论", hint: "" },
  ],
  prompt: "请用中文写；\n方法一节要画出数据流。",
};

test("clipNotes：每篇最多 6000 字，总共最多 20000 字，被截的标上；中文按字算", () => {
  const short = clipNotes([{ title: "短", body: "  几个字  " }]);
  assert.deepEqual(short, [{ title: "短", body: "几个字", truncated: false }]);

  const clipped = clipNotes(Array.from({ length: 5 }, (_, at) => ({ title: `第${at}篇`, body: "字".repeat(7000) })));
  assert.deepEqual(
    clipped.map((note) => [...note.body].length),
    [GEN_NOTE_CHARS, GEN_NOTE_CHARS, GEN_NOTE_CHARS, GEN_TOTAL_CHARS - 3 * GEN_NOTE_CHARS, 0],
  );
  assert.ok(clipped.every((note) => note.truncated));
  assert.equal(clipped.reduce((sum, note) => sum + [...note.body].length, 0), GEN_TOTAL_CHARS);
});

test("解析模型回复：代码块包着、前后有废话都行；多余字段丢掉；结果过现有校验", () => {
  const reply = `好的，模板如下：\n\`\`\`json\n${JSON.stringify({ ...GOOD, extra: "丢掉", sections: [...GOOD.sections.map((s) => ({ ...s, emoji: "x" }))] })}\n\`\`\`\n希望有帮助`;
  const template = normalizeGenerated(reply, []);
  assert.deepEqual(template, GOOD);
  // 没有 prompt 也行
  const plain = normalizeGenerated(JSON.stringify({ name: "周复盘", sections: [{ title: "做了什么" }] }), []);
  assert.deepEqual(plain, { name: "周复盘", sections: [{ title: "做了什么", hint: "" }] });
});

test("解析模型回复：坏 JSON、没有小节、标题带 #、有「其他」小节、提示里有 -->、名字带非法字符都报错", () => {
  const bad = [
    "我建议这样设计：问题、方法、结论",
    '{"name": "论文", "sections": [',
    JSON.stringify({ name: "论文", sections: [] }),
    JSON.stringify({ name: "论文", sections: [{ title: "## 问题", hint: "" }] }),
    JSON.stringify({ name: "论文", sections: [{ title: "其他", hint: "" }] }),
    JSON.stringify({ name: "论文", sections: [{ title: "问题", hint: "注意 --> 这里" }] }),
    JSON.stringify({ name: "论文:阅读", sections: [{ title: "问题", hint: "" }] }),
    JSON.stringify({ name: "论文", sections: [{ title: "问题", hint: "" }], prompt: "字".repeat(2001) }),
    JSON.stringify(["论文"]),
  ];
  for (const reply of bad) {
    assert.throws(() => normalizeGenerated(reply, []), TemplateGenError, reply.slice(0, 40));
  }
});

test("重名自动加「 2」「 3」，不区分大小写；超长名字截短前半截", () => {
  assert.equal(uniqueTemplateName("实现详情", ["实现详情", "学习笔记"]), "实现详情 2");
  assert.equal(uniqueTemplateName("Paper", ["paper", "Paper 2"]), "Paper 3");
  const long = "长".repeat(40);
  const renamed = uniqueTemplateName(long, [long]);
  assert.equal([...renamed].length, 40);
  assert.ok(renamed.endsWith(" 2"));
  const generated = normalizeGenerated(JSON.stringify({ ...GOOD, name: "实现详情" }), BUILTIN_TEMPLATES.map((t) => t.name));
  assert.equal(generated.name, "实现详情 2");
});

test("发给模型的消息：归纳带每篇标题、截断标记和补充说明；描述带那句话；改写提示词带小节骨架和现有要求", () => {
  const [notesSystem, notesUser] = templateGenMessages({
    from: "notes",
    notes: [
      { title: "甲", body: "正文甲", truncated: false },
      { title: "乙", body: "正文乙", truncated: true },
    ],
    note: " 偏重踩坑 ",
  });
  assert.match(notesSystem.content, /归纳它们共同的结构/);
  assert.match(notesSystem.content, /只回 JSON/);
  assert.match(notesSystem.content, /3～8 个/);
  assert.match(notesUser.content, /### 笔记 1：甲\n\n正文甲/);
  assert.match(notesUser.content, /### 笔记 2：乙（正文太长，已截断）/);
  assert.match(notesUser.content, /补充说明：偏重踩坑$/);

  const [describeSystem, describeUser] = templateGenMessages({ from: "describe", description: "论文阅读笔记，要能记方法和实验" });
  assert.match(describeSystem.content, /一句话描述/);
  assert.equal(describeUser.content, "想要的笔记模板：论文阅读笔记，要能记方法和实验");

  const [promptSystem, promptUser] = templateGenMessages({ from: "prompt", template: GOOD });
  assert.match(promptSystem.content, /\{"prompt": "额外要求"\}/);
  assert.match(promptUser.content, /## 问题\n<!-- 论文要解决什么 -->/);
  assert.match(promptUser.content, /现在的额外要求（可以在此基础上改进）：\n请用中文写；/);
});

test("改写提示词：只换 prompt，其它不动；没回、坏 JSON、太长都报错", () => {
  const next = normalizeGeneratedPrompt('```json\n{"prompt": "  新的要求一\\n新的要求二  ", "name": "别改我"}\n```', GOOD);
  assert.deepEqual(next, { ...GOOD, prompt: "新的要求一\n新的要求二" });
  for (const reply of ["好的", '{"prompt": ""}', '{"text": "x"}', JSON.stringify({ prompt: "字".repeat(2001) })]) {
    assert.throws(() => normalizeGeneratedPrompt(reply, GOOD), TemplateGenError, reply.slice(0, 30));
  }
});
