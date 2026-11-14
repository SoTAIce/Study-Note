import { useMemo } from "react";
import type { MouseEvent } from "react";
import { renderMarkdown } from "../lib/markdown.ts";

type Props = {
  markdown: string;
  onOpenWikilink: (target: string) => void;
  onFilterTag: (tag: string) => void;
  /** 额外的类名，例如阅览模式的 "reading" */
  className?: string;
};

/** 实时预览：marked 渲染后交给事件委托处理双链与标签点击。 */
export default function Preview({ markdown, onOpenWikilink, onFilterTag, className }: Props) {
  const html = useMemo(() => renderMarkdown(markdown), [markdown]);

  function handleClick(event: MouseEvent<HTMLDivElement>): void {
    const element = event.target as HTMLElement | null;
    if (!element) return;

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
