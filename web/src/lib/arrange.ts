/**
 * 按模板规整（tpl-002）：「只搬不改」的那一半，前后端共用、纯函数。
 *
 * 1. splitBlocks：去掉正文里已有的模板骨架，按 Markdown 顶层块切开、编号；
 * 2. parsePlan：从模型回复里取出「哪块放进哪个小节」的 JSON，并逐条校验；
 * 3. assemble：按方案把原文块逐字拼进模板的各小节；没分配的进「其他」，空小节写「待补」。
 *
 * 模型只能回编号，正文的每个字都来自原文。唯一的格式调整：被放进小节的 # / ## 标题降成 ###，
 * 免得它变成模板以外的新小节（标题文字不动，差异里看得到）。
 */
import { extractJsonReply } from "./ai-json.ts";
import { OTHER_SECTION, TODO_MARK, type NoteTemplate } from "./templates.ts";

/** 一次粘贴超过这么多字、且粘贴前正文几乎是空的，才提示要不要规整 */
export const ARRANGE_PASTE_MIN = 400;
/** 提示条多久不点就自己消失 */
export const ARRANGE_HINT_MS = 10_000;

export type BlockKind = "heading" | "paragraph" | "list" | "code" | "table" | "quote" | "comment";

export type Block = {
  /** 从 0 开始的编号，发给模型的就是它 */
  index: number;
  kind: BlockKind;
  /** 原文，逐字（行尾统一成 \n） */
  text: string;
  /** 标题块的级别（1～6），其它块为 0 */
  level: number;
};

export type ArrangePlan = {
  /** 与 template.sections 一一对应：每个小节收哪些块（按原文顺序） */
  sections: Array<{ title: string; blocks: number[] }>;
  /** 丢掉的块（只能是标题） */
  drop: number[];
  /** 没分配的块，进「其他」 */
  other: number[];
};

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const QUOTE = /^ {0,3}>/;
const TABLE = /^ {0,3}\|/;
const COMMENT_START = /^ {0,3}<!--/;

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

/** 这一行是不是模板骨架里的东西：小节同名的 ## 标题、「## 其他」、骨架提示注释 */
function skeletonLine(line: string, template: NoteTemplate): boolean {
  const heading = /^ {0,3}##[ \t]+(.+?)[ \t#]*$/.exec(line);
  if (heading) {
    const title = normalizeTitle(heading[1]);
    if (title === normalizeTitle(OTHER_SECTION)) return true;
    return template.sections.some((section) => normalizeTitle(section.title) === title);
  }
  const comment = /^\s*<!--\s*([\s\S]*?)\s*-->\s*$/.exec(line);
  if (comment) {
    return template.sections.some((section) => section.hint && section.hint.trim() === comment[1].trim());
  }
  return false;
}

/**
 * 切块。代码块里的 ## 不算标题；列表在空行之后若还是列表项或缩进续行，仍属同一块。
 * 先拿掉骨架（同名小节标题、骨架提示注释），以及上次规整写的单独一段「待补」。
 */
export function splitBlocks(body: string, template: NoteTemplate): Block[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const push = (kind: BlockKind, chunk: string[], level = 0): void => {
    const text = chunk.join("\n").replace(/\s+$/, "");
    if (!text.trim()) return;
    if (kind === "paragraph" && text.trim() === TODO_MARK) return;
    blocks.push({ index: blocks.length, kind, text, level });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const chunk = [line];
      i += 1;
      while (i < lines.length) {
        const current = lines[i];
        chunk.push(current);
        i += 1;
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(current);
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length) break;
      }
      push("code", chunk);
      continue;
    }

    if (skeletonLine(line, template)) {
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      push("heading", [line], heading[1].length);
      i += 1;
      continue;
    }

    if (COMMENT_START.test(line)) {
      const chunk = [line];
      let closed = line.includes("-->", line.indexOf("<!--") + 4);
      i += 1;
      while (!closed && i < lines.length) {
        chunk.push(lines[i]);
        closed = lines[i].includes("-->");
        i += 1;
      }
      push("comment", chunk);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const chunk = [line];
      i += 1;
      while (i < lines.length) {
        const current = lines[i];
        if (isBlank(current)) {
          // 空行后面还是列表项或缩进续行：同一个列表
          let next = i + 1;
          while (next < lines.length && isBlank(lines[next])) next += 1;
          if (next < lines.length && (LIST_ITEM.test(lines[next]) || /^(?: {2,}|\t)/.test(lines[next]))) {
            chunk.push(...lines.slice(i, next));
            i = next;
            continue;
          }
          break;
        }
        if (FENCE.test(current) && !/^(?: {2,}|\t)/.test(current)) break;
        if (HEADING.test(current) && !/^(?: {2,}|\t)/.test(current)) break;
        chunk.push(current);
        i += 1;
      }
      push("list", chunk);
      continue;
    }

    const kind: BlockKind = QUOTE.test(line) ? "quote" : TABLE.test(line) ? "table" : "paragraph";
    const chunk = [line];
    i += 1;
    while (i < lines.length) {
      const current = lines[i];
      if (isBlank(current) || FENCE.test(current) || HEADING.test(current)) break;
      if (kind === "quote" && !QUOTE.test(current)) break;
      if (kind === "table" && !TABLE.test(current)) break;
      if (kind === "paragraph" && (QUOTE.test(current) || TABLE.test(current) || LIST_ITEM.test(current))) break;
      if (skeletonLine(current, template)) break;
      chunk.push(current);
      i += 1;
    }
    push(kind, chunk);
  }
  return blocks;
}

/** 发给模型的块预览：太长的块只给开头，模型只需要知道它讲什么 */
export function blockPreview(block: Block, max = 400): string {
  const text = block.text;
  if ([...text].length <= max) return text;
  return `${[...text].slice(0, max).join("")}…（后面省略）`;
}

/** 从模型回复里取出 JSON 对象：容忍外面包着 ```json 代码块、前后有说明文字 */
export function extractJsonObject(reply: string): unknown {
  const parsed = extractJsonReply(reply);
  if (parsed === undefined) throw new ArrangeError("模型没有回一个能解析的 JSON 分配方案");
  return parsed;
}

export class ArrangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArrangeError";
  }
}

const DROP_KEYS = new Set(["drop", "删除", "丢弃"]);

/**
 * 校验分配方案。不合法就抛 ArrangeError（说清原因），绝不生成半截结果：
 * - 小节名必须是模板里的（忽略大小写和首尾空格）；
 * - 值必须是整数编号的数组，编号不越界、不重复（一个块只能去一个地方）；
 * - drop 里只能是标题块。
 */
export function parsePlan(raw: unknown, template: NoteTemplate, blocks: Block[]): ArrangePlan {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ArrangeError("分配方案应该是一个对象：{\"小节名\": [块编号…], \"drop\": [标题块编号…]}");
  }
  const byTitle = new Map(template.sections.map((section, at) => [normalizeTitle(section.title), at]));
  const sectionBlocks: number[][] = template.sections.map(() => []);
  const drop: number[] = [];
  const seen = new Map<number, string>();

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const isDrop = DROP_KEYS.has(key.trim().toLowerCase());
    // 模型自己写了「其他」：没分配的块本来就进「其他」，这里只校验编号
    const isOther = normalizeTitle(key) === normalizeTitle(OTHER_SECTION);
    const at = isDrop || isOther ? undefined : byTitle.get(normalizeTitle(key));
    if (!isDrop && !isOther && at === undefined) throw new ArrangeError(`模型给了模板里没有的小节「${key}」`);
    if (!Array.isArray(value)) throw new ArrangeError(`「${key}」的值应该是块编号的数组`);
    for (const item of value) {
      if (typeof item !== "number" || !Number.isInteger(item)) {
        throw new ArrangeError(`「${key}」里有不是编号的内容（模型只能回编号，不能写正文）`);
      }
      if (item < 0 || item >= blocks.length) throw new ArrangeError(`块编号 ${item} 超出范围（共 ${blocks.length} 块）`);
      const before = seen.get(item);
      if (before !== undefined) throw new ArrangeError(`块 ${item} 同时被放进了「${before}」和「${key}」`);
      seen.set(item, key);
      if (isDrop) {
        if (blocks[item].kind !== "heading") throw new ArrangeError(`块 ${item} 不是标题，不能丢掉（只有标题可以 drop）`);
        drop.push(item);
      } else if (at !== undefined) {
        sectionBlocks[at].push(item);
      }
    }
  }

  // 同一小节里保持原文先后顺序
  for (const list of sectionBlocks) list.sort((a, b) => a - b);
  drop.sort((a, b) => a - b);
  const placed = new Set<number>([...drop, ...sectionBlocks.flat()]);
  return {
    sections: template.sections.map((section, at) => ({ title: section.title, blocks: sectionBlocks[at] })),
    drop,
    other: blocks.map((block) => block.index).filter((index) => !placed.has(index)),
  };
}

/** 放进小节的 # / ## 标题降成 ###（只改井号，标题文字不动） */
function placeBlock(block: Block): string {
  if (block.kind === "heading" && block.level <= 2) {
    return block.text.replace(/^( {0,3})#{1,2}(?=[ \t]|$)/, "$1###");
  }
  return block.text;
}

/** 按方案拼出规整后的正文 */
export function assemble(template: NoteTemplate, blocks: Block[], plan: ArrangePlan): string {
  const parts: string[] = [];
  template.sections.forEach((section, at) => {
    const head = section.hint ? `## ${section.title}\n<!-- ${section.hint} -->` : `## ${section.title}`;
    const assigned = plan.sections[at]?.blocks ?? [];
    const content = assigned.length > 0 ? assigned.map((index) => placeBlock(blocks[index])).join("\n\n") : TODO_MARK;
    parts.push(`${head}\n\n${content}`);
  });
  if (plan.other.length > 0) {
    parts.push(`## ${OTHER_SECTION}\n\n${plan.other.map((index) => placeBlock(blocks[index])).join("\n\n")}`);
  }
  return `${parts.join("\n\n")}\n`;
}

/** 发给模型的消息（应用内 AI 只回分配方案） */
export function arrangeMessages(
  template: NoteTemplate,
  blocks: Block[],
  noteTitle: string,
): Array<{ role: "system" | "user"; content: string }> {
  const system = [
    "你是笔记整理助手。用户的笔记已经切成编号的块，你只负责把每一块分配到模板的某个小节。",
    "只回一个 JSON 对象，不要任何解释，不要改写或复述正文：",
    '{"小节名": [块编号, ...], ..., "drop": [块编号, ...]}',
    "规则：",
    "- 小节名只能用给出的那几个，原样照抄；",
    "- 每个编号最多出现一次；拿不准放哪的块不要写，应用会把它放进末尾的「其他」；",
    "- drop 只能放标题块：原文里和模板小节意思重复的标题（比如「## 1. 背景」），由模板的小节标题代替；",
    "- 讲细节的小标题（###）跟着它下面的内容一起放进同一个小节，不要 drop。",
  ].join("\n");
  const outline = template.sections
    .map((section) => (section.hint ? `- ${section.title}：${section.hint}` : `- ${section.title}`))
    .join("\n");
  const numbered = blocks
    .map((block) => `[${block.index}]${block.kind === "heading" ? "（标题）" : ""}\n${blockPreview(block)}`)
    .join("\n\n");
  const user = [
    `笔记标题：${noteTitle || "（未命名）"}`,
    `模板「${template.name}」的小节：\n${outline}`,
    `笔记的块（共 ${blocks.length} 块）：\n\n${numbered}`,
  ].join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
