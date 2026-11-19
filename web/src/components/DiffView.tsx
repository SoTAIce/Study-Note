import type { DiffRow } from "../lib/diff.ts";

/** 逐行差异（历史版本面板、按模板规整的预览共用） */
export default function DiffView({ rows, label }: { rows: DiffRow[]; label: string }) {
  return (
    <div className="diff" role="table" aria-label={label}>
      {rows.map((row, index) =>
        row.kind === "fold" ? (
          <div key={index} className="diff__fold" role="row">
            ··· {row.count} 行没有变化 ···
          </div>
        ) : (
          <div key={index} className={`diff__line diff__line--${row.kind}`} role="row">
            <span className="diff__sign" aria-hidden="true">
              {row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}
            </span>
            <span className="diff__text">{row.text || " "}</span>
          </div>
        ),
      )}
    </div>
  );
}
