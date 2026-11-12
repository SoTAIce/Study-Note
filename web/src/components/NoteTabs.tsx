import type { NoteTab } from "../lib/note-tabs.ts";
import Icon from "./Icon.tsx";

type Props = {
  tabs: NoteTab[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
};

export default function NoteTabs({ tabs, activeId, onActivate, onClose }: Props) {
  if (tabs.length === 0) return null;

  return (
    <div className="note-tabs" role="tablist" aria-label="打开的笔记">
      {tabs.map((tab) => (
        <div key={tab.id} className={`note-tab${tab.id === activeId ? " is-active" : ""}`}>
          <Icon name="notes" size={14} className="note-tab__icon" />
          <button
            type="button"
            className="note-tab__label"
            role="tab"
            aria-selected={tab.id === activeId}
            title={tab.title || "未命名"}
            onClick={() => onActivate(tab.id)}
          >
            {tab.title || "未命名"}
          </button>
          <button
            type="button"
            className="note-tab__close"
            aria-label={`关闭 ${tab.title || "未命名"}`}
            title="关闭标签"
            onClick={() => onClose(tab.id)}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
