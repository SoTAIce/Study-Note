# AI 对话助手实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在笔记应用里加一个整页 AI 对话界面：能选多家模型服务商，能自己搜/读笔记（及白名单目录），所有写入必须先出计划、人批准后执行，可整批撤销。

**Architecture:** 服务端自研 agent 循环。`providers/` 把三家协议翻译成内部统一消息格式；`agent-tools.ts` 提供 5 个只读工具；模型唯一的写入口是 `propose_plan`，计划经 `agent-plan.ts` 规范化校验后由 `agent-exec.ts` 确定性执行（批快照 + 可撤销）。前端新增整页 `Screen = "ai"`，SSE 驱动增量渲染。

**Tech Stack:** Node 24（原生 TS、`fetch`）、`node:sqlite`、Vite 8 + React 19。**零新增运行时依赖。**

**Spec:** `docs/superpowers/specs/2026-11-01-ai-agent-chat-design.md`

## Global Constraints

- 不新增任何 npm 运行时依赖；只用 Node 内置能力。
- 测试命令固定：`node --test --test-isolation=none "server/tests/*.test.ts" "web/src/lib/*.test.ts"`（沙箱下默认隔离会 EPERM）。
- 类型检查：`pnpm typecheck`；构建：`pnpm build`。两者都必须 0 错误。
- 密钥只存 `data/config.json`（已 gitignore），任何接口返回一律掩码。
- 写入只允许 `data/notes/**`；读取默认只允许该目录，白名单在 `agent.readRoots`。
- 所有服务端文件写入走 `NoteStore`（原子写 + 历史 + 冲突检测），不直接 `fs.writeFileSync` 到 notesRoot。
- 现有 `/api/ai/:mode` 十个模式的行为与配置字段不得改变。
- 代码注释用中文解释"为什么"；提交信息用 `feat(agent): …` / `fix(agent): …`。

## Review Focus

| 容易出事的地方 | 期望行为 | 归属任务 |
|---|---|---|
| 中文/空格/`#`/`%` 的文件名进计划与 URL | 路径原样保留、拒绝 `..`，云端/磁盘都按原名字读写 | Task 4、Task 9 |
| 工具返回超大内容（读整个目录/源码文件） | 截断到上限并在结果里注明"已截断"，循环不崩、上下文不爆 | Task 3 |
| 用户在生成中途点「停止」或网络断 | 已产出的文本仍保存进会话，连接不泄漏，下一轮能继续 | Task 6、Task 8 |
| 计划执行到一半出错/被外部改动 | 逐条独立成败、冲突跳过并报告，索引与列表仍一致，可撤销 | Task 7 |
| 模型给出的工具参数是坏 JSON 或缺字段 | 不抛到 500，回填一条明确错误给模型让它重试 | Task 3、Task 6 |

---

### Task 1: 服务商配置 + OpenAI 兼容适配器

**Files:**
- Create: `server/providers/types.ts`, `server/providers/openai.ts`, `server/providers/index.ts`
- Test: `server/tests/provider-openai.test.ts`

**Interfaces:**
- Produces:
  - `type Msg`, `type ToolCall`, `type Turn`, `type ToolSpec`, `type ProviderConfig`（字段见设计文档 6.1，`Msg.assistant/tool` 与 `ToolCall` 都带可选 `opaque?: unknown`）
  - `type ProviderEvent = { type: "text"; delta: string } | { type: "done"; turn: Turn }`
  - `type ProviderRuntime = { kind: "openai" | "anthropic" | "gemini"; baseUrl: string; apiKey: string; model: string; maxTokens?: number }`
  - `streamTurn(runtime: ProviderRuntime, req: { system: string; messages: Msg[]; tools: ToolSpec[] }, fetchImpl: typeof fetch, signal?: AbortSignal): AsyncGenerator<ProviderEvent>`（本任务只实现 `kind === "openai"` 分支，其余抛 `AI_UNSUPPORTED`，Task 2 补齐）
  - `streamOpenaiTurn(opts: { baseUrl; apiKey; model; system; messages; tools; maxTokens? }, fetchImpl, signal)`（内部实现，`streamTurn` 的分支调用它）
  - `loadProviders(dataDir): { activeId: string; items: ProviderConfig[] }`、`maskProviders(cfg): { activeId; items: Array<ProviderConfig & { apiKeyMasked: string }> }`、`saveProviders(dataDir, patch): void`

- [ ] **Step 1: 写失败测试** `server/tests/provider-openai.test.ts`

测试名与断言：
- `openai 请求体带 tools 且消息按内部格式翻译`：捕获 fetch 的 `init.body`，断言 `json.model`、`json.tools[0].type === "function"`、`json.tools[0].function.name === "search_notes"`、`json.messages[0].role === "system"`、`json.stream === true`。
- `解析流式增量与 tool_calls`：喂一段 SSE（`data: {"choices":[{"delta":{"content":"你好"}}]}`、再来一段 `delta.tool_calls[0]` 分两片 `{"function":{"name":"read_note","arguments":"{\"pa"}}` + `{"function":{"arguments":"th\":\"a.md\"}"}}`），断言产出事件为 `text:你好` 后跟 `done.turn.toolCalls[0]` 等于 `{ name:"read_note", args:{ path:"a.md" } }` 且 `finishReason === "tool"`。
- `401 映射成可读错误`：fetch 返回 401，断言抛出错误的 `code === "AI_AUTH"`。
- `网关多包一层 {success,data} 也能解析`：喂 `data: {"success":true,"data":{"choices":[...]}}`，断言仍产出 `text`。
- `配置读写会掩码 apiKey`：`saveProviders` 后 `maskProviders` 的 `items[0].apiKeyMasked` 不含原文、`items[0].apiKey` 不存在。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --test-isolation=none "server/tests/provider-openai.test.ts"` → 期望 FAIL（模块不存在）。

- [ ] **Step 3: 实现 `server/providers/types.ts`、`server/providers/openai.ts`、`server/providers/index.ts`**

要点：SSE 逐行解析（复用 `server/ai.ts` 里读 `data:` 行的写法，但不要改动它——复制必要逻辑到新文件，避免耦合）；`tool_calls` 按 `index` 累积拼接 `arguments` 字符串，流结束时统一 `JSON.parse`，解析失败则回填 `args` 为 `{ __parse_error: 原始字符串 }`（Task 6 会把这条错误回给模型而不是崩掉）；配置走 `server/config.ts` 的 `readSection/patchSection`（section 名 `providers`），默认 `activeId: "deepseek"`、空 items。

- [ ] **Step 4: 跑测试确认通过**

Run: 同上 → 期望 `pass 5 fail 0`。

- [ ] **Step 5: 提交**

```bash
git add server/providers server/tests/provider-openai.test.ts
git commit -m "feat(agent): 服务商配置与 OpenAI 兼容适配器"
```

---

### Task 2: Anthropic 与 Gemini 适配器

**Files:**
- Create: `server/providers/anthropic.ts`, `server/providers/gemini.ts`
- Modify: `server/providers/index.ts`（导出二者）
- Test: `server/tests/provider-anthropic.test.ts`, `server/tests/provider-gemini.test.ts`

**Interfaces:**
- Produces: `streamAnthropicTurn(opts, fetchImpl, signal)`、`streamGeminiTurn(opts, fetchImpl, signal)`，签名与 `streamOpenaiTurn` 完全一致（`opts` 里多一个 `baseUrl` 即可，Anthropic 用 `x-api-key` + `anthropic-version: 2023-06-01`，system 走顶层 `system` 字段且 `max_tokens` 必填 4096）。

- [ ] **Step 1: 写失败测试**

Anthropic：
- `anthropic 把 system 放顶层并带版本头`：断言请求头含 `anthropic-version`、body 有 `system`、`messages` 里没有 `role:"system"`。
- `anthropic 解析 tool_use 与透传 opaque`：喂 `content_block_start{tool_use,id:'tu_1',name:'read_note'}` + `input_json_delta` 分片 + `message_delta{stop_reason:'tool_use'}`，断言 `turn.toolCalls[0]` 为 `{id:'tu_1',name:'read_note',args:{path:'a.md'}}`；再喂一个带 `type:"thinking"` 的块，断言它被塞进 `assistant.msg.opaque`。
- `anthropic 的 tool 结果按 tool_result 形状回传`：用 `messages` 含 `{role:"tool",callId:"tu_1"}` 调一次，断言 body 里对应块是 `{type:"tool_result",tool_use_id:"tu_1"}`。

Gemini：
- `gemini 用 alt=sse 且把工具声明放 functionDeclarations`：断言 URL 含 `:streamGenerateContent` 与 `alt=sse`、body 里 `tools[0].functionDeclarations[0].name === "search_notes"`。
- `gemini 的 functionCall 造出 name#n 形式的 id 并保留 thoughtSignature`：断言 `turn.toolCalls[0].id === "search_notes#0"`，且 `turn.toolCalls[0].opaque` 含原 signature。
- `gemini 历史消息里 assistant 的角色是 model`：断言 body 里对应条目 `role === "model"`。
- `gemini 的 functionResponse 包成 {name, response}`。

- [ ] **Step 2: 跑测试确认失败**（两个文件都跑）

- [ ] **Step 3: 实现两个适配器**

要点：Anthropic 流式事件有 `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` 四类，按 index 聚合；thinking 块原样存 `opaque`。Gemini 的 SSE 每行 `data: {candidates:[{content:{parts:[…]}}]}`，`parts[].text` 是文本、`parts[].functionCall` 是工具调用；发回时 `functionResponse: { name, response: { content: <工具返回的字符串> } }`，`functionCall` 的 `thoughtSignature` 原样回填。

- [ ] **Step 4: 跑测试确认通过**（期望各 3-4 个用例全绿）

- [ ] **Step 5: 提交** `feat(agent): Anthropic 与 Gemini 适配器`

---

### Task 3: 只读工具与路径白名单

**Files:**
- Create: `server/agent-tools.ts`
- Test: `server/tests/agent-tools.test.ts`

**Interfaces:**
- Produces:
  - `createTools(deps: { db: DatabaseSync; store: NoteStore; notesRoot: string; readRoots: string[]; now?: () => Date }): { specs: ToolSpec[]; run(name: string, args: unknown): Promise<{ content: string; summary: string }> }`
  - `resolveInside(root: string, rel: string): string`（越界抛 `ToolError`，`ToolError.code` ∈ `"BAD_PATH" | "NOT_FOUND" | "TOO_LARGE"`）

- [ ] **Step 1: 写失败测试**

- `list_notes 返回库内笔记摘要`：建两篇笔记后调用，断言返回数组长度 2、含 `path/title/updated`。
- `search_notes 命中正文`：写一篇含"中间件"的笔记，搜索"中间件"断言命中该 path。
- `read_note 返回 body 与 hash，超长截断并标注`：造一篇 60 000 字的笔记，断言返回内容 ≤ 40 000 字且含 `〔已截断` 标记。
- `read_file 只读白名单目录`：白名单给临时目录 A，读 A 内文件成功；读白名单外文件抛 `BAD_PATH`。
- `路径穿越被拒`：`read_note("../secret.md")`、`read_file("C:\\Windows\\win.ini")` 均抛 `BAD_PATH`；`read_note` 传 `a/../../b.md` 也拒。
- `read_dir 跳过 node_modules 与 .git`：目录里造 `node_modules/x/y.js`，断言结果不含它。
- `坏参数不抛出未捕获异常`：`run("read_note", {})` 返回 `{ content: "参数错误：缺少 path" }` 而不是 throw（模型会据此重试）。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 `server/agent-tools.ts`**

要点：全部工具**只读**；`read_note` 走 `store.read`（拿到 hash 供计划做基线）；`search_notes` 调 `server/search.ts` 的 `search(db, q, {limit})`；`read_file`/`read_dir` 用 `fs` 但先 `resolveInside`，再 `fs.realpathSync` 二次校验落在 root 内；`run()` 内部 try/catch，把 `ToolError` 转成 `{ content: "错误：…" }`（喂给模型，不中断循环）；`specs` 是 5 个 JSON Schema 定义，与设计文档 6.3 的参数表逐字对应。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交** `feat(agent): 只读工具与路径白名单`

---

### Task 4: 计划规范化与校验

**Files:**
- Create: `server/agent-plan.ts`
- Test: `server/tests/agent-plan.test.ts`

**Interfaces:**
- Produces:
  - `type Op = { kind:"create"; path?: string; title: string; body: string; tags?: string[]; type?: "note"|"idea"|"source" } | { kind:"append"; path: string; text: string } | { kind:"rewrite"; path: string; body: string } | { kind:"trash"; path: string }`
  - `type NormalizedOp = { index:number; kind:Op["kind"]; path:string; title:string; before:{exists:boolean;raw:string;hash:string}; after:string; add:number; del:number }`
  - `normalizePlan(raw: unknown, deps: { store: NoteStore; notesRoot: string }): { id: string; summary: string; ops: NormalizedOp[] }`（非法则抛 `PlanError`，`code` ∈ `"BAD_OP" | "BAD_PATH" | "MISSING_FILE" | "CONFLICT" | "TOO_MANY"`）
  - `isSafeNotePath(rel: string): boolean`（强制 `.md`、拒 `..`、前导 `.`、控制字符、Windows 保留名 `CON/PRN/AUX/NUL/COM1-9/LPT1-9`，允许中文与空格）

- [ ] **Step 1: 写失败测试**

- `create 的合法路径原样保留`：`normalizePlan({summary, ops:[{kind:"create", path:"backend-go/08-测试.md", title:"测试", body:"# 测试"}]})` 断言 `ops[0].path === "backend-go/08-测试.md"`。
- `create 撞已有文件报 CONFLICT`：先建同名文件再规范化，断言抛 `code === "CONFLICT"`。
- `没有 path 的 create 自动落 日期-slug.md`：断言 path 匹配 `^\d{4}-\d{2}-\d{2}-.+\.md$`。
- `rewrite 不存在的文件报 MISSING_FILE`。
- `append 空文本被剔除`、`rewrite 与原文相同被剔除`：断言 `ops.length === 0`（若全被剔除，抛 `BAD_OP`，测试断言抛错）。
- `超过 20 条报 TOO_MANY`。
- `trash 保留但被标记`：断言 `ops[0].kind === "trash"` 且 `ops[0].before.exists === true`。
- `diff 统计正确`：原 `a\nb\nc` 改成 `a\nx\nc\nd`，断言 `add === 2`、`del === 1`。
- `Windows 保留名被拒`：`create` 的 path 为 `CON.md` 抛 `BAD_PATH`。
- `含 # % 空格 的中文文件名原样保留`：path 为 `a#b 50% 测试.md`，断言 `ops[0].path` 与该字符串完全相同（不得被编码或 slugify）。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 `server/agent-plan.ts`**

要点：`before` 由 `store.read(path)` 取（不存在则 `{exists:false,...}`）；`after` 由 kind 计算（create/rewrite → body；append → 原文 + `\n\n` + text；trash → 空）；`add`/`del` 用逐行 LCS 或简单集合差实现（行为等价即可，测试只断言上述两例）。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交** `feat(agent): 计划规范化与路径校验`

---

### Task 5: 会话存储

**Files:**
- Create: `server/agent-chats.ts`
- Test: `server/tests/agent-chats.test.ts`

**Interfaces:**
- Produces:
  - `type Chat = { id:string; title:string; createdAt:string; updatedAt:string; providerId:string; model:string; messages: Msg[]; plans: StoredPlan[] }`
  - `listChats(dataDir): Array<{id;title;updatedAt;model}>`（按 `updatedAt` 倒序）
  - `createChat(dataDir, init: { providerId: string; model: string }): Chat`
  - `getChat(dataDir, id): Chat`（不存在抛 `ChatError` code `NOT_FOUND`）
  - `patchChat(dataDir, id, patch: { title?: string; model?: string; providerId?: string }): Chat`
  - `deleteChat(dataDir, id): void`
  - `appendMessages(dataDir, id, msgs: Msg[]): Chat`（同时刷新 `updatedAt`；首条用户消息自动生成标题，取前 24 字）

- [ ] **Step 1: 写失败测试**

- `新建的会话能被列出且按时间倒序`（建两个，后建的在前）。
- `消息追加后能读回且顺序不变`：追加 `user` + `assistant` 两条，`getChat` 断言 `messages.map(m=>m.role)` 等于 `["user","assistant"]`。
- `首条用户消息生成标题`：内容 "把 backend-go 整理成一篇索引" → `title` 以它开头且长度 ≤ 24。
- `opaque 字段能落盘并读回`：assistant 消息带 `opaque:{signature:"abc"}`，读回仍在。
- `删除后再读抛 NOT_FOUND`。
- `会话 id 不能用于路径穿越`：`getChat(dataDir, "../config")` 抛错。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 `server/agent-chats.ts`**

要点：`data/chats/<id>.json`，`id` 用 `c_+randomUUID().slice(0,8)`，读取前校验 `^[A-Za-z0-9_-]+$`；写入用临时文件 + rename；单文件消息数超过 200 时保留最近 120 条并在最前面插一条 `system` 摘要占位。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交** `feat(agent): 会话存储`

---

### Task 6: agent 循环

**Files:**
- Create: `server/agent.ts`
- Test: `server/tests/agent-loop.test.ts`

**Interfaces:**
- Consumes: `streamTurn` + `ProviderRuntime`（Task 1/2）、`createTools`（Task 3）、`normalizePlan`（Task 4）、`appendMessages`（Task 5）
- Produces:
  - `const AGENT_SYSTEM_PROMPT: string`（内容按设计 6.9：唯一真源是 `.md`、改前必读、不确定先搜、**所有改动只能通过 `propose_plan`**、一次最多 20 个动作、不要编造、引用源码给路径与行号、用户的具体整理要求优先）
  - `type AgentEvent = {type:"text";delta:string} | {type:"step";id:string;name:string;args:unknown;status:"running"|"ok"|"error";summary?:string;ms:number} | {type:"plan";messageId:string;plan:{id;summary;ops:NormalizedOp[]}} | {type:"done";messageId:string} | {type:"error";code:string;message:string} | {type:"cancelled"}`
  - `runTurn(deps: { dataDir: string; chatId: string; text: string; tools: ReturnType<typeof createTools>; runtime: ProviderRuntime; fetchImpl?: typeof fetch; signal?: AbortSignal; now?: () => Date }, onEvent: (e: AgentEvent) => void): Promise<{ messageId: string }>`

- [ ] **Step 1: 写失败测试**（用假 provider 剧本：`(req) => 依次产出预设事件`）

- `一次纯文本回答：事件序列 text→done 且消息落盘`。
- `系统提示词含"只能通过 propose_plan 改动"`：捕获第一次请求的 `messages[0].role === "system"` 且内容含 `propose_plan` 与"一次最多 20"。
- `先搜后答：事件序列为 text→step(ok)→text→done，且第 2 轮的 messages 里含 role:"tool"`。
- `propose_plan 终止循环并推 plan 事件`：剧本第二轮返回 `propose_plan` 调用，断言事件以 `plan` 结尾、没有继续第 4 轮，且 plan 里 `ops.length` 与剧本一致。
- `工具参数是坏 JSON 时回填错误给模型而不崩`：工具调用 `args` 为 `{__parse_error:"{"}`，断言 step 事件 `status === "error"`，且下一轮 messages 里该 tool 消息含"参数解析失败"。
- `12 轮上限被触发`：剧本永远返回工具调用，断言最终有 `done` 且步数 ≤ 12。
- `用户中途 abort：已产出的文本仍保存`：在收到第一个 text 后 abort，断言 `getChat` 里 assistant 消息含已产出文本、事件末尾是 `cancelled`。
- `上下文压缩按整轮`：造 6 轮工具调用，断言发给 provider 的第 7 次请求里出现摘要占位文本且用户消息仍在。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 `server/agent.ts`**

要点：循环结构按设计 6.4；`propose_plan` 由本模块截获（不交给 tools.run），拿到参数后调 `normalizePlan`，成功存进 `chat.plans` 并推 `plan`；失败则把 `PlanError.message` 作为 tool 消息回给模型再给一次机会（最多 2 次）；工具**串行**执行；每轮追加消息后 `appendMessages` 落盘；abort 时把已产出文本存成 assistant 消息并推 `cancelled`。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交** `feat(agent): 对话循环与计划提案`

---

### Task 7: `store.createAt` + 计划执行与撤销

**Files:**
- Modify: `server/store.ts`（新增 `createAt`）、`server/agent-exec.ts`（新建）
- Test: `server/tests/agent-exec.test.ts`

**Interfaces:**
- Produces:
  - `store.createAt(relPath: string, input: { title: string; body: string; tags?: string[]; type?: "note"|"idea"|"source" }): StoredNote`（路径已存在则抛错；不做 slugify）
  - `executePlan(deps: { store: NoteStore; indexer: Indexer; dataDir: string }, plan: {id;ops: NormalizedOp[]}, opts?: { skip?: number[] }): { results: Array<{index:number;status:"ok"|"conflict"|"error";error?:string}> }`
  - `undoPlan(deps: { store: NoteStore; indexer: Indexer; dataDir: string }, plan: {id;ops: NormalizedOp[]}): { restored: number; skipped: Array<{path:string;reason:string}> }`

- [ ] **Step 1: 写失败测试**

- `create 落到指定路径且不 slugify`：`createAt("backend-go/08-测试.md", {title:"测试", body:"# 测试"})` 断言文件存在、内容含 `title: "测试"`。
- `createAt 撞已有路径抛错`。
- `执行 create/append/rewrite/trash 四条结果都是 ok`：四类 op 各一条，断言 `results.every(r=>r.status==="ok")`，且每篇文件内容符合预期。
- `执行时若磁盘 hash 已变则跳过该条`：生成计划后手改目标文件，断言该条 `status === "conflict"`、其它条仍 `ok`。
- `skip 生效`：传 `{skip:[1]}` 断言第 2 条未被执行。
- `执行前把受影响文件快照到 b-<planId>/`：断言 `data/.history/batches/b-<id>/` 下有对应文件。
- `undo 把内容还原、把新建的移出库`：执行后 undo，断言 rewrite 的笔记恢复原文、create 出来的文件已不存在。
- `undo 在文件被后续改动时跳过该条并报告`：执行后再手改，undo 断言 `skipped` 含该 path。
- `执行后索引与文件一致`：执行后 `db` 里能查到新笔记（用 `Indexer` 实例断言或 `search`）。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

要点：`executePlan` 先把**全部**受影响路径 `indexer.ignoreNext()`，再逐条执行，最后对成功路径统一 `indexFile()` 一次；批快照在 `data/.history/batches/b-<planId>/`，用 `fs.cpSync`/`readFileSync`+`writeFileSync` 保留原始 raw；`trash` 用 `store.moveToTrash`，undo 时用快照 raw 走 `store.restoreFromSnapshot(path, raw)`（不带 baseHash，因为撤销是显式动作）；`create` 的 undo = `store.moveToTrash(path)`。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交** `feat(agent): 计划执行与整批撤销`

---

### Task 8: HTTP 路由 + SSE

**Files:**
- Create: `server/sse.ts`（`sseStart(res)` + 心跳 + drain 写入）
- Modify: `server/api.ts`、`server/main.ts`（装配 providers/tools）
- Test: `server/tests/agent-api.test.ts`

**Interfaces:**
- Produces:
  - `sseStart(res: ServerResponse): { send(event: string, data: unknown): Promise<void>; close(): void; signal: AbortSignal }`
  - 路由表（见设计 6.7）：`GET/PUT /api/agent/providers`、`POST /api/agent/providers/:id/test`、`GET/POST /api/agent/chats`、`GET/PATCH/DELETE /api/agent/chats/:id`、`POST /api/agent/chats/:id/messages`、`GET /api/agent/plans/:planId`、`POST /api/agent/plans/:planId/execute`、`POST /api/agent/plans/:planId/undo`、`GET/PUT /api/agent/roots`

- [ ] **Step 1: 写失败测试**（起真实 `http.createServer(createApp(...))`，用假 provider，`listen(0)`）

- `GET /api/agent/providers 返回掩码`（断言不含明文 key）。
- `POST /api/agent/chats 后 GET 列表能看到它`。
- `发消息返回 SSE：text→done，且 content-type 是 text/event-stream`（用 `fetch` 读流拼字符串断言）。
- `执行计划后笔记落盘、再 undo 还原`（走完整 HTTP）。
- `未配置服务商时发消息返回 400 且 code=NO_PROVIDER`。
- `plan 事件带 messageId`。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现路由与 `server/sse.ts`**

要点：`sseStart` 设 `content-type: text/event-stream`、`cache-control: no-store`、`connection: keep-alive`、`x-accel-buffering: no`；每 12s `: ping\n\n`；`res.write()` 返 false 时 `await once(res, "drain")`；`res.on("close", …)` 触发内部 `AbortController`。所有新路由都放在 `return false` 之前；错误统一走现有 `HttpError`。`main.ts` 装配：`createTools` + 读 `agent.readRoots`。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `node --test --test-isolation=none "server/tests/*.test.ts" "web/src/lib/*.test.ts"` → 期望全绿。

- [ ] **Step 5: 提交** `feat(agent): agent HTTP 路由与 SSE`

---

### Task 9: 前端 SSE 客户端 + 会话页

**Files:**
- Modify: `web/src/api.ts`（抽 `readSse`、加 agent 类型与请求函数）
- Create: `web/src/components/AiChatPage.tsx`, `web/src/components/PlanCard.tsx`, `web/src/components/ProviderSettings.tsx`
- Test: `web/src/lib/plan-view.test.ts`（计划卡的状态计算抽成纯函数）

**Interfaces:**
- Produces:
  - `readSse<T>(res: Response, onEvent: (event: string, data: T) => void): Promise<void>`（从现有 `streamAi` 抽出，`streamAi` 改为薄包装，行为不变）
  - `sendAgentMessage(chatId, text, handlers: { onEvent(e: AgentEvent): void; signal?: AbortSignal }): Promise<void>`
  - `planSummary(ops): { creates:number; rewrites:number; appends:number; trashes:number }`（纯函数，进 `web/src/lib/plan-view.ts`）
  - `canExecute(ops, skipped: Set<number>, trashConfirmed: boolean): boolean`（含 trash 时必须先确认）

- [ ] **Step 1: 写失败测试** `web/src/lib/plan-view.test.ts`

- `统计各动作数量`（4 条 op → creates 1 / rewrites 1 / appends 1 / trashes 1）。
- `有 trash 且未确认时不能执行`：断言 `canExecute(ops, new Set(), false) === false`。
- `确认后可以执行`：`canExecute(ops, new Set(), true) === true`。
- `全部跳过时不能执行`：`canExecute(ops, new Set([0,1]), true) === false`。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --test-isolation=none "web/src/lib/plan-view.test.ts"`

- [ ] **Step 3: 实现 `web/src/lib/plan-view.ts` + `AiChatPage.tsx` + `PlanCard.tsx` + `ProviderSettings.tsx` + `readSse` 抽取**

要点：页面按设计 6.8 的三栏；SSE 事件 reducer：`text` 追加到最后一条 assistant 消息、`step` 追加到该消息的 steps 数组、`plan` 挂到 `messageId` 对应消息、`done` 结束加载、`error`/`cancelled` 结束并提示；计划卡：每条 op 可勾选跳过、可展开 `<Preview>` 渲染 before/after、trash 标红并需要单独勾选确认；`ProviderSettings` 五个卡片（DeepSeek/Claude/Gemini/Ollama/自定义）+ 读目录白名单。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交** `feat(agent): 对话页与计划卡`

---

### Task 10: 接线 + 端到端 + 构建验证

**Files:**
- Modify: `web/src/App.tsx`（`Screen` 加 `"ai"`、侧栏入口、`railVisible`、`keyContext.modalOpen`）、`web/src/components/Sidebar.tsx`、`web/src/styles/app.css`

- [ ] **Step 1: 接线**

`type Screen = "notes" | "trash" | "compose" | "ai"`；侧栏在「备份」那行之上加「AI 对话」；AI 页 `railVisible` 保持 false（整页铺开）；`keyContext.modalOpen` 包含 `screen === "ai"`（对话框内 Ctrl+S/Ctrl+N 不触发编辑器动作）；计划执行成功后 `loadList(filter) + refreshSidebar()`。

- [ ] **Step 2: 跑全量测试**

Run: `node --test --test-isolation=none "server/tests/*.test.ts" "web/src/lib/*.test.ts"` → 全绿。

- [ ] **Step 3: 类型检查与构建**

Run: `pnpm typecheck` → 0 错误；`pnpm build` → 成功，记录 bundle 体积。

- [ ] **Step 4: 真机验证（用用户自己的 key）**

重启服务 → 面板里配一个服务商 → 新建会话 → 发「列出我的笔记，挑一篇总结成 3 条要点」→ 观察步骤与流式输出；再发「把 backend-go 那几篇整理成一篇索引」→ 检查计划卡、执行、撤销各一次。**任一步失败都要记录原因并修复。**

- [ ] **Step 5: 提交** `feat(agent): 接入 AI 对话页`
