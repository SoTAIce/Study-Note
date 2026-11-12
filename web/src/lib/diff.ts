/**
 * 按行对比（纯函数，给历史版本面板用）。
 * 先剥掉首尾相同的行，中间用 LCS 动态规划；笔记规模（几千行以内）足够快。
 * 中间段太大时退化成「整段删除 + 整段新增」，保证不会卡死界面。
 */

export type DiffLine = { kind: "same" | "add" | "del"; text: string };
export type DiffRow = DiffLine | { kind: "fold"; count: number };

/** 中间段 n*m 超过这个就不做 LCS（约 4M 个格子，Int32 约 16MB）。 */
const MAX_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r\n/g, "\n").split("\n");
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i += 1) out.push({ kind: "same", text: a[i] });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;

  if (n * m > MAX_CELLS) {
    for (const text of midA) out.push({ kind: "del", text });
    for (const text of midB) out.push({ kind: "add", text });
  } else if (n > 0 || m > 0) {
    // lcs[i][j] = midA[i..] 与 midB[j..] 的最长公共子序列长度
    const width = m + 1;
    const lcs = new Int32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i * width + j] =
          midA[i] === midB[j]
            ? lcs[(i + 1) * width + j + 1] + 1
            : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({ kind: "same", text: midA[i] });
        i += 1;
        j += 1;
      } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
        out.push({ kind: "del", text: midA[i] });
        i += 1;
      } else {
        out.push({ kind: "add", text: midB[j] });
        j += 1;
      }
    }
    while (i < n) out.push({ kind: "del", text: midA[i++] });
    while (j < m) out.push({ kind: "add", text: midB[j++] });
  }

  for (let i = endA; i < a.length; i += 1) out.push({ kind: "same", text: a[i] });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "del") removed += 1;
  }
  return { added, removed };
}

/** 把远离改动的相同行折叠起来，只在改动前后各留 context 行。 */
export function foldUnchanged(lines: DiffLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k += 1) {
      keep[k] = true;
    }
  });
  const out: DiffRow[] = [];
  let folded = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (folded > 0) {
        out.push({ kind: "fold", count: folded });
        folded = 0;
      }
      out.push(line);
    } else {
      folded += 1;
    }
  });
  if (folded > 0) out.push({ kind: "fold", count: folded });
  return out;
}
