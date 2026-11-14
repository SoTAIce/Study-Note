/**
 * 读屏播报 AI 回复（a11y-001）。
 * 流式输出时不能把整块区域设成 aria-live：每来一小段读屏就重读一遍。
 * 改成单独的播报区：开始时说一句「正在生成」，结束时把完整回复读一次（太长截断）。
 */
export const ANNOUNCE_MAX = 600;

export function aiAnnouncement(state: { busy: boolean; text: string; error?: string | null }): string {
  if (state.error) return `AI 出错：${state.error}`;
  if (state.busy) return "AI 正在生成回复…";
  const text = state.text.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return `AI 回复完成：${text.length > ANNOUNCE_MAX ? `${text.slice(0, ANNOUNCE_MAX)}…（内容较长，其余请在页面上阅读）` : text}`;
}
