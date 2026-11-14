import { useCallback, useEffect, useState } from "react";
import * as api from "../api.ts";
import type { TrashItem } from "../api.ts";
import { relativeTime } from "../lib/time.ts";
import { purgeLabel } from "../lib/trash.ts";

type Props = {
  onBack: () => void;
  onRestored: (relPath: string) => void;
};

export default function TrashView({ onBack, onRestored }: Props) {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [retentionDays, setRetentionDays] = useState(30);
  const [confirming, setConfirming] = useState(false);
  const [emptying, setEmptying] = useState(false);
  const [emptyError, setEmptyError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getTrash();
      setItems(res.items);
      setRetentionDays(res.retentionDays);
    } catch (err) {
      setError(api.errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function restore(item: TrashItem): Promise<void> {
    setRestoring(item.name);
    setRestoreError(null);
    try {
      const res = await api.restoreTrash(item.name);
      setItems((current) => current.filter((entry) => entry.name !== item.name));
      onRestored(res.relPath);
    } catch (err) {
      setRestoreError(api.errorMessage(err));
    } finally {
      setRestoring(null);
    }
  }

  async function emptyAll(): Promise<void> {
    setEmptying(true);
    setEmptyError(null);
    try {
      await api.emptyTrash();
      setItems([]);
      setConfirming(false);
    } catch (err) {
      setEmptyError(api.errorMessage(err));
    } finally {
      setEmptying(false);
    }
  }

  return (
    <div className="trash">
      <header className="trash__head">
        <div>
          <h1>回收站</h1>
          <p className="trash__sub">
            删除的笔记先放这里，恢复后回到原来的文件位置；放进来超过 {retentionDays} 天的会自动永久删除。
          </p>
        </div>
        <div className="trash__actions">
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => {
              setEmptyError(null);
              setConfirming(true);
            }}
            disabled={items.length === 0 || confirming || emptying}
          >
            清空回收站
          </button>
          <button type="button" className="btn" onClick={onBack}>
            返回笔记
          </button>
        </div>
      </header>

      {confirming ? (
        <div className="trash__confirm" role="alertdialog" aria-label="确认清空回收站">
          <p>将永久删除回收站里的 {items.length} 篇笔记，删除后无法恢复。</p>
          <div className="trash__confirm-actions">
            <button type="button" className="btn btn--small" onClick={() => setConfirming(false)} disabled={emptying}>
              取消
            </button>
            <button
              type="button"
              className="btn btn--small btn--danger"
              onClick={() => void emptyAll()}
              disabled={emptying}
            >
              {emptying ? "正在删除…" : "永久删除"}
            </button>
          </div>
        </div>
      ) : null}

      {emptyError ? (
        <p className="trash__state trash__state--error" role="alert">
          清空失败：{emptyError}
        </p>
      ) : null}

      {loading ? <p className="trash__state">正在读取回收站…</p> : null}

      {error ? (
        <div className="trash__state trash__state--error" role="alert">
          <p>读取回收站失败：{error}</p>
          <button type="button" className="btn btn--small" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}

      {!loading && !error && items.length === 0 ? (
        <p className="trash__state">回收站是空的。</p>
      ) : null}

      {restoreError ? (
        <p className="trash__state trash__state--error" role="alert">
          恢复失败：{restoreError}
        </p>
      ) : null}

      <ul className="trash__list">
        {items.map((item) => (
          <li key={item.name} className="trash__item">
            <div className="trash__info">
              <span className="trash__name">{item.origPath}</span>
              <span className="trash__meta">
                {["删除于 " + relativeTime(item.deletedAt), purgeLabel(item.deletedAt, retentionDays), item.name]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => void restore(item)}
              disabled={restoring === item.name}
            >
              {restoring === item.name ? "恢复中…" : "恢复"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
