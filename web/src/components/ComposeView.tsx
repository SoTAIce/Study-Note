import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { TemplatesState } from "../templates-api.ts";
import { findTemplate, groupDefaultTemplate, isBlankOrSkeleton, templatePrompt, templateSkeleton } from "../lib/templates.ts";
import { copyText } from "../lib/clipboard.ts";
import { useConfirm } from "./ConfirmDialog.tsx";

/** 上次在新建页选的模板（本机浏览器记住；分组有默认模板时以默认的为准） */
const LAST_TEMPLATE_KEY = "study-notes.compose.template";

function readLastTemplate(): string {
  try {
    return window.localStorage.getItem(LAST_TEMPLATE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeLastTemplate(name: string): void {
  try {
    if (name) window.localStorage.setItem(LAST_TEMPLATE_KEY, name);
    else window.localStorage.removeItem(LAST_TEMPLATE_KEY);
  } catch {
    // 隐私模式等拿不到存储：不记就是了
  }
}

type Props = {
  busy: boolean;
  error: string | null;
  /** 可选的已有分组 */
  groups: string[];
  /** 打开新建页时左栏选中的分组：预先填进分组栏，可以改或清空 */
  initialGroup?: string;
  /** 笔记模板（tpl-001）；null = 还没读到 */
  templates: TemplatesState | null;
  onManageTemplates: () => void;
  onNotify: (text: string, kind?: "ok" | "info" | "error") => void;
  onCancel: () => void;
  onCreate: (input: { title: string; body: string; group: string | null; template: string | null }) => void;
};

/**
 * 新建笔记页：真正的「新建 → 书写 → 落盘」分离。
 * 这里什么都不写磁盘，点「创建并开始编辑」才 POST /api/notes；
 * 取消则整页丢弃（不会留下「未命名」的空笔记）。
 */
/** 新建页的预选模板：分组的默认模板，其次上次在新建页选的 */
function presetFor(templates: TemplatesState, group: string) {
  return (
    groupDefaultTemplate(templates.groupDefaults, templates.templates, group) ??
    findTemplate(templates.templates, readLastTemplate())
  );
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export default function ComposeView({
  busy,
  error,
  groups,
  initialGroup = "",
  templates,
  onManageTemplates,
  onNotify,
  onCancel,
  onCreate,
}: Props) {
  const confirm = useConfirm();
  const [title, setTitle] = useState("");
  const [group, setGroup] = useState(initialGroup);
  // 初值：分组有默认模板用默认的，否则用上次选的（tpl-001 方案 5.2）。
  // 模板已经读到时在第一次渲染就定好，不能等 effect（否则会先闪一下「不用模板」和空正文）
  const [initialPreset] = useState(() => (templates ? presetFor(templates, initialGroup) : undefined));
  const [body, setBody] = useState(() => (initialPreset ? templateSkeleton(initialPreset) : ""));
  /** 选中的模板名；空串 = 不用模板 */
  const [template, setTemplate] = useState(() => initialPreset?.name ?? "");
  /** 用户自己动过模板选择后，换分组不再自动跟着换 */
  const touchedRef = useRef(false);
  /** 初值定过了（打开时模板还没读到的，等读到再定一次） */
  const presetDoneRef = useRef(templates !== null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const list = templates?.templates ?? [];
  const chosen = findTemplate(list, template);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // 打开新建页时模板还没读到：读到以后再定初值
  useEffect(() => {
    if (!templates || presetDoneRef.current) return;
    presetDoneRef.current = true;
    if (touchedRef.current) return;
    const preset = presetFor(templates, initialGroup);
    if (preset) void choose(preset.name, { quiet: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates]);

  /** 换模板：正文空着或只有骨架就直接换成新骨架；写了东西先问 */
  async function choose(name: string, opts: { quiet?: boolean } = {}): Promise<void> {
    setTemplate(name);
    const all = templates?.templates ?? [];
    const next = findTemplate(all, name);
    if (!next) {
      if (body.trim() && isBlankOrSkeleton(body, all)) setBody("");
      return;
    }
    if (isBlankOrSkeleton(body, all)) {
      setBody(templateSkeleton(next));
      return;
    }
    if (opts.quiet) return;
    const ok = await confirm({
      title: `换成「${next.name}」的骨架？`,
      message: "正文已经写了东西。换成骨架会清掉现在的正文；不换就只记下模板名，正文照旧。",
      confirmLabel: "换成骨架",
      cancelLabel: "保留正文",
      danger: true,
    });
    if (ok) setBody(templateSkeleton(next));
  }

  function changeGroup(next: string): void {
    setGroup(next);
    if (touchedRef.current || !templates) return;
    const preset = groupDefaultTemplate(templates.groupDefaults, templates.templates, next.trim());
    if (preset && !sameName(preset.name, template)) void choose(preset.name, { quiet: true });
  }

  async function copyPrompt(): Promise<void> {
    if (!chosen) return;
    const ok = await copyText(templatePrompt(chosen, title));
    onNotify(
      ok ? "已复制提示词：发给 Claude、GPT 或 Gemini，把回答粘进正文" : "复制失败：浏览器没给剪贴板权限",
      ok ? "ok" : "error",
    );
  }

  function submit(): void {
    if (busy) return;
    writeLastTemplate(chosen?.name ?? "");
    onCreate({ title: title.trim(), body, group: group.trim() ? group.trim() : null, template: chosen?.name ?? null });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!busy) onCancel();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      submit();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === "s" || event.key === "S")) {
      event.preventDefault();
      submit();
    }
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      bodyRef.current?.focus();
    }
  }

  const lines = body ? body.split("\n").length : 0;

  return (
    <div className="compose" onKeyDown={handleKeyDown}>
      <header className="compose__head">
        <div className="compose__heading">
          <span className="compose__kicker">新建笔记</span>
          <span className="compose__sub">写好了再创建；取消就什么都不留</span>
        </div>
        <div className="compose__actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            取消 <kbd>Esc</kbd>
          </button>
          <button type="button" className="btn btn--primary" onClick={submit} disabled={busy}>
            {busy ? "创建中…" : "创建并开始编辑"} <kbd>Ctrl Enter</kbd>
          </button>
        </div>
      </header>

      <div className="compose__fields">
        <input
          ref={titleRef}
          className="compose__title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={handleTitleKeyDown}
          placeholder="标题（不写也行，会从正文第一行取）"
          aria-label="新笔记标题"
          spellCheck={false}
        />
        <div className="compose__group">
          <label className="compose__group-label" htmlFor="compose-group">
            分组
          </label>
          <input
            id="compose-group"
            className="compose__group-input"
            value={group}
            onChange={(event) => changeGroup(event.target.value)}
            list="compose-group-options"
            placeholder="不填就是未分组；填新的会自动建组"
            spellCheck={false}
          />
          <datalist id="compose-group-options">
            {groups.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
        <div className="compose__group compose__template">
          <label className="compose__group-label" htmlFor="compose-template">
            模板
          </label>
          <select
            id="compose-template"
            className="compose__template-select"
            value={chosen?.name ?? ""}
            onChange={(event) => {
              touchedRef.current = true;
              void choose(event.target.value);
            }}
            disabled={!templates}
          >
            <option value="">不用模板</option>
            {list.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
          {chosen ? (
            <button
              type="button"
              className="btn btn--small"
              onClick={() => void copyPrompt()}
              title="复制一段提示词：让外部 AI 按这个模板的小节写，回答粘回正文"
            >
              复制成提示词
            </button>
          ) : null}
          <button type="button" className="link-btn" onClick={onManageTemplates}>
            管理模板
          </button>
        </div>
        <textarea
          ref={bodyRef}
          className="compose__body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={"正文。支持 Markdown、[[双链]]、#标签。\n\n例：\n# 位置编码\n\n- 问题：注意力本身不含顺序信息\n- 做法：给每个位置一个可学习的向量"}
          aria-label="新笔记正文"
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      {error ? (
        <p className="compose__error" role="alert">
          创建失败：{error}
        </p>
      ) : null}

      <footer className="compose__foot">
        <span className="compose__hint">
          {lines} 行 · {body.length} 字 · 标签在正文里写 #标签 就会自动归类
        </span>
      </footer>
    </div>
  );
}
