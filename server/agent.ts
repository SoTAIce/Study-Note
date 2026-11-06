import { randomUUID } from "node:crypto";
import { appendMessages, getChat, patchChat, type StoredPlan } from "./agent-chats.ts";
import { normalizePlan, PlanError } from "./agent-plan.ts";
import { PROPOSE_PLAN_SPEC, type Tools } from "./agent-tools.ts";
import { streamTurn as realStreamTurn } from "./providers/index.ts";
import type { Msg, ProviderEvent, ProviderRuntime, StreamRequest, Turn } from "./providers/types.ts";

export const AGENT_SYSTEM_PROMPT = `你是这个本地笔记库（Markdown 笔记应用）的助手，帮用户整理、补全、串联笔记。

规则（必须遵守）：
1. 笔记库的唯一真源是 .md 文件；路径一律用库内相对路径（例如 backend-go/01-路由与中间件.md）。
2. 改任何笔记之前必须先 read_note 读它；不确定现状就先 search_notes 或 list_notes。
3. 所有改动只能通过 propose_plan 一次性提交，不要在正文里写"我将要……"然后不提交。一次最多 20 个动作。
4. 不要编造笔记里没有的内容；引用源码时给出文件路径与行号。
5. 正文用 Markdown；新建笔记要给合理标题与 #标签。
6. 用户可能给出具体的整理要求，按它来；如果与笔记现状冲突，在 summary 里说明取舍。
7. 闲聊或提问时直接回答，不要提交计划。
8. 笔记可以归入分组（groups）。只有用户明确提到某个科目/分组（例如"归到 Go 学习"）时才在动作里写 group；没提就不要猜，保持原样。查分组用 list_notes 的 group 参数（none = 未分组）。`;

const MAX_TOOL_ROUNDS = 12;
const MAX_KEEP_ROUNDS = 4;
const MAX_TOOL_RESULT = 200_000;
const MAX_PLAN_ATTEMPTS = 2;

export type AgentEvent =
  | { type: "text"; delta: string }
  | {
      type: "step";
      id: string;
      name: string;
      args: unknown;
      status: "running" | "ok" | "error";
      summary?: string;
      ms: number;
    }
  | { type: "plan"; messageId: string; plan: { id: string; summary: string; ops: unknown[] } }
  | { type: "done"; messageId: string }
  | { type: "error"; code: string; message: string }
  | { type: "cancelled" };

export type StreamTurn = (
  runtime: ProviderRuntime,
  req: StreamRequest,
  fetchImpl?: typeof fetch,
  signal?: AbortSignal,
) => AsyncGenerator<ProviderEvent>;

export type RunTurnDeps = {
  dataDir: string;
  chatId: string;
  text: string;
  tools: Tools;
  runtime: ProviderRuntime;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  now?: () => Date;
  /** 测试注入用；生产走 providers/index.ts 的真实分派 */
  streamTurn?: StreamTurn;
};

export async function runTurn(deps: RunTurnDeps, onEvent: (event: AgentEvent) => void): Promise<{ messageId: string }> {
  const chat = getChat(deps.dataDir, deps.chatId);
  const messageId = `m_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const streamTurns = deps.streamTurn ?? realStreamTurn;

  appendMessages(deps.dataDir, deps.chatId, [{ role: "user", content: deps.text }], { now: deps.now });

  /** 给模型看的对话（含每轮工具往返）；给用户看的是累积的叙述文本 */
  const messages: Msg[] = [...chat.messages, { role: "user", content: deps.text }];
  let visibleText = "";
  let planAttempts = 0;

  const persist = (toolCalls?: Turn["toolCalls"], opaque?: unknown) => {
    // 一条既没正文也没有工具调用的 assistant 消息，会让下一次请求被 OpenAI/Anthropic 直接拒掉
    // （Anthropic 明确不允许空 content）。用户点「停止」或第一轮就报错时会出现这种情况，所以干脆不存。
    const hasToolCalls = (toolCalls?.length ?? 0) > 0;
    if (!visibleText.trim() && !hasToolCalls) return getChat(deps.dataDir, deps.chatId);
    return appendMessages(
      deps.dataDir,
      deps.chatId,
      [{ role: "assistant", content: visibleText, ...(toolCalls ? { toolCalls } : {}), ...(opaque ? { opaque } : {}) }],
      { now: deps.now },
    );
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    if (deps.signal?.aborted) {
      persist();
      onEvent({ type: "cancelled" });
      return { messageId };
    }

    const request: StreamRequest = {
      system: AGENT_SYSTEM_PROMPT,
      messages: compactRounds(messages),
      tools: [...deps.tools.specs, PROPOSE_PLAN_SPEC],
    };

    let turn: Turn | null = null;
    try {
      for await (const event of streamTurns(deps.runtime, request, deps.fetchImpl, deps.signal)) {
        if (event.type === "text") {
          visibleText += event.delta;
          onEvent({ type: "text", delta: event.delta });
        } else {
          turn = event.turn;
        }
      }
    } catch (err) {
      const error = err as Error & { code?: string };
      persist();
      if (deps.signal?.aborted || error.code === "AI_CANCELLED") {
        onEvent({ type: "cancelled" });
      } else {
        onEvent({ type: "error", code: error.code ?? "AI_ERROR", message: error.message });
      }
      return { messageId };
    }

    if (!turn) {
      persist();
      onEvent({ type: "error", code: "AI_EMPTY", message: "模型没有返回内容" });
      return { messageId };
    }

    messages.push({
      role: "assistant",
      content: turn.text,
      ...(turn.toolCalls.length > 0 ? { toolCalls: turn.toolCalls } : {}),
      ...(turn.opaque ? { opaque: turn.opaque } : {}),
    });

    if (turn.toolCalls.length === 0) {
      persist(turn.toolCalls, turn.opaque);
      onEvent({ type: "done", messageId });
      return { messageId };
    }

    let planRejected = false;

    for (const call of turn.toolCalls) {
      const rawArgs = call.args as { __parse_error?: string } | undefined;
      const argsBroken = Boolean(rawArgs && typeof rawArgs === "object" && rawArgs.__parse_error);

      // 唯一的写入口：计划。不走 tools.run，而是就地校验。
      if (call.name === "propose_plan") {
        if (argsBroken) {
          planAttempts += 1;
          onEvent({ type: "step", id: call.id, name: call.name, args: call.args, status: "error", summary: "参数解析失败", ms: 0 });
          messages.push({
            role: "tool",
            callId: call.id,
            name: call.name,
            content: "参数解析失败：propose_plan 的参数不是合法 JSON。请重新提交并注意转义。",
          });
          planRejected = true;
          if (planAttempts >= MAX_PLAN_ATTEMPTS) break;
          continue;
        }

        try {
          const plan = normalizePlan(call.args, deps.tools.planDeps);
          const stored: StoredPlan = { ...plan, status: "pending" };
          patchChat(deps.dataDir, deps.chatId, { plans: [...chat.plans, stored] }, { now: deps.now });
          messages.push({ role: "tool", callId: call.id, name: call.name, content: `计划已提交（${plan.id}），等用户审批。` });
          persist();
          onEvent({ type: "plan", messageId, plan: { id: plan.id, summary: plan.summary, ops: plan.ops } });
          return { messageId };
        } catch (err) {
          const planErr = err as PlanError;
          planAttempts += 1;
          onEvent({ type: "step", id: call.id, name: call.name, args: call.args, status: "error", summary: planErr.message, ms: 0 });
          messages.push({
            role: "tool",
            callId: call.id,
            name: call.name,
            content: `计划被拒：${planErr.message}。请修正后重新提案。`,
          });
          planRejected = true;
          if (planAttempts >= MAX_PLAN_ATTEMPTS) break;
          continue;
        }
      }

      if (argsBroken) {
        onEvent({ type: "step", id: call.id, name: call.name, args: call.args, status: "error", summary: "参数解析失败", ms: 0 });
        messages.push({
          role: "tool",
          callId: call.id,
          name: call.name,
          content: `参数解析失败：工具 ${call.name} 的参数不是合法 JSON。请修正后重试。`,
        });
        continue;
      }

      const startedAt = Date.now();
      const result = await deps.tools.run(call.name, call.args);
      const failed = /^(错误|参数错误)：/.test(result.content);
      onEvent({
        type: "step",
        id: call.id,
        name: call.name,
        args: call.args,
        status: failed ? "error" : "ok",
        summary: result.summary,
        ms: Date.now() - startedAt,
      });
      messages.push({ role: "tool", callId: call.id, name: call.name, content: result.content.slice(0, MAX_TOOL_RESULT) });
    }

    if (planAttempts >= MAX_PLAN_ATTEMPTS) {
      persist();
      onEvent({ type: "error", code: "PLAN_REJECTED", message: "计划连续被拒两次，已停下。可以让用户换个说法再试。" });
      return { messageId };
    }
    if (planRejected) continue;
  }

  // 工具轮次用尽：收尾并告知用户，不再问模型（避免无底洞）
  const notice = "\n\n（本轮工具调用已达上限，先停在这里。可以再说一次让我继续。）";
  visibleText += notice;
  onEvent({ type: "text", delta: notice });
  persist();
  onEvent({ type: "done", messageId });
  return { messageId };
}

/**
 * 只保留最近 N 轮工具往返，更早的整轮换成一行摘要。
 * 绝不能只删单条 tool 消息——那会切断 tool_call/tool_result 配对，OpenAI 与 Anthropic 都会 400。
 */
export function compactRounds(messages: Msg[], keep: number = MAX_KEEP_ROUNDS): Msg[] {
  const rounds: Array<{ start: number; end: number; names: string }> = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !msg.toolCalls || msg.toolCalls.length === 0) continue;
    let end = i + 1;
    while (end < messages.length && messages[end].role === "tool") end += 1;
    rounds.push({ start: i, end, names: msg.toolCalls.map((call) => call.name).join("、") });
    i = end - 1;
  }

  const dropped = rounds.slice(0, Math.max(0, rounds.length - keep));
  if (dropped.length === 0) return messages;

  const out: Msg[] = [];
  let cursor = 0;
  for (const round of dropped) {
    for (; cursor < round.start; cursor += 1) out.push(messages[cursor]);
    out.push({ role: "system", content: `〔已省略更早的一轮工具结果：调用了 ${round.names}，结果略〕` });
    cursor = round.end;
  }
  for (; cursor < messages.length; cursor += 1) out.push(messages[cursor]);
  return out;
}
