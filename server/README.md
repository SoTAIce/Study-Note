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
| `store.ts` | 笔记读写、原子写、冲突检测（baseHash）、回收站、历史版本 | 所有写入都带 baseHash；整理动作（setGroup）不改 updated、不写历史 |
| `history.ts` | 历史版本命名 / 解析 / 分层稀疏（纯函数） | 设计：`docs/superpowers/specs/2026-11-12-note-history-design.md` |
| `parse.ts` | frontmatter 解析与序列化、标签/双链提取 | 与前端 `web/src/lib/markdown.ts` 的标签规则保持一致 |
| `indexer.ts` / `db.ts` / `search.ts` | SQLite 索引、FTS5 trigram 全文检索 | 索引是派生数据：schema 变了就重建，不做迁移 |
| `groups.ts` / `groups-api.ts` / `migrate-groups.ts` | 分组（frontmatter 的 `group:`） | 设计：`docs/superpowers/specs/2026-11-02-note-groups-design.md` |
| `ai.ts` / `agent*.ts` / `providers/` | 右栏 AI 动作、AI 对话代理（计划 → 人审批 → 执行 → 可撤销） | 改笔记必须走计划审批；执行前快照到 `.history/batches/` |
| `backup.ts` / `webdav.ts` | WebDAV 单向备份与快照恢复 | 免费额度每 30 分钟 600 次请求 |
| `config.ts` / `net.ts` / `sse.ts` | 配置读写、网络错误翻译、SSE | |
| `events.ts` | 笔记变化推送（`GET /api/events`）的合并：300ms 一批、同一路径留最后一次、超过 100 条改发 resync | 事件由 `Indexer.onChange` 发出（外部编辑和应用自己的写入都走这里），只说哪篇变了，不带正文 |

## 测试

`tests/*.test.ts`，`pnpm test` 一起跑（node:test）。每个模块的测试文件同名。接口测试在 `tests/api.test.ts` 起真 HTTP 服务。
