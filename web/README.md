# web/ 模块地图

React 19 + Vite，无状态管理库。入口 `src/main.tsx` → `src/App.tsx`。

## 结构

| 位置 | 职责 |
|---|---|
| `src/App.tsx` | 全部顶层状态：当前笔记、草稿、自动保存（停手 5 秒 / 连续输入最多 30 秒 / 失焦立即存，节奏见 `lib/save-plan.ts`；baseHash 冲突处理）、筛选、弹层开关、快捷键 |
| `src/api.ts` / `groups-api.ts` / `agent-api.ts` | 类型化 API 客户端，字段与 `server/api.ts` 一一对齐 |
| `src/components/` | 视图组件。`Sidebar` 左栏、`EditorPane` 编辑页、`RightRail`+`AiPanel` 右栏、`HistoryPanel` 历史版本、`BackupPanel` 备份、`AiChatPage` AI 对话页、`ReadingMode` 阅览模式、`ExportDialog` 导出 PDF、`Icon` 内置图标 |
| `src/lib/` | 纯函数（都有 `*.test.ts`）：markdown 渲染、diff、快捷键、时间、主题偏好；`live.ts` 外部编辑同步（连接 `/api/events` + 「当前这篇变了怎么办」的决策）；`save-plan.ts` 自动保存节奏、保存后刷新什么、回声过滤；`reading.ts` 阅览模式的目录 / 当前小节 / 上一篇下一篇 / 位置记忆；`export.ts` 导出选项与下载文件名；`trash.ts` 回收站条目还剩几天自动清理；`edit-ops.ts` 正文框的缩进 / 列表续行 / 加粗斜体链接；`image-src.ts` 图片地址换算（相对笔记目录 → 库内路径，`![[图片]]` 的候选位置，前后端共用）；`attachments.ts` 粘贴 / 拖入时挑图片、拼插入文本；`wikilink-complete.ts` 输入 [[ 补全；`scroll-sync.ts` 分栏同步滚动的换算；`preview-delay.ts` 长笔记预览防抖；`caret-coords.ts` 量正文框里字符的位置（DOM，无单测）；`textarea-edit.ts` 把替换用 insertText 应用到正文框（保留浏览器撤销栈，编辑键和 AI 插入 / 整篇替换都走它） |
| `src/styles/global.css` | 设计 token：浅色 / 深色两套，颜色只用这里的变量（带透明度用 `rgba(var(--accent-rgb), x)`） |
| `src/styles/app.css` | 组件样式，按区块分节 |
| `src/styles/content.css` / `reading.css` | 正文排版（预览 / 阅览 / PDF 共用）与阅读排版（字号随容器、代码换行、表格不截断） |

## 约定

- 新颜色先加 token，组件里不写十六进制颜色。
- 视觉规则以仓库根目录的 `DESIGN.md` 为准；`src/lib/design-rules.test.ts` 把其中能机械检查的几条变成了测试。
- 新图标加到 `components/Icon.tsx` 的 `PATHS`，不引图标库（要离线可用）。
- 窄屏断点 760px：左栏变抽屉。改布局后跑 `pnpm e2e`（含 390px 宽度不溢出检查）。
- 自动保存相关的 ref（`dirtyRef` / `hashRef` / `checkpointRef`）是并发正确性的关键，改动前读 `doSave()` 注释。
- 外部编辑同步：收到变化后先等进行中的保存落地，再拉一次磁盘版本比 hash（`checkCurrentNoteExternally`）。规则：一致就忽略；干净就重载；有未保存修改就出冲突；404 隔 1.5 秒复查后把编辑器内容存进回收站再关闭。
