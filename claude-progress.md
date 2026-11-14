# 进度日志

<!-- 文件名沿用课程约定（claude-progress.md），任何编码代理都可使用：开工时读，收工前更新。 -->

## 当前已验证状态

- 仓库根目录：`Study-Note/`
- 标准启动 / 验证：`./init.sh`（依赖 → typecheck → test → build → e2e）
- 最近一次全绿：2026-11-14，417 个单元/接口测试 + E2E 21 步（本机）
- 优先级最高的未完成功能：`media-001`（编辑器第二批已完成；media-001 改动较大，先写方案）
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

### 会话 011 · 2026-11-14 · 导出手机可读 PDF（export-001）

- 用户要求：继续下一步；以后不做「故意改坏」的变异检查（已写进 AGENTS.md 工作规则）。
- 完成：`server/export.ts`（自包含导出 HTML、找浏览器、经调试管道打印）；`POST /api/export/pdf`（下载）与 `POST /api/export/html`（打印兜底）；前端 `ExportDialog`（手机阅读 / A4、深色、标题信息，记住选择），编辑器工具栏和阅览模式各有入口，导出前先保存，找不到浏览器时改用打印对话框。
- 实现偏差：`--print-to-pdf` 配独立用户目录会挂住，改用 `--remote-debugging-pipe`（方案第十一节）。
- 验证：./init.sh 全绿（373 + E2E 16 步）；演示笔记导出后转图人工检查。
- 风险：只在 Linux 的 Chromium 上实测过，Windows 上的 Edge 需要在用户电脑上验一次（`docs/验收清单.md` 可加一条）；宽到放不下的表格只做了折行和缩小字号。
- 下一步：ci-001。

### 会话 012 · 2026-11-14 · GitHub Actions 持续集成（ci-001）

- 用户决定：Linux、Windows 都跑。
- 完成：`.github/workflows/ci.yml`（推送和 PR 时两个系统各跑一遍 ./init.sh，上传截图和导出的 PDF）；Windows 上导出 PDF 用系统浏览器（`E2E_PDF_BROWSER=system`）；`.gitattributes` 让 shell 脚本固定 LF。
- 支撑性修复（CI 暴露的真实问题）：
  1. Windows：路径里有 8.3 短名（如 `RUNNER~1`）时，在还不存在的子目录（`inbox/` 等）新建笔记被误报「路径越界（链接）」，15 个测试失败。`server/store.ts` 的 `realPathOf` 改为解析最近的已存在上级再拼回；`store.test.ts` 加了用目录链接模拟的回归测试。
  2. GitHub 的 Ubuntu 不允许普通用户建 Chromium 沙箱，导出 PDF 失败：加 `STUDY_PDF_NO_SANDBOX=1`，只在 CI 的 Linux 上设置。
  3. Windows 上 npm 全局目录不在 Node 查找路径里：CI 把 Playwright 装进固定目录再用 NODE_PATH 指过去；E2E 找不到 Playwright 时报出具体原因。
- 验证：Actions 第 4 次运行两边 success（374 + E2E 16 步）；本机 ./init.sh 全绿。
- 风险：日志没记录 Windows 上导出用的是哪个浏览器（按查找顺序应是 Edge）；「Edge 正开着时导出」仍要在用户电脑上验。
- 下一步：trash-001。

### 会话 013 · 2026-11-14 · 回收站清空与自动清理（trash-001）

- 完成：`store.emptyTrash()`（只删回收站顶层文件，不进子目录）、`store.purgeTrash(30)`（按说明文件的 deletedAt；没说明文件按修改时间；时间读不懂的保留）；`DELETE /api/trash` 清空；`GET /api/trash` 先清过期再列，并返回 `retentionDays`；`server/main.ts` 启动时清一次、之后每 6 小时一次。回收站页：「清空回收站」按钮 + 红色确认条（写明篇数、取消 / 永久删除），每条显示「N 天后自动清理」（`web/src/lib/trash.ts`）。
- 验证：store 测试 4 条、api 测试 1 条、trash.test.ts 3 条；E2E 新增回收站一步（过期条目被清、取消不删、确认后清空、目录为空）；./init.sh 382 + E2E 17 步全绿。GitHub Actions 运行 43564411517 两个系统都 success。
- 风险：清空不可撤销，只靠二次确认把关；自动清理在服务没运行时不会发生（下次启动补上）。
- 下一步：editor-001。

### 会话 014 · 2026-11-14 · 在分组里新建自动带上分组（group-001）

- 用户提出：选中某个分组时新建笔记，自动放进这个分组，但要能改（防误选）。
- 完成：`openCompose` 记下当前分组（`composeGroupRef`），`ComposeView` 的 `initialGroup` 预填分组栏，可改可清空；在当前分组里建完仍停在这个分组，其他情况照旧回到全部笔记。Ctrl+N 走同一条路。
- 验证：E2E 新增一步（预填、保存到该组、改组、全部笔记下为空）；./init.sh 382 + E2E 18 步全绿。
- 下一步：editor-001。

### 会话 015 · 2026-11-14 · 编辑器基础能力（editor-001）

- 完成：`web/src/lib/edit-ops.ts`（纯函数：indent / continueList / toggleWrap / makeLink）；`EditorPane` 的正文框接管 Tab、Shift+Tab、回车、Ctrl+B / I / K，用 `execCommand("insertText")` 应用以保留 Ctrl+Z；输入法组字（isComposing / 229）时不拦截。
- 决定：Ctrl+K 只在选中文字时变链接，没选中仍是搜索；有序列表的子项缩 3 格（marked 要求对齐内容列）；选区两头空白挪到标记外（Windows 双击选词带空格）。
- 验证：edit-ops.test.ts 16 条；E2E 新增一步（真实键盘输入，含 Ctrl+Z 撤回加粗）；./init.sh 398 + E2E 19 步全绿。
- 风险：execCommand 已被标为过时，但 Chromium / Edge / Firefox 仍支持；不支持时退回 setRangeText（这种情况下 Ctrl+Z 不保证）。
- 下一步：editor-002（AI 插入 / 替换可 Ctrl+Z 撤销，可复用这次的 applyEdit）。

### 会话 016 · 2026-11-14 · AI 改动可 Ctrl+Z 撤回（editor-002）

- 完成：把 editor-001 的应用函数抽成 `web/src/lib/textarea-edit.ts` 的 `applyEditUndoable`（先确认焦点真在正文框上再 insertText，防止把文字插进别的输入框；不支持时用 setRangeText + input 事件）。`App.tsx` 新增 `setBodyFromAi`：AI 插入、整篇替换、「撤销 AI 改写」都走它，走不了撤销栈（正文框隐藏）时退回直接改状态；两条路都按 AI 改动快速保存。整篇替换保留滚动位置。
- 验证：E2E 新增一步（假的 AI 接口；插入 → Ctrl+Z；整篇替换 → Ctrl+Z → Ctrl+Shift+Z 重做 → Ctrl+Z → Ctrl+S 落盘）；./init.sh 398 + E2E 20 步全绿。
- 风险：只看预览模式下 AI 改动不进撤销栈，只能用「撤销 AI 改写」按钮。
- 下一步：editor-003（输入 [[ 补全标题）。

### 会话 017 · 2026-11-14 · 编辑器第二批（editor-003 ~ 008、perf-002）

- 用户决定：编辑器的小项合成一批做完，不再逐项确认；media-001 另写方案。新增 editor-005 ~ 008（我梳理时提出、用户同意）。
- 完成：
  - editor-008 回车保持缩进（代码块里只保持缩进、不续列表 / 引用）；editor-007 选中文字粘贴网址变链接（`edit-ops.ts`）。
  - editor-006 预览里任务框可点：`renderMarkdown` 给任务框固定类名，`interactiveTasks` 时不禁用；`toggleTask` 按预览顺序改第 N 个框（跳过代码块，和 marked 的判定对齐：框后要有文字）。
  - editor-005 切换笔记记住光标 / 选区 / 滚动（`App.tsx` 的 `viewStateRef` + 换篇时的 layout effect）。
  - perf-002 预览防抖：`preview-delay.ts`（8 千字内立即、4 万字内 150ms、以上 400ms）；只写模式不渲染新预览；换篇立即显示新内容。
  - editor-003 `[[` 补全：`wikilink-complete.ts`（识别 / 排序 / 补全）+ `caret-coords.ts`（影子 div 量光标位置）；标题列表按需拉取、15 秒缓存；↑↓ 回车 / Tab Esc，鼠标可点；输入法组字时不拦截。
  - editor-004 分栏同步滚动：`renderMarkdown(sourceLines)` 给顶层块加 data-line；编辑区用影子 div 一次量出各块顶端；`scroll-sync.ts` 的 `mapScroll` 在锚点之间按比例换算。只同步编辑区 → 预览一个方向。
- 验证：新增单测 19 条；E2E 新增「编辑器第二批」一步；./init.sh 417 + E2E 21 步全绿。
- 中途问题：E2E 里两处是测试自己写错（在行首打字破坏了 ## 标题；分栏里长行会折行，不能按行高换算），已改测试，实现没动。
- 风险：同步滚动只按顶层块对齐，很长的列表 / 代码块内部按比例估算；预览里点任务框不进 Ctrl+Z 撤销栈（再点一次即可还原）。
- 下一步：media-001（图片粘贴与附件，要加上传接口，先写方案）。
