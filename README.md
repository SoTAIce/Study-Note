# Study Notes

## 项目简介

Study Notes 是一个面向个人学习记录与想法整理的本地笔记应用。笔记以 Markdown 文件作为唯一数据源，SQLite 仅用于全文检索、标签、双链和时间线索引，因此可以随时使用 VS Code、Typora 或 Obsidian 直接查看和编辑原始笔记。

项目提供 React Web 界面、Node.js 本地服务、全局快捷捕获和可选 AI 辅助能力。应用默认只监听 `127.0.0.1`，个人笔记保存在 `data/notes/`，适合在 Windows 个人电脑上本地部署。

### 界面

- 浅色 / 深色两套主题，默认跟随系统；左栏顶部的图标可在「跟随系统 → 浅色 → 深色」之间切换，选择会被记住。
- 编辑区可在「只写 / 分栏 / 只看预览」三种视图间切换（标题右侧的分段按钮），`Ctrl+Shift+F` 进入全屏阅读。
- 窄窗口（≤760px）下左栏收为抽屉，顶部出现操作栏，手机浏览器也能正常使用。

## 部署方式

### 环境要求

- Windows 10/11
- Node.js 24 或更高版本
- pnpm（推荐）或 npm

### 一键部署

```powershell
git clone https://github.com/SoTAIce/Study-Note.git
cd Study-Note
```

双击根目录的 `启动笔记.bat`。首次启动时，脚本会自动安装依赖、构建前端、启动本地服务并打开浏览器；后续启动会直接复用已安装的依赖和构建结果。

默认访问地址：<http://127.0.0.1:7777>

### 手动部署

```powershell
pnpm install
pnpm build
pnpm start
```

如果没有 pnpm，可将以上命令中的 `pnpm` 替换为 `npm`。
