import { useMemo } from "react";
import type { MouseEvent } from "react";
import { renderMarkdown } from "../lib/markdown.ts";

type Props = {
  markdown: string;
  onOpenWikilink: (target: string) => void;
  onFilterTag: (tag: string) => void;
  /** 额外的类名，例如阅览模式的 "reading" */
  className?: string;
  /** 给了就让任务框可点：点第 index 个框时回调（editor-006） */
  onToggleTask?: (index: number) => void;
  /** 顶层块带源码行号（分栏同步滚动用） */
  sourceLines?: boolean;
};

/** 实时预览：marked 渲染后交给事件委托处理双链与标签点击。 */
export default function Preview({ markdown, onOpenWikilink, onFilterTag, className, onToggleTask, sourceLines }: Props) {
  const interactive = Boolean(onToggleTask);
  const withLines = Boolean(sourceLines);
  const html = useMemo(
    () => renderMarkdown(markdown, { interactiveTasks: interactive, sourceLines: withLines }),
    [markdown, interactive, withLines],
  );

  function handleClick(event: MouseEvent<HTMLDivElement>): void {
    const element = event.target as HTMLElement | null;
    if (!element) return;

    if (onToggleTask && element instanceof HTMLInputElement && element.classList.contains("task-check")) {
      // 勾选状态以正文为准：先撤销浏览器自己的切换，改完正文后预览会重新渲染
      event.preventDefault();
      const boxes = Array.from(event.currentTarget.querySelectorAll("input.task-check"));
      const index = boxes.indexOf(element);
      if (index >= 0) onToggleTask(index);
      return;
    }

    const wikilink = element.closest<HTMLAnchorElement>("a.wikilink");
    if (wikilink) {
      event.preventDefault();
      const target = wikilink.dataset.target ?? "";
      if (target) onOpenWikilink(target);
      return;
    }

    const tag = element.closest<HTMLElement>(".tag-pill");
    if (tag) {
      event.preventDefault();
      const name = (tag.textContent ?? "").replace(/^#/, "").trim();
      if (name) onFilterTag(name);
      return;
    }

    const anchor = element.closest<HTMLAnchorElement>("a[href]");
    if (anchor) {
      const href = anchor.getAttribute("href") ?? "";
      if (/^https?:/i.test(href)) {
        event.preventDefault();
        window.open(href, "_blank", "noopener,noreferrer");
      }
    }
  }

  if (!markdown.trim()) {
    return (
      <div className="preview preview--empty">
        <p>预览会显示在这里。</p>
        <p className="preview__hint">支持 Markdown、[[双链]] 与 #标签。</p>
      </div>
    );
  }

  return (
    <div
      className={className ? `preview ${className}` : "preview"}
      // renderMarkdown 已经把原始 HTML 转义，双链/标签是受控生成的结构。
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleClick}
    />
  );
}
