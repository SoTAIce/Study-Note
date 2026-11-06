# 笔记分组（Group）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给每篇笔记一个「组」（Agent 学习 / Go 学习…），新建可选组、随时可在组间移动，左栏把分组独立罗列出来；移动不失败、不改正文、不动 `updated`。

**Architecture:** 组归属写在笔记 frontmatter 的 `group:` 键里（唯一真源），`data/groups.json` 只存显示顺序与空组；索引表 `notes` 增加 `group_name` 列（靠既有 `SCHEMA_VERSION` 重建机制升级）。新增 `NoteStore.setGroup()` 做行级元数据替换（不写历史、不动 `updated`），API 新增 `/api/groups` 与 `/api/notes/move`，前端左栏新增独立「分组」区。

**Tech Stack:** Node 24 原生 TS（type stripping）、`node:sqlite`、React 19 + Vite、`node --test`（无新依赖）。

**Spec:** `docs/superpowers/specs/2026-11-02-note-groups-design.md`

## Global Constraints

- `.md` 文件是唯一真源；`data/index.db` 只是索引，永不手改。
- **零新增运行时依赖**（不加包、不加库）。
- 测试命令：`node --test --test-isolation=none "server/tests/*.test.ts" "web/src/lib/*.test.ts"`（`--test-isolation=none` 必须保留，本机沙箱下默认隔离会 `spawn EPERM`）。
- 用户可见文案一律中文；报错格式沿用 `错误：…` / `参数错误：…`。
- 移动/改名**不得**修改 `updated`、**不得**写 `.history` 快照、不得改动正文一个字符。
- 组名规则：`trim` → 内部连续空白压成一个空格 → 1..40 字符 → 禁 `/ \ : * ? " < > |` 与控制字符 → **大小写不敏感**视为同一组 → 不接受字面量「未分组」。
- 不自动修改用户既有笔记；迁移脚本必须 dry-run 优先、`--apply` 才写。
- `SCHEMA_VERSION` 提到 2 会整库重建并清空 `ai_calls`（无界面在读，已同意）。
- 现有 199 个测试保持全绿。

## Review Focus

1. **frontmatter 被写坏**：`setGroup` 把别的键、正文、空行改掉（现有 8 篇 Go 笔记没有 frontmatter，边界最多）。
2. **组归属被洗掉**：任何走 `save()` 的路径（编辑器保存、AI 追加、MCP `notes_append`）之后组消失。
3. **升级后索引空**：`SCHEMA_VERSION` 改了但 `notes` 插入语句没带 `group_name`，或列在 SCHEMA 里但查询假定存在。
4. **移动静默失败**：失败却提示成功、或批量部分失败不报。
5. **路由被吞**：`/api/notes/move` 被 `/api/notes/:id` 抢先匹配返回 404/404 笔记。
6. **组名疯长**：`Go学习` / `go学习` / `GO 学习` 变成三个组。

---

## 文件清单

**新建**
- `server/groups.ts` — 组名规范/校验、`data/groups.json` 读写、union 列表
- `server/tests/groups.test.ts`
- `server/groups-api.ts` — 组相关路由处理（避免 `api.ts` 继续膨胀）
- `server/tests/groups-api.test.ts`
- `web/src/groups-api.ts` — 前端组 API 客户端
- `web/src/lib/group-filter.ts` + `.test.ts` — 分组过滤纯函数
- `bin/migrate-groups.mjs` — 一次性迁移脚本

**修改**
- `server/parse.ts`（`NoteMeta.group`、`serializeNote`、`parseNote`、`patchFrontmatterGroup`）
- `server/store.ts`（`setGroup`；`create`/`createAt`/`save` 支持 group）
- `server/db.ts`（`SCHEMA_VERSION = 2`、`group_name` 列与索引）
- `server/indexer.ts`（写入 `group_name`）
- `server/api.ts`（列表按组过滤、`summarize` 带 group、挂载组路由与移动路由）
- `server/agent-plan.ts`、`server/agent-exec.ts`、`server/agent-tools.ts`、`server/agent.ts`（计划 op 支持 group）
- `dsh-mcp/server.mjs`（`notes_create` 可带组、`notes_read` 回显组）
- `web/src/api.ts`（`NoteSummary.group`、`listNotes({group})`、`moveNote`）
- `web/src/lib/nav.ts`（`Filter` 增加 `group` / `none`）
- `web/src/components/Sidebar.tsx`（独立分组区）
- `web/src/components/EditorPane.tsx`、`ComposeView.tsx`（组下拉）
- `web/src/App.tsx`（接线）
- `web/src/styles/app.css`（分组区样式）
- `README.md`（用法）

---

## Task 1：组名规则 + `groups.json` 存储

**Files:** `server/groups.ts`, `server/tests/groups.test.ts`

**接口（按此签名实现，别人会照着调）**

```ts
export const MAX_GROUP_NAME = 40;
export const UNGROUPED_LABEL = "未分组";           // 仅展示用
export type GroupEntry = { name: string; order: number };
export function normalizeGroupName(raw: string): string;
export function validateGroupName(raw: string): { ok: true; name: string } | { ok: false; error: string };
export function sameGroup(a: string | null | undefined, b: string | null | undefined): boolean;
export function readGroups(dataDir: string): GroupEntry[];
export function writeGroups(dataDir: string, list: GroupEntry[]): void;
export function upsertGroup(dataDir: string, name: string): { entry: GroupEntry; created: boolean };
export function renameGroupEntry(dataDir: string, from: string, to: string): void;
export function removeGroupEntry(dataDir: string, name: string): void;
export function mergeGroupList(stored: GroupEntry[], namesInNotes: string[]): Array<{ name: string; order: number; empty: boolean }>;
```

规则：`groups.json` 路径 `path.join(dataDir, "groups.json")`，形状 `{ version: 1, groups: GroupEntry[] }`；文件缺失/坏 JSON/形状不对时返回 `[]`（**绝不抛错**，笔记库不能被一个坏 json 卡住）；`upsertGroup` 用 `sameGroup` 判重，新建的 `order` = max(order)+1；`mergeGroupList` 返回 union：先按 `order` 排 stored，再补 notes 里出现过但 stored 没有的（order 依次 +1），`empty = 该组不在 namesInNotes 里`。

- [ ] 写测试 `server/tests/groups.test.ts`：normalize（前后空格、内部多空格、全角空格）；validate（空、41 字、含 `:`、含控制符、名叫「未分组」都拒）；sameGroup（大小写）；read 坏 json 返回 `[]`；upsert 幂等；rename/remove 落盘；mergeGroupList 保留空组且补缺失组。
- [ ] 跑 `node --test --test-isolation=none "server/tests/groups.test.ts"` → 全部失败（模块不存在）。
- [ ] 实现 `server/groups.ts`。
- [ ] 再跑 → 全绿。
- [ ] `git commit -m "feat(groups): 组名规则与 groups.json 存储"`

## Task 2：frontmatter 读写 `group`（含无 frontmatter 的边界）

**Files:** `server/parse.ts`, `server/tests/parse.test.ts`

```ts
// NoteMeta 增加
group?: string;
// 新增（纯函数，store 会调用）
export function patchFrontmatterGroup(raw: string, group: string | null): { raw: string; changed: boolean };
```

行为：
- `serializeNote`：`meta.group` 存在且非空时，在 `tags:` 之后、`source:` 之前输出 `group: <yamlValue>`。
- `parseNote`：`data.group` 存在则 `meta.group = unquote(...)`（空串视为无）。
- `patchFrontmatterGroup(raw, group)`：
  - 有 frontmatter 块：`group` 非 null → 块内已有 `group:` 行则**原位替换**，没有则插到 `tags:` 行之后（无 tags 则插到块尾），其它行逐字节保留；`group` 为 null → 删掉 `group:` 行；删完块里没有任何 `key: value` 行则**整块删除**并保留正文。
  - 无 frontmatter：`group` 非 null → 返回 `"---\ngroup: X\n---\n\n" + raw`；null → 原样返回，`changed: false`。
  - `changed` 表示是否真的改了（同组 → false，幂等）。

- [ ] 在 `server/tests/parse.test.ts` 加测试：`serializeNote` 写出 group 且顺序在 tags 后；无 group 时不出现在块里；`parseNote` 读回；`patchFrontmatterGroup` 无 frontmatter 时插最小块且正文不变（用现有 8 篇风格的真实样本 `# 标题\n\n正文`）；有块时原位替换不影响其它键；null 删除且只剩 group 时整块消失；同组返回 `changed: false`。
- [ ] 跑该文件 → 新用例失败。
- [ ] 实现。
- [ ] 跑 → 全绿（其余 parse 用例不许坏）。
- [ ] `git commit -m "feat(parse): frontmatter 支持 group 字段与行级替换"`

## Task 3：`NoteStore.setGroup` + create/save 支持组

**Files:** `server/store.ts`, `server/tests/store.test.ts`

```ts
setGroup(relPath: string, group: string | null, opts: { baseHash?: string } = {}): StoredNote;
// create / createAt 的入参、save 的 patch 都增加 group?: string | null
```

要求（照抄）：
- 用 `patchFrontmatterGroup` 生成新内容；**不碰 `updated`、不写 `.history`**（对比 `save()`：它两者都会做，所以不能复用）。
- `opts.baseHash` 与当前 hash 不同 → 抛 `ConflictError(current.hash, current.mtime)`（复用 §store.ts 现有类）。
- 组名先 `validateGroupName`，非法 → `throw new Error("参数错误：" + error)`。
- 目标组与当前相同（`sameGroup`）→ 直接返回当前 note，不写盘。
- 写盘用与 `save()` 相同的原子写法（临时文件 + rename）。
- `save()` 的 patch 带 `group` 时，序列化结果要包含（因为 serializeNote 已支持）。
- `create`/`createAt` 带 `group` 时写进 frontmatter。

- [ ] `server/tests/store.test.ts` 加用例：`setGroup` 只改一行（断言正文与 `updated` 与其它 frontmatter 键逐一不变）；无 frontmatter 的文件被插入最小块且正文不变；`baseHash` 不符抛 `ConflictError`；同组幂等且 mtime 不变；非法组名报「参数错误：…」；`save()` 之后 group 仍在；`create({group})` 落盘有该键。
- [ ] 跑 → 失败。
- [ ] 实现。
- [ ] 跑 `server/tests/store.test.ts` → 全绿。
- [ ] `git commit -m "feat(store): setGroup 只改一行元数据，不动 updated 与历史"`

## Task 4：索引加 `group_name`（SCHEMA_VERSION 2）

**Files:** `server/db.ts`, `server/indexer.ts`, `server/tests/indexer.test.ts`（或无则新建 `server/tests/groups-index.test.ts`）

- `SCHEMA_VERSION` → `2`。
- `SCHEMA` 的 `notes` 表加 `group_name TEXT`，并加 `CREATE INDEX IF NOT EXISTS notes_group ON notes(group_name);`。
- `indexer.indexFile` 的 `INSERT INTO notes (...)` / upsert 语句带上 `group_name`（值 `note.parsed.meta.group ?? null`）。
- 不要写任何 `ALTER TABLE`。

- [ ] 加测试：临时目录建库（走 `openDb`），索引一篇带 `group: Go 学习` 的笔记后 `SELECT group_name` 为该值；无组笔记为 `NULL`；`meta.schema_version` 等于 `"2"`；用旧版本值（手动写 `schema_version = 1`）打开后表被重建且 `group_name` 列存在。
- [ ] 跑 → 失败。
- [ ] 实现。
- [ ] 跑 → 全绿。
- [ ] `git commit -m "feat(index): notes 表增加 group_name，SCHEMA_VERSION 升到 2"`

## Task 5：`/api/groups` 增删改查

**Files:** `server/groups-api.ts`, `server/api.ts`, `server/tests/groups-api.test.ts`

路由（挂在这个顺序，**在 `/api/notes` 之前**无冲突，但组路由要放在 notes 块之后无妨）：
- `GET /api/groups` → `{ items: [{ name, count, empty }], ungrouped: number }`。`count` 用 `SELECT group_name, COUNT(*) AS n FROM notes GROUP BY group_name`；`ungrouped` = `group_name IS NULL OR group_name = ''` 的计数；`items` 由 `mergeGroupList(readGroups(dataDir), dbGroups)` 得出，库里出现的组名覆盖 json 的（以笔记为准）。
- `POST /api/groups` `{ name }` → 校验后 `upsertGroup`；已存在返回 200 且 `created: false`；非法 400。
- `PATCH /api/groups/:name` `{ name }` → 新名校验；取该组所有笔记（`SELECT id, path FROM notes WHERE group_name = ?`，用 `sameGroup` 语义：`lower(group_name) = lower(?)`），逐篇 `store.setGroup(path, newName)`；单篇失败进 `failed[{relPath, reason}]`（`ConflictError` → `"文件已被改动"`）；成功后 `renameGroupEntry` + `reindex` 每篇；返回 `{ renamed: n, failed: [...] }`。新名与已有组合并（不报错）。
- `DELETE /api/groups/:name` → 组内每篇 `setGroup(path, null)`，`removeGroupEntry`，返回 `{ ungrouped: n, failed: [...] }`；**不删笔记**。
- 组名在 URL 里要 `decodeURIComponent`；找不到组 → 404 `{ error: "没有这个分组：X" }`。

- [ ] `server/tests/groups-api.test.ts`：建组/重复建（200 `created:false`）/非法名 400；GET 计数含空组与 ungrouped；PATCH 改名后每篇笔记 frontmatter 变新名且正文不变、`updated` 不变；PATCH 遇到一篇被外部改动（改 hash）→ 该篇进 `failed`，其余成功；DELETE 后退回未分组但文件仍在；改名成已有组名 = 合并。
- [ ] 跑 → 失败。
- [ ] 实现 `server/groups-api.ts` 并在 `api.ts` 里接线（注入 `{ db, store, dataDir, reindex }`）。
- [ ] 跑 → 全绿。
- [ ] `git commit -m "feat(api): 分组增删改查与批量改名"`

## Task 6：笔记移动 + 列表按组过滤

**Files:** `server/api.ts`, `server/tests/groups-api.test.ts`

- `POST /api/notes/move` `{ ids: string[], group: string | null }`：≤200 篇；组非 null 时 `validateGroupName` 失败即 400；**组不存在自动 `upsertGroup`**；逐篇 `setGroup` + `reindex`；返回 `{ moved: string[], failed: [{ id, reason }] }`。**必须注册在 `/api/notes/:id` 路由之前。**
- `POST /api/notes/:id/move` `{ group, baseHash? }`：单篇；`baseHash` 不符 → 409 `{ error: "文件已被改动，请刷新后重试", hash }`；笔记不存在 → 404。
- `GET /api/notes?group=X`：`X === "none"` → `group_name IS NULL OR group_name = ''`；否则 `lower(group_name) = lower(?)`；与 `type`/`tag` 条件用 `AND` 组合。
- `summarize()` 与 `GET /api/notes/:id` 响应增加 `group: string | null`；`NoteSummary` 类型同步。

- [ ] 测试：单篇移动到新组（自动建组，`GET /api/groups` 能看到）；`baseHash` 过期返回 409；批量 3 篇 1 篇冲突 → `moved` 2 篇、`failed` 1 篇；`?group=none` 只返回未分组；`?group=` 大小写不敏感；列表响应带 `group`。
- [ ] 跑 → 失败（注意：先确认 `/api/notes/move` 不会被 `:id` 吃掉，用一条 `POST /api/notes/move` 用例锁住）。
- [ ] 实现。
- [ ] 跑 → 全绿。
- [ ] `git commit -m "feat(api): 笔记单篇/批量移动与按组过滤"`

## Task 7：AI 计划支持组

**Files:** `server/agent-plan.ts`, `server/agent-exec.ts`, `server/agent-tools.ts`, `server/agent.ts`, `server/tests/agent-plan.test.ts`, `server/tests/agent-exec.test.ts`

- `Op` 增加 `group?: string`；`normalizePlan` 里对 `create/append/rewrite` 校验 `validateGroupName`，非法 → `PlanError`（消息带中文原因）；`NormalizedOp.group?: string`。
- `executePlan`：`create` 走 `store.createAt(..., { group })`；`append`/`rewrite` 若 op 带 group 则 `store.save(..., { group })` 一并写入。
- `agent-tools.ts`：`list_notes` 增加 `group` 参数（`"none"` 表示未分组）；`read_note` 返回体加一行 `组：X`（无组则不显示）；`propose_plan` 的 tool spec 描述里补 `group` 字段说明。
- `AGENT_SYSTEM_PROMPT` 加一句：只有在用户明确说了科目/组时才写 `group`，否则不写。

- [ ] 测试：`normalizePlan` 非法组名被拒；`executePlan` 带 group 的 create 落盘 frontmatter 有 `group:`；带 group 的 append 保留组；不带 group 的 append 不改已有组；`list_notes({group:"Go 学习"})` 只返回该组。
- [ ] 跑 → 失败。
- [ ] 实现。
- [ ] 跑 `server/tests/agent-plan.test.ts server/tests/agent-exec.test.ts server/tests/agent-tools.test.ts` → 全绿。
- [ ] `git commit -m "feat(agent): 计划与工具支持笔记分组"`

## Task 8：MCP 支持组

**Files:** `dsh-mcp/server.mjs`, `server/tests/mcp.test.ts`（已有则扩）

- `notes_create` 的 inputSchema 增加可选 `group`，透传给 `store.create`。
- `notes_read` 的返回文本里加 `组：X`（有则加）。
- 不改其它工具签名。

- [ ] 测试：MCP `notes_create` 带 group → 文件有 frontmatter 组；`notes_append` 到一篇已有组的笔记后组仍在（这是回归重点）。
- [ ] 跑 → 失败。
- [ ] 实现。
- [ ] 跑 → 全绿。
- [ ] `git commit -m "feat(mcp): notes_create 可指定分组，append 不丢组"`

## Task 9：前端数据层（客户端 + 过滤纯函数）

**Files:** `web/src/groups-api.ts`, `web/src/api.ts`, `web/src/lib/nav.ts`, `web/src/lib/group-filter.ts` + `.test.ts`

```ts
// web/src/groups-api.ts
export type GroupView = { name: string; count: number; empty: boolean };
export function listGroups(): Promise<{ items: GroupView[]; ungrouped: number }>;
export function createGroup(name: string): Promise<{ name: string; created: boolean }>;
export function renameGroup(name: string, next: string): Promise<{ renamed: number; failed: Array<{ id: string; reason: string }> }>;
export function deleteGroup(name: string): Promise<{ ungrouped: number; failed: Array<{ id: string; reason: string }> }>;
export function moveNote(id: string, group: string | null, baseHash?: string): Promise<{ group: string | null; hash: string }>;
export function moveNotes(ids: string[], group: string | null): Promise<{ moved: string[]; failed: Array<{ id: string; reason: string }> }>;
```

- `web/src/api.ts`：`NoteSummary` 加 `group: string | null`；`listNotes(opts)` 增加 `group?: string`（`"none"` 原样传）；新增 `moveNote` 到 `groups-api.ts` 而不是这里（避免与既有 `saveNote` 混淆）。
- `web/src/lib/nav.ts`：`Filter` 增加 `{ kind: "group"; name: string }` 与 `{ kind: "none" }`；`filterLabel` 分别返回组名与「未分组」；`sameFilter` 比较 name。
- `web/src/lib/group-filter.ts`：`function groupOf(note: { group: string | null }): string | null`；`function matchesGroup(note, filter)`（`none` 匹配 group 为空）。前端列表若走服务端过滤则此函数只用于本地兜底/测试。

- [ ] 测试 `web/src/lib/group-filter.test.ts` + `nav` 的 `filterLabel` 用例；`groups-api` 只做类型编译校验（不 mock fetch）。
- [ ] 跑 → 失败。
- [ ] 实现。
- [ ] 跑 → 全绿。
- [ ] `git commit -m "feat(web): 分组 API 客户端与过滤纯函数"`

## Task 10：左栏独立分组区 + 编辑页/新建页组下拉

**Files:** `web/src/components/Sidebar.tsx`, `web/src/components/EditorPane.tsx`, `web/src/components/ComposeView.tsx`, `web/src/App.tsx`, `web/src/styles/app.css`

- **左栏**：在「导航」`<nav>` 之后、标签云之前插入独立 `<section className="sidebar__groups" aria-label="分组">`：
  - 标题行：`分组` + 「＋ 新建」（`window.prompt("分组名")` → `onCreateGroup`）；
  - 折叠按钮（`aria-expanded`，状态存组件内 `useState(true)`）；
  - 列表：每个组一行，`组名` + 计数，`className` 在 `filter.kind === "group" && sameFilter` 时加 `is-active`；行尾两个图标按钮「✎」「✕」（`title` 中文），点击 `stopPropagation`；
  - 末尾固定一行「未分组 (n)」→ `onFilter({ kind: "none" })`；
  - 删除组前 `window.confirm("删除分组「X」？组里的 N 篇笔记会退回未分组，不会被删除。")`。
- **Props**：`groups: GroupView[]`、`ungroupedCount: number`、`onCreateGroup(name)`、`onRenameGroup(from, to)`、`onDeleteGroup(name)`。
- **编辑页**：`EditorPane` 工具栏加 `<select>`（当前组 + 全部组 + 「未分组」），`onChange` → `onMoveToGroup(group)`；组件不自己发请求。
- **新建页**：`ComposeView` 加同样的 `<select>`，末项 value `"__new__"` 时 `prompt` 新建并选中；选中值随 `createNote({ group })` 提交（`POST /api/notes` 也要接受 `group`）。
- **App**：`groups`/`ungroupedCount` state；`refreshSidebar()` 里 `Promise.all` 增加 `groupsApi.listGroups()`；`loadList` 支持 `group`/`none`（`api.listNotes({ group: target.name })` / `{ group: "none" }`）；实现 `handleMoveToGroup(id, group)`（调 `moveNote`，成功后 toast「已移到 X」/「已移出分组」，失败 `toast(errorMessage)` 并 `void loadList(filter)` 回滚界面）；`refreshSidebar` 之后同步刷新 groups。
- **CSS**：`.sidebar__groups` 与既有 `.sidebar__tags` 同构（间距、`is-active` 用既有高亮变量），行尾按钮默认 `opacity: 0`、`:hover` 显示。

- [ ] 手工核对数据结构：`NoteDetail` 增加 `group?: string | null`（`GET /api/notes/:id` 已返回）。
- [ ] `pnpm typecheck` 通过（先写组件骨架再补逻辑也行，但**不许留 TODO**）。
- [ ] `pnpm build` 成功。
- [ ] 真机：重启服务 → 浏览器（用户手动）验证；本地用 curl 复核接口。
- [ ] `git commit -m "feat(web): 左栏独立分组区与笔记移动入口"`

## Task 11：迁移脚本 + 文档 + 全量验证

**Files:** `bin/migrate-groups.mjs`, `README.md`

- 脚本：扫 `data/notes/backend-go/*.md`，对每篇用 `patchFrontmatterGroup(raw, "Go 学习")`；默认 dry-run，打印「将给 N 篇插入 group: Go 学习」+ 文件列表；`--apply` 才写盘并 `upsertGroup(dataDir, "Go 学习")`。
- README 补一节「分组」：左栏新建/改名/删除、编辑页移动、AI 也能指定组、组存在 frontmatter `group:` 里（Obsidian 可见）、迁移脚本用法。
- 全量验证：`node --test --test-isolation=none "server/tests/*.test.ts" "web/src/lib/*.test.ts"`、`pnpm typecheck`、`pnpm build`、重启服务、`GET /api/groups`、真实移动一篇再移回、确认 `updated` 未变。

- [ ] 写脚本 + dry-run 输出贴进交付说明。
- [ ] README 更新。
- [ ] 跑全量测试与构建。
- [ ] `git commit -m "feat(groups): 迁移脚本与文档"`

---

## 执行方式

推荐 **Native**（我在本会话里逐任务实现，最后请一个独立 reviewer 过一遍整条改动）：11 个任务通过 `parse → store → db → api → web` 的接口串成一条链，中间任务单独交给别人反而要反复同步类型签名；而且最后那次独立审查上一轮抓出过 P0，保留那个门禁就够了。
