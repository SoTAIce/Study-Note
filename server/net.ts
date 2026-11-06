/**
 * 网络层的统一处理：把 undici 那句没头没脑的 `fetch failed` 翻成人话，
 * 并在「还没开始读响应」时自动重试一次（网关偶发 RST 是真实存在的情况）。
 */

/** undici 的 fetch 在连接层失败时抛 TypeError("fetch failed")，真正原因在 err.cause.code 里。 */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

export function networkErrorCode(err: unknown): string | null {
  const cause = (err as { cause?: { code?: unknown; errno?: unknown } } | null)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : null;
  if (code) return code;
  const errno = cause?.errno;
  if (typeof errno === "string" && errno) return errno;
  return null;
}

/** 连接层失败（而不是「服务器返回了 4xx/5xx」）。 */
export function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return false;
  if (err.name !== "TypeError") return false;
  if (!err.message.includes("fetch failed")) return false;
  const code = networkErrorCode(err);
  return code === null || TRANSIENT_CODES.has(code);
}

const FRIENDLY: Record<string, string> = {
  ENOTFOUND: "域名解析失败（检查网络或代理）",
  EAI_AGAIN: "DNS 暂时不可用（检查网络或代理）",
  ECONNREFUSED: "连接被拒绝（网关地址或代理端口不对）",
  ECONNRESET: "连接被对端重置（网关抖动，稍后重试）",
  ETIMEDOUT: "连接超时（网关无响应）",
  UND_ERR_CONNECT_TIMEOUT: "连接超时（网关无响应）",
  UND_ERR_SOCKET: "套接字异常断开",
  UND_ERR_HEADERS_TIMEOUT: "等响应头超时",
  UND_ERR_BODY_TIMEOUT: "读响应超时",
};

export class AiNetworkError extends Error {
  readonly code = "AI_NETWORK";
  readonly causeCode: string | null;

  constructor(causeCode: string | null, tried: number) {
    const why = (causeCode && FRIENDLY[causeCode]) || "网络不通";
    const triedText = tried > 1 ? `（已重试 ${tried - 1} 次）` : "";
    super(`连不上 AI 网关：${why}${triedText}`);
    this.name = "AiNetworkError";
    this.causeCode = causeCode;
  }
}

/**
 * fetch + 连接层失败自动重试。只在「响应还没拿到」时重试，
 * 所以不会把已经吐了一半的流重放一遍（那会重复计费、重复内容）。
 */
export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  retries = 1,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchImpl(url, init);
    } catch (err) {
      lastError = err;
      if (!isNetworkFailure(err)) throw err;
      // 用户主动取消 / 超时不要重试
      const signal = init.signal;
      if (signal?.aborted) throw err;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  if (isNetworkFailure(lastError)) throw new AiNetworkError(networkErrorCode(lastError), retries + 1);
  throw lastError;
}
