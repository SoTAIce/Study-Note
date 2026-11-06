import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import * as api from "../api.ts";
import { REWRITE_MODES } from "../api.ts";
import type { AiConfig, AiMode } from "../api.ts";
import AiSettingsModal from "./AiSettingsModal.tsx";

type Props = {
  noteId: string | null;
  noteTitle: string;
  noteBody: string;
  selectionLength: number;
  getSelection: () => string;
  onInsert: (text: string, where: "cursor" | "end" | "replace") => void;
  /** 整篇替换（改稿类动作用），App 里负责记旧版本以便撤销。 */
  onReplaceAll: (text: string) => void;
  focusSignal: number;
  /** 调 AI 前先落盘，保证服务端读到的是最新正文。 */
  beforeRun?: () => Promise<void>;
};

const READ_MODES: Array<{ mode: AiMode; label: string; hint: string }> = [
  { mode: "expand", label: "扩写", hint: "把选段展开成结构化笔记" },
  { mode: "summarize", label: "总结", hint: "提炼这一段的关键结论" },
  { mode: "explain", label: "解释", hint: "用初学者能懂的方式讲一遍" },
  { mode: "quiz", label: "出题", hint: "生成 3 个复习问题（含折叠答案）" },
  { mode: "continue", label: "续写", hint: "顺着当前思路往下写" },
];

const EDIT_MODES: Array<{ mode: AiMode; label: string; hint: string }> = [
  { mode: "polish", label: "润色", hint: "更通顺更准确，信息与结构都不动，可直接整篇替换" },
  { mode: "shorten", label: "精简", hint: "删掉重复与套话，保留全部结论，可直接整篇替换" },
  { mode: "tidy", label: "规范排版", hint: "只改 Markdown 格式与错别字，不改表达" },
];

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError")
  );
}

export default function AiPanel({
  noteId,
  noteTitle,
  noteBody,
  selectionLength,
  getSelection,
  onInsert,
  onReplaceAll,
  focusSignal,
  beforeRun,
}: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const askRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef("");

  const [config, setConfig] = useState<AiConfig | null>(null);
  const [available, setAvailable] = useState(true);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState<AiMode | null>(null);
  const [output, setOutput] = useState("");
  const [outputMode, setOutputMode] = useState<AiMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [callId, setCallId] = useState<number | null>(null);

  const loadConfig = useCallback(async (): Promise<void> => {
    setConfigLoading(true);
    try {
      const result = await api.getAiConfig();
      setConfig(result.config);
      setAvailable(result.available);
      setConfigError(null);
    } catch (err) {
      setConfigError(api.errorMessage(err));
    } finally {
      setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (focusSignal <= 0) return;
    const timer = window.setTimeout(() => {
      panelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      askRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusSignal]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const configured = Boolean(config?.configured);
  const disabled = !configured || configLoading || Boolean(configError) || busy !== null;

  function resetSuggestion(): void {
    outputRef.current = "";
    setOutput("");
    setOutputMode(null);
    setError(null);
    setCallId(null);
  }

  async function run(mode: AiMode): Promise<void> {
    if (busy) return;
    if (!configured) {
      setSettingsOpen(true);
      return;
    }
    if (mode === "ask" && !question.trim()) {
      setError("先在下面写下你的问题。");
      askRef.current?.focus();
      return;
    }
    if (mode === "rewrite" && !question.trim()) {
      setError("先在下面写「要改成什么样」，比如：把第二节改成对比表。");
      askRef.current?.focus();
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    outputRef.current = "";
    setOutput("");
    setOutputMode(mode);
    setError(null);
    setCallId(null);
    setBusy(mode);

    try {
      await beforeRun?.();
      const selection = getSelection().trim();
      const done = await api.streamAi(
        mode,
        {
          noteId: noteId ?? undefined,
          title: noteTitle,
          body: noteBody,
          selection: selection || undefined,
          question: mode === "ask" || mode === "rewrite" ? question.trim() : undefined,
        },
        {
          signal: controller.signal,
          onDelta: (delta) => {
            outputRef.current += delta;
            setOutput(outputRef.current);
          },
        },
      );
      setCallId(done.callId);
      if (!outputRef.current.trim()) {
        setError(api.friendlyAiMessage("empty response content", "AI_EMPTY"));
      }
    } catch (err) {
      if (isAbortError(err)) return;
      setError(api.friendlyAiMessage(err));
    } finally {
      setBusy(null);
      abortRef.current = null;
    }
  }

  function discard(): void {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(null);
    resetSuggestion();
  }

  function insert(where: "cursor" | "end" | "replace"): void {
    const text = outputRef.current.trim();
    if (!text) return;
    onInsert(text, where);
    void api.acceptAi(callId);
    resetSuggestion();
  }

  function replaceAll(): void {
    const text = outputRef.current.trim();
    if (!text) return;
    onReplaceAll(text);
    void api.acceptAi(callId);
    resetSuggestion();
  }

  function handleAskKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void run("ask");
    }
  }

  return (
    <section className="ai" ref={panelRef} tabIndex={-1} aria-label="AI 建议">
      <div className="ai__head">
        <h2>AI 建议</h2>
        <button
          type="button"
          className="link-btn"
          onClick={() => setSettingsOpen(true)}
          title="AI 设置"
        >
          设置
        </button>
      </div>

      {configLoading ? <p className="ai__state">正在检查 AI 配置…</p> : null}

      {configError ? (
        <div className="ai__state ai__state--error" role="alert">
          <span>{configError}</span>
          <button type="button" className="link-btn" onClick={() => void loadConfig()}>
            重试
          </button>
        </div>
      ) : null}

      {!configLoading && !configError ? (
        configured ? (
          <p className="ai__state ai__state--dim">
            {config?.model || "已配置"}
            {config?.maxTokens ? ` · maxTokens ${config.maxTokens}` : ""}
          </p>
        ) : (
          <button type="button" className="ai__unconfigured" onClick={() => setSettingsOpen(true)}>
            AI 未配置：点这里填 key
          </button>
        )
      ) : null}

      <div className="ai__group">
        <span className="ai__grouplabel">读 / 学</span>
        <div className="ai__modes" role="group" aria-label="阅读类动作">
          {READ_MODES.map((item) => (
            <button
              key={item.mode}
              type="button"
              className="btn btn--small ai__mode"
              onClick={() => void run(item.mode)}
              disabled={disabled}
              title={item.hint}
            >
              {busy === item.mode ? "生成中…" : item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="ai__group">
        <span className="ai__grouplabel">改稿</span>
        <div className="ai__modes" role="group" aria-label="改稿动作">
          {EDIT_MODES.map((item) => (
            <button
              key={item.mode}
              type="button"
              className="btn btn--small ai__mode"
              onClick={() => void run(item.mode)}
              disabled={disabled}
              title={item.hint}
            >
              {busy === item.mode ? "改写中…" : item.label}
            </button>
          ))}
        </div>
      </div>

      <p className="ai__context">
        {selectionLength > 0
          ? `已选中 ${selectionLength} 字：改稿只改这一段。`
          : "没有选中时，改稿作用于整篇笔记。"}
      </p>

      <div className="ai__askrow">
        <input
          ref={askRef}
          className="ai__ask"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={handleAskKeyDown}
          placeholder="提问，或写改写要求（如：把第二节改成对比表）"
          aria-label="向笔记提问或写改写要求"
          spellCheck={false}
        />
        <button type="button" className="btn btn--small" onClick={() => void run("ask")} disabled={disabled}>
          问
        </button>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => void run("rewrite")}
          disabled={disabled}
          title="按上面这句要求改写内容"
        >
          改写
        </button>
      </div>

      {busy || output || error ? (
        <div className="ai__suggestion" aria-live="polite">
          <div className="ai__suggestion-head">
            <span>{outputMode && REWRITE_MODES.has(outputMode) ? "改写结果" : "建议块"}</span>
            {busy ? (
              <button type="button" className="link-btn" onClick={discard}>
                停止
              </button>
            ) : (
              <button type="button" className="link-btn" onClick={discard}>
                丢弃
              </button>
            )}
          </div>

          {output ? (
            <div className="ai__output">
              {output}
              {busy ? <span className="ai__cursor" aria-hidden="true" /> : null}
            </div>
          ) : busy ? (
            <p className="ai__state ai__state--dim">等待模型第一段输出…</p>
          ) : null}

          {error ? (
            <p className="ai__error" role="alert">
              {error}
            </p>
          ) : null}

          {output && !busy ? (
            outputMode && REWRITE_MODES.has(outputMode) ? (
              <div className="ai__ops ai__ops--rewrite">
                <button type="button" className="btn btn--small btn--primary" onClick={replaceAll}>
                  整篇替换
                </button>
                <button type="button" className="btn btn--small" onClick={() => insert("end")}>
                  追加到末尾
                </button>
                <button type="button" className="btn btn--small" onClick={() => insert("replace")} disabled={selectionLength === 0}>
                  替换选中
                </button>
                <p className="ai__hint">替换后用编辑器工具栏的「撤销 AI 改写」可以还原。</p>
              </div>
            ) : (
              <div className="ai__ops">
                <button type="button" className="btn btn--small" onClick={() => insert("cursor")}>
                  插入光标处
                </button>
                <button type="button" className="btn btn--small" onClick={() => insert("end")}>
                  追加到末尾
                </button>
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => insert("replace")}
                  disabled={selectionLength === 0}
                  title={selectionLength === 0 ? "先在编辑器里选中一段" : "用建议替换选区"}
                >
                  替换选区
                </button>
              </div>
            )
          ) : null}
        </div>
      ) : null}

      <AiSettingsModal
        open={settingsOpen}
        config={config ?? {
          baseUrl: "",
          model: "",
          apiKeyMasked: "",
          maxTokens: 2048,
          temperature: 0.4,
          configured: false,
        }}
        available={available}
        onClose={() => setSettingsOpen(false)}
        onSaved={(saved) => {
          setConfig(saved);
          setAvailable(true);
          setConfigError(null);
        }}
      />
    </section>
  );
}
