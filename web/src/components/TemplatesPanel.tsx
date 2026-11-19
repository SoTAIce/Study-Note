import { useEffect, useMemo, useRef, useState } from "react";
import { useDialogFocus } from "../lib/use-dialog-focus.ts";
import { isTopDialog } from "../lib/focus-trap.ts";
import { errorMessage, ApiError } from "../api.ts";
import * as templatesApi from "../templates-api.ts";
import type { TemplatesState } from "../templates-api.ts";
import {
  BUILTIN_TEMPLATES,
  MAX_TEMPLATE_PROMPT,
  findTemplate,
  templatePrompt,
  templateSkeleton,
  validateTemplate,
  validateTemplateList,
  type NoteTemplate,
} from "../lib/templates.ts";
import { sameGroupName } from "../lib/group-tree.ts";
import { useConfirm } from "./ConfirmDialog.tsx";
import Icon from "./Icon.tsx";
import TemplateGenDialog from "./TemplateGenDialog.tsx";

type Props = {
  open: boolean;
  /** 从左栏某个分组的「默认模板」打开：直接定位到这个组 */
  focusGroup: string | null;
  /** 现有分组名（设默认模板时选） */
  groups: string[];
  onClose: () => void;
  /** 保存成功后把最新状态交给 App（新建页、连读用） */
  onChanged: (state: TemplatesState) => void;
  onNotify: (text: string, kind?: "ok" | "info" | "error") => void;
};

type DraftSection = { key: number; title: string; hint: string };
/** origin：载入时的名字（新建的为 null），保存时据此判断哪些是改名 */
type Draft = { key: number; origin: string | null; name: string; sections: DraftSection[]; prompt: string };

let nextKey = 1;
const newKey = () => nextKey++;

function toDraft(list: NoteTemplate[]): Draft[] {
  return list.map((item) => ({
    key: newKey(),
    origin: item.name,
    name: item.name,
    sections: item.sections.map((section) => ({ key: newKey(), ...section })),
    prompt: item.prompt ?? "",
  }));
}

function draftTemplate(draft: Draft): NoteTemplate {
  return {
    name: draft.name,
    sections: draft.sections.map(({ title, hint }) => ({ title, hint })),
    // 空的不带这个字段：和服务端存下来的形状一致，不会凭空显示「有没保存的修改」
    ...(draft.prompt.trim() ? { prompt: draft.prompt } : {}),
  };
}

function toTemplates(drafts: Draft[]): NoteTemplate[] {
  return drafts.map(draftTemplate);
}

function sameDrafts(a: Draft[], b: NoteTemplate[]): boolean {
  return JSON.stringify(toTemplates(a)) === JSON.stringify(b);
}

/** 起一个不重名的名字：「名字 2」「名字 3」… */
function freeName(base: string, drafts: Draft[]): string {
  let name = base;
  for (let n = 2; drafts.some((item) => item.name.trim().toLowerCase() === name.toLowerCase()); n += 1) {
    name = `${base} ${n}`;
  }
  return name;
}

/**
 * 笔记模板管理（tpl-001）：左边模板列表（上下移动排序，最上面的是新建页的第一个选项），
 * 右边编辑小节（标题 + 提示），底下预览骨架；再往下是子项目的默认模板。
 * 改名在保存时识别（载入时的名字 ≠ 现在的名字），有笔记在用就问要不要一起改。
 */
export default function TemplatesPanel({ open, focusGroup, groups, onClose, onChanged, onNotify }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);
  const confirm = useConfirm();
  const [state, setState] = useState<TemplatesState | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newGroup, setNewGroup] = useState("");
  const [newGroupTemplate, setNewGroupTemplate] = useState("");
  /** 预览看哪个：新建时预填的骨架，还是复制给外部 AI 的提示词 */
  const [previewKind, setPreviewKind] = useState<"skeleton" | "prompt">("skeleton");
  const [genOpen, setGenOpen] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const defaultsRef = useRef<HTMLElement | null>(null);
  const focusSelectRef = useRef<HTMLSelectElement | null>(null);

  function adopt(next: TemplatesState): void {
    setState(next);
    setDrafts(toDraft(next.templates));
    setSelected((current) => Math.min(current, Math.max(0, next.templates.length - 1)));
  }

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSelected(0);
    setLoading(true);
    templatesApi
      .getTemplates()
      .then((next) => {
        adopt(next);
        if (focusGroup) {
          const has = Object.keys(next.groupDefaults).some((name) => sameGroupName(name, focusGroup));
          setNewGroup(has ? "" : focusGroup);
          setNewGroupTemplate(next.templates[0]?.name ?? "");
          window.setTimeout(() => {
            defaultsRef.current?.scrollIntoView({ block: "nearest" });
            focusSelectRef.current?.focus();
          }, 0);
        } else {
          setNewGroup("");
          setNewGroupTemplate(next.templates[0]?.name ?? "");
        }
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focusGroup]);

  // Esc / Ctrl+S 挂在 window 上：焦点落到 body（比如刚点的按钮变成禁用）时也要能关；只在自己是最上层弹窗时响应
  const keysRef = useRef<{ close: () => void; save: () => void }>({ close: () => undefined, save: () => undefined });
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || !isTopDialog(dialog)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        keysRef.current.close();
      } else if ((event.ctrlKey || event.metaKey) && (event.key === "s" || event.key === "S")) {
        event.preventDefault();
        keysRef.current.save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const dirty = state ? !sameDrafts(drafts, state.templates) : false;
  const current = drafts[selected] ?? null;
  const preview = useMemo(() => {
    if (!current) return "";
    const template = draftTemplate(current);
    return previewKind === "skeleton" ? templateSkeleton(template) : templatePrompt(template, "");
  }, [current, previewKind]);

  if (!open) return null;

  async function close(): Promise<void> {
    if (saving) return;
    if (dirty) {
      const ok = await confirm({
        title: "放弃没保存的修改？",
        message: "模板改了还没保存，关掉就丢了。",
        confirmLabel: "放弃修改",
        danger: true,
      });
      if (!ok) return;
    }
    onClose();
  }

  keysRef.current = { close: () => void close(), save: () => void save() };

  function patchCurrent(patch: (draft: Draft) => Draft): void {
    setDrafts((list) => list.map((draft, at) => (at === selected ? patch(draft) : draft)));
  }

  function patchSection(key: number, patch: Partial<DraftSection>): void {
    patchCurrent((draft) => ({
      ...draft,
      sections: draft.sections.map((section) => (section.key === key ? { ...section, ...patch } : section)),
    }));
  }

  function moveSection(key: number, delta: number): void {
    patchCurrent((draft) => {
      const at = draft.sections.findIndex((section) => section.key === key);
      const to = at + delta;
      if (at < 0 || to < 0 || to >= draft.sections.length) return draft;
      const sections = [...draft.sections];
      [sections[at], sections[to]] = [sections[to], sections[at]];
      return { ...draft, sections };
    });
  }

  function moveTemplate(delta: number): void {
    const to = selected + delta;
    if (to < 0 || to >= drafts.length) return;
    setDrafts((list) => {
      const next = [...list];
      [next[selected], next[to]] = [next[to], next[selected]];
      return next;
    });
    setSelected(to);
  }

  function addTemplate(copyOf?: Draft): void {
    const draft: Draft = copyOf
      ? {
          key: newKey(),
          origin: null,
          name: freeName(`${copyOf.name} 副本`, drafts),
          sections: copyOf.sections.map((section) => ({ ...section, key: newKey() })),
          prompt: copyOf.prompt,
        }
      : { key: newKey(), origin: null, name: freeName("新模板", drafts), sections: [{ key: newKey(), title: "要点", hint: "" }], prompt: "" };
    setDrafts((list) => [...list, draft]);
    setSelected(drafts.length);
  }

  async function removeTemplate(): Promise<void> {
    if (!current) return;
    if (drafts.length <= 1) {
      setError("至少留一个模板");
      return;
    }
    const used = current.origin ? (state?.usage[current.origin.toLowerCase()] ?? 0) : 0;
    const ok = await confirm({
      title: `删除模板「${current.name}」？`,
      message: `${used > 0 ? `已经用它建的 ${used} 篇笔记不受影响（文件头里的名字留着）。` : ""}设成它的子项目默认模板会一起清掉。保存后才生效。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setDrafts((list) => list.filter((_draft, at) => at !== selected));
    setSelected((at) => Math.max(0, at - 1));
  }

  /** AI 生成的模板（tpl-003）：放进列表末尾，和手工新建的一样要点「保存」才写盘 */
  function addGenerated(template: NoteTemplate): void {
    const draft: Draft = {
      key: newKey(),
      origin: null,
      name: freeName(template.name, drafts),
      sections: template.sections.map((section) => ({ key: newKey(), ...section })),
      prompt: template.prompt ?? "",
    };
    setDrafts((list) => [...list, draft]);
    setSelected(drafts.length);
    setGenOpen(false);
    onNotify(`已加入「${draft.name}」，点「保存」后生效`, "ok");
  }

  /** 让 AI 按当前小节改写专属提示词：结果放进文本框，保存前都能再改 */
  async function rewritePrompt(): Promise<void> {
    if (!current || rewriting) return;
    const check = validateTemplate(draftTemplate(current));
    if (!check.ok) {
      setError(check.error);
      return;
    }
    const key = current.key;
    setRewriting(true);
    setError(null);
    try {
      const result = await templatesApi.generateTemplate({ from: "prompt", template: check.template });
      setDrafts((list) => list.map((draft) => (draft.key === key ? { ...draft, prompt: result.template.prompt ?? "" } : draft)));
      setPreviewKind("prompt");
      onNotify("AI 改写了专属提示词，看一下再保存", "ok");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRewriting(false);
    }
  }

  function restoreBuiltins(): void {
    const missing = BUILTIN_TEMPLATES.filter((builtin) => !drafts.some((draft) => draft.name.trim().toLowerCase() === builtin.name.toLowerCase()));
    if (missing.length === 0) {
      onNotify("内置的两种都还在", "info");
      return;
    }
    setDrafts((list) => [...list, ...toDraft(missing).map((draft) => ({ ...draft, origin: null }))]);
    onNotify(`补回了 ${missing.map((item) => `「${item.name}」`).join("")}，保存后生效`, "ok");
  }

  async function save(): Promise<void> {
    if (!state || saving) return;
    const check = validateTemplateList(toTemplates(drafts));
    if (!check.ok) {
      setError(check.error);
      return;
    }
    if (check.templates.length === 0) {
      setError("至少留一个模板");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let latest = state;
      // 先逐个改名（服务端连带改子项目默认值、按需改笔记文件头），再整体保存小节和顺序
      for (const draft of drafts) {
        const name = draft.name.trim().replace(/\s+/g, " ");
        if (!draft.origin || draft.origin === name) continue;
        if (!findTemplate(latest.templates, draft.origin)) continue;
        const used = latest.usage[draft.origin.toLowerCase()] ?? 0;
        const updateNotes =
          used > 0 &&
          (await confirm({
            title: `有 ${used} 篇笔记用的是「${draft.origin}」`,
            message: `要把它们文件头里的模板名一起改成「${name}」吗？只改 template: 这一行，正文不动。`,
            confirmLabel: "一起改",
            cancelLabel: "只改模板",
          }));
        const renamed = await templatesApi.renameTemplate({ version: latest.version, from: draft.origin, to: name, updateNotes });
        latest = renamed;
        if (renamed.failed.length > 0) {
          onNotify(`「${name}」：${renamed.failed.length} 篇笔记文件刚被改过，没改模板名`, "error");
        } else if (updateNotes) {
          onNotify(`已把 ${renamed.renamed} 篇笔记的模板名改成「${name}」`, "ok");
        }
      }
      const saved = await templatesApi.saveTemplates({ version: latest.version, templates: check.templates });
      adopt(saved);
      onChanged(saved);
      onNotify("模板已保存", "ok");
    } catch (err) {
      const payload = err instanceof ApiError && err.status === 409 ? (err.payload as { current?: TemplatesState }) : null;
      if (payload?.current) {
        adopt(payload.current);
        onChanged(payload.current);
      }
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function setDefault(group: string, template: string | null): Promise<void> {
    try {
      const next = await templatesApi.setGroupDefault(group, template);
      // 只换默认值，别把正在编辑的小节冲掉
      setState((prev) => (prev ? { ...prev, version: next.version, groupDefaults: next.groupDefaults, usage: next.usage } : next));
      onChanged(next);
      onNotify(template ? `「${group}」新建时默认用「${template}」` : `「${group}」不再默认套模板`, "ok");
      if (group === newGroup) setNewGroup("");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const savedNames = state?.templates.map((item) => item.name) ?? [];
  const defaults = Object.entries(state?.groupDefaults ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const freeGroups = groups.filter((name) => !defaults.some(([group]) => sameGroupName(group, name)));

  return (
    <div className="overlay overlay--center" role="presentation" onMouseDown={() => void close()}>
      <div
        className="tpl-panel"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="笔记模板"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings__head">
          <h2>笔记模板</h2>
          <button type="button" className="icon-btn" onClick={() => void close()} aria-label="关闭">
            <Icon name="x" size={14} />
          </button>
        </header>

        {loading && !state ? <p className="tpl-panel__state">正在读取模板…</p> : null}

        {state ? (
          <>
            <div className="tpl-panel__main">
              <div className="tpl-panel__list">
                <ul role="listbox" aria-label="模板列表">
                  {drafts.map((draft, at) => (
                    <li key={draft.key}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={at === selected}
                        className={`tpl-panel__item${at === selected ? " is-active" : ""}`}
                        onClick={() => setSelected(at)}
                      >
                        <span className="tpl-panel__item-name">{draft.name || "（没起名）"}</span>
                        <span className="tpl-panel__item-meta">
                          {draft.sections.length} 节
                          {draft.origin && state.usage[draft.origin.toLowerCase()] ? ` · ${state.usage[draft.origin.toLowerCase()]} 篇在用` : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="tpl-panel__list-actions">
                  <button type="button" className="btn btn--small" onClick={() => addTemplate()}>
                    <Icon name="plus" size={12} /> 新建模板
                  </button>
                  <button type="button" className="btn btn--small" onClick={() => setGenOpen(true)}>
                    <Icon name="sparkles" size={12} /> 让 AI 生成
                  </button>
                  <button type="button" className="link-btn" onClick={restoreBuiltins} title="只补回缺的，不覆盖改过的">
                    恢复内置的两种
                  </button>
                </div>
                <p className="settings__tip">最上面的是新建页的第一个选项。</p>
              </div>

              {current ? (
                <div className="tpl-panel__editor">
                  <div className="tpl-panel__name-row">
                    <label className="field tpl-panel__name">
                      <span>模板名</span>
                      <input
                        value={current.name}
                        onChange={(event) => patchCurrent((draft) => ({ ...draft, name: event.target.value }))}
                        aria-label="模板名"
                        spellCheck={false}
                      />
                    </label>
                    <div className="tpl-panel__name-actions">
                      <button type="button" className="icon-btn" onClick={() => moveTemplate(-1)} disabled={selected === 0} aria-label="模板上移" title="上移">
                        <Icon name="chevronUp" size={13} />
                      </button>
                      <button type="button" className="icon-btn" onClick={() => moveTemplate(1)} disabled={selected === drafts.length - 1} aria-label="模板下移" title="下移">
                        <Icon name="chevronDown" size={13} />
                      </button>
                      <button type="button" className="btn btn--small" onClick={() => addTemplate(current)}>
                        复制一份
                      </button>
                      <button type="button" className="btn btn--small btn--danger" onClick={() => void removeTemplate()}>
                        删除
                      </button>
                    </div>
                  </div>

                  <div className="tpl-panel__sections" role="group" aria-label="小节">
                    <div className="tpl-panel__sections-head" aria-hidden="true">
                      <span>小节标题</span>
                      <span>提示（编辑时看得到，预览里不显示）</span>
                      <span className="tpl-panel__section-actions tpl-panel__section-actions--ghost" />
                    </div>
                    {current.sections.map((section, at) => (
                      <div key={section.key} className="tpl-panel__section">
                        <input
                          value={section.title}
                          onChange={(event) => patchSection(section.key, { title: event.target.value })}
                          aria-label={`第 ${at + 1} 节标题`}
                          spellCheck={false}
                        />
                        <input
                          value={section.hint}
                          onChange={(event) => patchSection(section.key, { hint: event.target.value })}
                          aria-label={`第 ${at + 1} 节提示`}
                          placeholder="这里写什么"
                          spellCheck={false}
                        />
                        <span className="tpl-panel__section-actions">
                          <button type="button" className="icon-btn" onClick={() => moveSection(section.key, -1)} disabled={at === 0} aria-label={`第 ${at + 1} 节上移`}>
                            <Icon name="chevronUp" size={12} />
                          </button>
                          <button type="button" className="icon-btn" onClick={() => moveSection(section.key, 1)} disabled={at === current.sections.length - 1} aria-label={`第 ${at + 1} 节下移`}>
                            <Icon name="chevronDown" size={12} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn icon-btn--danger"
                            onClick={() => patchCurrent((draft) => ({ ...draft, sections: draft.sections.filter((item) => item.key !== section.key) }))}
                            disabled={current.sections.length <= 1}
                            aria-label={`删除第 ${at + 1} 节`}
                          >
                            <Icon name="x" size={12} />
                          </button>
                        </span>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="link-btn tpl-panel__add-section"
                      onClick={() => patchCurrent((draft) => ({ ...draft, sections: [...draft.sections, { key: newKey(), title: "", hint: "" }] }))}
                    >
                      <Icon name="plus" size={12} /> 添加小节
                    </button>
                  </div>

                  <div className="tpl-panel__prompt">
                    <div className="tpl-panel__prompt-head">
                      <label htmlFor="tpl-panel-prompt">
                        专属提示词（可空：复制成提示词时接在固定要求后面） · {[...current.prompt].length} / {MAX_TEMPLATE_PROMPT}
                      </label>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => void rewritePrompt()}
                        disabled={rewriting}
                        title="按现在的小节，让应用内 AI 重写这一段；结果放进文本框，保存前都能改"
                      >
                        <Icon name="sparkles" size={12} /> {rewriting ? "AI 改写中…" : "让 AI 改写提示词"}
                      </button>
                    </div>
                    <textarea
                      id="tpl-panel-prompt"
                      value={current.prompt}
                      onChange={(event) => patchCurrent((draft) => ({ ...draft, prompt: event.target.value }))}
                      rows={3}
                      placeholder="例如：请用中文写；关键代码一节标出文件路径。"
                      aria-label="专属提示词"
                    />
                  </div>

                  <div className="tpl-panel__preview">
                    <div className="segmented tpl-panel__preview-tabs" role="tablist" aria-label="预览">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={previewKind === "skeleton"}
                        className={`segmented__btn segmented__btn--text${previewKind === "skeleton" ? " is-active" : ""}`}
                        onClick={() => setPreviewKind("skeleton")}
                      >
                        新建时预填
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={previewKind === "prompt"}
                        className={`segmented__btn segmented__btn--text${previewKind === "prompt" ? " is-active" : ""}`}
                        onClick={() => setPreviewKind("prompt")}
                      >
                        复制成提示词
                      </button>
                    </div>
                    <pre aria-label={previewKind === "skeleton" ? "骨架预览" : "提示词预览"}>{preview}</pre>
                  </div>
                </div>
              ) : null}
            </div>

            <section className="tpl-panel__defaults" ref={defaultsRef} aria-label="子项目默认模板">
              <h3>子项目默认模板</h3>
              <p className="settings__tip">在这个组里新建笔记、在连读里新建章，会自动套用它（新建时也能临时换）。</p>
              {defaults.length === 0 ? <p className="tpl-panel__state">还没有设默认模板的分组。</p> : null}
              <ul className="tpl-panel__default-list">
                {defaults.map(([group, template]) => {
                  const focused = focusGroup !== null && sameGroupName(group, focusGroup);
                  return (
                    <li key={group} className={`tpl-panel__default${focused ? " is-focused" : ""}`}>
                      <span className="tpl-panel__default-group">{group}</span>
                      <select
                        ref={focused ? focusSelectRef : undefined}
                        value={template}
                        onChange={(event) => void setDefault(group, event.target.value)}
                        aria-label={`「${group}」的默认模板`}
                      >
                        {savedNames.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                      <button type="button" className="link-btn" onClick={() => void setDefault(group, null)}>
                        清除
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="tpl-panel__default-add">
                <select value={newGroup} onChange={(event) => setNewGroup(event.target.value)} aria-label="要设默认模板的分组">
                  <option value="">选一个分组…</option>
                  {freeGroups.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <select
                  ref={focusGroup && !defaults.some(([group]) => sameGroupName(group, focusGroup)) ? focusSelectRef : undefined}
                  value={newGroupTemplate}
                  onChange={(event) => setNewGroupTemplate(event.target.value)}
                  aria-label="默认模板"
                >
                  {savedNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={!newGroup || !newGroupTemplate}
                  onClick={() => void setDefault(newGroup, newGroupTemplate)}
                >
                  设为默认
                </button>
              </div>
            </section>
          </>
        ) : null}

        {error ? (
          <p className="settings__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="settings__foot">
          {dirty ? <span className="tpl-panel__dirty">有没保存的修改</span> : null}
          <button type="button" className="btn" onClick={() => void close()} disabled={saving}>
            关闭
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={!state || saving || !dirty}>
            {saving ? "保存中…" : "保存"} <kbd>Ctrl S</kbd>
          </button>
        </div>
      </div>
      {genOpen ? (
        <TemplateGenDialog takenNames={drafts.map((draft) => draft.name)} onAdd={addGenerated} onClose={() => setGenOpen(false)} />
      ) : null}
    </div>
  );
}
