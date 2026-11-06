import { once } from "node:events";
import type { ServerResponse } from "node:http";

const HEARTBEAT_MS = 12_000;

export type SseSession = {
  send(event: string, data: unknown): void;
  close(): Promise<void>;
  signal: AbortSignal;
};

/**
 * 开一条 SSE。两个坑在这里补上：
 *  - 工具执行时可能几十秒没有文本输出，代理/浏览器会掐掉空闲连接 → 每 12 秒一行注释心跳；
 *  - res.write() 返 false 表示缓冲满了，继续写会把内存堆起来 → 等 drain。
 * 事件顺序由一个 promise 链保证（send 是同步调用，内部排队）。
 */
export function sseStart(res: ServerResponse): SseSession {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const controller = new AbortController();
  const onClose = (): void => {
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", onClose);

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, HEARTBEAT_MS);
  // 心跳不该阻止进程退出
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  let chain: Promise<void> = Promise.resolve();

  const send = (event: string, data: unknown): void => {
    chain = chain
      .then(async () => {
        if (res.writableEnded) return;
        const ok = res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (!ok) await once(res, "drain");
      })
      .catch(() => {
        /* 客户端断开就让上层自己察觉 signal */
      });
  };

  const close = async (): Promise<void> => {
    clearInterval(heartbeat);
    res.off("close", onClose);
    await chain;
    if (!res.writableEnded) res.end();
  };

  return { send, close, signal: controller.signal };
}
