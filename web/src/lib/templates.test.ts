import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_TEMPLATES,
  findTemplate,
  groupDefaultTemplate,
  isBlankOrSkeleton,
  templatePrompt,
  templateSkeleton,
  validateTemplate,
  validateTemplateList,
  validateTemplateName,
} from "./templates.ts";
import { renderMarkdown } from "./markdown.ts";

const impl = BUILTIN_TEMPLATES[0];

test("内置模板：实现详情、学习笔记，小节与方案一致，且都能通过校验", () => {
  assert.deepEqual(
    BUILTIN_TEMPLATES.map((t) => [t.name, t.sections.map((s) => s.title)]),
    [
      ["实现详情", ["背景", "设计", "关键代码", "踩坑", "待办"]],
      ["学习笔记", ["要点", "例子", "我的理解", "疑问", "简卡"]],
    ],
  );
  const check = validateTemplateList(BUILTIN_TEMPLATES);
  assert.ok(check.ok);
});

test("validateTemplateName：去空白、长度、保留字符", () => {
  assert.deepEqual(validateTemplateName("  会议　纪要 "), { ok: true, name: "会议 纪要" });
  assert.equal(validateTemplateName("").ok, false);
  assert.equal(validateTemplateName(123).ok, false);
  assert.equal(validateTemplateName("a".repeat(41)).ok, false);
  assert.equal(validateTemplateName("中".repeat(40)).ok, true);
  for (const bad of ["a:b", "a|b", 'a"b', "a?b", "a*b", "a<b", "a\\b", "a\u0007b"]) {
    assert.equal(validateTemplateName(bad).ok, false, bad);
  }
});

test("validateTemplate：至少一个小节、标题不空不重复不以 # 开头、不能叫「其他」、提示里不能有注释标记", () => {
  const ok = validateTemplate({ name: "T", sections: [{ title: " 一 ", hint: " 提示 " }, { title: "二" }] });
  assert.deepEqual(ok, { ok: true, template: { name: "T", sections: [{ title: "一", hint: "提示" }, { title: "二", hint: "" }] } });

  const bad = (sections: unknown, pattern: RegExp) => {
    const check = validateTemplate({ name: "T", sections });
    assert.equal(check.ok, false, JSON.stringify(sections));
    if (!check.ok) assert.match(check.error, pattern);
  };
  bad([], /至少要有一个小节/);
  bad([{ title: "" }], /没写标题/);
  bad([{ title: "A" }, { title: "a" }], /两个叫/);
  bad([{ title: "# A" }], /不能以 #/);
  bad([{ title: "其他" }], /其他/);
  bad([{ title: "A", hint: "x --> y" }], /<!-- 或 -->/);
  bad([{ title: "A", hint: "<!-- y" }], /<!-- 或 -->/);
  bad([{ title: "A", hint: "长".repeat(201) }], /提示太长/);
  bad(Array.from({ length: 21 }, (_v, i) => ({ title: `S${i}` })), /最多 20 个小节/);
});

test("validateTemplateList：重名（不区分大小写）报错；findTemplate 不区分大小写", () => {
  const check = validateTemplateList([
    { name: "Daily", sections: [{ title: "A" }] },
    { name: "daily", sections: [{ title: "B" }] },
  ]);
  assert.equal(check.ok, false);
  assert.equal(findTemplate(BUILTIN_TEMPLATES, " 学习笔记 ")?.name, "学习笔记");
  assert.equal(findTemplate(BUILTIN_TEMPLATES, "没有"), undefined);
  assert.equal(findTemplate(BUILTIN_TEMPLATES, ""), undefined);
});

test("templateSkeleton：## 小节 + 提示注释，不写 # 标题；没提示的小节只有标题", () => {
  assert.equal(
    templateSkeleton(impl),
    [
      "## 背景\n<!-- 为什么做、要解决什么问题 -->\n",
      "## 设计\n<!-- 结构、流程、关键决策和取舍 -->\n",
      "## 关键代码\n<!-- 文件路径 + 片段，说明它在流程里的位置 -->\n",
      "## 踩坑\n<!-- 遇到的问题、原因、怎么解决的 -->\n",
      "## 待办\n<!-- 还没做的、想改进的（- [ ] 任务） -->\n",
    ].join("\n"),
  );
  assert.equal(templateSkeleton({ name: "T", sections: [{ title: "A", hint: "" }, { title: "B", hint: "" }] }), "## A\n\n## B\n");
});

test("骨架渲染后只剩小节标题：提示注释在预览里看不见", () => {
  const html = renderMarkdown(templateSkeleton(impl));
  assert.equal(html, "<h2>背景</h2>\n<h2>设计</h2>\n<h2>关键代码</h2>\n<h2>踩坑</h2>\n<h2>待办</h2>\n");
  assert.ok(!html.includes("为什么做"));
});

test("isBlankOrSkeleton：空白或某个模板的原样骨架为真，写了东西为假", () => {
  assert.equal(isBlankOrSkeleton("  \n", BUILTIN_TEMPLATES), true);
  assert.equal(isBlankOrSkeleton(templateSkeleton(BUILTIN_TEMPLATES[1]), BUILTIN_TEMPLATES), true);
  assert.equal(isBlankOrSkeleton(`${templateSkeleton(impl)}\n写了一句`, BUILTIN_TEMPLATES), false);
});

test("templatePrompt：主题、小节结构、只输出 Markdown、没内容写「待补」；主题空着时提示自己补", () => {
  const prompt = templatePrompt(impl, " looprun 主循环 ");
  assert.equal(
    prompt,
    [
      "请就「looprun 主循环」写一篇笔记，严格按下面的结构输出：",
      "",
      "## 背景",
      "（为什么做、要解决什么问题）",
      "## 设计",
      "（结构、流程、关键决策和取舍）",
      "## 关键代码",
      "（文件路径 + 片段，说明它在流程里的位置）",
      "## 踩坑",
      "（遇到的问题、原因、怎么解决的）",
      "## 待办",
      "（还没做的、想改进的（- [ ] 任务））",
      "",
      "要求：",
      "- 只输出 Markdown 正文，从第一个「## 背景」开始，不要开场白、不要结尾的客套话；",
      "- 小节标题、顺序和级别都不要改，不要加别的 ## 小节（小节里可以用 ### 细分）；",
      "- 某个小节没有可写的内容就只写「待补」，不要编造。",
      "",
    ].join("\n"),
  );
  assert.match(templatePrompt(impl, ""), /^请就（主题自己补上）写一篇笔记/);
});

test("groupDefaultTemplate：组名不区分大小写、/ 两边空白不计；模板已删或没设返回 undefined；不往父分组找", () => {
  const defaults = { "agent/looprun": "实现详情", 旧: "已删的模板" };
  assert.equal(groupDefaultTemplate(defaults, BUILTIN_TEMPLATES, "Agent / LoopRun")?.name, "实现详情");
  assert.equal(groupDefaultTemplate(defaults, BUILTIN_TEMPLATES, "旧"), undefined);
  assert.equal(groupDefaultTemplate(defaults, BUILTIN_TEMPLATES, "agent"), undefined);
  assert.equal(groupDefaultTemplate(defaults, BUILTIN_TEMPLATES, ""), undefined);
});
