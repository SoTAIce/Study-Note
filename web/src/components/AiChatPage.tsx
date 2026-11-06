import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import * as agent from "../agent-api.ts";
import Preview from "./Preview.tsx";
import PlanCard from "./PlanCard.tsx";
import ProviderSettings from "./ProviderSettings.tsx";

type Props = {
  /** 计划执行/撤销后通知 App 刷新左侧列表与侧栏 */
  onNotesChanged: () => void;
};

type StreamState = {
  text: string;
  steps: agent.AgentStep[];
  plan: { id: string; summary: string; ops: unknown[] } | null;
};

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export default function AiChatPage({ onNotesChanged }: Props) {
  const [chats, setChats] = useState<agent.ChatSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [chat, setChat] = useState<agent.ChatDetail | null>(null);
  const [providers, setProviders] = useState<agent.ProvidersView | null>(null);
  const [stream, setStream] = useState<StreamState | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  /** 当前会话 id 的 ref：流式结束时用它判断"我现在还在看这个会话吗" */
  const activeIdRef = useRef<string | null>(null);
  /** 每次请求一个序号，只有最新那次能改状态（防止旧请求的 finally 覆盖新请求） */
  const requestSeq = useRef(0);
  const [providerId, setProviderId] = useState<string>("");
  const [model, setModel] = useState<string>("");

  const selectId = useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveId(id);
  }, []);

  const loadChats = useCallback(async () => {
    try {
      const list = await agent.listAgentChats();
      setChats(list);
      return list;
    } catch (err) {
      setError((err as Error).message);
      return [];
    }
  }, []);

  const loadProviders = useCallback(async () => {
    try {
      setProviders(await agent.getAgentProviders());
    } catch {
      /* 设置面板里再报错 */
    }
  }, []);

  const openChat = useCallback(
    async (id: string) => {
      // 切会话就把在途请求掐掉：否则旧请求回来会覆盖当前会话，甚至让人在 A 的界面上点 B 的计划
      abortRef.current?.abort();
      abortRef.current = null;
      requestSeq.current += 1;
      setBusy(false);
      setStream(null);
      selectId(id);
      setError(null);
      try {
        const detail = await agent.getAgentChat(id);
        if (activeIdRef.current !== id) return;
        setChat(detail);
        setProviderId(detail.providerId);
        setModel(detail.model);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [selectId],
  );

  useEffect(() => {
    void (async () => {
      await loadProviders();
      const list = await loadChats();
      if (list.length > 0) await openChat(list[0].id);
    })();
  }, [loadChats, loadProviders, openChat]);

  useEffect(() => {
    // 卸载时把在途请求也停掉，避免往已卸载的组件里 setState
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!providers) return;
    setProviderId((prev) => prev || chat?.providerId || providers.activeId);
    setModel((prev) => prev || chat?.model || "");
  }, [providers, chat?.providerId, chat?.model]);

  const newChat = async () => {
    setError(null);
    const picked = providerId || providers?.activeId || "";
    try {
      const created = await agent.createAgentChat({ providerId: picked, model });
      selectId(created.id);
      setChat(created);
      setProviderId(created.providerId);
      setModel(created.model);
      await loadChats();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** 换服务商/模型：新会话记在页面上，已有会话写回服务端（PATCH），并把 activeId 存下来 */
  const changeProvider = async (nextProvider: string, nextModel: string) => {
    setProviderId(nextProvider);
    setModel(nextModel);
    try {
      if (chat) {
        const updated = await agent.patchAgentChat(chat.id, {
          providerId: nextProvider,
          model: nextModel,
        });
        if (activeIdRef.current === chat.id) setChat(updated);
      }
      if (providers && providers.activeId !== nextProvider) {
        const saved = await agent.saveAgentProviders({
          activeId: nextProvider,
          items: providers.items.map((item) => ({ ...item, apiKey: "" })),
        });
        setProviders(saved);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const removeChat = async (id: string) => {
    if (!window.confirm("删除这个对话？（只删聊天记录，不动笔记）")) return;
    try {
      await agent.deleteAgentChat(id);
      const list = await loadChats();
      if (activeIdRef.current === id) {
        setChat(null);
        selectId(list[0]?.id ?? null);
        if (list[0]) await openChat(list[0].id);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    requestSeq.current += 1;
    setBusy(false);
    setStream(null);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    let target = chat;
    if (!target) {
      try {
        target = await agent.createAgentChat({ providerId: providerId || providers?.activeId, model });
        selectId(target.id);
        setChat(target);
        setProviderId(target.providerId);
        setModel(target.model);
        await loadChats();
      } catch (err) {
        setError((err as Error).message);
        return;
      }
    }

    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    const mine = () => requestSeq.current === seq;

    setInput("");
    setError(null);
    setBusy(true);
    setStream({ text: "", steps: [], plan: null });
    setChat((prev) => (prev ? { ...prev, messages: [...prev.messages, { role: "user", content: text }] } : prev));

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await agent.sendAgentMessage(target.id, text, {
        signal: controller.signal,
        onEvent: (event) => {
          if (!mine()) return;
          if (event.type === "text") {
            setStream((prev) => (prev ? { ...prev, text: prev.text + event.delta } : prev));
          } else if (event.type === "step") {
            setStream((prev) => (prev ? { ...prev, steps: [...prev.steps, event] } : prev));
          } else if (event.type === "plan") {
            setStream((prev) => (prev ? { ...prev, plan: event.plan } : prev));
          } else if (event.type === "error") {
            setError(`AI 出错（${event.code}）：${event.message}`);
          }
        },
      });
    } catch (err) {
      if (!isAbortError(err) && mine()) setError((err as Error).message);
    } finally {
      if (mine()) {
        abortRef.current = null;
        setBusy(false);
        setStream(null);
        // 以服务端为准重新拉一次：消息、计划、状态都对齐——但只在用户还停在这个会话时才覆盖界面
        try {
          const fresh = await agent.getAgentChat(target.id);
          if (mine() && activeIdRef.current === target.id) setChat(fresh);
        } catch {
          /* 忽略 */
        }
        void loadChats();
      }
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void send();
    }
  };

  const executePlan = async (planId: string, skip: number[]) => {
    setPlanBusy(true);
    try {
      const result = await agent.executeAgentPlan(planId, skip);
      if (activeId) setChat(await agent.getAgentChat(activeId));
      onNotesChanged();
      return result;
    } finally {
      setPlanBusy(false);
    }
  };

  const undoPlan = async (planId: string) => {
    setPlanBusy(true);
    try {
      const result = await agent.undoAgentPlan(planId);
      if (activeId) setChat(await agent.getAgentChat(activeId));
      onNotesChanged();
      return result;
    } finally {
      setPlanBusy(false);
    }
  };

  const historyMessages = (chat?.messages ?? []).filter(
    (msg) => (msg.role === "user" || msg.role === "assistant") && msg.content.trim().length > 0,
  );
  const plans = chat?.plans ?? [];
  const selectedProvider = providers?.items.find((item) => item.id === providerId);
  const modelOptions = selectedProvider?.models ?? [];

  return (
    <div className="agent">
      <aside className="agent__chats" aria-label="对话列表">
        <div className="agent__chats-head">
          <strong>AI 对话</strong>
          <button type="button" className="btn btn--small" onClick={() => void newChat()}>
            ＋ 新建
          </button>
        </div>
        <ul className="agent__chat-list">
          {chats.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`agent__chat-item${item.id === activeId ? " is-active" : ""}`}
                onClick={() => void openChat(item.id)}
              >
                <span className="agent__chat-title">{item.title}</span>
                <span className="agent__chat-meta">{relative(item.updatedAt)}</span>
              </button>
              <button
                type="button"
                className="agent__chat-del"
                aria-label={`删除 ${item.title}`}
                onClick={() => void removeChat(item.id)}
              >
                ×
              </button>
            </li>
          ))}
          {chats.length === 0 ? <li className="agent__chat-empty">还没有对话</li> : null}
        </ul>
        <button type="button" className="btn btn--small agent__settings-btn" onClick={() => setSettingsOpen(true)}>
          ⚙ 服务商设置
        </button>
      </aside>

      <section className="agent__main">
        <div className="agent__stream">
          {historyMessages.length === 0 && !stream ? (
            <div className="agent__hello">
              <h2>想怎么整理笔记？</h2>
              <p>我能搜遍整个笔记库、读你允许的源码目录，然后先给出一份改动计划，你点头我才动手。</p>
              <ul>
                <li>把 backend-go 那几篇整理成一篇索引，互链补上</li>
                <li>搜一下我关于中间件的笔记，看有没有自相矛盾的地方</li>
                <li>读 D:\work\greenlight 的路由代码，补一篇「路由注册顺序」</li>
              </ul>
            </div>
          ) : null}

          {historyMessages.map((msg, index) => (
            <article key={`${msg.role}-${index}`} className={`agent-msg agent-msg--${msg.role}`}>
              <div className="agent-msg__role">{msg.role === "user" ? "你" : "助手"}</div>
              <div className="agent-msg__body">
                <Preview markdown={msg.content} onOpenWikilink={() => {}} onFilterTag={() => {}} />
              </div>
            </article>
          ))}

          {stream ? (
            <article className="agent-msg agent-msg--assistant">
              <div className="agent-msg__role">助手</div>
              <div className="agent-msg__body">
                {stream.steps.length > 0 ? (
                  <ul className="agent-steps">
                    {stream.steps.map((step) => (
                      <li key={step.id} className={`agent-step is-${step.status}`}>
                        <span className="agent-step__name">{step.name}</span>
                        <span className="agent-step__summary">{step.summary ?? ""}</span>
                        <span className="agent-step__ms">{step.ms}ms</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {stream.text ? <Preview markdown={stream.text} onOpenWikilink={() => {}} onFilterTag={() => {}} /> : null}
                {busy ? <span className="agent-caret" aria-hidden="true" /> : null}
              </div>
            </article>
          ) : null}

          {plans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              busy={planBusy}
              onExecute={executePlan}
              onUndo={undoPlan}
            />
          ))}

          <div ref={bottomRef} />
        </div>

        {error ? <p className="agent__error" role="alert">{error}</p> : null}
        {selectedProvider && !selectedProvider.configured ? (
          <p className="agent__warn">
            「{selectedProvider.label}」还没填 API Key —— 点左边「⚙ 服务商设置」填一个就能用了。
          </p>
        ) : null}

        <footer className="agent__composer">
          <textarea
            value={input}
            rows={3}
            placeholder="说明你想怎么整理（Ctrl+Enter 发送）"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={busy}
          />
          <div className="agent__composer-bar">
            <div className="agent__pickers">
              <select
                className="agent__select"
                value={providerId}
                disabled={busy}
                aria-label="选择服务商"
                onChange={(event) => {
                  const next = event.target.value;
                  const nextDefault = providers?.items.find((item) => item.id === next)?.defaultModel ?? "";
                  void changeProvider(next, nextDefault);
                }}
              >
                {(providers?.items ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                    {item.configured ? "" : "（未填 key）"}
                  </option>
                ))}
              </select>
              <input
                className="agent__select agent__select--model"
                list="agent-model-options"
                value={model}
                disabled={busy}
                aria-label="选择模型"
                placeholder="模型名"
                onChange={(event) => setModel(event.target.value)}
                onBlur={() => {
                  if (model.trim()) void changeProvider(providerId, model.trim());
                }}
              />
              <datalist id="agent-model-options">
                {modelOptions.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
            {busy ? (
              <button type="button" className="btn" onClick={stop}>
                停止
              </button>
            ) : (
              <button type="button" className="btn btn--primary" onClick={() => void send()} disabled={!input.trim()}>
                发送
              </button>
            )}
          </div>
        </footer>
      </section>

      <ProviderSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => void loadProviders()}
      />
    </div>
  );
}
