# 进度日志

<!-- 文件名沿用课程约定（claude-progress.md），任何编码代理都可使用：开工时读，收工前更新。 -->

## 当前已验证状态

- 仓库根目录：`Study-Note/`
- 标准启动 / 验证：`./init.sh`（依赖 → typecheck → test → build → e2e）
- 最近一次全绿：2026-11-14，364 个单元/接口测试 + E2E 15 步
- 优先级最高的未完成功能：`export-001`（reading-001 已完成；ci-001 同优先级，用户先要阅览 + PDF）
- 当前阻塞：无

## 会话记录

### 会话 001 · 2026-11-12 · 界面重建与问题排查

- 目标：重做前端界面；排查现有问题。
- 完成：双主题 + 图标 + 全部主要界面重做 + 窄屏抽屉（ui-001）；修复双链二次转义、最近更新排序、Windows 路径越界、非法 URL 编码 500（fix-001）。
- 验证：pnpm typecheck / test（294）/ build；Playwright 截图核对浅色、深色、手机。
- 提交：24e2793
- 遗留：mcp.patch.yml 含本机路径（repo-001）；默认 Node 22 跑不了测试（已由 init.sh 处理，repo-002）。

### 会话 002 · 2026-11-12 · 可优化项梳理

- 目标：整理全部可优化点。
- 完成：23 条优化项，现已全部录入 `feature_list.json`。
- 验证：无代码改动。

### 会话 003 · 2026-11-12 · 历史版本

- 目标：hist-001。
- 完成：设计方案（用户批准，采用默认值）→ 实现：合并存档、分层稀疏、列表/读取/恢复接口、历史抽屉（对比、预览、恢复、撤销恢复）。
- 验证：pnpm test 315/315；Playwright 走完编辑 → 历史 → 恢复 → 撤销恢复（当时脚本在临时目录，未入库）。
- 提交：15802a5（方案）、ca85184（实现）
- 遗留：旧历史只在下次保存时整理；Firefox 的 Ctrl+Shift+H 被浏览器占用（hist-002）。

### 会话 004 · 2026-11-13 · 建立 harness（项目管理框架）

- 目标：按 Learn Harness Engineering 课程管理项目（harness-001）。只做初始化，不写业务功能。
- 完成：`AGENTS.md`（入口，路由式）+ `CLAUDE.md`（导入 AGENTS.md）、`feature_list.json`（28 条，4 条已通过）、本日志、`init.sh`、`session-handoff.md`、`docs/harness/`（收工清单、验收评分、质量等级）、`server/README.md` 与 `web/README.md` 模块地图；把浏览器测试正式入库为 `scripts/e2e.mjs`（`pnpm e2e`）。
- 验证：`./init.sh` 在默认 Node 22 环境下自动切到 Node 24 并全绿（typecheck、315 测试、build、E2E 8/8）；变异检查：故意改坏 E2E 断言，退出码 1；恢复后 0。
- 证据：E2E 截图在 `e2e-artifacts/`（不入库，每次重新生成）。
- 遗留风险：init.sh 是 bash，Windows 本机需用 Git Bash 运行（或 `SKIP_E2E=1`）；E2E 依赖全局 Playwright。
- 下一步：sync-001（外部编辑后界面自动同步），先写设计方案。

### 会话 005 · 2026-11-13 · sync-001 设计方案

- 目标：sync-001 先出设计方案。
- 完成：`docs/superpowers/specs/2026-11-13-external-edit-sync-design.md`（SSE 推送 + 索引层统一发事件 + 前端按 hash 比对决定重载 / 冲突 / 删除提示）；sync-001 标为 in_progress。
- 验证：仅文档改动，未改代码。
- 下一步：用户批准方案（或调整第八节的默认值）后按方案实现。

### 会话 006 · 2026-11-13 · Apple 风格 DESIGN.md 与界面改造

- 目标：用户插入的需求：参考 VoltAgent/awesome-design-md 的 Apple 设计语言，生成项目的 DESIGN.md 并改造前端（ui-003）。sync-001 暂停，方案保留。
- 完成：根目录 `DESIGN.md`（按笔记应用改写，并列出和原版的差异）；`global.css` token 全换（系统蓝、parchment / canvas、三级灰、圆角档位、系统字体栈、浮层专用阴影）；`app.css` 去掉渐变和非浮层阴影、主按钮 / 搜索框 / 标签改胶囊、按下缩小、侧栏选中改浅灰底 + 蓝图标、预览正文 17px、标签页改圆角块、窄屏顶栏毛玻璃、减少动态效果时关动画；favicon / theme-color 同步；新增 `design-rules.test.ts`。
- 验证：./init.sh 全绿（319 + E2E 8 步）；设计规则测试做了变异检查；Playwright 截图核对浅色 / 深色 / 手机。
- 支撑性修复：E2E 首步在数据加载前读统计数字，约一半概率失败，改为先等最近更新卡片出现再读（断言不变）。由此发现的「加载中显示 0」记为 ui-004。
- 遗留：AI 面板、弹窗等旧组件只随 token 变化，没有逐个精修（归入 style-001）。
- 下一步：sync-001 等用户批准方案。

### 会话 007 · 2026-11-13 · 细节精修（style-001）与首页加载占位（ui-004）

- 目标：用户要求先做细节调整和顺手的小问题，再商量同步功能。按一次一个的顺序：先 ui-004，再 style-001。
- ui-004：首页统计在数据到达前显示「—」，也不再闪现「还没有笔记」；E2E 新增一步（扣住时间流接口再断言），做了变异检查。
- style-001：删除 9 条无用样式，修正 `.ai-settings` → `.settings` 的改名遗留；表单控件外观统一；回收站、备份面板标签、新建页、AI 对话精修；把「无用类名」检查做成测试。
- 验证：./init.sh 全绿（320 + E2E 9 步）；两套主题截图核对 8 个界面。
- 遗留：AI 计划卡没截图核对（需要配置 AI）。
- 下一步：和用户商量 sync-001 方案（docs/superpowers/specs/2026-11-13-external-edit-sync-design.md）。

### 会话 008 · 2026-11-13 · 外部编辑同步（sync-001）

- 用户决定：干净时自动载入；外部删除正打开的笔记 → 内容存进回收站；300ms / 100 条按默认；多标签页共用连接先不做、实现时说明（已记为 sync-002）。
- 完成：`server/events.ts`（合并推送）；`Indexer.onChange`（indexFile / removeFile / reindexAll 发事件，重建时只发一次 resync）；`GET /api/events`（SSE）；`POST /api/trash/salvage`（`NoteStore.salvageToTrash`，与 moveToTrash 同格式，内容相同不重复存）；前端 `web/src/lib/live.ts` + App 接线（左栏 / 统计 / 标签页标题防抖刷新；当前这篇按 hash 决定忽略 / 重载 / 冲突 / 进回收站；重载保持光标）。
- 支撑性修复：文件已被外部删除但索引还在时接口回 500 → 改回 404。
- 验证：./init.sh 全绿（347 + E2E 13 步）；两处变异检查（关订阅、脏也重载）都能被测试抓到。
- 已知限制：每个标签页常驻 1 条连接（sync-002）；外部删除的是「另一篇」时，它若开在标签页里不会被标记失效，点开时走现有的「打不开」提示。
- 下一步：perf-001。

### 会话 009 · 2026-11-13 · 保存不再连带刷新（perf-001）

- 用户要求：按 perf-001 做；另外习惯用 Ctrl+S，自动保存间隔不用太短。
- 完成：`server/index-diff.ts` + `Indexer.indexFile` 返回索引前后对比，保存接口多回 `changes` / `excerpt` / `indexTags`；前端 `web/src/lib/save-plan.ts`：只在标题 / 标签 / 类型分组变了时刷新左栏，标题或链接变了时刷新反链，时间线和列表就地更新；推送通道里自己保存的回声直接丢掉。自动保存改为停手 5 秒、连续输入最多 30 秒一次，窗口失焦或页面隐藏立即保存；AI 改写等一次性动作仍 0.8 秒。
- 验证：./init.sh 全绿（358 + E2E 14 步）；四处变异检查都能被测试抓到（见 feature_list 证据）。
- 风险：自动保存间隔变长后，未保存的窗口期最多 30 秒；关页面有 beforeunload 提示、切换笔记会先保存，浏览器崩溃时最多丢这段。
- 下一步：ci-001。

### 会话 010 · 2026-11-14 · 阅览模式（reading-001）

- 用户要求：加导出手机可读 PDF 和本机阅览模式，先写方案。方案 `docs/superpowers/specs/2026-11-14-reading-mode-pdf-export-design.md`，用户回复「可以」，按推荐执行（决定见方案第十节）；多篇合并、自动放进 WebDAV 记为 export-002 / export-003。
- 完成：阅览模式替换原全屏预览：目录（h1–h3，当前小节高亮，点击跳转）、阅读进度条、行宽窄 / 中 / 宽、A− / A+、← / → 切篇（中间列表顺序）、Esc / E 回编辑、每篇位置记在 localStorage、窄屏目录变抽屉。正文排版拆到 `content.css`，阅读排版 `reading.css`（PDF 复用）；`design-rules.test.ts` 改为检查 global.css 以外的全部样式表。
- 验证：./init.sh 全绿（364 + E2E 15 步）；三处变异检查都能抓到。
- 下一步：export-001（导出手机可读 PDF）。
