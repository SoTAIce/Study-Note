import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Msg } from "./providers/types.ts";
import type { NormalizedPlan } from "./agent-plan.ts";

export type StoredPlan = NormalizedPlan & {
  status: "pending" | "executed" | "undone";
  results?: Array<{ index: number; status: "ok" | "conflict" | "error"; error?: string }>;
};

export type Chat = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  providerId: string;
  model: string;
  messages: Msg[];
  plans: StoredPlan[];
};

export class ChatError extends Error {
  readonly code: "NOT_FOUND" | "BAD_ID";

  constructor(code: ChatError["code"], message: string) {
    super(message);
    this.name = "ChatError";
    this.code = code;
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_MESSAGES = 200;
const KEEP_MESSAGES = 120;
const TITLE_LIMIT = 24;

type Clock = { now?: () => Date };

function chatsDir(dataDir: string): string {
  const dir = path.join(dataDir, "chats");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileOf(dataDir: string, id: string): string {
  // id 必须来自我们自己的生成器：拒绝任何路径分隔符，挡穿越
  if (!ID_PATTERN.test(id)) throw new ChatError("BAD_ID", `会话 id 不合法：${id}`);
  return path.join(chatsDir(dataDir), `${id}.json`);
}

function writeAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function readChatFile(dataDir: string, id: string): Chat {
  const file = fileOf(dataDir, id);
  if (!fs.existsSync(file)) throw new ChatError("NOT_FOUND", `会话不存在：${id}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Chat;
  } catch {
    throw new ChatError("NOT_FOUND", `会话文件损坏：${id}`);
  }
}

function makeTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= TITLE_LIMIT ? clean : clean.slice(0, TITLE_LIMIT);
}

export function listChats(dataDir: string): Array<{ id: string; title: string; updatedAt: string; model: string }> {
  const dir = chatsDir(dataDir);
  const out: Array<{ id: string; title: string; updatedAt: string; model: string }> = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const chat = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Chat;
      out.push({ id: chat.id, title: chat.title, updatedAt: chat.updatedAt, model: chat.model });
    } catch {
      // 单个坏文件不该让整个列表挂掉
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createChat(dataDir: string, init: { providerId: string; model: string }, clock: Clock = {}): Chat {
  const now = (clock.now ?? (() => new Date()))().toISOString();
  const chat: Chat = {
    id: `c_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    title: "新对话",
    createdAt: now,
    updatedAt: now,
    providerId: init.providerId,
    model: init.model,
    messages: [],
    plans: [],
  };
  writeAtomic(fileOf(dataDir, chat.id), chat);
  return chat;
}

export function getChat(dataDir: string, id: string): Chat {
  return readChatFile(dataDir, id);
}

export function patchChat(
  dataDir: string,
  id: string,
  patch: { title?: string; model?: string; providerId?: string; plans?: StoredPlan[] },
  clock: Clock = {},
): Chat {
  const chat = readChatFile(dataDir, id);
  const next: Chat = {
    ...chat,
    title: patch.title?.trim() ? patch.title.trim().slice(0, 80) : chat.title,
    model: patch.model ?? chat.model,
    providerId: patch.providerId ?? chat.providerId,
    plans: patch.plans ?? chat.plans,
    updatedAt: (clock.now ?? (() => new Date()))().toISOString(),
  };
  writeAtomic(fileOf(dataDir, id), next);
  return next;
}

export function deleteChat(dataDir: string, id: string): void {
  const file = fileOf(dataDir, id);
  if (!fs.existsSync(file)) throw new ChatError("NOT_FOUND", `会话不存在：${id}`);
  fs.rmSync(file, { force: true });
}

export function appendMessages(dataDir: string, id: string, msgs: Msg[], clock: Clock = {}): Chat {
  const chat = readChatFile(dataDir, id);
  const messages = [...chat.messages, ...msgs];

  // 首条用户消息当标题：比"新对话"好认，也不需要再让模型起名
  let title = chat.title;
  if (title === "新对话") {
    const firstUser = msgs.find((msg) => msg.role === "user");
    if (firstUser && "content" in firstUser && firstUser.content.trim()) title = makeTitle(firstUser.content);
  }

  // 截断只能从一条用户消息开始切：从 tool 消息中间切会让「assistant 调用 / tool 结果」配不上，
  // 下次请求会被 OpenAI、Anthropic 直接拒绝（400）。
  const trimmed =
    messages.length > MAX_MESSAGES
      ? (() => {
          const tail = messages.slice(-KEEP_MESSAGES);
          const firstUser = tail.findIndex((msg) => msg.role === "user");
          const kept = firstUser > 0 ? tail.slice(firstUser) : tail;
          return [{ role: "system" as const, content: `〔为控制上下文，只保留最近 ${kept.length} 条消息〕` }, ...kept];
        })()
      : messages;

  const next: Chat = {
    ...chat,
    title,
    messages: trimmed,
    updatedAt: (clock.now ?? (() => new Date()))().toISOString(),
  };
  writeAtomic(fileOf(dataDir, id), next);
  return next;
}

/** 按 planId 反查它属于哪个会话（计划详情/执行/撤销接口只拿得到 planId）。 */
export function findPlan(dataDir: string, planId: string): { chat: Chat; plan: StoredPlan } | null {
  const dir = chatsDir(dataDir);
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const chat = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Chat;
      const plan = chat.plans.find((entry) => entry.id === planId);
      if (plan) return { chat, plan };
    } catch {
      // 坏文件跳过
    }
  }
  return null;
}
