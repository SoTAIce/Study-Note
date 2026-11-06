# Study Notes 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `D:\work\study-notes` 交付一个本地单人使用的学习笔记应用：Markdown 文件为唯一真源，SQLite 索引提供检索/双链反查/标签/时间流，带 AI 六种动作、系统级热键捕获助手，以及给 DSH 用 MCP 连接线。

**Architecture:** 单进程 Node 24 HTTP 服务（`node:sqlite`，零原生依赖）同时托管 Vite 构建出的 React 前端；数据层分两半——`store.ts` 负责 `.md` 文件的原子读写与历史版本，`indexer.ts` 负责把文件投影进 `index.db`（唯一写者），所有查询走 `search.ts` / `db`。AI 走 OpenAI 兼容网关的适配层，文本经 SSE 推到前端「建议块」，用户确认后才写回文件。捕获助手是独立常驻的 PowerShell + WPF 进程，只依赖 HTTP API；MCP 服务器只写 `.md`，不碰索引库。

**Tech Stack:** Node v24.22.1（原生类型剥离，`.ts` 直跑）、`node:sqlite`（SQLite 3.53.4 / FTS5 trigram）、React 19 + Vite 7 + `marked`、PowerShell 5.1/WPF、stdio MCP（手写 JSON-RPC，无 SDK）、`node:test`（`--test-isolation=none`）。

**Spec:** `docs/superpowers/specs/2026-10-30-study-notes-design.md`

## Global Constraints

- 平台 Windows 11；Node **v24.22.1**、pnpm **11.28.5**；**不允许任何原生编译依赖**（无 better-sqlite3、无 node-gyp、无 jieba）。
- 后端 `.ts` 由 Node 原生类型剥离直接运行：import 必须写全 `.ts` 后缀；禁 `enum` / `namespace` / 参数属性；只导入类型时用 `import type`。
- 单测命令固定为 `node --test --test-isolation=none server/tests/<file>`（沙箱内默认模式会 `spawn EPERM`）。前端纯函数测试同理，放在 `web/src/lib/*.test.ts`，不要引入 vitest。
- `pnpm install`、`pnpm build`、监听端口在 DSH 沙箱下需要一次性 `danger-full-access`；单测不需要。
- 服务只监听 `127.0.0.1`，端口 `7777`（可用 `STUDY_PORT` 覆盖）。
- 数据目录：`data/notes/`（真源）、`data/index.db`、`data/.history/`、`data/.trash/`、`data/config.json`。
- git 只追踪源码、文档与 `data/notes/**/*.md`；忽略 `data/index.db*`、`data/.history/`、`data/.trash/`、`data/config.json`、`node_modules/`、`dist/`。
- 界面文案用中文；代码标识符用英文。
- 时间戳一律使用带时区的 ISO 8601；测试固定使用 UTC（`Z`），运行时由注入的 `now()` 产生。
- AI 默认值：`baseUrl=https://api.cline.bot/api/v1`、`model=cline-pass/deepseek-v4.1-flash-1017`、`maxTokens=2048`、`temperature=0.4`。

## Review Focus

排序即优先级；每条都在对应任务里配了测试。

1. **2 字中文查询**（如「算法」「向量」）必须命中 —— 走 `LIKE` 兜底（Task 5）。
2. **没有 frontmatter、或 frontmatter 写坏的外部 `.md`** 必须能被读进来而不是抛错（Task 2/4）。
3. **同名笔记**（不同目录同名 / `[[同名]]` 指向多条）不能让反查崩掉或串台（Task 4/6）。
4. **文件被外部编辑器改过之后再保存**，必须 409 提示而不是静默覆盖（Task 3/6）。
5. `data/notes/` 里的**非 `.md` 文件、子目录、中文与空格文件名**全链路可用（Task 3/4）。
6. **超大文件 > 2 MB** 不建历史版本、不拖垮索引（Task 3/4）。
7. **AI 流式中途断开 / 网关返回 500 `empty response content`** 要给可读提示，不能崩前端（Task 10/11）。
8. **全局热键被别的程序占用**时助手要能报告并降级，不静默失效（Task 12）。
9. **服务未启动时**捕获助手提交要自动拉起服务或明确提示（Task 12）。

---

### Task 1: 项目骨架、测试通道与静态托管

**Files:**
- Create: `package.json`、`tsconfig.json`、`vite.config.ts`、`index.html`、`.gitignore`、`.npmrc`
- Create: `server/app.ts`、`server/main.ts`、`server/tests/health.test.ts`
- Create: `web/src/main.tsx`、`web/src/App.tsx`、`web/src/styles/global.css`

**Interfaces:**
- Produces: `createApp(deps: AppDeps): (req: IncomingMessage, res: ServerResponse) => void`（`server/app.ts`）
  ```ts
  export type AppDeps = { now?: () => Date; notesRoot: string; dataDir: string };
  ```
- Produces: `GET /api/health` → `{ ok: true, version: string }`

- [ ] **Step 1:** 写失败测试 `server/tests/health.test.ts`：用 `createApp(...)` 起 `http.createServer(app).listen(0)`，`fetch('http://127.0.0.1:'+port+'/api/health')`，断言 `res.status === 200` 且 body 的 `ok === true`；`after()` 里 `server.close()`。数据目录用 `fs.mkdtempSync(path.join(os.tmpdir(), 'sn-'))`。
- [ ] **Step 2:** 跑 `node --test --test-isolation=none server/tests/health.test.ts`，期望 FAIL（模块不存在）。
- [ ] **Step 3:** 写 `package.json`（`"type": "module"`，scripts：`dev`、`build`、`start`、`test`、`typecheck`）、`tsconfig.json`（`allowImportingTsExtensions`、`noEmit`、`verbatimModuleSyntax`、`module: nodenext`）、`.gitignore`（按 Global Constraints）、`.npmrc`（`registry=https://registry.npmmirror.com/` 注释掉备用）。
- [ ] **Step 4:** 实现 `server/app.ts` 的 `createApp`：路由分发骨架 + `/api/health` + 静态文件托管（从 `dist/`，未命中且是 GET 则回 `index.html`，`/api/*` 未命中回 404 JSON）。
- [ ] **Step 5:** 实现 `server/main.ts`：读 `STUDY_PORT ?? 7777`，`listen('127.0.0.1')`，打印启动地址；端口占用时报错并提示改 `STUDY_PORT`。
- [ ] **Step 6:** 跑 Step 1 的测试，期望 PASS。
- [ ] **Step 7:** 写最小前端 `index.html` + `web/src/main.tsx` + `App.tsx`（只有标题与「服务正常」状态探测 `/api/health`）+ `vite.config.ts`（`root: 'web'`、`build.outDir: '../dist'`、`server.proxy['/api'] → http://127.0.0.1:7777`）。
- [ ] **Step 8:** 提权跑 `pnpm install`、`pnpm build`，确认 `dist/index.html` 生成；`node server/main.ts` 后 `Invoke-WebRequest http://127.0.0.1:7777/api/health` 返回 200。
- [ ] **Step 9:** `git init` + 首次提交（含设计文档）。

---

### Task 2: 解析层 `server/parse.ts`（纯函数，无 IO）

**Files:** Create `server/parse.ts`、`server/tests/parse.test.ts`

**Interfaces:**
```ts
export type NoteType = 'note' | 'idea' | 'source';
export type NoteMeta = { id: string; title: string; created: string; updated: string; type: NoteType; tags: string[]; source?: string };
export type ParsedNote = { meta: NoteMeta; body: string; hadFrontmatter: boolean };
export function parseNote(raw: string, fallback: { path: string; mtime: string }): ParsedNote;
export function serializeNote(meta: NoteMeta, body: string): string;
export function extractTags(body: string): string[];              // 去重、去 frontmatter、保留中文
export function extractLinks(body: string): Array<{ title: string; display: string | null; heading: string | null }>;
export function deriveTitle(body: string, fallbackPath: string): string;
export function excerpt(body: string, max?: number): string;      // 默认 120 字，压掉换行
export function slugify(title: string): string;                   // 保留中文，非法字符→'-'，最多 60 字符
export function contentHash(raw: string): string;                 // sha256 hex
```

- [ ] **Step 1:** 写测试：`parseNote` 能吃 `tags: [a, b]`、`tags: a, b`、`tags: 中文, 深度学习` 三种写法；无 frontmatter 时 `hadFrontmatter === false`、`title` 取自首行 `# 标题` 或文件名、`created/updated` 取 `mtime`；frontmatter 里 `created: 2026-10-30` 这种无时间的值要补成合法 ISO。
- [ ] **Step 2:** 写测试：`extractLinks("见 [[位置编码]] 与 [[Transformer|注意力]] 和 [[Bert#训练]]")` → 三项，`display`/`heading` 分别正确；`![[图.png]]` **不返回**。
- [ ] **Step 3:** 写测试：`serializeNote` → `parseNote` 往返等价（含中文标签、无 `source` 字段时不输出空行）；`slugify('Transformer 的位置编码: 原理/实现')` → `Transformer-的位置编码-原理-实现`；`excerpt` 压掉 `\n`。
- [ ] **Step 4:** 跑测试，期望 FAIL（函数未定义）。
- [ ] **Step 5:** 实现 `server/parse.ts`（手写 YAML 子集：`key: value` / `key: [a, b]` / 引号字符串，不引入 yaml 依赖）。
- [ ] **Step 6:** 跑测试，期望 PASS。
- [ ] **Step 7:** 提交。

---

### Task 3: 文件层 `server/store.ts`

**Files:** Create `server/store.ts`、`server/tests/store.test.ts`

**Interfaces:**
```ts
export class ConflictError extends Error { readonly code: 'CONFLICT' }
export type StoredNote = { id: string; relPath: string; raw: string; parsed: ParsedNote; hash: string; mtime: string };
export class NoteStore {
  constructor(opts: { notesRoot: string; historyDir: string; trashDir: string; now?: () => Date });
  list(): string[];                                   // 递归列出 *.md 相对路径（正斜杠）
  read(relPath: string): StoredNote;
  create(input: { title?: string; body: string; tags?: string[]; type?: NoteType; source?: string }): StoredNote;
  save(relPath: string, body: string, baseHash: string): StoredNote;
  moveToTrash(relPath: string): { name: string };
  listTrash(): Array<{ name: string; origPath: string; deletedAt: string }>;
  restore(name: string): { relPath: string };
}
```
文件命名：`<YYYY-MM-DD>-<slug>.md`；`type: 'idea'` 存 `inbox/` 下、slug 取正文前 20 字；`id` 用 `crypto.randomUUID().slice(0, 8)`。

- [ ] **Step 1:** 写测试：`create` 生成的文件名匹配 `/^\d{4}-\d{2}-\d{2}-.+\.md$/`、frontmatter 含 id/title/created/type/tags；idea 落在 `inbox/`。
- [ ] **Step 2:** 写测试：`save` 前后 `data/.history/<id>/` 出现一份旧版本；连续保存 25 次后该目录**恰好 20** 个文件且最旧的被删；>2 MB 内容跳过版本但仍保存成功。
- [ ] **Step 3:** 写测试：`save` 传错的 `baseHash` 抛 `ConflictError` 且**文件内容未变**；`list()` 忽略 `.txt`/`index.db`/`.trash` 内的文件；中文与空格文件名能 `create` 后 `read` 回来。
- [ ] **Step 4:** 写测试：`moveToTrash` 后 `list()` 不含它、`listTrash()` 有 `origPath`；`restore` 回到原位；同名文件已存在时恢复出的名字带 `-1` 后缀。
- [ ] **Step 5:** 跑测试，期望 FAIL。实现 `store.ts`：写临时文件到同目录 `<file>.tmp-<rand>` 后 `fs.renameSync`；历史版本用 `fs.copyFileSync`。
- [ ] **Step 6:** 跑测试，期望 PASS；提交。

---

### Task 4: 数据库与索引器 `server/db.ts` + `server/indexer.ts`

**Files:** Create `server/db.ts`、`server/indexer.ts`、`server/tests/indexer.test.ts`

**Interfaces:**
```ts
export function openDb(file: string): DatabaseSync;         // WAL + schema + meta.schema_version
export const SCHEMA_VERSION = 1;
export class Indexer {
  constructor(deps: { db: DatabaseSync; store: NoteStore; now?: () => Date });
  indexFile(relPath: string): void;
  removeFile(relPath: string): void;
  reindexAll(): { indexed: number; removed: number };
  watch(): () => void;        // fs.watch(notesRoot, {recursive:true})，300ms 防抖，返回取消函数
  ignoreNext(relPath: string): void;
}
```
建表语句与设计文档 §6.3 一致；`notes_fts` 用 `fts5(note_id UNINDEXED, title, body, tokenize='trigram')`（**非 contentless**，这样 `LIKE` 兜底与 `snippet()` 都能用）。

- [ ] **Step 1:** 写测试：`openDb` 对同一文件调两次不报错、`meta.schema_version === '1'`；`PRAGMA journal_mode` 是 `wal`。
- [ ] **Step 2:** 写测试：往临时 `notes/` 放 3 个 md（其中一个无 frontmatter、一个在子目录、一个中文文件名），`reindexAll()` 返回 `indexed: 3`，`notes` 表 3 行，`tags`/`links` 行数与内容正确。
- [ ] **Step 3:** 写测试：`[[同名]]` 同时存在 `a/同名.md` 与 `b/同名.md` 时，`links` 行保留 `target_title`、`target_id` 解析到**排序第一**的那条且 `indexFile` 不抛错。
- [ ] **Step 4:** 写测试：改文件内容后 `indexFile` 让 `content_hash` 变化；删文件后 `removeFile` 让三张表都不再有该行；`reindexAll` 在空目录返回 `{indexed:0, removed:0}`。
- [ ] **Step 5:** 写测试：`watch()` 后写入一个新 md，等 500ms，`notes` 表出现该行；取消函数调用后再写不再索引。
- [ ] **Step 6:** 跑测试 FAIL → 实现 `db.ts` + `indexer.ts` → 跑测试 PASS → 提交。

---

### Task 5: 检索 `server/search.ts`

**Files:** Create `server/search.ts`、`server/tests/search.test.ts`

**Interfaces:**
```ts
export type SearchHit = { id: string; relPath: string; title: string; snippet: string; score: number; updated: string };
export function search(db: DatabaseSync, q: string, opts?: { tag?: string; limit?: number; now?: Date }): SearchHit[];
```
规则：`q.trim().length >= 3` → FTS5 `MATCH`（trigram）取 bm25；`< 3` → `notes_fts` 上 `title LIKE ?` / `body LIKE ?`。加权：标题命中 ×3、标签命中 ×2、7 天内更新 ×1.2。`snippet` 取首个命中位置前后共 60 字，命中词包 `<mark>`。`limit` 默认 20。

- [ ] **Step 1:** 写测试：库里一条「向量数据库的索引结构」笔记，`search(db, '向量')` 与 `search(db, '数据库')` 均非空（**2 字路径**），`search(db, '向量数据库')` 命中且 `score > 0`。
- [ ] **Step 2:** 写测试：英文 `search(db, 'transformer')` 与 `'Transformer'` 结果一致；`search(db, 'zzzz不存在')` 返回 `[]`。
- [ ] **Step 3:** 写测试：标题含关键词的笔记排在只有正文含关键词的笔记之前；`{tag:'深度学习'}` 只返回带该标签的；`snippet` 含 `<mark>`。
- [ ] **Step 4:** 跑 FAIL → 实现 → 跑 PASS → 提交。

---

### Task 6: HTTP API `server/api.ts`（CRUD、回收站、捕获、反查、时间流）

**Files:** Create `server/api.ts`、`server/tests/api.test.ts`；Modify `server/app.ts`（挂载真实依赖）

**Interfaces:**
```ts
export function createApi(deps: { store: NoteStore; indexer: Indexer; db: DatabaseSync; now?: () => Date }):
  (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;   // 处理了返回 true
```
路由：设计文档 §6.4 全部（`/api/notes*`、`/api/search`、`/api/backlinks/:id`、`/api/timeline`、`/api/tags`、`/api/trash*`、`/api/capture`、`/api/index/file`、`/api/reindex`）。
约定：JSON 请求体上限 5 MB；错误统一 `{ error: string }`；`ConflictError` → 409 且附 `{ currentHash, diskUpdated }`；找不到 → 404。

- [ ] **Step 1:** 写测试（起临时数据目录 + 临时 server）：`POST /api/notes` → 201 带 `id`；`GET /api/notes` 含它；`GET /api/notes/:id` 返回正文与 `hash`。
- [ ] **Step 2:** 写测试：`PUT /api/notes/:id` 用正确 `baseHash` → 200；用过期 `baseHash` → 409 且响应含 `currentHash`，磁盘内容保持旧值（**A3 防护**）。
- [ ] **Step 3:** 写测试：`POST /api/capture {text:'突然想到：稀疏注意力'}` → 201，`GET /api/timeline` 首条是它且 `type==='idea'`；`GET /api/tags` 计数正确。
- [ ] **Step 4:** 写测试：A 笔记正文写 `[[B的标题]]`，`GET /api/backlinks/<B.id>` 返回 A；`DELETE /api/notes/:id` → `GET /api/trash` 有它 → `POST /api/trash/<name>/restore` → 原路径文件回来了。
- [ ] **Step 5:** 跑 FAIL → 实现 `api.ts` 并在 `app.ts` 注入真实 `NoteStore/Indexer/openDb`（`data/` 缺失时创建目录 + `reindexAll`）→ 跑 PASS。
- [ ] **Step 6:** 提交。

---

### Task 7: 前端骨架 —— 三栏布局、编辑器、自动保存、实时预览

**Files:** Create `web/src/api.ts`、`web/src/components/Sidebar.tsx`、`EditorPane.tsx`、`Preview.tsx`、`web/src/lib/markdown.ts`、`web/src/lib/markdown.test.ts`、`web/src/styles/app.css`；Modify `web/src/App.tsx`

**Interfaces:**
```ts
// web/src/lib/markdown.ts（纯函数，node:test 可测）
export function renderMarkdown(md: string): string;   // marked + 双链/标签后处理
export function renderInline(text: string): string;   // 只处理 [[..]] 与 #tag，给标题/片段用
```
`renderMarkdown` 要求：`[[笔记|别名]]` → `<a class="wikilink" data-target="笔记">别名</a>`；`#标签` → `<span class="tag">#标签</span>`（代码块/行内代码内不处理）；`<script>` 被转义。

- [ ] **Step 1:** 写 `markdown.test.ts`：三种双链形态、`![[图片]]` 保持原文、代码围栏里 `[[x]]` 不变、`<script>alert(1)</script>` 被转义。
- [ ] **Step 2:** 跑测试 FAIL → 实现 `markdown.ts`（`marked` + 正则后处理）→ PASS。
- [ ] **Step 3:** 写 `web/src/api.ts`：`listNotes/getNote/createNote/saveNote/deleteNote/search/tags/timeline/backlinks/restore/reindex`，全部 typing 与后端返回一致，`saveNote` 透出 409。
- [ ] **Step 4:** 实现三栏布局（左列表 / 中分屏编辑器+预览 / 右占位栏）、800ms 防抖自动保存、保存状态指示（保存中/已保存/冲突）。冲突时弹提示条：「文件已被外部修改」+「以我的覆盖 / 重新加载」。
- [ ] **Step 5:** 提权跑 `pnpm build`，`node server/main.ts`，浏览器实测：新建 → 输入 → 自动保存 → 刷新后内容还在 → 预览里双链可点（点了先跳列表筛选）。
- [ ] **Step 6:** 提交。

---

### Task 8: 检索面板、标签、时间流、反查栏

**Files:** Create `web/src/components/SearchPalette.tsx`、`RightRail.tsx`、`web/src/lib/keyboard.ts`、`web/src/lib/keyboard.test.ts`；Modify `App.tsx`、`Sidebar.tsx`

**Interfaces:**
```ts
// web/src/lib/keyboard.ts
export type Action = 'search' | 'new' | 'save' | 'ai' | 'capture';
export function resolveKey(ev: { key: string; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }): Action | null;
```
映射：`Ctrl+K`→search、`Ctrl+N`→new、`Ctrl+S`→save、`Ctrl+J`→ai、`Ctrl+Shift+Space`→capture。

- [ ] **Step 1:** 写 `keyboard.test.ts`：五个映射逐一断言；`Ctrl+Alt+K` 返回 `null`；`Ctrl+S` 返回 `'save'` 而不是 `'search'`。
- [ ] **Step 2:** 跑 FAIL → 实现 → PASS。
- [ ] **Step 3:** 实现 `SearchPalette`（`Ctrl+K` 弹出、输入即搜、↑↓ 选择、Enter 打开、显示 `<mark>` 片段）。
- [ ] **Step 4:** 实现侧边栏三段（全部笔记 / 标签云可点筛选 / 时间流按天分组）与右栏（反查链接、出链、占位给 AI）。
- [ ] **Step 5:** 提权 `pnpm build`，浏览器实测：搜「向量」有结果、点标签能筛选、反查栏显示引用来源。
- [ ] **Step 6:** 提交。

---

### Task 9: 应用内捕获弹层

**Files:** Create `web/src/components/CaptureModal.tsx`；Modify `App.tsx`、`api.ts`

**Interfaces:**
- Consumes: `POST /api/capture`、`resolveKey(...)` 的 `'capture'`。
- Produces: `<CaptureModal open onClose onCaptured={(id) => void} />`，`textarea` 自动聚焦，`Ctrl+Enter` 提交，`Esc` 关闭，成功后 400ms 提示「已收进 inbox」并把左侧列表刷新。

- [ ] **Step 1:** 实现组件与快捷键接入。
- [ ] **Step 2:** 提权 `pnpm build`，实测：任意页面按 `Ctrl+Shift+Space` → 输入 → `Ctrl+Enter` → 左侧收件箱多一条，文件出现在 `data/notes/inbox/`。
- [ ] **Step 3:** 提交。

---

### Task 10: AI 后端 —— 适配层、六种动作、SSE

**Files:** Create `server/ai.ts`、`server/tests/ai.test.ts`；Modify `server/api.ts`、`server/db.ts`（`ai_calls` 表）

**Interfaces:**
```ts
export type AiMode = 'expand' | 'summarize' | 'explain' | 'quiz' | 'continue' | 'ask';
export type AiConfig = { baseUrl: string; apiKey: string; model: string; temperature: number; maxTokens: number };
export function normalizeResponse(payload: unknown): { content: string; reasoning: string | null };  // 兼容 {choices} 与 {data:{choices}}
export function buildMessages(mode: AiMode, input: { noteTitle: string; noteBody: string; selection?: string; question?: string; related?: Array<{ title: string; excerpt: string }> }): Array<{ role: 'system' | 'user'; content: string }>;
export async function* streamAi(cfg: AiConfig, messages: Array<{ role: string; content: string }>, fetchImpl?: typeof fetch): AsyncGenerator<string>;
export function loadAiConfig(dataDir: string): AiConfig | null;   // config.json 优先，缺失则从 paper-reader 的 config.json 复制三项
export function saveAiConfig(dataDir: string, patch: Partial<AiConfig>): AiConfig;  // GET 返回时 apiKey 打码
```

- [ ] **Step 1:** 写测试：`normalizeResponse({choices:[{message:{content:'x', reasoning:'r'}}]})` → `{content:'x', reasoning:'r'}`；`normalizeResponse({success:true, data:{choices:[{message:{content:'y'}}]}})` → `{content:'y', reasoning:null}`；空 content 时抛 `AiEmptyError`。
- [ ] **Step 2:** 写测试：`buildMessages('explain', ...)` 的 system 文案包含「用初学者能懂的方式」、`user` 含选段；六个 mode 各自产出非空且互不相同。
- [ ] **Step 3:** 写测试：`streamAi` 用假 `fetchImpl` 返回两段 SSE（`data: {"choices":[{"delta":{"content":"你"}}]}` 与 `data: [DONE]`），断言 yield `['你', '好']`；上游 500 且 body 含 `empty response content` 时抛 `AiEmptyError`；流中抛错时已 yield 的内容不丢、错误对象带 `partial`。
- [ ] **Step 4:** 跑 FAIL → 实现 `ai.ts` → 跑 PASS。
- [ ] **Step 5:** 在 `api.ts` 加 `POST /api/ai/:mode`（SSE：`text/event-stream`，逐块 `data:`，结束 `event: done`，错误 `event: error` 带 `code`）与 `GET/PUT /api/config`；每次调用写 `ai_calls`。
- [ ] **Step 6:** 用真实网关一次性验证（提权）：`node -e` 调 `streamAi` 打「用一句话解释位置编码」，确认有增量输出；提交。

---

### Task 11: AI 前端 —— 建议块与插入

**Files:** Create `web/src/components/AiPanel.tsx`；Modify `EditorPane.tsx`、`RightRail.tsx`、`api.ts`

**Interfaces:**
- Consumes: `POST /api/ai/:mode`（SSE）、当前选区、当前笔记。
- Produces: `<AiPanel mode onInsert(text, where: 'cursor' | 'end' | 'replace') onDiscard />`；六个动作按钮；流式逐字追加；错误条显示「模型没给出正文，换个说法或调大长度」。

- [ ] **Step 1:** 实现 SSE 读取（`fetch` + `ReadableStream`，按 `\n\n` 切事件）、流式渲染、四个操作按钮（插入光标处 / 追加末尾 / 替换选区 / 丢弃）。
- [ ] **Step 2:** 实测：选中一段 → `Ctrl+J` → 点「解释」→ 流式输出 → 「插入光标处」→ 正文出现、`ai_calls.inserted` 为 1。
- [ ] **Step 3:** 实测错误态：临时把 `apiKey` 改错 → 出现可读错误条而非白屏。
- [ ] **Step 4:** 提交。

---

### Task 12: 捕获助手（系统级热键 + 预热小窗）

**Files:** Create `bin/capture.ps1`、`bin/捕获助手.vbs`、`bin/start.bat`；Modify `server/api.ts`（`/api/health` 已够用）

**Interfaces:**
- `capture.ps1` 用 `Add-Type` 声明 `RegisterHotKey`/`UnregisterHotKey` 与 WPF 窗口；热键 `Ctrl+Alt+Space`；窗口 `520×160`、`Topmost`、`ShowActivated`、光标定位到 `TextBox`；`Ctrl+Enter` → `Invoke-RestMethod POST http://127.0.0.1:7777/api/capture`；失败时尝试 `Start-Process bin\start.bat` 后重试一次，再失败则窗口内红字提示。
- `捕获助手.vbs`：`CreateObject("WScript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ...\capture.ps1", 0, False`。
- `start.bat`：`/install-autostart` 时往 `shell:startup` 放快捷方式；默认启动捕获助手（若未运行）+ 服务 + 浏览器。

- [ ] **Step 1:** 实现 `capture.ps1` 骨架：注册热键、窗口显示/隐藏、Esc 关闭；先不接 HTTP。
- [ ] **Step 2:** 实测：双击 `.vbs` 后按 `Ctrl+Alt+Space`，窗口立刻出现（脚本内记录「注册到显示」耗时到 `%TEMP%\capture-timing.log`），连按 10 次，全部 < 300ms；热键被占用时日志写明 `RegisterHotKey failed (1409)`。
- [ ] **Step 3:** 接 HTTP 提交 + 服务未启动时的自动拉起与提示。
- [ ] **Step 4:** 实测：服务关掉 → 按热键 → 输入 → `Ctrl+Enter` → 服务被拉起且笔记出现在 inbox。
- [ ] **Step 5:** 实现 `start.bat`（含 `/install-autostart`）并实测一键启动。
- [ ] **Step 6:** 提交。

---

### Task 13: DSH 连接线（stdio MCP）

**Files:** Create `dsh-mcp/server.mjs`、`server/tests/mcp.test.ts`、`dsh-mcp/README.md`

**Interfaces:**
- 手写 MCP JSON-RPC（无 SDK）：支持 `initialize`（回 `protocolVersion: '2024-11-05'`、`capabilities.tools`）、`tools/list`、`tools/call`、`notifications/initialized`（忽略）。
- 工具：`notes_search(query, limit?)`、`notes_read(id|path)`、`notes_create(title, body, tags?, type?)`、`notes_append(id, text)`、`notes_capture(text, tags?)`。
- **只写 `.md`**：写完后 `POST http://127.0.0.1:7777/api/index/file`（3s 超时），失败静默忽略。
- 数据根 `STUDY_NOTES_DIR ?? D:\work\study-notes`。

- [ ] **Step 1:** 写测试 `server/tests/mcp.test.ts`：`spawn` 子进程跑 `node dsh-mcp/server.mjs`（需提权或直接 `child_process.spawn` 在沙箱外跑——若 EPERM 则改为用 `node:stream` 直接 `import` 出 `createMcpSession()` 做进程内测试），发 `initialize` → 回应 `protocolVersion`；`tools/list` 返回 5 个工具名；`tools/call notes_create` 后临时目录里出现 md。
- [ ] **Step 2:** 实现 `server.mjs` → 跑 PASS。
- [ ] **Step 3:** 写 `dsh-mcp/README.md`：给出在 DSH profile 中注册 stdio MCP 的确切配置片段与验证方法。
- [ ] **Step 4:** 在 DSH 里实际注册并验证：让 DSH 调 `notes_search` 搜一条真实笔记；把验证截图/输出记进 README。
- [ ] **Step 5:** 提交。

---

### Task 14: 收尾 —— README、验收清单、端到端验收

**Files:** Create `README.md`、`docs/验收清单.md`；Modify 任意遗留问题

- [ ] **Step 1:** 写 `README.md`：做什么 / 怎么启动 / 数据在哪 / 怎么配 AI / 怎么接 DSH / 沙箱提权说明 / 备份建议（`git -C data/notes`）。
- [ ] **Step 2:** 写 `docs/验收清单.md`，逐条覆盖设计文档 §2 的 G1–G7 与 A1–A4。
- [ ] **Step 3:** 手工跑完清单，把每条的真实结果（命令输出 / 现象）填进去；任何未通过项要么修，要么在 README 的「已知限制」里写清。
- [ ] **Step 4:** 跑 `node --test --test-isolation=none server/tests/` 全绿 + `pnpm build` 成功 + `pnpm typecheck` 无错。
- [ ] **Step 5:** 用真实学习记录跑 30 分钟（造 10 条笔记 + 3 个 idea + 1 次 AI 扩写），确认不卡、不丢字。
- [ ] **Step 6:** 最终提交。
