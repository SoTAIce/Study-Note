/**
 * 分栏同步滚动（editor-004）：编辑区滚到哪，预览跟到对应位置。
 * 两边各有一组「锚点」：同一个 Markdown 块在编辑区和预览里的顶端位置。
 * 编辑区的滚动位置落在哪两个锚点之间，就按比例换算到预览里同样的两个锚点之间。
 */
export function mapScroll(
  editorTops: number[],
  previewTops: number[],
  scrollTop: number,
  editorMax: number,
  previewMax: number,
): number {
  if (editorMax <= 0) return 0;
  if (scrollTop >= editorMax - 1) return previewMax;
  const anchors: Array<[number, number]> = [[0, 0]];
  const count = Math.min(editorTops.length, previewTops.length);
  for (let i = 0; i < count; i += 1) {
    const [lastE, lastP] = anchors[anchors.length - 1];
    const e = Math.min(editorTops[i], editorMax);
    const p = Math.min(previewTops[i], previewMax);
    // 只要单调递增的锚点：折行测量有误差时宁可跳过
    if (e > lastE && p >= lastP) anchors.push([e, p]);
  }
  const [lastE, lastP] = anchors[anchors.length - 1];
  if (editorMax > lastE) anchors.push([editorMax, Math.max(previewMax, lastP)]);
  for (let i = 1; i < anchors.length; i += 1) {
    const [e0, p0] = anchors[i - 1];
    const [e1, p1] = anchors[i];
    if (scrollTop <= e1) {
      const ratio = e1 === e0 ? 0 : (scrollTop - e0) / (e1 - e0);
      return Math.max(0, Math.min(previewMax, p0 + ratio * (p1 - p0)));
    }
  }
  return previewMax;
}

/** 每行开头的字符位置 */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}
