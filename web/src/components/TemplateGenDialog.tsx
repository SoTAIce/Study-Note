import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api.ts";
import { isTopDialog } from "../lib/focus-trap.ts";
import { GEN_MAX_DESCRIPTION, GEN_MAX_EXTRA, GEN_MAX_NOTES } from "../lib/template-gen.ts";
import { MAX_TEMPLATE_PROMPT, templatePrompt, templateSkeleton, validateTemplate, type NoteTemplate } from "../lib/templates.ts";
import { useDialogFocus } from "../lib/use-dialog-focus.ts";
import * as templatesApi from "../templates-api.ts";
import Icon from "./Icon.tsx";

/**
 * 让 AI 生成模板（tpl-003）：从 1～5 篇笔记归纳，或一句话描述 → AI 给出小节、每节提示、专属提示词 →
 * 预览里直接改 → 「加入模板列表」交给模板面板（标成没保存，点面板的「保存」才写盘）。
 */
type Props = {
  /** 已有的模板名（列表里的，含没保存的）：加入时避免重名 */
  takenNames: string[];
  onAdd: (template: NoteTemplate) => void;
  onClose: () => void;
};

type Source = "describe" | "notes";
type Picked = { id: string; title: string };
type DraftSection = { key: number; title: string; hint: string };
type Draft = { name: string; sections: DraftSection[]; prompt: string };

let nextKey = 1;

function toDraft(template: NoteTemplate): Draft {
  return {
    name: template.name,
    sections: template.sections.map((section) => ({ key: nextKey++, ...section })),
    prompt: template.prompt ?? "",
  };
}

function fromDraft(draft: Draft): NoteTemplate {
  return {
    name: draft.name,
    sections: draft.sections.map(({ title, hint }) => ({ title, hint })),
    ...(draft.prompt.trim() ? { prompt: draft.prompt } : {}),
  };
}

function isAbort(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError";
}

export default function TemplateGenDialog({ takenNames, onAdd, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  useDialogFocus(dialogRef);

  const [source, setSource] = useState<Source>("describe");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Picked[]>([]);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  // 选笔记：没输入时列最近的，输入了就搜
  useEffect(() => {
    if (source !== "notes") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const q = query.trim();
      const load = q
        ? api.searchNotes(q, { limit: 8 }).then((result) => result.items.map((item) => ({ id: item.id, title: item.title })))
        : api.listNotes({ type: "note" }).then((result) =>
            [...result.items]
              .sort((a, b) => b.updated.localeCompare(a.updated))
              .slice(0, 8)
              .map((item) => ({ id: item.id, title: item.title })),
          );
      load.then(
        (items) => {
          if (!cancelled) setHits(items);
        },
        () => {
          if (!cancelled) setHits([]);
        },
      );
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, source]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Esc：在跑就先停，否则关掉（只在自己是最上层弹窗时）
  const closeRef = useRef<() => void>(() => undefined);
  closeRef.current = () => {
    if (busy) cancel();
    else onClose();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || !isTopDialog(dialog) || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const result = useMemo(() => (draft ? fromDraft(draft) : null), [draft]);
  const check = useMemo(() => (result ? validateTemplate(result) : null), [result]);
  const clash = result ? takenNames.some((name) => name.trim().toLowerCase() === result.name.trim().toLowerCase()) : false;

  function cancel(): void {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
  }

  async function generate(): Promise<void> {
    if (busy) return;
    const payload: templatesApi.TemplateGenPayload | null =
      source === "describe"
        ? description.trim()
          ? { from: "describe", description: description.trim() }
          : null
        : picked.length > 0
          ? { from: "notes", ids: picked.map((item) => item.id), ...(extra.trim() ? { note: extra.trim() } : {}) }
          : null;
    if (!payload) {
      setError(source === "describe" ? "先写一句想要什么样的模板。" : "先选至少一篇笔记。");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const generated = await templatesApi.generateTemplate(payload, controller.signal);
      if (controller.signal.aborted) return;
      setDraft(toDraft(generated.template));
      if (generated.truncated.length > 0) {
        setNotice(`${generated.truncated.map((title) => `《${title}》`).join("")}太长，只发了前面一部分。`);
      }
    } catch (err) {
      if (isAbort(err) || controller.signal.aborted) return;
      setError(api.errorMessage(err));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  }

  function patchSection(key: number, patch: Partial<DraftSection>): void {
    setDraft((prev) => (prev ? { ...prev, sections: prev.sections.map((item) => (item.key === key ? { ...item, ...patch } : item)) } : prev));
  }

  function add(): void {
    if (!result || !check) return;
    if (!check.ok) {
      setError(check.error);
      return;
    }
    if (clash) {
      setError(`已经有叫「${result.name}」的模板了，换个名字`);
      return;
    }
    onAdd(check.template);
  }

  return (
    <div
      className="overlay overlay--center overlay--top"
      role="presentation"
      onMouseDown={(event) => {
        // 它挂在模板面板里面：别让点背景冒泡上去把面板也关了
        event.stopPropagation();
        closeRef.current();
      }}
    >
      <div
        className="tpl-gen"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="让 AI 生成模板"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings__head">
          <h2>让 AI 生成模板</h2>
          <button type="button" className="icon-btn" onClick={() => closeRef.current()} aria-label="关闭让 AI 生成模板">
            <Icon name="x" size={14} />
          </button>
        </header>

        <div className="segmented tpl-gen__tabs" role="tablist" aria-label="根据什么生成">
          {(
            [
              ["describe", "一句话描述"],
              ["notes", "从笔记归纳"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={source === value}
              className={`segmented__btn segmented__btn--text${source === value ? " is-active" : ""}`}
              onClick={() => {
                setSource(value);
                setError(null);
              }}
              disabled={busy}
            >
              {label}
            </button>
          ))}
        </div>

        {source === "describe" ? (
          <label className="tpl-gen__field">
            <span>想要什么样的笔记模板？</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={GEN_MAX_DESCRIPTION}
              rows={2}
              placeholder="例如：论文阅读笔记，要能记方法和实验"
              aria-label="模板描述"
              disabled={busy}
            />
          </label>
        ) : (
          <div className="tpl-gen__notes">
            <label className="tpl-gen__field">
              <span>
                选 1～{GEN_MAX_NOTES} 篇写得好的笔记（已选 {picked.length} 篇）
              </span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜标题或内容；不输入时列出最近的"
                aria-label="搜索要归纳的笔记"
                disabled={busy}
              />
            </label>
            {picked.length > 0 ? (
              <ul className="tpl-gen__chips" aria-label="已选的笔记">
                {picked.map((item) => (
                  <li key={item.id} className="tpl-gen__chip">
                    <span>{item.title || "（未命名）"}</span>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setPicked((list) => list.filter((other) => other.id !== item.id))}
                      aria-label={`去掉《${item.title}》`}
                      disabled={busy}
                    >
                      <Icon name="x" size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <ul className="tpl-gen__hits" aria-label="可选的笔记">
              {hits
                .filter((hit) => !picked.some((item) => item.id === hit.id))
                .map((hit) => (
                  <li key={hit.id}>
                    <button
                      type="button"
                      className="tpl-gen__hit"
                      onClick={() => setPicked((list) => (list.length >= GEN_MAX_NOTES ? list : [...list, hit]))}
                      disabled={busy || picked.length >= GEN_MAX_NOTES}
                    >
                      <Icon name="plus" size={11} />
                      <span>{hit.title || "（未命名）"}</span>
                    </button>
                  </li>
                ))}
            </ul>
            <label className="tpl-gen__field">
              <span>补充说明（可空）</span>
              <input
                value={extra}
                onChange={(event) => setExtra(event.target.value)}
                maxLength={GEN_MAX_EXTRA}
                placeholder="例如：偏重踩坑"
                aria-label="补充说明"
                disabled={busy}
              />
            </label>
            <p className="settings__tip">选中笔记的正文会发给你在 AI 设置里配置的服务商（和右栏 AI 动作一样）。</p>
          </div>
        )}

        <div className="tpl-gen__run">
          {busy ? (
            <>
              <span className="tpl-gen__busy" role="status">
                <span className="arrange__spinner" aria-hidden="true" /> AI 正在整理…
              </span>
              <button type="button" className="btn btn--small" onClick={cancel}>
                取消
              </button>
            </>
          ) : (
            <button type="button" className={`btn btn--small${draft ? "" : " btn--primary"}`} onClick={() => void generate()}>
              <Icon name="sparkles" size={12} /> {draft ? "重新生成" : "生成"}
            </button>
          )}
        </div>

        {error ? (
          <p className="settings__error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p className="settings__tip">{notice}</p> : null}

        {draft ? (
          <section className="tpl-gen__preview" aria-label="生成的模板">
            <label className="field tpl-gen__name">
              <span>模板名</span>
              <input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                aria-label="生成的模板名"
                spellCheck={false}
              />
            </label>
            <div className="tpl-gen__sections" role="group" aria-label="生成的小节">
              {draft.sections.map((section, at) => (
                <div key={section.key} className="tpl-panel__section">
                  <input
                    value={section.title}
                    onChange={(event) => patchSection(section.key, { title: event.target.value })}
                    aria-label={`生成的第 ${at + 1} 节标题`}
                    spellCheck={false}
                  />
                  <input
                    value={section.hint}
                    onChange={(event) => patchSection(section.key, { hint: event.target.value })}
                    aria-label={`生成的第 ${at + 1} 节提示`}
                    spellCheck={false}
                  />
                  <span className="tpl-panel__section-actions">
                    <button
                      type="button"
                      className="icon-btn icon-btn--danger"
                      onClick={() => setDraft({ ...draft, sections: draft.sections.filter((item) => item.key !== section.key) })}
                      disabled={draft.sections.length <= 1}
                      aria-label={`删除生成的第 ${at + 1} 节`}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
            <label className="tpl-gen__field">
              <span>
                专属提示词（复制成提示词时接在固定要求后面） · {[...draft.prompt].length} / {MAX_TEMPLATE_PROMPT}
              </span>
              <textarea
                value={draft.prompt}
                onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
                rows={3}
                aria-label="生成的专属提示词"
              />
            </label>
            <div className="tpl-gen__previews">
              <div className="tpl-panel__preview">
                <span className="tpl-panel__preview-label">新建时预填</span>
                <pre aria-label="生成的骨架预览">{result ? templateSkeleton(result) : ""}</pre>
              </div>
              <div className="tpl-panel__preview">
                <span className="tpl-panel__preview-label">复制成提示词</span>
                <pre aria-label="生成的提示词预览">{result ? templatePrompt(result, "") : ""}</pre>
              </div>
            </div>
            {check && !check.ok ? <p className="settings__error">{check.error}</p> : null}
            {check?.ok && clash ? <p className="settings__error">列表里已经有叫「{result?.name}」的模板了，换个名字</p> : null}
          </section>
        ) : null}

        <div className="settings__foot">
          <button type="button" className="btn" onClick={() => closeRef.current()}>
            {draft ? "放弃" : "关闭"}
          </button>
          <button type="button" className="btn btn--primary" onClick={add} disabled={!draft || busy || !check?.ok || clash}>
            加入模板列表
          </button>
        </div>
      </div>
    </div>
  );
}
