/**
 * AI 生成模板（tpl-003）：POST /api/ai/template
 *   { from: "notes", ids: string[], note?: string }      选 1～5 篇笔记归纳共同结构
 *   { from: "describe", description: string }            一句话描述
 *   { from: "prompt", template: { name, sections, prompt? } }  按小节改写专属提示词
 * → { template: { name, sections, prompt? }, truncated: string[], callId }
 *
 * **不写盘**：只产出模板，前端预览、人确认后加入列表，点「保存」才写进 templates.json。
 * 纯逻辑（截断、消息、解析与校验）在 web/src/lib/template-gen.ts。
 */
import { AiEmptyError, loadAiConfig, streamAi, type AiConfig } from "./ai.ts";
import { readTemplates } from "./templates.ts";
import {
  GEN_MAX_DESCRIPTION,
  GEN_MAX_EXTRA,
  GEN_MAX_NOTES,
  TemplateGenError,
  clipNotes,
  normalizeGenerated,
  normalizeGeneratedPrompt,
  templateGenMessages,
  type GenNote,
  type GenRequest,
} from "../web/src/lib/template-gen.ts";
import { validateTemplate, type NoteTemplate } from "../web/src/lib/templates.ts";

export class TemplateGenHttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "TemplateGenHttpError";
    this.status = status;
    this.code = code;
  }
}

/** 模板 JSON 不长，但归纳时模型要先读几篇笔记；给推理型模型留够预算 */
const GEN_MIN_TOKENS = 4096;

export type TemplateGenInput = {
  dataDir: string;
  payload: Record<string, unknown>;
  /** 按 id 读笔记正文（已去掉文件头和提示注释）；不存在时抛 404 */
  readNote: (id: string) => GenNote;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  record?: (model: string, output: string) => number;
};

function bad(message: string): TemplateGenHttpError {
  return new TemplateGenHttpError(400, "BAD_REQUEST", `参数错误：${message}`);
}

/** 校验请求、读笔记，得到发给模型的请求和被截断的笔记标题 */
function buildRequest(input: TemplateGenInput): { request: GenRequest; truncated: string[] } {
  const { payload } = input;
  if (payload.from === "notes") {
    const ids = Array.isArray(payload.ids) ? [...new Set(payload.ids.filter((id): id is string => typeof id === "string" && id.length > 0))] : [];
    if (ids.length === 0) throw bad("至少选一篇笔记");
    if (ids.length > GEN_MAX_NOTES) throw bad(`最多选 ${GEN_MAX_NOTES} 篇笔记`);
    const extra = typeof payload.note === "string" ? payload.note.trim() : "";
    if ([...extra].length > GEN_MAX_EXTRA) throw bad(`补充说明最多 ${GEN_MAX_EXTRA} 个字`);
    const notes = clipNotes(ids.map((id) => input.readNote(id)));
    if (notes.every((note) => !note.body.trim())) throw bad("选中的笔记都是空的，没有可归纳的内容");
    return {
      request: { from: "notes", notes, note: extra || undefined },
      truncated: notes.filter((note) => note.truncated).map((note) => note.title),
    };
  }
  if (payload.from === "describe") {
    const description = typeof payload.description === "string" ? payload.description.trim() : "";
    if (!description) throw bad("先写一句想要什么样的模板");
    if ([...description].length > GEN_MAX_DESCRIPTION) throw bad(`描述最多 ${GEN_MAX_DESCRIPTION} 个字`);
    return { request: { from: "describe", description }, truncated: [] };
  }
  if (payload.from === "prompt") {
    const check = validateTemplate(payload.template);
    if (!check.ok) throw bad(check.error);
    return { request: { from: "prompt", template: check.template }, truncated: [] };
  }
  throw bad("from 只能是 notes、describe 或 prompt");
}

export async function generateTemplate(
  input: TemplateGenInput,
): Promise<{ template: NoteTemplate; truncated: string[]; callId: number | null }> {
  const { request, truncated } = buildRequest(input);
  const cfg = loadAiConfig(input.dataDir);
  if (!cfg) throw new TemplateGenHttpError(503, "AI_UNCONFIGURED", "AI 未配置：请在设置里填 baseUrl / model / apiKey");
  const callCfg: AiConfig = { ...cfg, maxTokens: Math.max(cfg.maxTokens, GEN_MIN_TOKENS) };

  let reply = "";
  try {
    for await (const delta of streamAi(callCfg, templateGenMessages(request), input.fetchImpl, input.signal)) {
      reply += delta;
    }
  } catch (err) {
    if (err instanceof AiEmptyError) {
      throw new TemplateGenHttpError(502, "AI_EMPTY", "模型没给出内容，换个模型或调大长度（maxTokens）再试");
    }
    const code = (err as { code?: string }).code ?? "AI_ERROR";
    throw new TemplateGenHttpError(code === "AI_CANCELLED" ? 499 : 502, code, (err as Error).message);
  }
  const callId = input.record ? input.record(callCfg.model, reply) : null;

  try {
    const template =
      request.from === "prompt"
        ? normalizeGeneratedPrompt(reply, request.template)
        : normalizeGenerated(reply, readTemplates(input.dataDir).templates.map((item) => item.name));
    return { template, truncated, callId };
  } catch (err) {
    if (err instanceof TemplateGenError) {
      throw new TemplateGenHttpError(422, "TEMPLATE_INVALID", `${err.message}；什么都没保存，可以重试或换个模型`);
    }
    throw err;
  }
}
