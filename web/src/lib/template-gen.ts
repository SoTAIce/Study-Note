/**
 * AI 生成模板（tpl-003）的纯函数，前后端共用：
 * - clipNotes：选中笔记的正文按上限截断（每篇 6000 字、总共 20000 字）；
 * - templateGenMessages：三种请求（从笔记归纳 / 一句话描述 / 按小节改写专属提示词）发给模型的消息；
 * - normalizeGenerated：从模型回复里取出模板，只认 name / sections / prompt，用现有校验把关，重名自动加「 2」。
 *
 * AI 只产出模板，不写盘：前端预览、人确认后加入列表，点「保存」才写进 templates.json。
 */
import { extractJsonReply } from "./ai-json.ts";
import {
  MAX_TEMPLATE_NAME,
  OTHER_SECTION,
  TODO_MARK,
  sameTemplate,
  templateSkeleton,
  validateTemplate,
  type NoteTemplate,
} from "./templates.ts";

export const GEN_MAX_NOTES = 5;
export const GEN_NOTE_CHARS = 6000;
export const GEN_TOTAL_CHARS = 20000;
export const GEN_MAX_DESCRIPTION = 500;
export const GEN_MAX_EXTRA = 200;

export type GenNote = { title: string; body: string };
export type ClippedNote = { title: string; body: string; truncated: boolean };

export type GenRequest =
  | { from: "notes"; notes: ClippedNote[]; note?: string }
  | { from: "describe"; description: string }
  | { from: "prompt"; template: NoteTemplate };

export class TemplateGenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateGenError";
  }
}

function chars(text: string): string[] {
  return [...text];
}

/** 每篇最多 GEN_NOTE_CHARS 字，总共最多 GEN_TOTAL_CHARS 字；被截的标上，告诉模型「已截断」 */
export function clipNotes(notes: GenNote[]): ClippedNote[] {
  let left = GEN_TOTAL_CHARS;
  return notes.map((note) => {
    const body = chars(note.body.trim());
    const keep = Math.max(0, Math.min(GEN_NOTE_CHARS, left, body.length));
    left -= keep;
    return { title: note.title, body: body.slice(0, keep).join(""), truncated: keep < body.length };
  });
}

const SHAPE = '{"name": "模板名", "sections": [{"title": "小节标题", "hint": "一句话提示"}], "prompt": "额外要求"}';

const RULES = [
  "规则：",
  "- 只回一个 JSON 对象，不要任何解释或代码块以外的文字；",
  `- name 简短（不超过 ${MAX_TEMPLATE_NAME} 个字），不能有 \\ : * ? " < > | 这些字符；`,
  "- sections 3～8 个；title 简短、不带编号和 # 号，彼此不重复；",
  `- 不要有叫「${OTHER_SECTION}」的小节（应用整理内容时自己会用它）；`,
  "- hint 一句话，说这一节写什么，不能包含 <!-- 或 -->；",
  "- prompt 只写这个模板特有的额外要求（语言、侧重点、某一节怎么写），2～5 条，用换行分开；",
  `  不要重复小节结构，也不要写「只输出 Markdown」「没内容写${TODO_MARK}」这类通用要求，应用会自己加。`,
].join("\n");

/** 三种请求发给模型的消息 */
export function templateGenMessages(request: GenRequest): Array<{ role: "system" | "user"; content: string }> {
  if (request.from === "prompt") {
    const system = [
      "你是笔记模板设计助手。用户给出一个笔记模板的小节，请为它写「额外要求」：",
      "这段话会接在固定要求（按小节结构输出、只输出 Markdown、没内容写待补）后面，发给外部 AI 用来写笔记。",
      `只回一个 JSON 对象：{"prompt": "额外要求"}。`,
      "额外要求 2～5 条，用换行分开，针对这几个小节的写法和侧重点，不要重复小节结构，也不要写通用要求。",
    ].join("\n");
    const user = [
      `模板「${request.template.name}」的小节：`,
      templateSkeleton(request.template).trim(),
      request.template.prompt ? `现在的额外要求（可以在此基础上改进）：\n${request.template.prompt}` : "现在还没有额外要求。",
    ].join("\n\n");
    return [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
  }

  const system =
    request.from === "notes"
      ? `你是笔记模板设计助手。用户给出几篇写得好的笔记，请归纳它们共同的结构，设计成一个可复用的笔记模板。只回 JSON：${SHAPE}\n${RULES}`
      : `你是笔记模板设计助手。用户用一句话描述想要的笔记模板，请设计它。只回 JSON：${SHAPE}\n${RULES}`;

  let user: string;
  if (request.from === "notes") {
    const parts = request.notes.map(
      (note, at) => `### 笔记 ${at + 1}：${note.title || "（未命名）"}${note.truncated ? "（正文太长，已截断）" : ""}\n\n${note.body}`,
    );
    user = [
      `下面是 ${request.notes.length} 篇笔记，请归纳共同的结构（不要只照搬其中一篇）：`,
      ...parts,
      ...(request.note?.trim() ? [`补充说明：${request.note.trim()}`] : []),
    ].join("\n\n");
  } else {
    user = `想要的笔记模板：${request.description.trim()}`;
  }
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** 不和已有模板重名：「名字 2」「名字 3」…（超长时截短前半截） */
export function uniqueTemplateName(base: string, taken: string[]): string {
  let name = base;
  for (let n = 2; taken.some((item) => sameTemplate(item, name)); n += 1) {
    const suffix = ` ${n}`;
    name = `${chars(base).slice(0, MAX_TEMPLATE_NAME - suffix.length).join("").trimEnd()}${suffix}`;
  }
  return name;
}

/**
 * 从模型回复里取出模板：只认 name / sections（title、hint）/ prompt，其余字段丢掉；
 * 用现有的 validateTemplate 把关（不合格就报错，不生成半截模板）；名字和已有的重复时自动加「 2」。
 */
export function normalizeGenerated(reply: string, takenNames: string[]): NoteTemplate {
  const raw = extractJsonReply(reply);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TemplateGenError("模型没有回一个能解析的 JSON 模板");
  }
  const input = raw as Record<string, unknown>;
  const sections = Array.isArray(input.sections)
    ? input.sections.map((item) => {
        const section = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        return {
          title: typeof section.title === "string" ? section.title : "",
          hint: typeof section.hint === "string" ? section.hint : "",
        };
      })
    : input.sections;
  const check = validateTemplate({ name: input.name, sections, prompt: input.prompt });
  if (!check.ok) throw new TemplateGenError(`模型给的模板不合格：${check.error}`);
  return { ...check.template, name: uniqueTemplateName(check.template.name, takenNames) };
}

/** 「让 AI 改写提示词」：只取 prompt，校验长度和控制字符 */
export function normalizeGeneratedPrompt(reply: string, template: NoteTemplate): NoteTemplate {
  const raw = extractJsonReply(reply);
  const prompt = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).prompt : undefined;
  if (typeof prompt !== "string" || !prompt.trim()) throw new TemplateGenError("模型没有回新的提示词");
  const check = validateTemplate({ ...template, prompt });
  if (!check.ok) throw new TemplateGenError(`模型给的提示词不合格：${check.error}`);
  return check.template;
}
