# AGENTS.md

Study Notes：本地个人笔记应用。`data/notes/*.md` 是唯一真源，SQLite 只是可重建的索引；Node 24 后端 + React 前端，只监听 127.0.0.1，主要部署在 Windows 个人电脑。

目标不是多写代码，而是让每个会话结束时，下一个会话不用猜就能接着干。

## 开工流程（每个会话都按顺序做）

1. `pwd` 确认在仓库根目录。
2. 读 `claude-progress.md`：上次验证过的状态、遗留风险、下一步。
3. 读 `feature_list.json`：选**优先级最高的未完成功能**（`in_progress` 优先，其次 `not_started`）。
4. `git log --oneline -5` 看最近提交。
5. 跑 `./init.sh`（依赖 + 类型检查 + 单元测试 + 构建 + E2E）。
6. **基线不绿就先修基线**，不在坏掉的起点上叠新功能。

## 工作规则

- 一次只做一个功能；开工时把它在 `feature_list.json` 里改成 `in_progress`。
- 只在所选功能范围内改动；遇到阻塞只做最小的支撑性修复，并记进进度日志。
- 改动较大的功能先在 `docs/superpowers/specs/` 写设计方案，用户批准后再实现。
- 不为了让测试变绿而删测试、跳过测试、放宽断言；不在实现过程中偷偷改验证规则。
- 不做「故意改坏代码、看测试会不会失败、再改回来」的变异检查（用户 2026-11-14 要求）。测试按行为写清楚断言即可。
- 发现的新问题记进 `feature_list.json`（新条目，`not_started`），不顺手做。
- 结论写进仓库文件，不留在聊天记录里。

## 完成的定义

一个功能只有同时满足以下几条才能标成 `passing`：

- 目标行为已实现，`user_visible_behavior` 里描述的事真的能做到；
- `verification` 里列的检查真的跑过并通过（新行为要有对应的单测 / 接口测试，界面流程要进 `scripts/e2e.mjs`）；
- 证据（命令 + 结果）写进该条目的 `evidence`；
- `./init.sh` 从头跑仍然全绿。

## 收工流程

1. 更新 `claude-progress.md`（本次会话一节 + 顶部「当前已验证状态」）。
2. 更新 `feature_list.json` 的状态与证据。
3. 写下未解决的风险或阻塞；会话较大或中途停下时填 `session-handoff.md`。
4. 对照 `docs/harness/clean-state-checklist.md` 自检。
5. 在安全状态下提交，提交信息说清做了什么。

## 常用命令

| 用途 | 命令 |
|---|---|
| 完整基线验证 | `./init.sh`（没装 Playwright：`SKIP_E2E=1 ./init.sh`，并在日志里注明） |
| 单元 / 接口测试 | `pnpm test` |
| 类型检查 | `pnpm typecheck` |
| 端到端冒烟 | `pnpm build && pnpm e2e`（截图在 `e2e-artifacts/`） |
| 本地运行 | `pnpm start` → http://127.0.0.1:7777（开发：`pnpm dev:server` + `pnpm dev`） |

## 硬性约束

1. Markdown 文件是唯一真源：任何功能都不能只把数据存进 SQLite；索引必须能从 `data/notes` 重建。
2. 写笔记一律经 `server/store.ts`，带 baseHash 做冲突检测，用原子写。
3. 个人数据不进 git：`data/notes/*`、`data/config.json`、`.history`、`.trash`、`chats/` 都已 gitignore，别改。
4. 服务只监听 127.0.0.1；`server/app.ts` 的 Host / Origin / Content-Type 闸门不能放宽。
5. 笔记内容渲染必须转义原始 HTML、过滤危险链接（`web/src/lib/markdown.ts`）。
6. AI 改笔记必须先出计划、人批准后执行，且可撤销。
7. 不引入新的运行时依赖，除非设计方案里说明理由并经用户同意（应用要离线可用）。
8. 界面按 `DESIGN.md`（Apple 风格的设计语言）：颜色只用 `web/src/styles/global.css` 的 token，浅色 / 深色都要能看；`design-rules.test.ts` 会检查写死颜色、渐变和字重。
9. Windows 是主要部署平台：路径处理用 `path`，别假设 `/` 分隔；`.bat` 文件保持纯 ASCII。
10. 提交信息、代码注释里不写模型名称或型号。

## 进一步阅读（按需打开）

- 界面长什么样：`DESIGN.md`（改界面前先读）
- 后端模块地图：`server/README.md`；前端模块地图：`web/README.md`
- 功能清单（唯一的「要做什么」来源）：`feature_list.json`
- 进度日志：`claude-progress.md`；交接：`session-handoff.md`
- 设计方案：`docs/superpowers/specs/`（实现计划在 `docs/superpowers/plans/`）
- 收工自检：`docs/harness/clean-state-checklist.md`；验收评分：`docs/harness/evaluator-rubric.md`
- 各模块质量等级：`docs/harness/quality.md`
- 人工验收清单：`docs/验收清单.md`
