export type NoteTab = {
  id: string;
  title: string;
};

export function upsertNoteTab(tabs: NoteTab[], tab: NoteTab): NoteTab[] {
  const index = tabs.findIndex((item) => item.id === tab.id);
  if (index < 0) return [...tabs, tab];
  if (tabs[index].title === tab.title) return tabs;
  return tabs.map((item, itemIndex) => (itemIndex === index ? tab : item));
}

export function renameNoteTab(tabs: NoteTab[], id: string, title: string): NoteTab[] {
  return tabs.map((tab) => (tab.id === id && tab.title !== title ? { ...tab, title } : tab));
}

export function closeNoteTab(
  tabs: NoteTab[],
  closingId: string,
  activeId: string | null,
): { tabs: NoteTab[]; nextActiveId: string | null } {
  const index = tabs.findIndex((tab) => tab.id === closingId);
  if (index < 0) return { tabs, nextActiveId: activeId };

  const remaining = tabs.filter((tab) => tab.id !== closingId);
  if (closingId !== activeId) return { tabs: remaining, nextActiveId: activeId };

  const next = tabs[index + 1] ?? tabs[index - 1] ?? null;
  return { tabs: remaining, nextActiveId: next?.id ?? null };
}

/** 列表刷新后，用最新标题更新已打开的标签页（外部改了标题时）；没变化就返回原数组，避免多余渲染。 */
export function syncNoteTabTitles(tabs: NoteTab[], items: Array<{ id: string; title: string }>): NoteTab[] {
  const titles = new Map(items.map((item) => [item.id, item.title]));
  let changed = false;
  const next = tabs.map((tab) => {
    const title = titles.get(tab.id);
    if (title === undefined || title === tab.title) return tab;
    changed = true;
    return { ...tab, title };
  });
  return changed ? next : tabs;
}
