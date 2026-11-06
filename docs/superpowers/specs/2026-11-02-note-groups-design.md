# 笔记分组（Group）设计

日期：2026-11-02 · 状态：待批准 · 作者：Lead（与用户共同确认）

## 一、意图与为什么

用户按「科目」归档笔记：Agent 学习、Go 学习这种。诉求原话是"为每个笔记分组，最好支持创建后组间移动，**防止我加入失败**"。已确认：**一篇笔记只属于一个组，一个组可以有多篇**（像文件夹，不像标签）。

现状与缺口：

- 笔记是 `data/notes/` 下的 `.md`，`backend-go/` 这类目录**事实上已经在当分组**，但左栏没有分组区；按组列笔记只能靠解析路径。
- frontmatter 只有 `id / title / created / updated / type / tags / source`；索引表 `notes` 无分组列。
- 标签能多归属，但不能折叠收纳、不能"必须选一个"，替代不了科目。

## 二、目标

1. 每篇笔记有且仅有一个组，可为「未分组」。
2. 新建笔记（编辑页新建、快速捕获、AI 计划）时可指定组。
3. 任意笔记能在组间移动，单篇与批量都支持；**失败不产生副作用**。
4. 左栏新增「分组」区：每行显示组名与篇数，点击即过滤列表。
5. 建组 / 改名 / 删组；删组不删笔记（退回未分组）。
6. AI 助手能读组、能在计划里给笔记指定组。

## 三、非目标

- 不做多归属（用户已定）。
- 不把组做成目录（不迁移文件、不改文件名、不动 `[[双链]]`）。
- 不做嵌套组 / 子组。
- 不做拖拽排序与组配色。
- 不改回收站、历史快照、备份的既有语义（组随笔记走）。

## 四、反目标（达到这些就算失败）

- 一篇笔记同时出现在两个组（数据分裂）。
- 移动失败但界面显示成功，或移动后笔记内容/其它 frontmatter 字段受损。
- 改组名之后笔记还挂着旧组名（幽灵组）。
- 因为组不存在而拒绝移动（这是用户最担心的"加入失败"）。

## 五、数据模型（核心决策）

**组归属写在笔记 frontmatter 的 `group` 键里，是唯一真源。**

- `group: Go 学习`；缺省（不写这个键）＝ 未分组。
- `group` 是 `NoteMeta` 的**一等字段**（parse.ts 解析、serializeNote 写出），不是"未知键"：因为 `dsh-mcp` 也会调 `store.save()` 追加正文，若 group 只做行级旁路，MCP 追加一次就会把组归属丢掉。
- 只改这一行元数据，文件不挪窝 → `[[双链]]`、历史快照、回收站、AI 计划路径全部不受影响，这是选 B 方案的核心理由。

**写路径（`store.setGroup`，新方法，不复用 `save()`）**：

`save()` 会 `serializeNote` 重写整块 frontmatter、把 `updated` 改成 now、并写一份 `.history` 快照。移动/改名是**整理动作，不是编辑**，所以 `setGroup` 单独实现：

1. 读磁盘原文，按 `parseFrontmatter` 切成 frontmatter 块 + 正文；
2. 有 frontmatter → 只改/插入 `group:` 一行，其余键与顺序原样保留；没有 frontmatter（现有 8 篇 Go 笔记就属于这种）→ **只在正文前插入最小块** `---\ngroup: X\n---\n\n`，正文一个字节不动；
3. `updated` **不动**，不写历史快照；
4. 写前校验 `baseHash`，原子写入；同组则幂等返回。

**组清单**存 `data/groups.json`：`{ version: 1, groups: [{ name, order }] }`，只负责「显示顺序」和「空组」。

**有效组列表 = union(groups.json 的顺序, 笔记里实际出现的组名)**：

- json 丢了、手改过、或笔记被别人在 Obsidian 里加了新组 → 不会出现"幽灵组"，也不会丢组；
- 空组能被记住；组名以笔记里出现的为准，json 只提供顺序。

**组名规范化**：`trim` → 内部连续空白压成一个空格 → 长度 1..40 → 禁止 `/ \ : * ? " < > |` 与控制字符 → 大小写不敏感归并（`go学习` 与 `Go学习` 同组，显示用先出现的那种写法）。

## 六、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/groups` | `{ items: [{ name, count, order, empty }], ungrouped: n }`（union + 计数，含空组与未分组数） |
| POST | `/api/groups` | `{ name }` 建组；已存在则幂等返回现有（200 而不是冲突） |
| PATCH | `/api/groups/:name` | `{ name: 新名 }` 批量把该组所有笔记改成新名 + 更新 json；逐篇 `setGroup`，遇 hash 冲突则跳过并报告；新名与已有组重名 = 合并 |
| DELETE | `/api/groups/:name` | 组内笔记去掉 `group` 键（回未分组）+ 从 json 删；**不删笔记** |
| POST | `/api/notes/:id/move` | `{ group, baseHash? }` 单篇移动；组不存在则**自动创建**（消灭"加入失败"） |
| POST | `/api/notes/move` | `{ ids: string[], group }` 批量（≤200）：`{ moved: [...], failed: [{id, reason}] }`。**路由必须注册在 `/api/notes/:id` 之前**，否则 `/api/notes/move` 会被当成 id |
| GET | `/api/notes?group=名字` | 列表按组过滤；`group=none` 表示未分组 |

移动实现要点（防失败的关键）：

1. 走 `store.setGroup`：读磁盘当前内容，**只动 `group` 一行**，正文与其它键原样写回——别人刚在编辑器里改的内容不会被覆盖，`updated` 也不会被顶到今天。
2. `baseHash` 给了就先校验；不一致返回 409 + 当前 hash，前端提示「磁盘已变，已刷新」，不写。
3. 组不存在 → 自动建组再移动（不报错）。
4. 目标组与当前相同 → 幂等返回 `ok`，不写文件。
5. 批量：逐篇处理，成功的照做、失败的进 `failed[]`，如实汇报（部分成功）。

## 七、索引

`server/db.ts` 只有一种升级机制：`meta.schema_version` 对不上就 **DROP 全部表再按 SCHEMA 重建**，然后 `main.ts` 启动时 `reindexAll()` 全量重建索引。仓库里没有任何 `ALTER TABLE`。

所以本设计照 codebase 的做法来，**不引入 ALTER**：

- `SCHEMA` 里 `notes` 表直接加一列 `group_name TEXT`，并加索引 `notes_group`；
- `SCHEMA_VERSION` 从 1 提到 2 → 下次启动会整库重建 + 自动 reindex，笔记/标签/链接/全文索引全部由 `.md` 真源重建，无需迁移脚本；
- 代价：`ai_calls`（AI 调用统计）会被清空，目前没有界面在读它，可接受；
- 计数 SQL：`SELECT group_name, COUNT(*) FROM notes GROUP BY group_name`；
- FTS、links、tags 结构不动。

## 八、界面

- 左栏「导航」之下、标签云之上新增**分组区**（可折叠，默认展开）：
  - 每行 `名称 (n)`；点击 = `onFilter({ kind: "group", name })`；行尾悬停出现「改名 / 删除」；
  - 顶部「＋ 新建分组」；末尾固定一行「未分组 (n)」。
- 编辑页工具栏加一个**分组输入框**（自由输入 + `<datalist>` 提示已有分组，失焦/回车提交；成功 toast，失败 toast 带原因并把输入框还原成磁盘上的组名）。
- Compose（新建页）同样用输入框 + `<datalist>`：填一个不存在的组名会由服务端自动建组。
- 捕获弹窗（全局热键）先落「未分组」，可在编辑页再挪——捕获追求快，不打断。

## 九、AI 助手与 MCP（两个写 `.md` 的进程）

**范围包含 `dsh-mcp` 的最小支持**，原因是它 `import { NoteStore }` 直接写同一个笔记库：如果 group 不是一等字段，MCP 的 `notes_append`（读→改正文→`save()`）会把组归属洗掉。

- `propose_plan` 的 op 新增可选 `group`（create / append / rewrite 可用）；spec 里说明「不写就沿用/未分组」。
- `NoteStore.createAt` / `save` 的 patch 支持 `group`（`serializeNote` 已能写出，所以 MCP 路径自动保组）；组名走同一套规范化校验，非法则 `BAD_ARG`。
- `executePlan` 落盘时写 frontmatter；计划卡目前**不显示**组名（只显示路径与增删行数）。
- `list_notes` 工具增加按组过滤的参数，`read_note` 返回体带当前组。
- `dsh-mcp`：`notes_create` 增加可选 `group` 参数，`notes_read` 返回体带 `group`；其余工具不动、不新增工具。

## 十、迁移（现有 8 篇 `backend-go/`）

现有 8 篇**完全没有 frontmatter**（第一行就是 `# 标题`），所以迁移只做一件事：在正文前插入最小块 `---\ngroup: Go 学习\n---\n\n`，**不**补 `id/title/created/updated`，正文一个字不动，`文件路径不变`。

- 提供一次性脚本 `bin/migrate-groups.mjs`：默认 dry-run，打印将要改的文件与插入的行；带 `--apply` 才写盘。
- 同时把这些组名写进 `data/groups.json`（保证顺序与空组记忆）。
- **不自动运行**，必须用户明确同意后再跑。

## 十一、边界与错误

| 情况 | 行为 |
|---|---|
| 移动 / 改名 | **不改 `updated`、不写历史快照**（整理不算编辑；否则批量改名会把真正的版本历史挤掉、笔记全被顶到列表最前） |
| 组名空 / 超长 / 含非法字符 | 400，中文原因，不落盘 |
| 移动时组不存在 | 自动创建组（不报错） |
| 目标组 == 当前组 | 200 幂等，不写文件 |
| 笔记在磁盘上已被改（hash 不符） | 409 + 当前 hash，前端提示刷新后重试 |
| 笔记文件被外部删除 | 404，提示刷新列表 |
| 批量移动部分失败 | 成功的生效，`failed` 里说明原因，UI 如实提示 |
| 改名时某篇笔记正文被改（hash 冲突） | 跳过该篇并报告，其余照改 |

## 十二、测试计划

- `parse`：读写 `group`；未分组时不写该键；组名里的中文/空格/引号转义。
- `store`：移动只改 meta 不改正文；`baseHash` 冲突；同组幂等；非法组名。
- `groups`：union 列表与计数；建组幂等；改名批量 + 冲突跳过；删组退回未分组；组名大小写归并。
- `index/db`：SCHEMA_VERSION 1→2 触发重建后，`group_name` 列存在、按组过滤与计数正确。
- `api`：六条路由的 HTTP 层（含 409/404/400 与自动建组）。
- `agent`：计划 op 带 group 落盘；组名非法在方案阶段被拒。
- `mcp`：`notes_create` 带 group、`notes_append` 不洗掉已有 group。
- `web/lib`：`filterLabel` 支持分组、分组过滤纯函数。
- 回归：现有 199 个测试保持全绿。

## 十三、留给实现者的

- 组名在界面上是否显示颜色/图标（先不做）。
- 分组区默认是否展开（默认展开，可折叠）。
- 批量移动的入口先只做「多选后移动」还是先只做单篇（先单篇 + API 支持批量）。

## 十四、Builder check 落定的三件事（原文档含糊处）

1. **写盘路径**：新增 `store.setGroup`，只改 `group` 一行、不动 `updated`、不写历史；现有 8 篇无 frontmatter 的笔记插入最小块。`save()` 继续负责正文编辑，两者分工明确，不再自相矛盾。
2. **索引升级**：走 codebase 既有的 `SCHEMA_VERSION` 重建机制（1→2），不用 `ALTER TABLE`；`ai_calls` 被清空可接受。
3. **MCP 在范围内**：`group` 必须是一等 frontmatter 字段，MCP 的 `notes_append` 才不会洗掉归属；顺手给 `notes_create` 加可选 `group`、`notes_read` 回显 `group`。组名校验放在 parse/store 层，不是只写在 API 层。

## 实现与设计稿的偏差（2026-11-02 收尾时同步）

- 编辑页/新建页的分组是**输入框 + datalist**，不是下拉：分组是自由文本（随手新建），下拉会挡住「填一个新组名」这条路。
- 计划卡不显示 `→ 组名`：只影响观感，AI 计划里的 group 依旧照常落盘。
- `none` 被列为保留组名（`?group=none` 是「只看未分组」的哨兵）。
- 归组/移动会还原文件 mtime：没有 `updated:` 的老笔记不会因为整理而跳到列表顶部。
