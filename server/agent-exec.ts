import fs from "node:fs";
import path from "node:path";
import type { NormalizedOp, NormalizedPlan } from "./agent-plan.ts";
import type { NoteStore } from "./store.ts";
import type { Indexer } from "./indexer.ts";

export type OpResult = { index: number; status: "ok" | "conflict" | "error"; error?: string };

type BatchEntry = {
  index: number;
  kind: NormalizedOp["kind"];
  path: string;
  beforeHash: string;
  afterHash: string;
  snapshot?: string;
  ok?: boolean;
};

export type BatchMeta = { planId: string; entries: BatchEntry[] };

const BATCH_DIR = ["batches"] as const;

export function batchDirOf(dataDir: string, planId: string): string {
  return path.join(dataDir, ".history", ...BATCH_DIR, `b-${planId}`);
}

/**
 * 执行计划。顺序写、逐条独立成败：
 * 磁盘 hash 与计划生成时不一致（= 期间被人改过）就跳过那一条，绝不覆盖手工修改。
 */
export function executePlan(
  deps: { store: NoteStore; indexer: Indexer; dataDir: string },
  plan: NormalizedPlan,
  opts: { skip?: number[] } = {},
): { results: OpResult[] } {
  const skip = new Set(opts.skip ?? []);
  const ops = plan.ops.filter((op) => !skip.has(op.index));
  const dir = batchDirOf(deps.dataDir, plan.id);
  fs.mkdirSync(dir, { recursive: true });

  // 1) 先快照：撤销要靠它，且必须在动手之前写下来
  const entries: BatchEntry[] = ops.map((op) => {
    const entry: BatchEntry = {
      index: op.index,
      kind: op.kind,
      path: op.path,
      beforeHash: op.before.hash,
      afterHash: "",
    };
    // 只要执行前文件存在就留快照——0 字节的 .md 也是合法文件，空字符串照样能还原
    if (op.before.exists) {
      const snapshot = path.join(dir, `${op.index}.md`);
      fs.writeFileSync(snapshot, op.before.raw, "utf8");
      entry.snapshot = snapshot;
    }
    return entry;
  });

  // 2) 让 watcher 别把这次写入当外部变化重复索引；写完统一索引一次
  for (const op of ops) {
    if (op.before.exists) deps.indexer.ignoreNext(op.path);
  }

  const results: OpResult[] = [];

  for (const op of ops) {
    const entry = entries.find((item) => item.index === op.index)!;
    try {
      if (op.kind === "create") {
        deps.store.createAt(op.path, {
          title: op.title,
          body: op.after,
          ...(op.tags ? { tags: op.tags } : {}),
          ...(op.type ? { type: op.type } : {}),
          ...(op.group ? { group: op.group } : {}),
        });
      } else if (op.kind === "trash") {
        assertUnchanged(deps.store, op);
        deps.store.moveToTrash(op.path);
      } else {
        assertUnchanged(deps.store, op);
        if (op.groupOnly) {
          // 只换分组：setGroup 不动 updated、不写历史快照
          deps.store.setGroup(op.path, op.group ?? null, { baseHash: op.before.hash });
        } else {
          deps.store.save(op.path, op.after, op.before.hash, op.group ? { group: op.group } : {});
        }
      }
      entry.afterHash = currentHash(deps.store, op);
      entry.ok = true;
      results.push({ index: op.index, status: "ok" });
    } catch (err) {
      if (err instanceof UnchangedError) {
        results.push({ index: op.index, status: "conflict", error: err.message });
      } else {
        results.push({ index: op.index, status: "error", error: (err as Error).message });
      }
    }
  }

  // 3) 统一重建索引（逐条 indexFile 会把 FTS 反复重写）
  for (const result of results) {
    if (result.status !== "ok") continue;
    const op = ops.find((item) => item.index === result.index)!;
    try {
      if (op.kind === "trash") deps.indexer.removeFile(op.path);
      else deps.indexer.indexFile(op.path);
    } catch {
      // 索引失败不该让"笔记已写入"这件事变成失败
    }
  }

  const meta: BatchMeta = { planId: plan.id, entries: entries.filter((entry) => entry.ok) };
  fs.writeFileSync(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  return { results };
}

/**
 * 撤销一批计划。逐条检查"当前 hash 是否还等于执行后记录的 hash"：
 * 一致才还原，不一致就跳过并报告——不覆盖用户在这期间的手工修改。
 */
export function undoPlan(
  deps: { store: NoteStore; indexer: Indexer; dataDir: string },
  plan: NormalizedPlan,
): { restored: number; skipped: Array<{ path: string; reason: string }> } {
  const dir = batchDirOf(deps.dataDir, plan.id);
  const metaFile = path.join(dir, "meta.json");
  const skipped: Array<{ path: string; reason: string }> = [];
  if (!fs.existsSync(metaFile)) {
    return { restored: 0, skipped: plan.ops.map((op) => ({ path: op.path, reason: "没有找到这一批的快照" })) };
  }
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as BatchMeta;

  let restored = 0;
  for (const entry of [...meta.entries].reverse()) {
    const op = plan.ops.find((item) => item.index === entry.index);
    if (!op) continue;
    const hash = currentHash(deps.store, op);
    if (hash !== entry.afterHash) {
      skipped.push({ path: entry.path, reason: "执行之后这篇又被改过，跳过以免覆盖" });
      continue;
    }
    deps.indexer.ignoreNext(entry.path);
    try {
      if (entry.kind === "create") {
        if (fs.existsSync(deps.store.absPath(entry.path))) deps.store.moveToTrash(entry.path);
      } else if (entry.snapshot && fs.existsSync(entry.snapshot)) {
        const abs = deps.store.absPath(entry.path);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, fs.readFileSync(entry.snapshot));
      } else {
        skipped.push({ path: entry.path, reason: "快照丢了" });
        continue;
      }
      restored += 1;
      if (fs.existsSync(deps.store.absPath(entry.path))) deps.indexer.indexFile(entry.path);
      else deps.indexer.removeFile(entry.path);
    } catch (err) {
      skipped.push({ path: entry.path, reason: (err as Error).message });
    }
  }

  return { restored, skipped };
}

class UnchangedError extends Error {}

function assertUnchanged(store: NoteStore, op: NormalizedOp): void {
  const hash = currentHash(store, op);
  if (hash !== op.before.hash) {
    throw new UnchangedError(`${op.path} 在执行前被改过（计划时 ${op.before.hash || "无"}，现在 ${hash || "无"}）`);
  }
}

function currentHash(store: NoteStore, op: NormalizedOp): string {
  try {
    if (!fs.existsSync(store.absPath(op.path))) return "";
    return store.read(op.path).hash;
  } catch {
    return "";
  }
}
