# AI 对话助手（可读整个笔记库、按计划改笔记）· 设计文档

日期：2026-11-01
状态：待批准（未开始实现）
选型结论：用户选 **B（带工具的助手）**，方式 **1（流式工具循环 + 写入只能提计划）**

## 一、意图与为什么

用户想要的是把「AI 替我写笔记」这件事从对话窗口搬进这个应用本身：一个常驻的对话界面，能选不同的模型服务商，能自己翻笔记库、读源码目录，**先给出整理方案、人点一次批准、再执行**。

背景：之前用户让我读 `D:\work\greenlight` 的 Go 源码、产出 `data/notes/backend-go/` 下 8 篇互链笔记——那次之所以成，是因为我**能读文件、能搜索、能多轮迭代**，而不是一次性生成文本。现在应用里的 AI 只有 10 个「一次性动作」（润色/精简/改写…），单轮进出、无双工具能力。这个功能补的就是这个差口。

## 二、目标

1. 一个**整页对话界面**（侧栏「AI」入口），会话可保存、可续聊。
2. **多服务商**：OpenAI 兼容（覆盖 DeepSeek/Kimi/Qwen/Ollama/自建网关）、Anthropic、Gemini；各存各的 key，界面切换模型。
3. **只读工具**：列笔记、全文搜索、读单篇、读目录、读文件（含笔记库之外的允许目录）。
4. **写入只能通过 `propose_plan`**：模型把要做的改动交成结构化计划，界面渲染成可展开的 diff 清单，人点「执行」才落盘；整批可撤销。
5. 过程在界面上可见：每一次工具调用是一条步骤（工具名、参数、结果摘要），不是一次性吐一大段字。
6. 生成流式、可中断；失败给可读原因（鉴权/限流/超时/工具错误）。

## 三、非目标（v1 明确不做）

- 不做「每改一篇问一次」的逐条确认（用户已选批量计划模式）。
- 不提供 shell / 网络抓取 / 任意 HTTP 工具（读不到的就读不到）。
- 不做向量检索；检索复用现有 FTS5 trigram。
- 不做多用户、不做账号体系（本地单用户，127.0.0.1）。
- 不做「自动整理」（无人值守），每次执行都必须有人点。
- 不做 `replace_section`（按标题替换某一节）——v1 用整篇 rewrite 覆盖；按节替换留到 v1.1，因为它需要标题匹配策略，容易切错。

## 四、约束

| 约束 | 影响 |
|---|---|
| 项目零运行时依赖 | 适配器、SSE 解析、工具循环全部手写，只用 Node 内置 `fetch` |
| 单进程 127.0.0.1:7777 同时给 API 与前端 | 对话流用 SSE（沿用 `/api/ai/:mode` 既有模式），不引入 WebSocket |
| `.md` 是唯一真源，索引是派生物 | 工具读笔记可以走 SQLite（快），写必须走 `NoteStore`（原子写 + 历史 + 冲突检测） |
| 现有 10 个 AI 模式不能坏 | 新配置独立成 `providers` 段；旧模式继续读原有 `baseUrl/apiKey/model` 字段，两者并存 |
| 密钥只能留在本地 | 存 `data/config.json`（已 gitignore），接口一律掩码 |
| 沙箱/权限 | 读笔记库之外要有**显式目录白名单**，否则等于给 AI 整台电脑的读权限 |

## 五、考虑过的方案

| 方案 | 做法 | 结论 |
|---|---|---|
| 1. 流式工具循环 + 写入只能提计划 | 内部统一消息/工具格式；适配器翻译成各家协议；模型可自由读、搜、迭代；写操作只能通过 `propose_plan` | **选定**（用户挑的）：既能边读边改主意，又有「一次批准」的安全阀 |
| 2. 两段式（先出 JSON 计划，再确定性执行） | 一轮定计划，人确认后执行；模型不能中途探索 | 简单三成，但复杂任务要人多次往返，且读到内容后没法调整计划 |
| 3. 挂外部 agent 引擎（把 DSH 当后端） | App 只做界面 | 排除：DSH 是桌面应用不是服务，进程/版本/稳定性不可控，且违背「自己选 API」 |

## 六、设计

### 6.1 服务商与适配器

配置（`data/config.json` 新增 `providers` 段；旧的 `baseUrl/apiKey/model` 保持不动给旧模式用）：

```json
"providers": {
  "activeId": "deepseek",
  "items": [
    { "id": "deepseek", "kind": "openai", "label": "DeepSeek", "baseUrl": "https://api.deepseek.com/v1", "apiKey": "sk-…", "models": ["deepseek-chat", "deepseek-reasoner"], "defaultModel": "deepseek-chat" },
    { "id": "claude",   "kind": "anthropic", "label": "Claude", "baseUrl": "https://api.anthropic.com/v1", "apiKey": "sk-ant-…", "models": ["claude-sonnet-4-5"], "defaultModel": "claude-sonnet-4-5" },
    { "id": "gemini",   "kind": "gemini",    "label": "Gemini", "baseUrl": "https://generativelanguage.googleapis.com/v1beta", "apiKey": "…", "models": ["gemini-2.5-pro"], "defaultModel": "gemini-2.5-pro" },
    { "id": "ollama",   "kind": "openai",    "label": "Ollama（本地）", "baseUrl": "http://127.0.0.1:11434/v1", "apiKey": "", "models": [], "defaultModel": "" }
  ]
}
```

内部统一格式（适配器只负责翻译，不动上层）：

```ts
type Msg =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; opaque?: unknown }
  | { role: "tool"; callId: string; name: string; content: string; opaque?: unknown };
type ToolCall = { id: string; name: string; args: unknown; opaque?: unknown };
type Turn = { text: string; toolCalls: ToolCall[]; finishReason: "stop" | "tool" | "length" };
```

**`opaque` 是必需的，不是可选的**（评审发现的坑）：

- Gemini 2.5 思考模型的 `functionCall` 带 `thoughtSignature`，下一轮回传时必须原样带上，丢了下游直接 400；
- Anthropic 的 thinking block 同理；
- Gemini **不返回 tool call id**，按 `name` 配对，我们用 `name#序号` 造稳定 id。

所以 `opaque` 要**落进会话 JSON**（否则重启后接着聊就断），但**不推给前端**（SSE 事件里剥掉），保持界面事件干净。

适配器接口：`streamTurn(cfg, model, messages, tools, signal): AsyncGenerator<{type:"text",delta:string} | {type:"done",turn:Turn}>`。

| kind | 端点 | 工具协议 |
|---|---|---|
| `openai`（含 Ollama、Kimi、Qwen、自建网关） | `POST {base}/chat/completions`，`tools: [{type:"function",…}]` | `tool_calls[]` → 解析 `arguments`（字符串 JSON） |
| `anthropic` | `POST {base}/messages`，`tools: [{name, description, input_schema}]` | content block `tool_use{id,name,input}`；结果回 `tool_result{content:[{type:"text"}]}` |
| `gemini` | `POST {base}/models/{model}:streamGenerateContent?alt=sse`，`tools:[{functionDeclarations}]` | `parts[].functionCall{name args}`；结果回 `parts[].functionResponse` |

### 6.2 会话

`data/chats/<id>.json`（不进 git）：

```json
{ "id":"c_xxx", "title":"整理 backend-go", "createdAt":"…", "updatedAt":"…",
  "providerId":"deepseek", "model":"deepseek-chat",
  "messages":[ /* Msg[] */ ],
  "plans":[ { "id":"p_xxx", "summary":"…", "ops":[…], "status":"pending|executed|undone", "results":[…] } ] }
```

会话列表按 `updatedAt` 倒序；标题取首条用户消息前 24 字（可改名）。

### 6.3 工具（5 个只读 + 1 个提案）

| 工具 | 参数 | 返回（截断策略） |
|---|---|---|
| `list_notes` | `{ tag?, type?, limit?=50 }` | `[{path,title,type,updated,tags}]` |
| `search_notes` | `{ query, limit?=10 }` | `[{path,title,snippet,updated}]`（复用 `server/search.ts`） |
| `read_note` | `{ path }` | `{path,title,tags,created,updated,hash,body}`；body > 40 000 字则截断并注明 |
| `read_dir` | `{ path, depth?=1 }` | `{root, entries:[{name,kind,size,children?}]}`；默认跳过 `node_modules/.git/bin/dist/.superpowers` |
| `read_file` | `{ path, offset?=1, limit?=400 }` | 行窗口文本；单次 ≤ 200 KB；二进制拒绝 |
| `propose_plan` | `{ summary, ops: Op[] }` | `{planId}`，并**终止本轮循环** |

`Op` 联合（v1）：

```ts
type Op =
  | { kind:"create";  path?: string; title: string; body: string; tags?: string[]; type?: "note"|"idea"|"source" }
  | { kind:"append";  path: string; text: string }
  | { kind:"rewrite"; path: string; body: string }
  | { kind:"trash";   path: string };
```

**读权限**：`agent.readRoots: string[]`，默认只有 `data/notes`。用户可在设置里加 `D:\work\greenlight` 这类目录。解析时 `path.resolve(root, rel)` 必须落在某个 root 之内（拒绝 `..`、盘符跨越、符号链接逃逸用 `realpath` 再校验一次）。绝对路径也只在 root 内才接受。

**写权限**：只有 `data/notes`，且只能经计划执行。

### 6.4 循环

```
轮次最多 12 次工具调用（超出则要求模型停止并总结）
每轮：provider.streamTurn → 文本增量直接推给前端
      若返回 toolCalls：**顺序执行**（见下）把结果作为 role:"tool" 追加
      若调用 propose_plan：校验、存档计划、推 event:plan，结束本轮
      若无 toolCalls 且模型停下：推 event:done
```

- **工具顺序执行**，不写 `Promise.all`：`db` 是 `DatabaseSync`（同步 API），对 SQLite/fs 的"并发"没有真并发，只是把事件循环让出去，反而让错误处理更难读。串行最多 4 个连续工具调用后插一次让出。
- 中断：前端断开 SSE 或点「停止」→ `AbortController.abort()` → provider 请求中断，已产出的文本仍保存进会话。
- 每次工具结果计入对话上下文；单个工具返回 > 200 KB 先截断并标注。
- **上下文压缩以「整轮」为单位**：一条 `assistant(toolCalls)` + 它产生的全部 `tool` 结果，一起换成一行摘要（"〔第 3 轮：搜了 X 并读了 3 篇，结果略〕"）。**绝不能只替换单条 tool 结果**——那会切断 tool_call/tool_result 配对，OpenAI 和 Anthropic 都直接 400。用户消息永不压缩。

### 6.5 计划

**规范化与服务端校验**（不信任模型给的任何东西）：

1. `path` 必须 `isSafeRelPath` 且落在 `data/notes` 内；
2. `create` 的 path 若与既有文件冲突 → 报错让模型换路径（不自动改名）；
3. `append`/`rewrite`/`trash` 的 path 必须存在；执行时的 `baseHash` 取**计划生成时**的 hash；
4. ops 数量 ≤ 20，总正文字数 ≤ 400 000；
5. 空操作（append 空文本、rewrite 与原文相同）被剔除；
6. 每条 op 计算 `before`（原文/不存在）与 `after`，生成**预览用 diff 统计 +12 −3**，前端展开看完整新旧内容。

**执行**：`POST /api/agent/plans/:id/execute`，body `{ skip?: number[] }`。

- 执行前把受影响文件 + 将新建的路径清单快照到 `data/.history/batches/b-<planId>/`（`b-` 前缀避免和 `.history/<noteId>/` 撞名；该目录不在 notesRoot 下，watcher 看不到，`rotateHistory` 也只轮转 `<noteId>/`，安全）；
- 逐条执行（create→`store.createAt`、append/rewrite→`store.save`、trash→`moveToTrash`）；
- **索引策略**：执行前把**全部**受影响路径 `ignoreNext`，全部写完后**统一 `indexFile` 一次**。逐条 `indexFile` 会把 FTS 重写 20 遍，而且 `ignoreNext` 的 800ms 窗口一过还可能被 watcher 重复索引；
- 冲突（磁盘 hash 已变）**跳过该条并继续**，结果里标红，不整批回滚；每条记 `{status:"ok"|"conflict"|"error", error?}`。

**`createAt` 的路径规则**：给了 `path` 就原样使用——强制 `.md` 后缀，拒绝 `..`、前导 `.`、控制字符、Windows 保留名（`CON/PRN/AUX/NUL/COM1-9/LPT1-9`），允许中文与空格；`title` 取 `op.title`，**不对文件名做 slugify**（用户/AI 要 `08-测试.md` 就得是它）。没给 `path` 才落回 `日期-slug.md`。

**撤销**：`POST /api/agent/plans/:id/undo`。三个语义先说清（评审追问的三条）：

1. **按计划撤销，不是"只能撤最近一次"**：每个 plan 自带 `batchDir`，只要快照还在就能撤它；同一篇笔记若已被后续操作改过则拒该条；
2. **`trash` 的撤销 = 从批快照写回原路径**（不是从回收站搬回来：回收站文件名带时间戳前缀、还可能被用户手工清空或恢复过，搬回会留残影）；
3. **期间被外部改过 → 尽力还原**：逐条比对"执行后记录的 hash"与当前 hash，一致才写回，不一致的标 `skipped_conflict` 并返回；**不整批拒绝**，也不覆盖用户的手动修改。

返回 `{ restored: n, skipped: [{path, reason}] }`，索引重建一次。

### 6.6 事件协议（SSE，`POST /api/agent/chats/:id/messages`）

| event | data |
|---|---|
| `text` | `{delta}` |
| `step` | `{id,name,args,status:"running"|"ok"|"error",summary?,ms}` |
| `plan` | `{messageId,planId,summary,ops:[{index,kind,path,title,add,del}]}` |
| `usage` | `{input,output}`（有就推） |
| `done` | `{messageId}` |
| `error` | `{code,message}` |
| `cancelled` | `{}` |

实现细节（评审给的，都是真会出事的）：

- 服务端把 `writeHead` + `res.on("close", abort)` 抽成 `sseStart(res)`；客户端把现有 `streamAi` 里的 reader + `parseSseBlock` 抽成通用 `readSse(res, onEvent)`，旧模式变成薄包装。
- **每 12 秒发一行注释心跳 `: ping\n\n`**：代理/浏览器/undici 的空闲策略会掐掉长时间没数据的连接，而工具执行期间可能几十秒没有文本输出。
- `res.write()` 返回 `false` 时 `await once(res, "drain")`，否则大事件会把内存堆起来。
- **`plan` 事件必须带 `messageId`**：计划卡要挂在产生它的那条消息下面，否则刷新/续聊后计划卡会浮在会话末尾。
- 超时不用改：`main.ts` 没设 `server.timeout` / `requestTimeout`，请求体读完就停表，长响应不会被掐。

### 6.7 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET/PUT` | `/api/agent/providers` | 读（掩码）/ 写服务商配置 |
| `POST` | `/api/agent/providers/:id/test` | 发一个最小请求验证 key |
| `GET/POST` | `/api/agent/chats` | 列表 / 新建 |
| `GET/PATCH/DELETE` | `/api/agent/chats/:id` | 详情 / 改名·换模型 / 删除 |
| `POST` | `/api/agent/chats/:id/messages` | 发消息并流式返回（SSE） |
| `GET` | `/api/agent/plans/:planId` | 计划详情（含 before/after 全文） |
| `POST` | `/api/agent/plans/:planId/execute` | 执行（可带 skip） |
| `POST` | `/api/agent/plans/:planId/undo` | 撤销本批 |
| `GET/PUT` | `/api/agent/roots` | 允许读的目录白名单 |

### 6.8 前端

侧栏底部新增「**AI 对话**」（在备份那行之上）。点开是整页（`Screen = "ai"`），三块：

```
┌──────────┬────────────────────────────────────────────┐
│ 会话列表  │  消息流                                     │
│ + 新建    │   ├ 你：把 backend-go 整理成索引             │
│ 整理索引  │   ├ 助手：先搜一下…                         │
│ 读源码    │   │   ▸ search_notes("backend-go") 8 条 320ms│
│           │   │   ▸ read_note(...) 1.2k 字              │
│           │   └ 计划卡：4 个动作        [执行] [撤销]   │
│           │        ✎ 01-路由.md  +12 −3  ⌄展开 diff     │
│           │        ＋ 08-测试.md 新建                   │
│           │        ☐ 跳过这条                          │
│           │  ┌──────────────────────────────────────┐ │
│           │  │ 输入…（Ctrl+Enter 发送）  模型 ▾  发送 │ │
└──────────┴────────────────────────────────────────────┘
```

- 计划卡：每条 op 可勾选跳过、可展开看完整新旧正文；点「执行」调 execute，逐条显示结果；执行后出现「撤销整批」。
- 停止：生成中按钮变「停止」，断开 SSE 并 abort。
- 服务商/模型选择放在输入框右侧；未配置服务商时整页给引导（去设置）。
- 复用现有 `<Preview>` 渲染 Markdown，复用 `.pv-full` 的字号/行距 token，视觉与全屏预览一致。
- **接线的三处必须一起改**（评审提醒）：`type Screen` 加 `"ai"`；`railVisible` 现在写死 `screen === "notes"`（AI 页整页铺开、不显示右栏，别让它保持 true）；`keyContext.modalOpen` 要把 `screen === "ai"` 也算进去，否则在对话框里按 Ctrl+S / Ctrl+N 会触发编辑器动作。
- 执行成功后复用现有 `loadList(filter) + refreshSidebar()`，让左侧列表立即反映改动。

### 6.9 提示词要点（system）

- 你是这个本地笔记库的助手，唯一真源是 `.md`，路径用库内相对路径。
- 改任何文件前必须读它；不确定就先 `search_notes`。
- **所有改动必须通过 `propose_plan` 一次性提交**，不要在正文里直接写"我将要……"然后不做。
- 一次最多 20 个动作；新建笔记要给合理标题与 `#标签`。
- 不要编造笔记里没有的内容；引用源码时给文件路径与行号。
- 用户可能给具体整理要求，按它来；若与笔记现状冲突，在 summary 里说明取舍。

## 七、关键取舍（我的判断，可被否决）

0. **`opaque` 字段落盘但不外泄**：Gemini 的 `thoughtSignature`、Anthropic 的 thinking block 必须原样回传，否则第二轮就 400；所以它进会话 JSON，但在 SSE 事件里剥掉。
1. **旧 AI 模式与新服务商配置并存**：旧 10 个模式继续读原字段，新的读 `providers`。好处是不破坏现有功能，代价是设置页有两个入口（旧的「AI 设置」+ 新的「服务商」）。
2. **`trash` 允许出现在计划里**：整理常伴随清理，但界面上必须显式标红，且执行后可用「撤销整批」恢复。
3. **冲突不整批回滚**：一条冲突只跳过那一条，其余照做——整批回滚会把已经看完的结果也丢掉。
4. **按节替换不做**：整篇 rewrite 覆盖足够，按标题切分容易切错，风险大于收益。
5. **上下文压缩以整轮为单位**，不引入向量库；绝不单条替换 tool 结果（会断配对直接 400）。

## 八、风险

| 风险 | 应对 |
|---|---|
| 模型给出非法/危险 op | 服务端规范化 + 白名单校验 + 上限；任何解析失败都拒收并回一条错误给模型 |
| 读目录把 `node_modules` 灌进上下文 | 默认忽略名单 + 单次返回上限 + 目录深度限制 |
| 上下文超长导致 400 | token 估算 + 旧工具结果替换成摘要 |
| 密钥泄露 | 掩码返回、不写日志、不进 git |
| 计划卡误点执行 | 执行前二次确认（"将修改 4 篇、新建 1 篇"），执行后可撤销 |
| 模型服务商不兼容（网关多包一层） | 适配器里对 `{success,data}` 包一层的响应做兼容（已知 cline 网关行为） |

## 九、测试计划

- **适配器**（fake fetch）：三家请求体形状、流式增量拼装、tool_calls 解析、错误映射（401/429/超时）、网关多包一层兼容。
- **循环**（fake provider 剧本）：先 `search_notes` 再 `propose_plan` → 断言事件序列 `text→step→text→plan`；工具报错回填给模型后能继续；12 轮上限被触发。
- **工具**：`read_note`/`read_file` 的截断；`read_dir` 忽略名单；路径穿越（`../`、绝对路径、`C:\`）被拒；白名单外的目录读不到。
- **计划**：非法 op 被拒；空操作被剔除；`create` 撞已有文件报错；执行 create/append/rewrite/trash；冲突跳过；撤销后文件恢复原文、新建的被移入回收站。
- **会话**：CRUD、落盘、重启后能读回、消息顺序。
- **端到端**：本地假 provider（HTTP）+ 假 SSE 客户端跑「提问→读笔记→出计划→执行→列表刷新→撤销」。

## 十、实现顺序（批准后）

1. `server/providers.ts`（统一格式 + 三家适配器 + 流式）→ 测试
2. `server/agent-tools.ts`（6 个工具 + 路径白名单）→ 测试
3. `server/agent.ts`（循环 + 计划规范化/执行/撤销 + 会话存储）→ 测试
4. `server/api.ts` 路由（SSE 事件）+ `store.createAt`
5. 前端：`AiChatPage` + 计划卡 + 服务商设置 → `App.tsx` 接线 + CSS
6. 端到端假 provider 测试 → typecheck → build → 真机用自己的 key 验证

规模：后端约 900 行、前端约 700 行、测试约 500 行——是目前为止最大的一块。

## 十一、用户已确认（2026-11-01）

1. **`trash`（移入回收站）允许出现在计划里，但必须单独过一道审批**：计划卡上这类动作标红，且「执行」按钮在用户勾选「我确认把这 N 篇移入回收站」之前保持禁用；执行中的结果同样列出被移走的路径。
2. 内置服务商卡片：**DeepSeek / Claude / Gemini / Ollama / 自定义 OpenAI 兼容**（覆盖 Kimi、Qwen、自建网关）。
3. **读笔记库之外的目录默认全关**：默认 `agent.readRoots = [data/notes]`；要读 `D:\work\greenlight` 必须手动加一条白名单，加之前 AI 完全看不到。

## 十二、实现顺序（批准后）
