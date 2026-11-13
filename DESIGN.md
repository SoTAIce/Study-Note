---
version: 1
name: study-notes-apple-inspired
description: 安静的书桌。界面退到背景里，让笔记本身说话。单一的蓝色强调色，系统字体，大量留白，用表面颜色的深浅而不是边框和阴影来分层。灵感来自 Apple 的设计语言（参考 VoltAgent/awesome-design-md 的 apple/DESIGN.md），并按「本地笔记应用」而非「产品宣传页」做了改写。
source: https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/apple/DESIGN.md

colors:
  light:
    canvas: "#ffffff"          # 编辑区、卡片
    parchment: "#f5f5f7"       # 侧栏、底栏、标签条
    sunken: "#ededf0"          # 输入框底、分段控件底
    ink: "#1d1d1f"             # 所有正文
    ink-secondary: "#6e6e73"   # 次要文字
    ink-tertiary: "#86868b"    # 提示、计数、占位
    hairline: "#e5e5ea"
    hairline-strong: "#d2d2d7"
    accent: "#0071e3"          # 唯一的强调色
    accent-pressed: "#0062c4"
    ok: "#248a3d"
    warn: "#b25000"
    danger: "#d70015"
  dark:
    canvas: "#1d1d1f"
    parchment: "#161617"
    raised: "#232325"
    elevated: "#2c2c2e"
    sunken: "#111112"
    ink: "#f5f5f7"
    ink-secondary: "#a1a1a6"
    ink-tertiary: "#6e6e73"
    hairline: "#2f2f32"
    hairline-strong: "#424245"
    accent: "#0a84ff"
    accent-pressed: "#409cff"
    ok: "#30d158"
    warn: "#ff9f0a"
    danger: "#ff453a"

typography:
  family-ui: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei UI', system-ui, sans-serif"
  family-display: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI Variable Display', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', system-ui, sans-serif"
  family-mono: "'SF Mono', 'JetBrains Mono', 'Cascadia Code', Consolas, 'Microsoft YaHei Mono', monospace"
  scale:
    hero:      { size: 40px, weight: 600, lineHeight: 1.1,  tracking: -0.025em }   # 首页大标题
    title:     { size: 28px, weight: 600, lineHeight: 1.2,  tracking: -0.02em }    # 笔记标题
    section:   { size: 21px, weight: 600, lineHeight: 1.25, tracking: -0.01em }   # 面板标题
    reading:   { size: 17px, weight: 400, lineHeight: 1.7,  tracking: -0.01em }   # 预览正文
    body:      { size: 14px, weight: 400, lineHeight: 1.45, tracking: -0.005em }  # 界面默认
    control:   { size: 13px, weight: 400, lineHeight: 1.3 }                        # 列表、按钮
    caption:   { size: 12px, weight: 400, lineHeight: 1.35 }
    fine:      { size: 11px, weight: 400, lineHeight: 1.3 }
  weights: [400, 600, 700]     # 不用 500 / 650 / 800

rounded:
  xs: 5px      # kbd、行内代码
  sm: 6px      # 小按钮、图标按钮
  md: 8px      # 列表行、输入框、普通按钮
  ctl: 11px    # 分段控件、弹出菜单
  lg: 18px     # 卡片、抽屉、对话框
  pill: 999px  # 主要操作、搜索框、标签

spacing: [4, 8, 12, 16, 20, 24, 32, 48, 64]

elevation:
  flat: 无阴影、无边框（侧栏、编辑区、列表）
  hairline: 1px var(--line)（卡片、输入框）
  glass: 半透明底 + backdrop-filter saturate(180%) blur(20px)（粘性顶栏、窄屏顶栏）
  float: 只给浮在内容上的层用（弹出菜单、搜索面板、抽屉、对话框、提示条）

motion:
  press: "transform: scale(0.97)"   # 所有可按的东西
  duration: 150–200ms
  ease: cubic-bezier(0.25, 0.1, 0.25, 1)
---

# Study Notes 设计语言

这份文件说明 Study Notes **应该长什么样**；`AGENTS.md` 说明**怎么做**。改界面之前先读这里。所有颜色、圆角、字体都已经落到 `web/src/styles/global.css` 的 token 里，组件只引用 token，不写死颜色值。

## 一、总体气质

Apple 的网站是「让产品照片说话的博物馆」。笔记应用里的「产品」就是**你写的字**，所以我们取它的这几条精神：

1. **界面退后**：侧栏、工具栏、状态栏都是安静的浅灰（parchment），编辑区是纯白画布。没有渐变，没有装饰性阴影，没有彩色色块。
2. **只有一个强调色**：蓝色 `accent` 用在所有「可以点」的信号上：主要按钮、链接、选中项的图标、光标、焦点环。不引入第二个品牌色；绿 / 橙 / 红只表达状态（成功 / 提醒 / 危险），不做装饰。
3. **用表面分层，不用线和影**：侧栏和编辑区的区分靠 `parchment` 和 `canvas` 的颜色差；卡片只有一条细线。阴影只给真正**浮在内容上**的层（弹出菜单、搜索面板、抽屉、对话框）。
4. **阅读的节奏**：预览正文 17px、行高 1.7；标题用较重的字重（600）加略紧的字距（负 tracking），这是 Apple 标题的标志性观感。
5. **触感**：所有按钮按下时轻微缩小（`scale(0.97)`），这是整套系统唯一的微交互语言。

## 和 Apple 原版的差异（有意为之）

| 原版（宣传网站） | 本项目（每天用的工具） | 原因 |
|---|---|---|
| 正文 17px | 界面 13–14px，**预览正文 17px** | 侧栏、列表要信息密度；阅读区才需要宣传页的节奏 |
| 全宽明暗交替的大色块 | 侧栏 parchment / 编辑区 canvas 两种表面 | 工具界面不需要满屏切换背景 |
| 唯一的阴影只给产品图 | 阴影只给浮层 | 我们没有产品图；浮层需要和下面的内容分开 |
| 主色 `#0066cc` | 浅色 `#0071e3`、深色 `#0a84ff` | 用 Apple 系统界面（macOS / iOS）的蓝，按钮上的白字更清楚；深色模式原文缺失，按 macOS 深色补齐 |
| 只有浅色 | 浅色 + 深色 | 本项目的硬性要求（AGENTS.md 第 8 条） |
| SF Pro 字体 | 系统字体栈 | 不打包字体（离线、无新依赖）；Mac 上就是 SF Pro，Windows 上是 Segoe UI Variable + 微软雅黑 |

## 二、颜色

- **canvas**：编辑区、预览、卡片、输入框。纯白（深色 `#1d1d1f`）。
- **parchment**：侧栏、标签条、编辑器底栏、右栏。`#f5f5f7` 是 Apple 的招牌米白。
- **ink 三级**：正文 `ink`；次要说明 `ink-secondary`；计数、占位、时间 `ink-tertiary`。不要发明第四级灰。
- **accent**：只用于可交互的东西。选中的列表行**不**整块涂蓝，而是浅灰底 + 蓝色图标（和 Finder 侧栏一致）；只有主要按钮和选中的标签是实心蓝。
- **语义色**：`ok` / `warn` / `danger` 只出现在状态（保存成功、冲突、删除）上，用浅底 + 同色字（`rgba(色, 0.1)`），不用实心大色块。
- 对应 token：`--bg`（canvas）、`--bg-side`（parchment）、`--bg-raised`、`--bg-elev`、`--bg-sunken`、`--text` / `--text-dim` / `--text-faint`、`--line` / `--line-strong`、`--accent` / `--accent-strong` / `--accent-soft`、`--ok` / `--warn` / `--danger`。

## 三、字体

- 字体栈见上方 `typography`。Mac 上得到 SF Pro，Windows 上得到 Segoe UI Variable 和微软雅黑，**不额外下载字体**。
- 字重只用 400 / 600 / 700。正文 400，强调和标题 600，首页统计数字 700。
- 14px 以上的标题都略微收紧字距（`-0.01em` 到 `-0.025em`）；12px 以下不收紧。
- 编辑器的 Markdown 源码仍然用等宽字体（表格、代码对齐需要），字号 14.5px、行高 1.75；预览才用 17px 的阅读字体。
- 数字一律 `font-variant-numeric: tabular-nums`。

## 四、形状

| 用途 | 圆角 |
|---|---|
| kbd、行内代码 | 5px |
| 图标按钮、小按钮 | 6px |
| 列表行、输入框、普通按钮 | 8px |
| 分段控件、弹出菜单 | 11px |
| 卡片、抽屉、对话框 | 18px |
| 主要操作按钮、搜索框、标签 | 胶囊（999px） |

不在这几档之间取中间值。

## 五、层次

| 层 | 处理 | 用在 |
|---|---|---|
| 平 | 无阴影无边框 | 侧栏、编辑区、列表行 |
| 细线 | 1px `--line` | 卡片、输入框、分隔 |
| 毛玻璃 | 半透明底 + `backdrop-filter: saturate(180%) blur(20px)` | 窄屏顶栏、粘性小标题 |
| 浮层 | `--shadow-md` / `--shadow-lg` | 弹出菜单、搜索面板、抽屉、对话框、提示条 |

卡片悬停**不**上浮、不加阴影，只把边框换成 `--line-strong`。

## 六、组件

- **主要按钮**（`.btn--primary`、新建笔记）：实心 `accent`、白字、胶囊形、字重 600。一屏最多一个。
- **普通按钮**（`.btn`）：`canvas` 底、1px 细线、8px 圆角、无阴影。
- **图标按钮**（`.icon-btn`）：透明底，悬停浅灰，按下缩小；选中态是蓝色图标 + `accent-soft` 底。
- **搜索框**：胶囊形、`sunken` 底、无边框，左边放大镜。
- **分段控件**：`sunken` 底、11px 圆角；选中段是 `canvas` 底 + 一层极淡的阴影（模仿 macOS 分段控件，是唯一允许在非浮层上用阴影的地方）。
- **侧栏行**（导航、分组、笔记）：8px 圆角；悬停 `--bg-hover`；选中 `--bg-hover-strong` + 蓝色图标 + 字重 600；不加边框和阴影。
- **标签**：胶囊形；默认 `sunken` 底；选中实心蓝。
- **卡片**（首页统计、快捷操作、最近更新）：`canvas` 底、细线、18px 圆角、内边距 16–20px，悬停只换边框色。
- **笔记标签页**：放在 parchment 条上；选中的标签页是 canvas 底的圆角块（8px），不加顶部彩条。
- **提示条 / 冲突条**：语义色的浅底 + 同色图标，8px 圆角。

## 七、动效

- 按下：`transform: scale(0.97)`，120ms。
- 颜色过渡：150ms。
- 抽屉、对话框出现：200ms，`cubic-bezier(0.25, 0.1, 0.25, 1)`。
- 尊重 `prefers-reduced-motion`：此时去掉位移和缩放，只保留颜色变化。

## 八、响应式

- ≥ 1100px：侧栏 + 编辑区 + 右栏。
- 760–1099px：右栏变抽屉。
- < 760px：侧栏变抽屉，顶部出现毛玻璃顶栏；页面不允许横向滚动（E2E 会检查）。
- 触控目标不小于 32px（窄屏不小于 40px）。

## 九、要做 / 不要做

**要做**
- 新颜色先加 token（浅色、深色各一份），再在组件里引用。
- 想强调某个东西时，先试试换表面颜色或字重，再考虑加线或加色。
- 改完在浅色和深色下都截图看一遍。

**不要做**
- 不要渐变（包括文字渐变）。
- 不要给卡片、按钮、列表行加阴影。
- 不要引入第二个强调色，也不要用彩色装饰图标。
- 不要用字重 500 / 650 / 800。
- 不要在代码里写死颜色值（`#xxxxxx`），全部走 token。
