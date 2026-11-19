/**
 * 笔记模板（tpl-001）的纯函数：内置模板、校验、骨架、给外部 AI 的提示词。
 * 前端（新建页预填、复制成提示词、模板面板）和后端（templates.json 读写、新建时自动套用）共用这一份。
 */

export type TemplateSection = { title: string; hint: string };
/**
 * prompt（tpl-003，可选）：这个模板专属的「额外要求」，复制成提示词时接在固定要求后面。
 * 空着就不写进 templates.json，旧文件照常读。
 */
export type NoteTemplate = { name: string; sections: TemplateSection[]; prompt?: string };

/** 模板名、小节标题的上限（字符数，中文也算 1 个） */
export const MAX_TEMPLATE_NAME = 40;
export const MAX_SECTION_TITLE = 40;
export const MAX_SECTION_HINT = 200;
export const MAX_TEMPLATES = 50;
export const MAX_SECTIONS = 20;
/** 专属提示词（额外要求）最长多少字 */
export const MAX_TEMPLATE_PROMPT = 2000;

/** 规整时放不进任何小节的内容去这里（tpl-002）；模板里不能有同名小节 */
export const OTHER_SECTION = "其他";
/** 小节没有内容时写的字（提示词要求外部 AI 也这么写） */
export const TODO_MARK = "待补";

export const BUILTIN_TEMPLATES: NoteTemplate[] = [
  {
    name: "实现详情",
    sections: [
      { title: "背景", hint: "为什么做、要解决什么问题" },
      { title: "设计", hint: "结构、流程、关键决策和取舍" },
      { title: "关键代码", hint: "文件路径 + 片段，说明它在流程里的位置" },
      { title: "踩坑", hint: "遇到的问题、原因、怎么解决的" },
      { title: "待办", hint: "还没做的、想改进的（- [ ] 任务）" },
    ],
  },
  {
    name: "学习笔记",
    sections: [
      { title: "要点", hint: "最重要的几条结论" },
      { title: "例子", hint: "能说明要点的例子或代码" },
      { title: "我的理解", hint: "用自己的话复述，和已知的东西联系起来" },
      { title: "疑问", hint: "还没弄懂的地方" },
      { title: "简卡", hint: "一行一张：问题 :: 答案，复习时用" },
    ],
  },
];

const BAD_NAME_CHARS = /[\\:*?"<>|]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** 多行文字（专属提示词）里允许换行和 Tab，其它控制字符不行 */
const CONTROL_CHARS_MULTILINE = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** 专属提示词：统一换行、去首尾空白；空的返回 ""（调用方据此不写这个字段） */
export function validateTemplatePrompt(raw: unknown, label = "模板"): { ok: true; prompt: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, prompt: "" };
  if (typeof raw !== "string") return { ok: false, error: `${label}的专属提示词必须是文字` };
  const prompt = raw.replace(/\r\n?/g, "\n").trim();
  if ([...prompt].length > MAX_TEMPLATE_PROMPT) {
    return { ok: false, error: `${label}的专属提示词太长，最多 ${MAX_TEMPLATE_PROMPT} 个字` };
  }
  if (CONTROL_CHARS_MULTILINE.test(prompt)) return { ok: false, error: `${label}的专属提示词里有不可见控制字符` };
  return { ok: true, prompt };
}

/** 模板名比较：去首尾空白、不区分大小写 */
export function sameTemplate(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

/** 某个分组设的默认模板（只认这个组自己的，不往父分组找）；没设或模板已删返回 undefined */
export function groupDefaultTemplate(
  groupDefaults: Record<string, string>,
  templates: NoteTemplate[],
  group: string | null | undefined,
): NoteTemplate | undefined {
  if (!group?.trim()) return undefined;
  const norm = (name: string) =>
    name
      .replace(/[\s\u3000]+/g, " ")
      .split("/")
      .map((part) => part.trim())
      .join("/")
      .trim()
      .toLowerCase();
  const key = Object.keys(groupDefaults).find((name) => norm(name) === norm(group));
  return key ? findTemplate(templates, groupDefaults[key]) : undefined;
}

export function findTemplate(list: NoteTemplate[], name: string | null | undefined): NoteTemplate | undefined {
  if (!name?.trim()) return undefined;
  return list.find((item) => sameTemplate(item.name, name));
}

/** 去首尾空白，内部连续空白压成一个半角空格 */
function tidy(raw: string): string {
  return raw.replace(/[\s　]+/g, " ").trim();
}

export function validateTemplateName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "模板名必须是文字" };
  const name = tidy(raw);
  if (!name) return { ok: false, error: "模板名不能为空" };
  if ([...name].length > MAX_TEMPLATE_NAME) return { ok: false, error: `模板名太长，最多 ${MAX_TEMPLATE_NAME} 个字` };
  if (BAD_NAME_CHARS.test(name)) return { ok: false, error: '模板名里不能有 \\ : * ? " < > | 这些字符' };
  if (CONTROL_CHARS.test(name)) return { ok: false, error: "模板名里有不可见控制字符" };
  return { ok: true, name };
}

/** 校验一个模板（名字、小节），返回规整后的副本 */
export function validateTemplate(raw: unknown): { ok: true; template: NoteTemplate } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "模板格式不对" };
  const input = raw as Record<string, unknown>;
  const name = validateTemplateName(input.name);
  if (!name.ok) return name;
  const label = `模板「${name.name}」`;
  if (!Array.isArray(input.sections) || input.sections.length === 0) {
    return { ok: false, error: `${label}至少要有一个小节` };
  }
  if (input.sections.length > MAX_SECTIONS) return { ok: false, error: `${label}最多 ${MAX_SECTIONS} 个小节` };
  const sections: TemplateSection[] = [];
  for (const item of input.sections) {
    const section = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const title = typeof section.title === "string" ? tidy(section.title) : "";
    const hint = typeof section.hint === "string" ? tidy(section.hint) : "";
    if (!title) return { ok: false, error: `${label}有小节没写标题` };
    if ([...title].length > MAX_SECTION_TITLE) {
      return { ok: false, error: `${label}的小节「${title}」标题太长，最多 ${MAX_SECTION_TITLE} 个字` };
    }
    // 小节标题会写成 `## 标题`：开头的 # 会变成更深的标题
    if (/^#/.test(title) || CONTROL_CHARS.test(title)) {
      return { ok: false, error: `${label}的小节「${title}」标题不能以 # 开头` };
    }
    if (sameTemplate(title, OTHER_SECTION)) {
      return { ok: false, error: `${label}不能有叫「${OTHER_SECTION}」的小节：规整时放不进去的内容用它` };
    }
    if (sections.some((other) => sameTemplate(other.title, title))) {
      return { ok: false, error: `${label}有两个叫「${title}」的小节` };
    }
    if ([...hint].length > MAX_SECTION_HINT) {
      return { ok: false, error: `${label}的小节「${title}」提示太长，最多 ${MAX_SECTION_HINT} 个字` };
    }
    // 提示写进 <!-- … -->：里面再出现注释标记会把注释提前截断，后半截露到预览里
    if (hint.includes("-->") || hint.includes("<!--") || CONTROL_CHARS.test(hint)) {
      return { ok: false, error: `${label}的小节「${title}」提示里不能有 <!-- 或 -->` };
    }
    sections.push({ title, hint });
  }
  const prompt = validateTemplatePrompt(input.prompt, label);
  if (!prompt.ok) return prompt;
  return { ok: true, template: prompt.prompt ? { name: name.name, sections, prompt: prompt.prompt } : { name: name.name, sections } };
}

/** 校验整份模板列表（数量、重名） */
export function validateTemplateList(raw: unknown): { ok: true; templates: NoteTemplate[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "templates 必须是列表" };
  if (raw.length > MAX_TEMPLATES) return { ok: false, error: `最多 ${MAX_TEMPLATES} 个模板` };
  const out: NoteTemplate[] = [];
  for (const item of raw) {
    const check = validateTemplate(item);
    if (!check.ok) return check;
    if (findTemplate(out, check.template.name)) return { ok: false, error: `有两个叫「${check.template.name}」的模板` };
    out.push(check.template);
  }
  return { ok: true, templates: out };
}

/**
 * 骨架：每个小节一个 `## 标题`，下面一行 `<!-- 提示 -->`（预览里不显示）。
 * 不写 `# 标题`：标题已经在文件头和连读的章标题里。
 */
export function templateSkeleton(template: NoteTemplate): string {
  return template.sections
    .map((section) => (section.hint ? `## ${section.title}\n<!-- ${section.hint} -->\n` : `## ${section.title}\n`))
    .join("\n");
}

/** 正文是不是「空的或者只有这个模板的骨架」：是的话换模板时可以直接覆盖，不用问 */
export function isBlankOrSkeleton(body: string, templates: NoteTemplate[]): boolean {
  const text = body.trim();
  if (!text) return true;
  return templates.some((template) => templateSkeleton(template).trim() === text);
}

/** 复制给外部 AI 的提示词（方案 5.3）。topic 空着时让用户自己补 */
export function templatePrompt(template: NoteTemplate, topic: string): string {
  const subject = topic.trim() ? `「${topic.trim()}」` : "（主题自己补上）";
  const outline = template.sections
    .map((section) => (section.hint ? `## ${section.title}\n（${section.hint}）` : `## ${section.title}`))
    .join("\n");
  const first = template.sections[0]?.title ?? "";
  return [
    `请就${subject}写一篇笔记，严格按下面的结构输出：`,
    "",
    outline,
    "",
    "要求：",
    `- 只输出 Markdown 正文，从第一个「## ${first}」开始，不要开场白、不要结尾的客套话；`,
    "- 小节标题、顺序和级别都不要改，不要加别的 ## 小节（小节里可以用 ### 细分）；",
    `- 某个小节没有可写的内容就只写「${TODO_MARK}」，不要编造。`,
    // 模板专属的额外要求（tpl-003）接在固定要求后面：结构和「只输出 Markdown / 写待补」这几条始终由应用来写
    ...(template.prompt?.trim() ? ["", "这个模板的额外要求：", template.prompt.trim()] : []),
    "",
  ].join("\n");
}
