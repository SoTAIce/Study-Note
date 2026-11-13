# web/ 模块地图

React 19 + Vite，无状态管理库。入口 `src/main.tsx` → `src/App.tsx`。

## 结构

| 位置 | 职责 |
|---|---|
| `src/App.tsx` | 全部顶层状态：当前笔记、草稿、自动保存（800ms 防抖 + baseHash 冲突处理）、筛选、弹层开关、快捷键 |
| `src/api.ts` / `groups-api.ts` / `agent-api.ts` | 类型化 API 客户端，字段与 `server/api.ts` 一一对齐 |
| `src/components/` | 视图组件。`Sidebar` 左栏、`EditorPane` 编辑页、`RightRail`+`AiPanel` 右栏、`HistoryPanel` 历史版本、`BackupPanel` 备份、`AiChatPage` AI 对话页、`Icon` 内置图标 |
| `src/lib/` | 纯函数（都有 `*.test.ts`）：markdown 渲染、diff、快捷键、时间、主题偏好 |
| `src/styles/global.css` | 设计 token：浅色 / 深色两套，颜色只用这里的变量（带透明度用 `rgba(var(--accent-rgb), x)`） |
| `src/styles/app.css` | 组件样式，按区块分节 |

## 约定

- 新颜色先加 token，组件里不写十六进制颜色。
- 新图标加到 `components/Icon.tsx` 的 `PATHS`，不引图标库（要离线可用）。
- 窄屏断点 760px：左栏变抽屉。改布局后跑 `pnpm e2e`（含 390px 宽度不溢出检查）。
- 自动保存相关的 ref（`dirtyRef` / `hashRef` / `checkpointRef`）是并发正确性的关键，改动前读 `doSave()` 注释。
