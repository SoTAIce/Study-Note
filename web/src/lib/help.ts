/**
 * 帮助（help-001）的纯数据和纯函数：速查表（快捷键 + 语法）、手册章节的整理。
 * 应用级快捷键那几行带着实际的按键组合（combo）和动作（action），单测拿 keyboard.ts 逐条核对，
 * 改了快捷键忘了改这里，测试会失败。
 */
import type { Action, KeyInput } from "./keyboard.ts";

export type CheatGroup = "全局" | "编辑器" | "阅览模式" | "连读" | "复习" | "语法";

export type CheatRow = {
  group: CheatGroup;
  /** 显示的按键或写法 */
  keys: string;
  /** 作用 */
  does: string;
  /** 补充：在哪里生效、注意什么 */
  note?: string;
  /** 应用级快捷键：对应 keyboard.ts 的动作和按键组合 */
  action?: Action;
  combo?: KeyInput;
};

export const CHEAT_GROUPS: readonly CheatGroup[] = ["全局", "编辑器", "阅览模式", "连读", "复习", "语法"];

export const CHEAT_SHEET: readonly CheatRow[] = [
  // —— 全局（keyboard.ts） ——
  { group: "全局", keys: "Ctrl+K", does: "搜索笔记、找命令", action: "search", combo: { key: "k", ctrlKey: true } },
  { group: "全局", keys: "Ctrl+N", does: "新建笔记", action: "new", combo: { key: "n", ctrlKey: true } },
  { group: "全局", keys: "Ctrl+S", does: "立即保存", note: "平时自动保存，不按也行", action: "save", combo: { key: "s", ctrlKey: true } },
  { group: "全局", keys: "Ctrl+J", does: "打开右栏 AI", action: "ai", combo: { key: "j", ctrlKey: true } },
  { group: "全局", keys: "Ctrl+Shift+Space", does: "快速捕获一个想法，进收件箱", action: "capture", combo: { key: " ", ctrlKey: true, shiftKey: true } },
  { group: "全局", keys: "Ctrl+Shift+F", does: "进入阅览模式", action: "preview", combo: { key: "F", ctrlKey: true, shiftKey: true } },
  { group: "全局", keys: "Ctrl+Shift+H", does: "历史版本", action: "history", combo: { key: "H", ctrlKey: true, shiftKey: true } },
  { group: "全局", keys: "Ctrl+Shift+R", does: "今日复习（知识简卡）", action: "review", combo: { key: "R", ctrlKey: true, shiftKey: true } },
  { group: "全局", keys: "Ctrl+\\", does: "收起 / 展开左栏", action: "sidebar", combo: { key: "\\", ctrlKey: true } },
  { group: "全局", keys: "?", does: "打开这个速查表", note: "不在输入框里时" },
  { group: "全局", keys: "Esc", does: "关掉弹窗 / 退出当前页" },
  { group: "全局", keys: "Mac 上", does: "Ctrl 换成 ⌘" },

  // —— 编辑器 ——
  { group: "编辑器", keys: "Ctrl+B / Ctrl+I", does: "加粗 / 斜体" },
  { group: "编辑器", keys: "Ctrl+K", does: "选中文字后加链接", note: "在正文框里时" },
  { group: "编辑器", keys: "Tab / Shift+Tab", does: "列表缩进 / 取消缩进" },
  { group: "编辑器", keys: "Enter", does: "列表、任务自动续行；空项回车结束列表" },
  { group: "编辑器", keys: "[[", does: "补全双链：输入标题，↑ ↓ 选，Enter 确认" },
  { group: "编辑器", keys: "Ctrl+Z / Ctrl+Shift+Z", does: "撤销 / 重做", note: "AI 改写、插图也能撤" },
  { group: "编辑器", keys: "选中文字后粘贴网址", does: "变成链接" },
  { group: "编辑器", keys: "粘贴 / 拖入图片", does: "存进 attachments/ 并插入" },
  { group: "编辑器", keys: "拖 .md 文件进窗口", does: "导入成新笔记", note: "拖到左栏项目上就导入到那个项目" },
  { group: "编辑器", keys: "Ctrl+Enter", does: "新建页、快速捕获里：创建" },

  // —— 阅览模式 ——
  { group: "阅览模式", keys: "← → / [ ]", does: "上一篇 / 下一篇", note: "分屏时作用于当前栏" },
  { group: "阅览模式", keys: "E", does: "编辑当前栏那篇" },
  { group: "阅览模式", keys: "Esc", does: "回到编辑页" },
  { group: "阅览模式", keys: "Ctrl+点双链", does: "在另一栏打开（分屏）" },
  { group: "阅览模式", keys: "分隔条上 ← →", does: "调两栏比例；双击恢复一半" },

  // —— 连读 ——
  { group: "连读", keys: "[ ]", does: "上一章 / 下一章" },
  { group: "连读", keys: "双击一章", does: "就地编辑这一章" },
  { group: "连读", keys: "Esc / Ctrl+S", does: "编辑一章时：保存并退出编辑" },

  // —— 复习 ——
  { group: "复习", keys: "Space / Enter", does: "翻面" },
  { group: "复习", keys: "1 2 3 4", does: "翻面后打分（按按钮上的顺序）" },
  { group: "复习", keys: "Ctrl+Z", does: "撤回上一次打分" },
  { group: "复习", keys: "Esc", does: "结束复习" },

  // —— 语法 ——
  { group: "语法", keys: "[[标题]]", does: "双链；标题不存在时点它会新建", note: "[[标题|显示的字]] 换显示文字" },
  { group: "语法", keys: "#标签", does: "标签，左栏标签云里能筛选" },
  { group: "语法", keys: "- [ ] 任务", does: "任务框，预览里可以直接勾" },
  { group: "语法", keys: "> [!card] 概念", does: "一张知识简卡，后面的 > 行是要点" },
  { group: "语法", keys: "概念 :: 解释", does: "一行一张简卡（:: 两边要有空格）" },
  { group: "语法", keys: "![[图片.png|300]]", does: "插图，| 后面是宽度（像素）" },
  { group: "语法", keys: "<!-- 提示 -->", does: "模板里的小节提示，编辑时看得到，预览里不显示" },
  { group: "语法", keys: "```语言", does: "代码块" },
];

/** 筛选框：按键、作用、补充、分组里有这个字就留下（不区分大小写，空格隔开的几个词都要有） */
export function filterCheatSheet(rows: readonly CheatRow[], query: string): CheatRow[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((row) => {
    const text = `${row.group} ${row.keys} ${row.does} ${row.note ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** 按 ? 打开速查表：只认单独的 ?（Shift+/），带 Ctrl / Alt / ⌘ 不算；在输入框里不算 */
export function isHelpKey(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }, typing: boolean): boolean {
  return !typing && event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey;
}

// —— 使用手册 ——

export type ManualChapter = { slug: string; title: string; part: string; body: string };

/** 练习笔记放在哪个子项目、目录叫什么 */
export const MANUAL_GROUP = "使用手册/练习";
export const MANUAL_INDEX_TITLE = "使用手册 · 目录";

/** 手册里章与章之间的链接写成 [[手册：标题]]：只读页面里换成面板内跳转，练习笔记里就是普通双链 */
export const MANUAL_TITLE_PREFIX = "手册：";

/** 按部分分组，保持章节顺序 */
export function groupChapters(chapters: readonly ManualChapter[]): Array<{ part: string; chapters: ManualChapter[] }> {
  const out: Array<{ part: string; chapters: ManualChapter[] }> = [];
  for (const chapter of chapters) {
    const last = out[out.length - 1];
    if (last && last.part === chapter.part) last.chapters.push(chapter);
    else out.push({ part: chapter.part, chapters: [chapter] });
  }
  return out;
}

/** 双链目标 → 手册里的哪一章（只认带「手册：」前缀的） */
export function chapterForLink(chapters: readonly ManualChapter[], target: string): ManualChapter | undefined {
  const title = target.trim();
  if (!title.startsWith(MANUAL_TITLE_PREFIX)) return undefined;
  return chapters.find((chapter) => chapter.title === title);
}
