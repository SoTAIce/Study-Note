# study-notes MCP 连接线（DSH）

一个**手写、零 npm 依赖**的 stdio MCP JSON-RPC 服务器：让 DSH（或任何 MCP 客户端）直接读写
`D:\work\study-notes\data\notes` 下的 Markdown 笔记。不依赖 study-notes App 是否在运行。

```
dsh-mcp/
├─ server.mjs       实现（Node 24 原生，直接 `node dsh-mcp/server.mjs` 即可跑）
├─ server.d.mts     createSession 的类型声明（只供 typecheck / 测试使用）
└─ README.md        本文件
```

## 设计约束（重要）

**MCP 只写 `.md`，索引由 App 的 watcher 或 `/api/index/file` 补齐。**

- Markdown 文件是唯一真源，`data/index.db` 只是派生索引；**MCP 绝不直接写 `index.db`**。
- 每次写完 `.md`，服务器会 `POST http://127.0.0.1:7777/api/index/file`（由 `server/api.ts` 实现），body 为 `{"path": "<相对 data/notes 的路径>"}`，成功回 `{ok: true, path}`；**3 秒超时，失败静默忽略**。
- App 在跑 → 由 App 进程（索引的唯一写者）重建该文件索引；App 没跑 → 跳过，等 App 下次启动时的全量扫描补齐。这样 `index.db` 永远只有一个写者，不需要跨进程锁。
- 因此：**App 没启动时新写的笔记，要等 App 启动后才会被 `notes_search` 搜到**；`notes_read` 按 `path` 不依赖索引，按 `id` 才需要查索引。

## 数据根与环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `STUDY_NOTES_DIR` | `D:\work\study-notes` | 仓库根目录 |
| `STUDY_DATA` | `<STUDY_NOTES_DIR>\data` | 数据目录 |

派生路径：笔记 `<data>\notes`，索引 `<data>\index.db`（**只读**打开），历史版本 `<data>\.history`，回收站 `<data>\.trash`。

## 直接运行 / 自测

```powershell
# 作为 stdio MCP 服务器运行（由客户端喂 stdin）
node D:\work\study-notes\dsh-mcp\server.mjs
```

协议要点：

- 传输：**行分隔 JSON-RPC 2.0**，每行一个 JSON 对象；不支持 JSON-RPC 批量请求。
- 支持方法：`initialize`（回 `protocolVersion: "2024-11-05"`、`capabilities.tools`、`serverInfo`）、`tools/list`、`tools/call`、`ping`。
- **通知（没有 `id`）一律忽略、不回应**，例如 `notifications/initialized`。
- 未知方法返回 `-32601`，无法解析的行返回 `-32700`。
- 工具执行失败（参数缺失、文件不存在等）返回 `{content: [...], isError: true}`，而不是 JSON-RPC error。

进程内冒烟（不 spawn 子进程，沙箱安全）：

```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
'@ | node D:\work\study-notes\dsh-mcp\server.mjs
```

自动化测试：

```powershell
node --test --test-isolation=none server/tests/mcp.test.ts
```

测试通过 `createSession({root, dataDir, indexUrl})` 在进程内构造会话，并用一个只实现
`POST /api/index/file` 的临时 HTTP 服务模拟 App 的索引写入者——**不 spawn 子进程**
（DSH 沙箱下 `child_process` 管道会 EPERM），也不碰真实数据目录。

## 五个工具

所有工具的结果都是 `{ content: [{ type: "text", text: "..." }] }`。

### `notes_search({ query, limit? })`

全文检索。

- `query`（必填，string）：检索词。**≥3 字符**对 `notes_fts` 用 FTS5 **trigram `MATCH`**；**1–2 字符**（常见中文短词）退回 `notes_fts.title LIKE ? OR body LIKE ?`。
- `limit`（选填，integer）：默认 10，最大 50。
- 返回：每条命中一行，含 `id`、标题、相对路径（`path:`）、以及**命中词两侧各 30 字**的片段（命中词只出现在标题时退回正文摘要）。索引不存在时返回提示文本（不是错误）。

### `notes_read({ id? , path? })`

读取一条笔记。

- `id` 或 `path` 至少给一个（相对 `data/notes` 的路径，例如 `inbox/2026-10-30-想法.md`；`id` 需要索引可用）。
- 返回：frontmatter 摘要（`id` / `path` / `type` / `created` / `updated` / `tags` / `source`）+ Markdown 正文。
- `id` 在索引里查不到、文件不存在、路径越界：`isError: true`。

### `notes_create({ title, body, tags?, type? })`

新建一条笔记（`NoteStore.create`）。

- `title`（必填，string）、`body`（必填，string，Markdown）。
- `tags`（选填，string[]）、`type`（选填，`note` | `idea` | `source`，默认 `note`；`idea` 落在 `inbox/`）。
- 文件名规则：`YYYY-MM-DD-<slug>.md`，同日同名自动加 `-2`、`-3`。
- 返回：标题、`id`、`path`。写完后触发一次索引补齐请求。

### `notes_append({ id | path, text })`

追加到已有笔记末尾。

- `id` 或 `path`（二选一）+ `text`（必填，string）。
- 在正文末尾追加 `\n\n### <本地时间>\n<text>\n`，例如 `### 2026-10-30 15:20`；**不改动已有正文**。
- 内部用 `NoteStore.save(path, body, baseHash)`，`baseHash` 取刚读到的内容 hash（保留历史版本与冲突检测）。
- 返回：标题、`id`、`path`、追加的小标题。

### `notes_capture({ text, tags? })`

快速捕获一条想法：等价于 `notes_create({ body: text, type: "idea" })`，内容落在 `data/notes/inbox/`。

- `text`（必填，string）、`tags`（选填，string[]）。
- 返回：标题、`id`、`path`。

## 在 DSH 里注册

### 桌面版（desktop profile）——推荐

desktop profile **由 Electron 应用独占管理**，`dsh --profile desktop ...` 会直接报错
`profile "desktop" is managed exclusively by the Electron application`。官方入口是用户 patch 层
`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`（它在每个 bundle 层之后应用）。

```powershell
bin\install-mcp.ps1            # 备份 + 追加（幂等）
bin\install-mcp.ps1 -Remove    # 撤回
```

然后**重启 DSH**。生成的内容等价于 [`../mcp.patch.yml`](../mcp.patch.yml)：

```yaml
- insert:
    - id: mcp-study-notes
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: study-notes
        transport: stdio
        command: 'C:\Program Files\nodejs\node.exe'
        args:
          - 'D:\work\study-notes\dsh-mcp\server.mjs'
        env:
          STUDY_NOTES_DIR: 'D:\work\study-notes'
          STUDY_DATA: 'D:\work\study-notes\data'
        toolCallTimeoutMs: 60000
        failOnStartupError: false
```

**已验证**：这段 patch 被真实 loader 接受并组合进配置树
（`dsh --profile <临时profile> --patch mcp.patch.yml --dump-config` 输出里出现
`- id: mcp-study-notes / name: '@deepseek-ai/dsh-mcp-client' / serverName: study-notes`）。
插件本体随应用发布（`@deepseek-ai/dsh-mcp-client` 0.2.1-rc.3），无需安装。

### CLI 启动的 profile

```powershell
dsh --profile web --patch D:\work\study-notes\mcp.patch.yml --dump-config
dsh --profile web --patch D:\work\study-notes\mcp.patch.yml
```

### 注册后

DSH 在首个回合前发现工具，模型侧看到的名字是 `mcp__<serverName>__<toolName>`：

```
mcp__study-notes__notes_search
mcp__study-notes__notes_read
mcp__study-notes__notes_create
mcp__study-notes__notes_append
mcp__study-notes__notes_capture
```

验证：让 DSH 调一次 `mcp__study-notes__notes_search` 搜一条真实笔记；
再 `mcp__study-notes__notes_capture` 记一条 idea，确认 `data/notes/inbox/` 下出现新文件。

> stdio 的命令按可信宿主代码执行，`command`/`args` 请写死绝对路径；改动 `server.mjs` 后重启 DSH
> 或让 MCP 行重连才会生效（工具清单在启动时发现）。

## 已知限制

- 索引补齐依赖 App：`POST /api/index/file` 已实现（`server/api.ts`），但 App 没在跑时请求会失败并被静默忽略——不影响 `.md` 写入，等 App 的 watcher / 启动扫描补齐索引即可。
- App 未运行时搜索看不到刚写的笔记（见上文设计约束）；`notes_read` 的 `id` 形式同样依赖索引，可用 `path` 绕过。
- 不支持 JSON-RPC 批处理、MCP Resources / Prompts（只注册 tools）。
- 本机单人使用，无认证；`data/index.db` 只以只读方式打开。
