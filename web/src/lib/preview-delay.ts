/**
 * 预览跟着打字刷新要等多久（perf-002）。
 * 实测（本机 Node）：500 行 / 2 万字渲染约 12ms，2000 行约 47ms，5000 行 / 21 万字约 84ms，
 * 还要加上浏览器把 HTML 放进页面的时间。短笔记立刻刷新；长笔记等停手一下再渲染，打字不卡。
 */
export function previewDelay(length: number): number {
  if (length < 8_000) return 0;
  if (length < 40_000) return 150;
  return 400;
}
