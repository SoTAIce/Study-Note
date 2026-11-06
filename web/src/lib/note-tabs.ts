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
