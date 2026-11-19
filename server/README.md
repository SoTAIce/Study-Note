# server/ 模块地图

Node 24 直接运行 `.ts` 源码（类型擦除），零运行时框架。入口 `main.ts`：建 `NoteStore` → 建索引 → 监听文件变化 → 起 HTTP（只听 127.0.0.1）。

## 数据流

```
data/notes/*.md  ──(唯一真源)──►  store.ts  ──►  indexer.ts ──► data/index.db（SQLite，可随时重建）
        ▲                             │
        └── 外部编辑器改动 ── fs.watch ┘          api.ts 读索引列表/搜索，读写笔记一律经 store.ts
```

## 文件职责

| 文件 | 职责 | 改它时要注意 |
|---|---|---|
| `app.ts` | HTTP 闸门（Host / Origin / Content-Type 校验）、静态文件 | 安全闸门有测试 `tests/guard.test.ts`，不要放宽 |
| `api.ts` | 全部 `/api/*` 路由 | 写笔记前 `indexer.ignoreNext()`，写完 `indexer.indexFile()` |
| `store.ts` | 笔记读写、原子写、冲突检测（baseHash）、回收站（清空 `emptyTrash`、超过 30 天自动清理 `purgeTrash`）、历史版本 | 所有写入都带 baseHash；整理动作（setGroup / setTemplate）不改 updated、不写历史；改已有笔记（save、恢复历史、从备份恢复）用 `parse.ts` 的 `rewriteFrontmatter` 只改变了的文件头键，应用不认识的键、块状 tags、顺序、换行风格原样保留（data-001），不要再用 `serializeNote` 整块重写已有文件 |
| `history.ts` | 历史版本命名 / 解析 / 分层稀疏（纯函数） | 设计：`docs/superpowers/specs/2026-11-12-note-history-design.md` |
| `parse.ts` | frontmatter 解析与序列化、标签/双链提取；只改文件头一行的 `patchFrontmatterGroup` / `patchFrontmatterTemplate`；`stripHtmlComments`（去 `<!-- -->`，代码里的不动、行号不变）；`rewriteFrontmatter` 保存时只改变了的键；文件头按顶格键分组读（块状列表 `tags:\n  - a` 认得出，缩进的嵌套键不顶替外层） | 与前端 `web/src/lib/markdown.ts` 的标签规则保持一致 |
| `indexer.ts` / `db.ts` / `search.ts` / `index-diff.ts` | SQLite 索引、FTS5 trigram 全文检索；`indexFile` 返回索引前后对比（保存接口据此告诉前端要不要刷新左栏 / 反链） | 索引是派生数据：schema 变了就重建，不做迁移。`notes_fts.note_id` 是 UNINDEXED 列，按它查 / 删会扫整张全文表——要定位单行用 rowid（全文行的 rowid 与 notes 行对齐，SCHEMA_VERSION 4 起）；`reindexAll` 跳过内容 hash 没变的文件，左栏「重建索引」传 force 全量重写。搜索改动后跑 `pnpm bench:search`，索引改动后跑 `pnpm bench:index` |
| `export.ts` | 导出 PDF：自包含 HTML（复用前端 `renderMarkdown` 和样式；本地图片用 `inlineImages` 嵌成 data:，总量 50MB）、找 Edge / Chrome、经调试管道 `Page.printToPDF`；整本导出（book-003）`buildBookExportHtml`：封面 + 目录页、每章新起一页、章内标题降一级让书签成「章 → 小标题」、书内双链变文档内跳转（`/api/export/book/{pdf,html}`） | 不加依赖；HTML 禁止脚本；浏览器参数全由服务端拼，不含用户输入 |
| `groups.ts` / `groups-api.ts` / `migrate-groups.ts` | 分组（frontmatter 的 `group:`）；`父分组/子项目` 两层，父分组筛选 / 改名 / 删除连带子项目（`groupFilterSql`、`isInGroup`） | 设计：`docs/superpowers/specs/2026-11-02-note-groups-design.md`、子项目见 `2026-11-18-project-book-view-design.md` |
| `ai.ts` / `agent*.ts` / `providers/` | 右栏 AI 动作、AI 对话代理（计划 → 人审批 → 执行 → 可撤销） | 改笔记必须走计划审批；执行前快照到 `.history/batches/` |
| `backup.ts` / `webdav.ts` | WebDAV 单向备份与快照恢复；图片附件按二进制只传 `latest/`，不进每日快照 / 月度归档；复习日志（`_review/`）和模板（`_templates/templates.json`）跟着笔记备份，不出现在「从快照恢复笔记」里 | 免费额度每 30 分钟 600 次请求 |
| `book.ts` | 连读（book-001）：`GET /api/book?group=` 按组里 `type: index` 目录笔记的 [[链接]] 顺序组装整本（外来章、缺章、未排入目录）；`POST /api/book/index` 生成目录 / 追加章节（带 baseHash）；`POST /api/book/chapters` 在某章之后新建一章（book-002，`insertIndexLinkAfter` 沿用那一行的列表样式）；`createBookService` 供整本导出复用 | 正文从 store 读，数据库只用来找有哪些笔记；设计：`2026-11-18-project-book-view-design.md` |
| `templates.ts` | 笔记模板（tpl-001）：`data/templates.json` 读写（没有文件 = 内置两种，第一次修改才写盘；写坏了报 500 不悄悄覆盖）、`version` 防两个标签页互相覆盖、子项目默认模板（`groupDefaults`，分组改名 / 删除时 `renameGroupDefaults` / `removeGroupDefaults` 跟着变）、模板改名连带改笔记文件头（`store.setTemplate`，只改 `template:` 一行）；`resolveNewNoteTemplate` 决定新建笔记 / 章节用哪个模板。校验、骨架、提示词是纯函数，在 `web/src/lib/templates.ts` 前后端共用 | 笔记文件头 `template:` 是唯一记录，索引 `notes.template` 列可重建；HTML 注释（小节提示）不进摘要、全文索引、简卡解析（`parse.ts` 的 `stripHtmlComments`）；设计：`2026-11-18-note-templates-design.md` |
| `arrange.ts` | 按模板规整（tpl-002）：`POST /api/ai/arrange` 的实现，切块 → 请应用内 AI 只回分配方案（JSON）→ 校验 → 逐字拼好正文，返回给前端预览。切块、校验、拼接是纯函数，在 `web/src/lib/arrange.ts` 前后端共用 | **不写盘**：应用由前端走 AI 整篇替换（历史版本、可撤销）；模型只能回编号，正文每个字来自原文 |
| `template-gen.ts` | AI 生成模板（tpl-003）：`POST /api/ai/template`，三种请求（选 1～5 篇笔记归纳 / 一句话描述 / 按小节改写专属提示词），读笔记时去掉文件头和提示注释、按上限截断，请应用内 AI 只回 JSON，校验后返回。截断、消息、解析与校验是纯函数，在 `web/src/lib/template-gen.ts` | **不写盘**：模板由面板预览、人确认后加入列表，点「保存」才写进 `templates.json` |
| `cards.ts` / `fsrs.ts` / `review.ts` / `review-api.ts` | 知识简卡（srs-001）：从正文解析 `> [!card] 标题` 和 `概念 :: 解释`（索引进 `cards` 表）；FSRS 调度；`data/review/log.jsonl` 只追加的复习日志（打分 / 撤回 / 别名），启动重放算状态；卡片墙、今日队列、打分接口 | 复习状态只在日志里，SQLite 只放可重建的卡片；卡片 id 不写进笔记，改标题靠别名接上记录 |
| `attachments.ts` | 图片附件：按文件头认类型（PNG / JPEG / GIF / WebP）、起名（带内容指纹，去重）、原子写到 `attachments/`；读文件接口的白名单 | 不收 SVG；读文件只限库内图片、隐藏目录不给，越界一律 404 |
| `app-stamp.ts` | 代码指纹（repo-003）：`appStamp` 对 server/、web/、构建配置和依赖清单（不含测试和文档）做内容哈希，服务启动时算一次放进 `/api/health` 和推送通道的 hello；`depsStamp` 只看依赖清单；`preparePlan` 决定要不要重装依赖 / 重建前端。`scripts/prestart.ts`（`bin/start.ps1` 调用）照它安装 / 构建并写 `node_modules/.study-deps-stamp`、`dist/.study-build-stamp` | 只用 Node 内置模块（依赖没装时也要能跑）；Windows 上的完整流程由 CI 跑 `scripts/test-start.ps1` 验证 |
| `config.ts` / `net.ts` / `sse.ts` | 配置读写、网络错误翻译、SSE | |
| `events.ts` | 笔记变化推送（`GET /api/events`）的合并：300ms 一批、同一路径留最后一次、超过 100 条改发 resync | 事件由 `Indexer.onChange` 发出（外部编辑和应用自己的写入都走这里），只说哪篇变了，不带正文 |

## 测试

`tests/*.test.ts`，`pnpm test` 一起跑（node:test）。每个模块的测试文件同名。接口测试在 `tests/api.test.ts` 起真 HTTP 服务。
