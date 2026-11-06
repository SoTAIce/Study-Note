/** 计划卡片的纯计算：统计、能否执行、每条的标签。抽出来是为了能直接单测。 */

export type PlanOpView = {
  index: number;
  kind: "create" | "append" | "rewrite" | "trash";
  path: string;
  title: string;
  add?: number;
  del?: number;
};

export type PlanSummary = {
  creates: number;
  rewrites: number;
  appends: number;
  trashes: number;
  total: number;
};

export function planSummary(ops: PlanOpView[]): PlanSummary {
  const summary: PlanSummary = { creates: 0, rewrites: 0, appends: 0, trashes: 0, total: ops.length };
  for (const op of ops) {
    if (op.kind === "create") summary.creates += 1;
    else if (op.kind === "rewrite") summary.rewrites += 1;
    else if (op.kind === "append") summary.appends += 1;
    else summary.trashes += 1;
  }
  return summary;
}

/**
 * 能否执行：
 *  - 至少有一条没被跳过；
 *  - 只要还有没被跳过的"移入回收站"，就必须先单独确认（用户要求：删除类动作必须额外审批）。
 */
export function canExecute(ops: PlanOpView[], skipped: Set<number>, trashConfirmed: boolean): boolean {
  const active = ops.filter((op) => !skipped.has(op.index));
  if (active.length === 0) return false;
  if (active.some((op) => op.kind === "trash") && !trashConfirmed) return false;
  return true;
}

export function opLabel(op: PlanOpView): string {
  const mark = op.kind === "create" ? "＋" : op.kind === "trash" ? "✗" : "✎";
  return `${mark} ${op.path}`;
}

export function diffLabel(op: PlanOpView): string {
  if (op.kind === "create") return "新建";
  if (op.kind === "trash") return "移入回收站";
  const add = op.add ?? 0;
  const del = op.del ?? 0;
  return `+${add} −${del}`;
}
