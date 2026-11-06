import { useState } from "react";
import Preview from "./Preview.tsx";
import { canExecute, diffLabel, opLabel, planSummary, type PlanOpView } from "../lib/plan-view.ts";
import type { ExecuteResult, StoredPlanView, UndoResult } from "../agent-api.ts";

type Props = {
  plan: StoredPlanView;
  busy: boolean;
  onExecute: (planId: string, skip: number[]) => Promise<ExecuteResult>;
  onUndo: (planId: string) => Promise<UndoResult>;
};

/** 计划卡：人批准的唯一界面。trash 类动作必须单独勾选确认才能执行。 */
export default function PlanCard({ plan, busy, onExecute, onUndo }: Props) {
  const ops = plan.ops as unknown as Array<PlanOpView & { before?: { exists: boolean; raw: string }; after?: string }>;
  const summary = planSummary(ops);
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [trashConfirmed, setTrashConfirmed] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const executed = plan.status === "executed";
  const undone = plan.status === "undone";
  const canRun = canExecute(ops, skipped, trashConfirmed) && !busy;

  const parts: string[] = [];
  if (summary.creates) parts.push(`新建 ${summary.creates}`);
  if (summary.rewrites) parts.push(`改写 ${summary.rewrites}`);
  if (summary.appends) parts.push(`追加 ${summary.appends}`);
  if (summary.trashes) parts.push(`移入回收站 ${summary.trashes}`);

  const toggleSkip = (index: number) => {
    setSkipped((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const run = async () => {
    setError(null);
    setOutcome(null);
    try {
      const result = await onExecute(plan.id, [...skipped]);
      const ok = result.results.filter((item) => item.status === "ok").length;
      const conflict = result.results.filter((item) => item.status === "conflict").length;
      const failed = result.results.filter((item) => item.status === "error").length;
      setOutcome(
        `已执行 ${ok} 项${conflict ? `，${conflict} 项因磁盘已变被跳过` : ""}${failed ? `，${failed} 项失败` : ""}`,
      );
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const undo = async () => {
    setError(null);
    setOutcome(null);
    try {
      const result = await onUndo(plan.id);
      setOutcome(
        `已还原 ${result.restored} 项${result.skipped.length ? `，跳过 ${result.skipped.length} 项（之后被改过）` : ""}`,
      );
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className={`plan-card${undone ? " plan-card--undone" : ""}`}>
      <div className="plan-card__head">
        <span className="plan-card__title">📋 {plan.summary}</span>
        <span className="plan-card__meta">
          {parts.join(" · ") || "无改动"} · {executed ? "已执行" : undone ? "已撤销" : "待审批"}
        </span>
      </div>

      <ul className="plan-card__ops">
        {ops.map((op) => {
          const result = plan.results?.find((item) => item.index === op.index);
          const isSkipped = skipped.has(op.index);
          return (
            <li
              key={op.index}
              className={`plan-op plan-op--${op.kind}${isSkipped ? " is-skipped" : ""}`}
            >
              <label className="plan-op__pick">
                <input
                  type="checkbox"
                  checked={!isSkipped}
                  disabled={executed || undone}
                  onChange={() => toggleSkip(op.index)}
                  aria-label={`包含 ${op.path}`}
                />
              </label>
              <button
                type="button"
                className="plan-op__main"
                onClick={() => setExpanded(expanded === op.index ? null : op.index)}
                aria-expanded={expanded === op.index}
              >
                <span className="plan-op__label">{opLabel(op)}</span>
                <span className={`plan-op__diff${op.kind === "trash" ? " is-danger" : ""}`}>{diffLabel(op)}</span>
              </button>
              {result ? (
                <span className={`plan-op__result is-${result.status}`}>
                  {result.status === "ok" ? "✓" : result.status === "conflict" ? "冲突跳过" : "失败"}
                </span>
              ) : null}
              {expanded === op.index ? (
                <div className="plan-op__preview">
                  {op.before?.exists ? (
                    <details>
                      <summary>改动前</summary>
                      <Preview markdown={op.before.raw ?? ""} onOpenWikilink={() => {}} onFilterTag={() => {}} />
                    </details>
                  ) : null}
                  <details open>
                    <summary>改动后</summary>
                    <Preview markdown={op.after ?? ""} onOpenWikilink={() => {}} onFilterTag={() => {}} />
                  </details>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {summary.trashes > 0 && !executed && !undone ? (
        <label className="plan-card__danger">
          <input
            type="checkbox"
            checked={trashConfirmed}
            onChange={(event) => setTrashConfirmed(event.target.checked)}
          />
          我确认把这 {ops.filter((op) => op.kind === "trash" && !skipped.has(op.index)).length} 篇移入回收站
        </label>
      ) : null}

      <div className="plan-card__foot">
        {!executed && !undone ? (
          <button type="button" className="btn btn--primary" disabled={!canRun} onClick={() => void run()}>
            {busy ? "执行中…" : "执行这批改动"}
          </button>
        ) : null}
        {executed ? (
          <button type="button" className="btn" disabled={busy} onClick={() => void undo()}>
            {busy ? "撤销中…" : "撤销整批"}
          </button>
        ) : null}
        {outcome ? <span className="plan-card__outcome">{outcome}</span> : null}
        {error ? <span className="plan-card__error">{error}</span> : null}
      </div>
    </div>
  );
}
