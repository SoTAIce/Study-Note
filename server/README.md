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
| `store.ts` | 笔记读写、原子写、冲突检测（baseHash）、回收站（清空 `emptyTrash`、超过 30 天自动清理 `purgeTrash`）、历史版本 | 所有写入都带 baseHash；整理动作（setGroup）不改 updated、不写历史 |
| `history.ts` | 历史版本命名 / 解析 / 分层稀疏（纯函数） | 设计：`docs/superpowers/specs/2026-11-12-note-history-design.md` |
| `parse.ts` | frontmatter 解析与序列化、标签/双链提取 | 与前端 `web/src/lib/markdown.ts` 的标签规则保持一致 |
| `indexer.ts` / `db.ts` / `search.ts` / `index-diff.ts` | SQLite 索引、FTS5 trigram 全文检索；`indexFile` 返回索引前后对比（保存接口据此告诉前端要不要刷新左栏 / 反链） | 索引是派生数据：schema 变了就重建，不做迁移。`notes_fts.note_id` 是 UNINDEXED 列，按它查 / 删会扫整张全文表——要定位单行用 rowid（全文行的 rowid 与 notes 行对齐，SCHEMA_VERSION 4 起）；`reindexAll` 跳过内容 hash 没变的文件，左栏「重建索引」传 force 全量重写。搜索改动后跑 `pnpm bench:search`，索引改动后跑 `pnpm bench:index` |
| `export.ts` | 导出 PDF：自包含 HTML（复用前端 `renderMarkdown` 和样式；本地图片用 `inlineImages` 嵌成 data:，总量 50MB）、找 Edge / Chrome、经调试管道 `Page.printToPDF` | 不加依赖；HTML 禁止脚本；浏览器参数全由服务端拼，不含用户输入 |
| `groups.ts` / `groups-api.ts` / `migrate-groups.ts` | 分组（frontmatter 的 `group:`）；`父分组/子项目` 两层，父分组筛选 / 改名 / 删除连带子项目（`groupFilterSql`、`isInGroup`） | 设计：`docs/superpowers/specs/2026-11-02-note-groups-design.md`、子项目见 `2026-11-18-project-book-view-design.md` |
| `ai.ts` / `agent*.ts` / `providers/` | 右栏 AI 动作、AI 对话代理（计划 → 人审批 → 执行 → 可撤销） | 改笔记必须走计划审批；执行前快照到 `.history/batches/` |
| `backup.ts` / `webdav.ts` | WebDAV 单向备份与快照恢复；图片附件按二进制只传 `latest/`，不进每日快照 / 月度归档 | 免费额度每 30 分钟 600 次请求 |
| `cards.ts` / `fsrs.ts` / `review.ts` / `review-api.ts` | 知识简卡（srs-001）：从正文解析 `> [!card] 标题` 和 `概念 :: 解释`（索引进 `cards` 表）；FSRS 调度；`data/review/log.jsonl` 只追加的复习日志（打分 / 撤回 / 别名），启动重放算状态；卡片墙、今日队列、打分接口 | 复习状态只在日志里，SQLite 只放可重建的卡片；卡片 id 不写进笔记，改标题靠别名接上记录 |
| `attachments.ts` | 图片附件：按文件头认类型（PNG / JPEG / GIF / WebP）、起名（带内容指纹，去重）、原子写到 `attachments/`；读文件接口的白名单 | 不收 SVG；读文件只限库内图片、隐藏目录不给，越界一律 404 |
| `config.ts` / `net.ts` / `sse.ts` | 配置读写、网络错误翻译、SSE | |
| `events.ts` | 笔记变化推送（`GET /api/events`）的合并：300ms 一批、同一路径留最后一次、超过 100 条改发 resync | 事件由 `Indexer.onChange` 发出（外部编辑和应用自己的写入都走这里），只说哪篇变了，不带正文 |

## 测试

`tests/*.test.ts`，`pnpm test` 一起跑（node:test）。每个模块的测试文件同名。接口测试在 `tests/api.test.ts` 起真 HTTP 服务。
