import { useEffect, useState } from "react";
import * as agent from "../agent-api.ts";

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
};

/** 服务商设置：五张内置卡片 + key + 模型 + 允许读取的目录。 */
export default function ProviderSettings({ open, onClose, onSaved }: Props) {
  const [providers, setProviders] = useState<agent.ProvidersView | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { baseUrl: string; apiKey: string; model: string }>>({});
  const [roots, setRoots] = useState<string>("");
  const [notesRoot, setNotesRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const [data, rootInfo] = await Promise.all([agent.getAgentProviders(), agent.getAgentRoots()]);
        setProviders(data);
        setNotesRoot(rootInfo.notesRoot);
        setRoots(rootInfo.readRoots.join("\n"));
        const next: Record<string, { baseUrl: string; apiKey: string; model: string }> = {};
        for (const item of data.items) {
          next[item.id] = { baseUrl: item.baseUrl, apiKey: "", model: item.defaultModel };
        }
        setDrafts(next);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [open]);

  if (!open) return null;

  const patchDraft = (id: string, patch: Partial<{ baseUrl: string; apiKey: string; model: string }>) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  const save = async (opts: { silent?: boolean } = {}) => {
    if (!providers) return;
    setBusy(true);
    setError(null);
    if (!opts.silent) setNote(null);
    try {
      const items = providers.items.map((item) => {
        const draft = drafts[item.id];
        return {
          ...item,
          baseUrl: draft?.baseUrl ?? item.baseUrl,
          defaultModel: draft?.model ?? item.defaultModel,
          ...(draft?.apiKey ? { apiKey: draft.apiKey } : {}),
        };
      });
      const saved = await agent.saveAgentProviders({ activeId: providers.activeId, items });
      const list = roots
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      await agent.saveAgentRoots(list);
      setProviders(saved);
      setDrafts((prev) => {
        const next = { ...prev };
        for (const item of saved.items) next[item.id] = { ...next[item.id], apiKey: "" };
        return next;
      });
      if (!opts.silent) setNote("已保存");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const test = async (id: string) => {
    setTesting(id);
    setError(null);
    setNote(null);
    try {
      // 先把当前填的内容存下来：否则刚填完 key 就点「测试连接」，测的是还没保存的旧配置
      await save({ silent: true });
      const result = await agent.testAgentProvider(id);
      if (result.ok) setNote(`${id} 连通正常（${result.model}）：${result.sample ?? ""}`.trim());
      else setError(result.error ?? "测试失败");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="agent-settings" role="dialog" aria-label="AI 服务商设置">
      <div className="agent-settings__panel">
        <header className="agent-settings__head">
          <h2>AI 服务商</h2>
          <button type="button" className="btn btn--small" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="agent-settings__body">
          {providers?.items.map((item) => (
            <section key={item.id} className="agent-provider">
              <div className="agent-provider__title">
                <strong>{item.label}</strong>
                <span className="agent-provider__kind">{item.kind}</span>
                {item.configured ? <span className="agent-provider__ok">已配置</span> : null}
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={testing === item.id}
                  onClick={() => void test(item.id)}
                >
                  {testing === item.id ? "测试中…" : "测试连接"}
                </button>
              </div>
              <label>
                接口地址
                <input
                  value={drafts[item.id]?.baseUrl ?? ""}
                  onChange={(event) => patchDraft(item.id, { baseUrl: event.target.value })}
                  placeholder="https://api.example.com/v1"
                />
              </label>
              <label>
                API Key
                <input
                  type="password"
                  value={drafts[item.id]?.apiKey ?? ""}
                  onChange={(event) => patchDraft(item.id, { apiKey: event.target.value })}
                  placeholder={item.apiKeyMasked || "填过就留空表示不改"}
                />
              </label>
              <label>
                模型
                <input
                  value={drafts[item.id]?.model ?? ""}
                  onChange={(event) => patchDraft(item.id, { model: event.target.value })}
                  placeholder="deepseek-chat"
                />
              </label>
            </section>
          ))}

          <section className="agent-roots">
            <strong>允许 AI 读取的目录</strong>
            <p className="agent-roots__hint">
              笔记库默认可读：{notesRoot || "（未知）"}。要让它读源码，把目录加在下面，一行一个。
            </p>
            <textarea
              rows={3}
              value={roots}
              onChange={(event) => setRoots(event.target.value)}
              placeholder={"D:\\work\\greenlight"}
            />
          </section>

          {note ? <p className="agent-settings__note">{note}</p> : null}
          {error ? <p className="agent-settings__error">{error}</p> : null}
        </div>

        <footer className="agent-settings__foot">
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void save()}>
            {busy ? "保存中…" : "保存"}
          </button>
        </footer>
      </div>
    </div>
  );
}
