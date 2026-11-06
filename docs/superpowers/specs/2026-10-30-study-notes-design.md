# Study Notes —— 个人学习记录与想法捕捉工作台 · 设计文档

- 日期：2026-10-30
- 状态：待用户确认
- 项目目录：`D:\work\study-notes`

---

## 1. 意图与为什么

使用者是一个人（本机 Windows 用户），日常有两种记录行为：

1. **学习记录**：读论文、看书、看课程，边学边记，笔记之间互相引用，日后要能翻出来、串起来。
2. **想法捕捉**：某个时刻冒出一个 idea，要能在几秒内记下来，不打断当下的思路。

现有工具的痛点：纯 Markdown 笔记（Obsidian 类）检索和反查靠插件、中文搜索质量一般、移动文件容易断链；数据库型笔记（Notion 类）数据在云端、离线差、打开慢、写一条要走很多步。使用者要的是 **文件躺在自己磁盘上、但有数据库级的检索与关联能力**。

AI 的定位是**局部助手**，不是代写：把选中的一段展开成结构化笔记、解释没看懂的一段、基于相关笔记回答一个问题、生成几个复习问题。AI 的产出必须经过使用者确认才落盘。

## 2. 目标 / 非目标 / 反目标

### 目标

| 编号 | 目标 |
|---|---|
| G1 | 打开即写：系统级热键唤起捕获窗，从按键到光标可输入 **≤ 300 ms**（不启动浏览器、不等待页面加载） |
| G2 | 数据主权：Markdown 文件是唯一真源，任何编辑器可读可改；索引可随时从文件重建 |
| G3 | 检索：中英混排全文检索，**2 个汉字**的查询也能命中；结果按标题命中、最近编辑加权 |
| G4 | 关联：`[[双链]]` 解析与反查（谁引用了我）、`#标签`、按创建时间的时间流 |
| G5 | AI：选中文本 → 扩写 / 总结 / 解释 / 出题 / 顺着思路续写；产出以「建议块」呈现，点一下才插入 |
| G6 | DSH 桥：在 DSH 聊天里能搜索我的笔记、把讨论结果写回成一条笔记 |
| G7 | 坚固：原子写、保存前留历史版本、崩溃不丢字、外部改动冲突要拦下来 |

### 非目标（本期不做）

- 多用户、账号、云同步、冲突合并
- 移动端、局域网/公网访问（只监听 127.0.0.1）
- 所见即所得富文本编辑
- 知识图谱可视化、白板、看板视图
- 插件生态、主题市场
- PDF 标注、手写、语音转录

### 反目标（做到这些就算失败）

| 编号 | 反目标 |
|---|---|
| A1 | 笔记内容锁在数据库里、导出有损 |
| A2 | AI 未经确认直接覆写使用者手写的内容 |
| A3 | 保存时丢字，或悄悄覆盖掉外部编辑器的改动 |
| A4 | 为了界面好看牺牲「记」的速度 |

## 3. 约束

- 平台 Windows 11；Node **v24.22.1**（类型剥离默认开启，后端 `.ts` 可直接运行）、pnpm 11.28.5；**没有全局 Python**。
- `node:sqlite` 可用，内置 SQLite **3.53.4**，FTS5 可用（已实测）；因此后端零原生依赖、零编译。
- DSH 文件沙箱：工作区内**既有子目录**写入受限，`pnpm install` / 构建 / 监听端口需要一次性提权（`danger-full-access`）；开发流程要把这一点写进 README。**沙箱内无外网**（实测：DNS 可解析、TLS 连接被拒），提权后 npm registry 与 AI 网关均可达 —— 这只影响「我开发时跑测试」，使用者正常双击 `start.bat` 启动的进程不受沙箱影响。
- AI 网关已实测（`https://api.cline.bot/api/v1`，模型 `cline-pass/deepseek-v4.1-flash-1017`）：**非流式与流式都可用**；响应是 OpenAI 兼容格式（但历史记录显示该网关有时会多包一层 `{success, data}`，解析器两种形状都要吃）；**它是推理模型**，`max_tokens` 过小（实测 32）会因推理 token 占满而返回 `500 {"error":"empty response content"}`，响应体里带 `reasoning` / `reasoning_details` 字段。
- 单机单人，服务只监听 `127.0.0.1`，默认端口 **7777**（避开 DSH 的 53386）。
- 规模假设：笔记 ≤ 1 万条，总文本 < 100 MB。

## 4. 用户已定的方向

| 决定 | 选择 |
|---|---|
| 形态 | **C：先做独立的本地 Web App，再补上 DSH 连接线** |
| 技术栈 | **方案三：Node + Vite 全栈** |
| 存储真源 | 由我定 → **Markdown 文件为真源 + SQLite 只做索引** |
| AI 分工 | App 内 AI 按钮直接调模型网关（独立于 DSH）；DSH 那侧做成工具桥 |

## 5. 考虑过的方案与取舍

### 5.1 形态

| 方案 | 说明 | 取舍 |
|---|---|---|
| A 独立本地 Web App | 自带服务 + 浏览器页面，数据在本地 | 独立、可控、笔记不绑死在 AI 工具上；代价是多一个进程 + DSH 侧要补连接线 |
| B 住进 DSH 界面 | 做成 DSH 插件页面 | 一个入口、AI 就是 DSH 本身；代价是界面受宿主框架约束、DSH 升级/重启会影响笔记功能 |
| **C 先 A 再补桥**（选） | A 做完，加一个薄工具桥 | 兼顾数据寿命与 AI 能力；工作分两步 |

**为什么**：笔记这种东西生命周期远长于任何一个 AI 工具。把它绑死在宿主界面上，等于把数据资产押在一个会频繁升级的进程上。

### 5.2 技术栈

| 方案 | 说明 | 取舍 |
|---|---|---|
| 一 FastAPI + SQLite + 原生 JS | 与既有 paper-reader 同模式 | 本机无全局 Python，必须自带 venv 才能跑，分发麻烦 |
| 二 Go 单二进制 + 内嵌前端 | 一个 exe 双击即用 | 部署最爽；但每次改界面都要重新 build，Markdown 渲染 / AI 调用全手写 |
| **三 Node + Vite**（用户选） | Vite + React 前端，Node 后端 | 前端生态最好、开发热更新快、`node:sqlite` 免编译；代价是要有 Node 环境 + 构建步骤 |

**配套**：Vite 前端产物由 Node 服务托管，对外只有一个端口、一个启动脚本。

### 5.3 存储真源

| 方案 | 说明 | 取舍 |
|---|---|---|
| **文件真源 + 索引**（选） | `.md` 是唯一真源，SQLite 存目录树 / 检索 / 反查 | 程序挂了、删了，笔记一条不少；可 git 备份、可用任何编辑器打开，可与 Obsidian 共存 |
| 数据库真源 + 导出 | 写库，定期导出 md | 单一真源简单，但导出必然有损，且外部编辑不回流（触碰 A1） |
| 纯数据库 | 不做文件 | 最省事，但直接违背「数据主权」目标 |

**为什么**：使用者明确要「接入数据库」，但数据库在这里的正确角色是**索引与关联**，不是仓库本身。

### 5.4 中文检索

| 方案 | 说明 | 取舍 |
|---|---|---|
| **FTS5 trigram + LIKE 兜底**（选） | ≥3 字符走 FTS5（trigram 分词，中英文都能子串匹配、bm25 排序），<3 字符走 `LIKE '%q%'` | 零依赖、已实测可用；万条规模下 LIKE 全表扫描约几十毫秒，够用 |
| 自建 bigram 倒排表 | 完全可控 | 多一张表 + 自己算打分，收益不明显 |
| 引入分词库（jieba 等） | 分词质量最好 | 多一个依赖与词典，为一个个人笔记应用过重 |

## 6. 怎么造（结构）

### 6.1 目录结构

```
D:\work\study-notes\
├─ bin\start.bat              一键启动：装依赖 → 构建前端 → 起服务 → 开浏览器
├─ bin\捕获助手.vbs            无窗口启动捕获助手（放 shell:startup 可开机自启）
├─ bin\capture.ps1            常驻进程：全局热键 + 预热的 WPF 捕获小窗
├─ data\                      运行时数据（除 config 外都进 .gitignore）
│  ├─ notes\                  真源 Markdown
│  │  ├─ inbox\               快速捕获的 idea
│  │  └─ ...                  按主题建的笔记
│  ├─ .history\<id>\<ts>.md   保存前的旧版本（每条保留最近 20 版）
│  ├─ index.db                SQLite 索引
│  └─ config.json             AI 网关配置（gitignore）
├─ server\                    后端：Node 24 + node:sqlite，.ts 直跑
│  ├─ main.ts                 HTTP 服务 + 静态托管
│  ├─ db.ts                   schema / 迁移
│  ├─ notes.ts                文件读写、原子写、历史版本
│  ├─ indexer.ts              frontmatter / 双链 / 标签解析，增量与全量索引
│  ├─ search.ts               检索（FTS5 + LIKE + 加权）
│  ├─ ai.ts                   OpenAI 兼容网关调用（含 403/包一层适配）
│  └─ api.ts                  路由
├─ web\                       Vite + React + TS 前端
├─ dsh-mcp\                   MCP stdio 服务器（DSH 连接线）
│  └─ server.mjs
└─ docs\superpowers\specs\    设计文档（本文件）
```

**版本管理边界**（消除「可 git 备份」与「data 全忽略」的矛盾）：

- **进 git**：源码、文档、`data/notes/**/*.md`（笔记本体，这是「可 git 备份」的实现方式）、`.gitignore`、`README.md`。
- **不进 git**：`data/index.db*`（可重建）、`data/.history/`（体积大、机器状态）、`data/.trash/`、`data/config.json`（含 API key）、`node_modules/`、`web/dist/`、`bin/.cache/`。

### 6.2 笔记文件格式

一条笔记一个文件，文件名 `YYYY-MM-DD-<slug>.md`（idea 放 `inbox/`，slug 取正文前若干字符）。

```markdown
---
id: 7f3a1c2e
title: Transformer 的位置编码
created: 2026-10-30T06:02:11Z
updated: 2026-10-30T07:41:03Z
type: note        # note | idea | source
tags: [深度学习, 论文]
source: https://arxiv.org/abs/1706.03762
---

正文，支持 [[双链]]、#标签、代码块、公式（v2 支持 KaTeX 渲染，v1 先原样显示）。
```

- `id` 前端不需要看到，用于反查与版本目录；缺失时由索引器按路径生成并回填。
- `created` / `updated` 由程序维护；`title` 缺失时用文件名推导。
- **双链语法支持范围**（v1）：`[[笔记名]]`、`[[笔记名|显示别名]]`、`[[笔记名#小节]]` 三种都解析，反查按「笔记名」匹配；`![[嵌入]]` 与块引用 `^block-id` 不解析，按普通文本显示。
- **空库起步**：示例环境没有存量 Obsidian vault，v1 不做导入迁移；解析器按上面的语法上限设计，日后要接 Obsidian 只需放宽这一层。

### 6.3 数据库 schema（`data/index.db`）

```sql
meta(key TEXT PRIMARY KEY, value TEXT);            -- schema_version 等

notes(
  id TEXT PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,      -- 相对 data/notes/
  title TEXT, excerpt TEXT,
  type TEXT, created TEXT, updated TEXT,
  content_hash TEXT,              -- sha256，用于外部改动冲突检测
  chars INTEGER, indexed_at TEXT
);

tags(note_id TEXT, tag TEXT, PRIMARY KEY(note_id, tag));
links(src_id TEXT, target_title TEXT, target_id TEXT);   -- target_id 可空：指向未存在的笔记
notes_fts USING fts5(title, body, tokenize='trigram', content='');
ai_calls(id, note_id, mode, model, created, output, inserted INTEGER);
```

### 6.4 HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/notes` | 列表（支持 `?type=` `?tag=` `?sort=updated`） |
| GET | `/api/notes/:id` | 单条（含正文） |
| POST | `/api/notes` | 新建（title / body / tags / type） |
| PUT | `/api/notes/:id` | 保存（带 `baseHash` 做冲突检测，冲突返 409） |
| DELETE | `/api/notes/:id` | 移到 `data/.trash/`（不真删） |
| GET | `/api/trash` | 回收站列表（文件名、删除时间、原路径） |
| POST | `/api/trash/:name/restore` | 从回收站放回原位；同名冲突时加时间后缀 |
| POST | `/api/index/file` | 单文件重建索引（供 MCP 在 App 运行时调用） |
| GET | `/api/search?q=&tag=` | 检索，返回高亮片段 |
| GET | `/api/backlinks/:id` | 谁引用了这条 |
| GET | `/api/timeline?from=&to=` | 时间流（按 created 倒序，含 idea） |
| GET | `/api/tags` | 标签及计数 |
| POST | `/api/capture` | 快速捕获：`{text, tags?}` → 建一条 `type=idea` 笔记进 inbox，返回 id |
| POST | `/api/reindex` | 重建索引 |
| POST | `/api/ai/:mode` | SSE 流式返回建议文本，不写文件 |
| GET/PUT | `/api/config` | AI 网关配置读写（key 打码返回） |

### 6.5 一致性与安全

- **原子写**：写临时文件 + `rename` 覆盖，避免半截文件。
- **历史版本**：内容变化时把旧版本复制到 `data/.history/<id>/<timestamp>.md`，保留 20 份。
- **冲突检测**：保存请求带 `baseHash`；磁盘 hash 与库内 hash 不一致（被外部编辑器改过）时返回 409，前端提示「文件已被外部修改」，让使用者选择「以我的覆盖 / 重新加载」。
- **外部修改回收**：服务启动时全量扫描；运行中用 `fs.watch(..., {recursive:true})` 监听 `data/notes`，静默 300ms 后增量重建该文件索引（自己写入时先标记路径，避免自触发）。
- **索引可丢**：删掉 `index.db` 重启即从文件重建，不丢任何内容。

### 6.6 AI 设计

- 配置在 `data/config.json`：`{ baseUrl, apiKey, model, temperature, maxTokens }`；也接受环境变量覆盖。**首次启动时从 `D:\work\paper-reader\data\config.json` 复制** `base_url / api_key / model` 三项作为默认值（该文件已在本地、不进 git、不进本仓库），缺失则该功能优雅降级为「未配置 AI」而不是报错。
- 适配层要处理三件事：
  1. **响应形状**：标准 `choices[0].message.content` 与该网关偶发的 `{success, data:{choices}}}` 两种都吃；
  2. **推理模型**：`maxTokens` 默认 **2048**（过小会因推理 token 占满而返回 500 `empty response content`，此错误要翻译成「模型没给出正文，请调大长度或换个说法」而不是抛原始 500）；响应中的 `reasoning` 字段不展示给使用者，仅在调试日志里留；
  3. **流式**：`stream:true` 走 SSE，前端用 `EventSource`/`fetch` 流读取，逐字追加到建议块。
- 动作（`mode`）：

  | mode | 用途 | 输入上下文 |
  |---|---|---|
  | `expand` | 把选段展开成结构化笔记（小标题 / 要点 / 例子） | 选段 + 所在笔记标题与邻近段落 |
  | `summarize` | 提炼这一段的关键结论 | 选段或整篇 |
  | `explain` | 解释没看懂的选段（讲给初学者） | 选段 + 前后文 |
  | `quiz` | 生成 3 个复习问题（含答案，折叠） | 整篇 |
  | `continue` | 顺着我的思路往下写，保持我的语气 | 当前笔记尾段 |
  | `ask` | 针对当前笔记提问 | 当前笔记 + 检索到的相关笔记（各截断） |

- 输出不落盘：SSE 推到前端右侧「建议块」，四个按钮 —— **插入光标处 / 追加到末尾 / 替换选区 / 丢弃**。
- 每次调用记入 `ai_calls`（mode、model、token 估算、是否被采纳），用于日后回看 AI 到底帮上忙没有。

### 6.7 界面

三栏布局，键盘优先，暗色为默认：

- **左栏**：搜索框（`Ctrl+K`）、收件箱（未整理的 idea）、全部笔记、标签云（可点筛选）、时间流。
- **中栏**：左右分屏 —— 左编辑（textarea，等宽字体、行号可选）、右实时预览（`marked` 渲染，`[[双链]]` 与 `#标签` 渲染成可点击胶囊）；顶部标题、标签、保存状态。
- **右栏**：反查链接（谁引用了我）+ 出链（我引用了谁）+ AI 建议块。
- **快速捕获助手（常驻，系统级热键）**：`bin\捕获助手.vbs` 无窗口启动 `bin\capture.ps1`，后者常驻内存并注册全局热键（默认 **`Ctrl+Alt+Space`**，可在 `data/config.json` 改）。按下后立即把已预热的 WPF 小窗（约 520×160，置顶、居中、跟随当前屏幕）显示出来，光标已在输入框；`Ctrl+Enter` 提交到 `POST /api/capture`，窗口淡出（400 ms 提示「已收进 inbox」），`Esc` 丢弃关闭。服务于未启动时自动拉起 `bin\start.bat` 再提交。
  - 为什么不用浏览器：浏览器标签或 Edge `--app` 窗口每次唤起要 400 ms～1 s，达不到「感知不到等待」；常驻进程把这段时间压到 100 ms 级。
  - 为什么用 PowerShell + WPF：Windows 自带、零安装、零原生编译依赖（与后端 `node:sqlite` 一样不引入二进制）。代价是首次写这块要自己 P/Invoke `RegisterHotKey`，约 200 行。
  - 可选开机自启：`start.bat --install-autostart` 在 `shell:startup` 放一个快捷方式，可一键卸载。
- 快捷键：`Ctrl+K` 搜索、`Ctrl+N` 新建、`Ctrl+S` 手动保存（平时自动保存防抖 800ms）、`Ctrl+J` 唤起 AI、`Ctrl+Shift+Space` 快速捕获。
- 视觉规范按 `design-taste-frontend` 技能产出，不在此文档里定死。

### 6.8 DSH 连接线（MCP）

`dsh-mcp/server.mjs`：一个 stdio MCP 服务器，**直接读写 `data/notes`**，不依赖 App 服务是否在运行。

**索引并发规则（重要）**：MCP **从不直接写 `index.db`**。它写完 `.md` 后尝试 `POST /api/index/file`；App 在跑 → 由服务进程索引（单写者）；App 没跑 → 跳过，等下次启动全量扫描补齐。这样 `index.db` 永远只有一个写者，不需要跨进程锁。

| 工具 | 作用 |
|---|---|
| `notes_search(query, limit?)` | 全文检索，返回 id / 标题 / 片段 |
| `notes_read(id \| title)` | 读一条笔记全文 |
| `notes_create(title, body, tags?, type?)` | 新建笔记 |
| `notes_append(id, text)` | 追加到已有笔记末尾（自动加时间戳小标题） |
| `notes_capture(text, tags?)` | 记一条 idea 进 inbox |

在 DSH profile 里注册为 stdio MCP 连接即可使用。**不选 DSH 插件的原因**：MCP 是标准协议、与 GUI 版本解耦、不占用宿主路由；插件形态（侧栏面板）留作 v2。

### 6.9 启动与开发

- `bin\start.bat`：检测 node → 首次 `pnpm install` → `pnpm build` → 起服务 → 打开 `http://127.0.0.1:7777`。
- 开发：`node --watch server/main.ts` + `pnpm --dir web dev`（Vite 代理 `/api` 到 7777）。
- 沙箱注意：`pnpm install`、`pnpm build`、监听端口在本机 DSH 沙箱下需要一次性 `danger-full-access`；README 里写明。

## 7. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | 文件层 + 索引骨架：读写 md、frontmatter、原子写、全量/增量索引、`/api/notes*` | 造 30 条笔记，重启后索引一致；删库能重建 |
| M2 | 检索 + 双链 + 标签 + 时间流 + 快速捕获 API | 中文 2 字查询有结果；改 A 里的 `[[B]]` 后 B 的反查出现 A |
| M3 | 前端三栏 + 分屏编辑 + 预览 + 快捷键 + 应用内捕获入口 | 手工验收清单全过 |
| M3.5 | 捕获助手：常驻进程 + 全局热键 + 预热 WPF 小窗 | 连按 10 次热键，每次从按键到光标可输入 < 300 ms；`Ctrl+Enter` 落进 inbox |
| M4 | AI 六种动作 + SSE 建议块 + 配置界面 | 选中一段能生成建议并插入 |
| M5 | DSH MCP 桥 + 启动脚本 + README | DSH 里问「搜一下我关于位置编码的笔记」能返回 |
| M6 | 打磨：冲突提示、历史版本恢复、错误态、空态、首屏性能 | 全链路真实使用 30 分钟不卡 |

## 8. 测试

- **后端单测**（`node:test`）：frontmatter 解析、双链提取、slug 生成、中文检索打分、冲突检测、历史版本轮转。
- **后端集成**：起临时 server + 临时数据目录，用 `fetch` 走完 CRUD / 检索 / 反查 / 409 冲突。MCP 服务器同样用临时目录测。
- **前端**：`vitest` 覆盖纯函数（双链解析、快捷键映射、防抖保存）。
- **手工验收清单**：写在 `docs/验收清单.md`，M3 之后逐条勾。

## 9. 留给实现者的决定

- 视觉细节（配色、间距、字体）由 `design-taste-frontend` 技能产出，本文件不锁。
- 端口 7777；如被占用则启动时报错并提示改 `STUDY_PORT`。
- 全局热键默认 `Ctrl+Alt+Space`（避开 Windows 输入法切换与 DSH 常用组合），冲突时在 `data/config.json` 改。
- 历史版本保留 20 份、每份上限 2 MB 之外的不再保留（超大文件跳过版本）。
- 检索加权：标题命中 ×3，标签命中 ×2，正文命中 ×1，7 天内编辑的 ×1.2。
- v1 不做公式渲染与附件管理；`![[图片]]` 先按普通文本显示。
