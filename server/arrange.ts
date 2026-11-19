/**
 * 按模板规整（tpl-002）的服务端：POST /api/ai/arrange { id, template, baseHash }
 *
 * 切块 → 请应用内 AI 只回分配方案 → 校验 → 逐字拼好正文，**不写盘**：
 * 前端先给人看差异，点「应用」才走整篇替换保存（存历史版本，可撤销）。
 * 纯逻辑在 web/src/lib/arrange.ts（前后端共用、单测覆盖）。
 */
import { AiEmptyError, loadAiConfig, streamAi, type AiConfig } from "./ai.ts";
import { readTemplates } from "./templates.ts";
import {
  ArrangeError,
  arrangeMessages,
  assemble,
  extractJsonObject,
  parsePlan,
  splitBlocks,
  type ArrangePlan,
  type Block,
} from "../web/src/lib/arrange.ts";
import { findTemplate } from "../web/src/lib/templates.ts";

export type ArrangeResult = {
  template: string;
  /** 规整基于的那一版（前端应用前对一下，期间正文改过就不能直接套用） */
  baseHash: string;
  blocks: Block[];
  plan: ArrangePlan;
  body: string;
};

export class ArrangeHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ArrangeHttpError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** 分配方案很短；给推理型模型留点余量，免得思考把预算吃光 */
const ARRANGE_MIN_TOKENS = 2048;

export type ArrangeInput = {
  dataDir: string;
  note: { title: string; body: string; hash: string };
  templateName: string;
  baseHash?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** 记一笔 ai_calls，返回 callId（前端应用后会回报 accept） */
  record?: (model: string, output: string) => number;
};

export async function arrangeNote(input: ArrangeInput): Promise<ArrangeResult & { callId: number | null }> {
  const { note } = input;
  if (input.baseHash && input.baseHash !== note.hash) {
    throw new ArrangeHttpError(409, "CONFLICT", "笔记在别处改过了，请先刷新再规整", { currentHash: note.hash });
  }
  const template = findTemplate(readTemplates(input.dataDir).templates, input.templateName);
  if (!template) throw new ArrangeHttpError(400, "TEMPLATE_MISSING", `模板「${input.templateName}」不存在`);

  const blocks = splitBlocks(note.body, template);
  if (blocks.length === 0) throw new ArrangeHttpError(400, "EMPTY", "正文里除了模板骨架没有别的内容，没有可规整的");

  const cfg = loadAiConfig(input.dataDir);
  if (!cfg) {
    throw new ArrangeHttpError(503, "AI_UNCONFIGURED", "AI 未配置：请在设置里填 baseUrl / model / apiKey");
  }
  const callCfg: AiConfig = { ...cfg, temperature: Math.min(cfg.temperature, 0.2), maxTokens: Math.max(cfg.maxTokens, ARRANGE_MIN_TOKENS) };

  let reply = "";
  try {
    for await (const delta of streamAi(callCfg, arrangeMessages(template, blocks, note.title), input.fetchImpl, input.signal)) {
      reply += delta;
    }
  } catch (err) {
    if (err instanceof AiEmptyError) {
      throw new ArrangeHttpError(502, "AI_EMPTY", "模型没给出分配方案，换个模型或调大长度（maxTokens）再试");
    }
    const code = (err as { code?: string }).code ?? "AI_ERROR";
    throw new ArrangeHttpError(code === "AI_CANCELLED" ? 499 : 502, code, (err as Error).message);
  }
  const callId = input.record ? input.record(callCfg.model, reply) : null;

  let plan: ArrangePlan;
  try {
    plan = parsePlan(extractJsonObject(reply), template, blocks);
  } catch (err) {
    if (err instanceof ArrangeError) {
      throw new ArrangeHttpError(422, "ARRANGE_INVALID", `${err.message}；正文没有改动，可以重试或换个模型`);
    }
    throw err;
  }
  return { template: template.name, baseHash: note.hash, blocks, plan, body: assemble(template, blocks, plan), callId };
}

export { ArrangeError };
