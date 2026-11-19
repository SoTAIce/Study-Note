import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseNote,
  serializeNote,
  extractTags,
  extractLinks,
  deriveTitle,
  excerpt,
  slugify,
  contentHash,
  type NoteMeta,
  patchFrontmatterGroup,
  patchFrontmatterTemplate,
  stripHtmlComments,
} from "../parse.ts";

const fb = { path: "2026-10-30-位置编码.md", mtime: "2026-10-30T02:00:00Z" };

test("frontmatter 的 tags 三种写法都能解析", () => {
  const list = parseNote("---\ntitle: 甲\ntags: [深度学习, 论文]\n---\n正文", fb);
  assert.deepEqual(list.meta.tags, ["深度学习", "论文"]);

  const comma = parseNote("---\ntags: a, b\n---\n正文", fb);
  assert.deepEqual(comma.meta.tags, ["a", "b"]);

  const chinese = parseNote("---\ntags: 中文, 深度学习\n---\n正文", fb);
  assert.deepEqual(chinese.meta.tags, ["中文", "深度学习"]);
});

test("没有 frontmatter 时标题取一级标题、时间取 mtime", () => {
  const r = parseNote("# 位置编码\n\n正文", fb);
  assert.equal(r.hadFrontmatter, false);
  assert.equal(r.meta.title, "位置编码");
  assert.equal(r.meta.created, fb.mtime);
  assert.equal(r.meta.updated, fb.mtime);
  assert.equal(r.meta.type, "note");
  assert.deepEqual(r.meta.tags, []);
  assert.equal(r.body, "# 位置编码\n\n正文");
});

test("没有一级标题时标题从文件名推导（去掉日期前缀）", () => {
  const r = parseNote("正文而已", fb);
  assert.equal(r.meta.title, "位置编码");
});

test("frontmatter 写坏的（没有结束标记）当作无 frontmatter，不抛错", () => {
  const r = parseNote("---\ntitle: x\n\n正文没有结束标记", fb);
  assert.equal(r.hadFrontmatter, false);
  assert.ok(r.body.includes("正文没有结束标记"));
});

test("只有日期没有时间的 created 补成合法 ISO（沿用 mtime 的时区偏移）", () => {
  const r = parseNote("---\ntitle: x\ncreated: 2026-10-28\n---\n正文", fb);
  assert.equal(r.meta.created, "2026-10-28T00:00:00Z");
});

test("无法从 mtime 推导时区时使用 UTC，而不是固定地区时区", () => {
  const r = parseNote("---\ntitle: x\ncreated: 2026-10-28\n---\n正文", {
    path: "x.md",
    mtime: "invalid",
  });
  assert.equal(r.meta.created, "2026-10-28T00:00:00Z");
});

test("extractLinks 解析三种形态并忽略嵌入", () => {
  const links = extractLinks("见 [[位置编码]] 与 [[Transformer|注意力]] 和 [[Bert#训练]]，还有 ![[图.png]]");
  assert.deepEqual(links, [
    { title: "位置编码", display: null, heading: null },
    { title: "Transformer", display: "注意力", heading: null },
    { title: "Bert", display: null, heading: "训练" },
  ]);
});

test("extractTags 去重、忽略 frontmatter 与井号标题", () => {
  const body = "## 二级标题\n学习 #深度学习 还有 #论文 以及 #深度学习\n行内 `#不是标签`";
  assert.deepEqual(extractTags(body), ["深度学习", "论文"]);
});

test("serializeNote 与 parseNote 往返等价（标题含冒号、中文标签）", () => {
  const meta: NoteMeta = {
    id: "abc12345",
    title: "Transformer 的位置编码: 原理",
    created: "2026-10-30T02:00:00Z",
    updated: "2026-10-30T03:00:00Z",
    type: "note",
    tags: ["深度学习", "论文"],
  };
  const raw = serializeNote(meta, "正文 [[双链]] #标签");
  const back = parseNote(raw, { path: "x.md", mtime: meta.updated });
  assert.deepEqual(back.meta, meta);
  assert.equal(back.body, "正文 [[双链]] #标签");
  assert.equal(raw.includes("source"), false);
});

test("serializeNote 在有 source 时保留 source", () => {
  const meta: NoteMeta = {
    id: "abc12345",
    title: "论文",
    created: "2026-10-30T02:00:00Z",
    updated: "2026-10-30T02:00:00Z",
    type: "source",
    tags: [],
    source: "https://arxiv.org/abs/1706.03762",
  };
  const back = parseNote(serializeNote(meta, "正文"), { path: "x.md", mtime: meta.updated });
  assert.equal(back.meta.source, "https://arxiv.org/abs/1706.03762");
});

test("slugify 保留中文、替换非法字符、限制长度", () => {  assert.equal(slugify("Transformer 的位置编码: 原理/实现"), "Transformer-的位置编码-原理-实现");
  assert.equal(slugify("   ...  "), "untitled");
  assert.ok(slugify("a".repeat(100)).length <= 60);
});

test("excerpt 压掉换行并截断", () => {
  const got = excerpt("# 标题\n\n这是 一段\n正文内容", 6);
  assert.equal(got.includes("\n"), false);
  assert.ok(got.length <= 7);
});

test("excerpt：行内代码保留文字、表格只留单元格（list-001）", () => {
  assert.equal(excerpt("更新参数：`w = w - lr * g`。"), "更新参数：w = w - lr * g。");
  assert.equal(excerpt("| 函数 | 特点 |\n|---|:---:|\n| ReLU | 简单 |"), "函数 · 特点 ReLU · 简单");
});

test("excerpt：去掉列表、任务、引用、分隔线标记（list-001）", () => {
  const body = "## 矩阵乘法\n- [x] 复习定义\n- [ ] 做习题 3.2\n1. 第一步\n* 星号项\n> 引用：[[概率论]]\n\n---\n结尾";
  assert.equal(excerpt(body), "矩阵乘法 复习定义 做习题 3.2 第一步 星号项 引用：概率论 结尾");
});

test("excerpt：callout 的 [!card] 标记不进摘要（srs-001）", () => {
  assert.equal(excerpt("> [!card] 梯度下降\n> - 沿负梯度更新"), "梯度下降 沿负梯度更新");
});

test("excerpt：snake_case 的下划线保留，强调标记去掉（list-001）", () => {
  assert.equal(excerpt("调用 learning_rate_decay，**重点** 和 _斜体_ ~~删掉~~"), "调用 learning_rate_decay，重点 和 斜体 删掉");
});

test("parseNote：inbox/ 里没写 type 的笔记算收件箱想法（ui-008）", () => {
  const mtime = "2026-11-14T00:00:00.000Z";
  assert.equal(parseNote("# 快速记录\n临时想法", { path: "inbox/quick.md", mtime }).meta.type, "idea");
  assert.equal(parseNote("# 快速记录", { path: "inbox\\quick.md", mtime }).meta.type, "idea");
  assert.equal(parseNote("---\ntype: note\n---\n正文", { path: "inbox/x.md", mtime }).meta.type, "note");
  assert.equal(parseNote("正文", { path: "inboxes/x.md", mtime }).meta.type, "note");
  assert.equal(parseNote("正文", { path: "x.md", mtime }).meta.type, "note");
});

test("contentHash 稳定且区分内容", () => {
  assert.equal(contentHash("abc"), contentHash("abc"));
  assert.notEqual(contentHash("abc"), contentHash("abd"));
  assert.equal(contentHash("abc").length, 64);
});

test("deriveTitle 优先一级标题，其次文件名", () => {
  assert.equal(deriveTitle("# 我的标题\n正文", "2026-10-30-x.md"), "我的标题");
  assert.equal(deriveTitle("正文", "2026-10-30-我的笔记.md"), "我的笔记");
});

test("正文被 --- 包起来但不是 key: value 形状时，不当 frontmatter，正文一段都不丢", () => {
  const raw = "---\n\n第一段\n\n---\n\n第二段";
  const note = parseNote(raw, { path: "2026-10-30-分隔线.md", mtime: "2026-10-30T02:00:00Z" });
  assert.equal(note.hadFrontmatter, false);
  assert.equal(note.body, raw);
  assert.ok(note.body.includes("第一段"));
  assert.ok(note.body.includes("第二段"));
});

test("中文键名不算 frontmatter（避免把「注意：xxx」当元数据吞掉）", () => {
  const raw = "---\n注意：这不是元数据\n---\n正文还在";
  const note = parseNote(raw, { path: "x.md", mtime: "2026-10-30T02:00:00Z" });
  assert.equal(note.hadFrontmatter, false);
  assert.equal(note.body, raw);
});


// ---- 分组（group）字段 ----

const baseMeta: NoteMeta = {
  id: "n1",
  title: "位置编码",
  created: "2026-10-30T02:00:00Z",
  updated: "2026-10-30T02:00:00Z",
  type: "note",
  tags: ["深度学习"],
};

test("serializeNote 把 group 写在 tags 之后、source 之前", () => {
  const raw = serializeNote({ ...baseMeta, group: "Go 学习", source: "graylight" }, "正文");
  const tagsAt = raw.indexOf("tags:");
  const groupAt = raw.indexOf("group: Go 学习");
  const sourceAt = raw.indexOf("source: graylight");
  assert.ok(tagsAt > 0 && groupAt > tagsAt && sourceAt > groupAt, raw);
  assert.ok(raw.includes("group: Go 学习"));
});

test("没有 group 时 frontmatter 里不出现这个键", () => {
  const raw = serializeNote(baseMeta, "正文");
  assert.equal(raw.includes("group:"), false);
});

test("parseNote 读回 group，去引号", () => {
  const plain = parseNote("---\ntitle: 甲\ngroup: Go 学习\n---\n正文", fb);
  assert.equal(plain.meta.group, "Go 学习");

  const quoted = parseNote('---\ntitle: 甲\ngroup: "Agent: 入门"\n---\n正文', fb);
  assert.equal(quoted.meta.group, "Agent: 入门");
});

test("patchFrontmatterGroup 给没有 frontmatter 的笔记插入最小块，正文一个字不动", () => {
  const raw = "# Go 学习\n\n第一课\n";
  const result = patchFrontmatterGroup(raw, "Go 学习");
  assert.equal(result.changed, true);
  assert.equal(result.raw, "---\ngroup: Go 学习\n---\n\n# Go 学习\n\n第一课\n");

  const parsed = parseNote(result.raw, fb);
  assert.equal(parsed.meta.group, "Go 学习");
  assert.equal(parsed.body, raw);
});

test("patchFrontmatterGroup 原位替换 group 行，其它键与顺序不变", () => {
  const raw = "---\nid: n1\ntitle: 甲\ntags: [a]\ngroup: 旧的\n---\n正文";
  const result = patchFrontmatterGroup(raw, "新的");
  assert.equal(result.raw, "---\nid: n1\ntitle: 甲\ntags: [a]\ngroup: 新的\n---\n正文");
});

test("patchFrontmatterGroup 在 tags 之后插入 group 行", () => {
  const raw = "---\nid: n1\ntitle: 甲\ntags: [a]\n---\n正文";
  const result = patchFrontmatterGroup(raw, "新的");
  assert.equal(result.raw, "---\nid: n1\ntitle: 甲\ntags: [a]\ngroup: 新的\n---\n正文");
});

test("patchFrontmatterGroup 传 null 删掉 group 行，块还空就整块拿掉", () => {
  const keepOthers = patchFrontmatterGroup("---\nid: n1\ngroup: x\n---\n正文", null);
  assert.equal(keepOthers.raw, "---\nid: n1\n---\n正文");

  const onlyGroup = patchFrontmatterGroup("---\ngroup: x\n---\n正文", null);
  assert.equal(onlyGroup.raw, "正文");
});

test("patchFrontmatterGroup 同组时返回 changed: false 且内容不变", () => {
  const raw = "---\nid: n1\ngroup: Go 学习\n---\n正文";
  const same = patchFrontmatterGroup(raw, "go 学习");
  assert.equal(same.changed, false);
  assert.equal(same.raw, raw);

  const noGroup = patchFrontmatterGroup("---\nid: n1\n---\n正文", null);
  assert.equal(noGroup.changed, false);
});


// ---- 边界：BOM / 往返一致（整理不算编辑，来回一趟文件要回到原样） ----

test("patchFrontmatterGroup 认得带 BOM 的 frontmatter，不会插出第二个块", () => {
  const raw = "\uFEFF---\ntitle: 甲\ntags: []\n---\n正文\n";
  const result = patchFrontmatterGroup(raw, "Go 学习");
  assert.equal(result.changed, true);
  assert.ok(result.raw.startsWith("\uFEFF---\n"), "BOM 要留在文件最前面");
  assert.equal(result.raw, "\uFEFF---\ntitle: 甲\ntags: []\ngroup: Go 学习\n---\n正文\n");
  assert.equal(result.raw.replace("\uFEFF", "").match(/^---/gm)?.length, 2, "只应该有一个 frontmatter 块");

  const parsed = parseNote(result.raw, fb);
  assert.equal(parsed.meta.title, "甲");
  assert.equal(parsed.meta.group, "Go 学习");
});

test("没有 frontmatter 的笔记：归组再移出，文件逐字节回到原样", () => {
  const raw = "# 标题\n\n正文一行\n";
  const set = patchFrontmatterGroup(raw, "Go 学习");
  const cleared = patchFrontmatterGroup(set.raw, null);
  assert.equal(cleared.raw, raw);

  const crlf = "# 标题\r\n\r\n正文\r\n";
  const setCrlf = patchFrontmatterGroup(crlf, "Go 学习");
  // 整份文件是 CRLF 时，插入的块也用 CRLF（不制造混合换行）\n  assert.equal(setCrlf.raw, "---\r\ngroup: Go 学习\r\n---\r\n\r\n# 标题\r\n\r\n正文\r\n");
  const clearedCrlf = patchFrontmatterGroup(setCrlf.raw, null);
  assert.equal(clearedCrlf.raw, crlf);
});

// ---- 笔记模板（tpl-001） ----

test("stripHtmlComments：去掉注释、换行和行号不变；代码块、行内代码、没闭合的不动", () => {
  assert.equal(stripHtmlComments("## 背景\n<!-- 为什么做 -->\n正文"), "## 背景\n\n正文");
  assert.equal(stripHtmlComments("a <!-- 两行\n注释 --> b"), "a \n b");
  assert.equal(stripHtmlComments("<!-- <script>x</script> -->正文"), "正文");
  assert.equal(stripHtmlComments("```\n<!-- 代码里 -->\n```\n<!-- 外面 -->"), "```\n<!-- 代码里 -->\n```\n");
  assert.equal(stripHtmlComments("~~~~\n```\n<!-- 还在代码里 -->\n~~~~"), "~~~~\n```\n<!-- 还在代码里 -->\n~~~~");
  assert.equal(stripHtmlComments("看 `<!-- 行内 -->` 和 <!-- 注释 -->"), "看 `<!-- 行内 -->` 和 ");
  assert.equal(stripHtmlComments("<!-- 没闭合\n正文"), "<!-- 没闭合\n正文");
  const plain = "没有注释的正文\n";
  assert.equal(stripHtmlComments(plain), plain);
});

test("excerpt：模板提示注释不进摘要", () => {
  assert.equal(excerpt("## 背景\n<!-- 为什么做、要解决什么问题 -->\n\n真正的内容\n"), "背景 真正的内容");
});

test("parseNote / serializeNote：template 键读写，写在 group 之后", () => {
  const meta: NoteMeta = {
    id: "t1",
    title: "主循环",
    created: "2026-11-19T09:00:00+08:00",
    updated: "2026-11-19T09:00:00+08:00",
    type: "note",
    tags: [],
    group: "agent/looprun",
    template: "实现详情",
  };
  const raw = serializeNote(meta, "正文\n");
  assert.match(raw, /group: agent\/looprun\ntemplate: 实现详情\n---/);
  assert.equal(parseNote(raw, fb).meta.template, "实现详情");
  assert.equal(parseNote('---\ntemplate: "a: b"\n---\n\nx', fb).meta.template, "a: b");
  assert.equal(parseNote("---\ntitle: x\n---\n\ny", fb).meta.template, undefined);
});

test("patchFrontmatterTemplate：只改这一行，正文与其它键逐字节保留；插在 group 之后；null 删行", () => {
  const raw = "---\nid: a\ntags: []\ngroup: g\nsource: s\n---\n\n正文 <!-- x -->\n";
  const added = patchFrontmatterTemplate(raw, "实现详情");
  assert.equal(added.raw, "---\nid: a\ntags: []\ngroup: g\ntemplate: 实现详情\nsource: s\n---\n\n正文 <!-- x -->\n");
  const renamed = patchFrontmatterTemplate(added.raw, "实现细节");
  assert.equal(renamed.raw, raw.replace("group: g\n", "group: g\ntemplate: 实现细节\n"));
  // 只改大小写也算改
  assert.equal(patchFrontmatterTemplate("---\ntemplate: daily\n---\nx", "Daily").raw, "---\ntemplate: Daily\n---\nx");
  assert.deepEqual(patchFrontmatterTemplate(added.raw, "实现详情"), { raw: added.raw, changed: false });
  assert.equal(patchFrontmatterTemplate(added.raw, null).raw, raw);
  // 没有 group：插在 tags（含块状列表）之后
  assert.equal(
    patchFrontmatterTemplate("---\ntags:\n  - a\nsource: s\n---\nx", "T").raw,
    "---\ntags:\n  - a\ntemplate: T\nsource: s\n---\nx",
  );
  // 没有 frontmatter：插最小块，再删掉逐字节回到原样
  const bare = "# 标题\n正文";
  const withBlock = patchFrontmatterTemplate(bare, "T");
  assert.equal(withBlock.raw, "---\ntemplate: T\n---\n\n# 标题\n正文");
  assert.equal(patchFrontmatterTemplate(withBlock.raw, null).raw, bare);
  assert.deepEqual(patchFrontmatterTemplate(bare, null), { raw: bare, changed: false });
  // 带引号的值要转义
  assert.match(patchFrontmatterTemplate("---\nid: a\n---\nx", "a: b").raw, /template: "a: b"/);
});
