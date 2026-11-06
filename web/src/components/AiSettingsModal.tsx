import { useEffect, useState } from "react";
import * as api from "../api.ts";
import type { AiConfig } from "../api.ts";

type Props = {
  open: boolean;
  config: AiConfig;
  available: boolean;
  onClose: () => void;
  onSaved: (config: AiConfig) => void;
};

/** AI 网关设置弹层：PUT /api/config，apiKey 只上行不回落。 */
export default function AiSettingsModal({ open, config, available, onClose, onSaved }: Props) {
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [model, setModel] = useState(config.model);
  const [apiKey, setApiKey] = useState("");
  const [maxTokens, setMaxTokens] = useState(String(config.maxTokens));
  const [temperature, setTemperature] = useState(String(config.temperature));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBaseUrl(config.baseUrl);
    setModel(config.model);
    setApiKey("");
    setMaxTokens(String(config.maxTokens));
    setTemperature(String(config.temperature));
    setSaving(false);
    setError(null);
  }, [open, config]);

  if (!open) return null;

  async function submit(): Promise<void> {
    if (saving) return;
    const tokens = Number(maxTokens);
    const temp = Number(temperature);
    if (!Number.isFinite(tokens) || tokens < 256) {
      setError("maxTokens 至少 256（太小会因推理 token 占满而返回空正文）。");
      return;
    }
    if (!Number.isFinite(temp) || temp < 0 || temp > 2) {
      setError("temperature 需要在 0 到 2 之间。");
      return;
    }
    const patch: api.AiConfigPatch = {
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      maxTokens: Math.floor(tokens),
      temperature: temp,
    };
    if (apiKey.trim()) patch.apiKey = apiKey.trim();

    setSaving(true);
    setError(null);
    try {
      const saved = await api.putAiConfig(patch);
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(api.errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overlay overlay--center" role="presentation" onMouseDown={onClose}>
      <div
        className="settings"
        role="dialog"
        aria-modal="true"
        aria-label="AI 设置"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings__head">
          <h2>AI 设置</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        {!available ? (
          <p className="settings__notice" role="status">
            服务端还没有提供 <code>/api/config</code>。先把下面的值填好并保存，重启服务后即可生效。
          </p>
        ) : null}

        <label className="field">
          <span>Base URL</span>
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.cline.bot/api/v1"
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>模型</span>
          <input value={model} onChange={(event) => setModel(event.target.value)} spellCheck={false} />
        </label>

        <label className="field">
          <span>API Key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={config.apiKeyMasked ? `已保存：${config.apiKeyMasked}（留空则不修改）` : "sk-…"}
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        <div className="settings__row">
          <label className="field">
            <span>maxTokens</span>
            <input
              type="number"
              min={256}
              step={256}
              value={maxTokens}
              onChange={(event) => setMaxTokens(event.target.value)}
            />
          </label>
          <label className="field">
            <span>temperature</span>
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={temperature}
              onChange={(event) => setTemperature(event.target.value)}
            />
          </label>
        </div>

        <p className="settings__tip">
          推理模型建议 maxTokens ≥ 2048；返回空正文通常就是长度不够。
        </p>

        {error ? (
          <p className="settings__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="settings__foot">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
