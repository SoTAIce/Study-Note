/**
 * 最小可用的 WebDAV 客户端（零依赖，只用 Node 内置 fetch）。
 *
 * 只实现备份需要的五个动作：建目录、PUT、GET、DELETE、探活。
 * 几个不显然的点，都是踩过才知道的：
 * - 授权头必须按 UTF-8 编 base64（`btoa` 只吃 latin1，密码含中文会直接抛）
 * - `redirect: "manual"`：WebDAV 端点回 3xx 时，跟随重定向会把 PUT 的请求体吃掉
 * - MKCOL 对已存在的目录返回 405，这是成功不是失败；PUT 到不存在的父目录返回 409
 * - 每个路径段单独 encodeURIComponent（文件名里有空格/#/% 很常见）
 */

export type WebdavSettings = {
  /** WebDAV 服务根地址，例如 https://dav.example.com/remote.php/dav/files/user/ */
  url: string;
  account: string;
  appPassword: string;
  /** 远端根目录，默认 study-notes，避免污染网盘根 */
  remoteRoot: string;
};

export type WebdavErrorCode = "AUTH" | "RATE_LIMIT" | "NOT_FOUND" | "SERVER" | "REDIRECT" | "NETWORK";

export class WebdavError extends Error {
  readonly code: WebdavErrorCode;
  readonly status: number | undefined;

  constructor(code: WebdavErrorCode, message: string, status?: number) {
    super(message);
    this.name = "WebdavError";
    this.code = code;
    this.status = status;
  }
}

export type WebdavClient = {
  /** 逐级创建目录（幂等，405 视为已存在）。 */
  ensureDir(relDir: string): Promise<void>;
  put(relPath: string, data: string): Promise<void>;
  /** 不存在返回 null，不抛错。 */
  get(relPath: string): Promise<string | null>;
  /** 删除文件；不存在也算成功。 */
  remove(relPath: string): Promise<void>;
  /** 探活：PROPFIND 根目录，只看状态码。 */
  probe(): Promise<void>;
};

const TIMEOUT_MS = 30_000;

function basicAuth(account: string, password: string): string {
  // 关键：UTF-8 → base64。btoa 只接受 latin1，中文密码会抛 DOMException。
  return `Basic ${Buffer.from(`${account}:${password}`, "utf8").toString("base64")}`;
}

export function createWebdavClient(settings: WebdavSettings, fetchImpl: typeof fetch = fetch): WebdavClient {
  const base = settings.url.endsWith("/") ? settings.url : `${settings.url}/`;
  const root = settings.remoteRoot.replace(/^\/+|\/+$/g, "");
  const authorization = basicAuth(settings.account, settings.appPassword);
  // 每次备份会重复建同样的目录，缓存一下能省掉大量请求（免费额度是 600 次/30 分钟）。
  const ensured = new Set<string>();

  function urlForParts(parts: string[]): URL {
    return new URL(parts.map((part) => encodeURIComponent(part)).join("/"), base);
  }

  function urlFor(relPath: string): URL {
    const clean = relPath.replace(/^\/+/, "");
    const segments = clean.split("/").filter(Boolean);
    return urlForParts([...(root ? [root] : []), ...segments]);
  }

  async function send(
    method: string,
    relPath: string,
    options: { body?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    return await sendTo(method, urlFor(relPath), options);
  }

  async function sendTo(
    method: string,
    target: URL,
    options: { body?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization,
      ...(options.headers ?? {}),
    };
    try {
      return await fetchImpl(target, {
        method,
        headers,
        body: options.body,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof WebdavError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new WebdavError("NETWORK", `连不上 WebDAV：${reason}`);
    }
  }

  function check(res: Response, action: string, allow: number[]): void {
    if (allow.includes(res.status)) return;
    if (res.status >= 300 && res.status < 400) {
      throw new WebdavError("REDIRECT", `${action} 被重定向（${res.status}），请检查 WebDAV 地址是否正确`, res.status);
    }
    if (res.status === 401 || res.status === 403) {
      throw new WebdavError("AUTH", `${action} 鉴权失败（${res.status}），检查账号或应用密码`, res.status);
    }
    if (res.status === 429) {
      throw new WebdavError("RATE_LIMIT", "请求太频繁被限流（429），稍后重试", res.status);
    }
    throw new WebdavError("SERVER", `${action} 失败（HTTP ${res.status}）`, res.status);
  }

  async function ensureDir(relDir: string): Promise<void> {
    const dirs = relDir.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    // 远端根目录自己也要建：`/dav/<root>/latest` 的 MKCOL 在 `<root>` 不存在时返回 409
    const full = [...(root ? [root] : []), ...dirs];
    for (let i = 1; i <= full.length; i += 1) {
      const parts = full.slice(0, i);
      const key = parts.join("/");
      if (ensured.has(key)) continue;
      const res = await sendTo("MKCOL", urlForParts(parts));
      // 201 新建成功；200 有时也会返回；405 = 已存在。
      if (res.status === 405 || res.status === 200) {
        ensured.add(key);
        continue;
      }
      check(res, `建目录 ${key}`, [201]);
      ensured.add(key);
    }
  }

  async function put(relPath: string, data: string): Promise<void> {
    const slash = relPath.lastIndexOf("/");
    const parent = slash > -1 ? relPath.slice(0, slash) : "";
    if (parent) await ensureDir(parent);

    const doPut = (): Promise<Response> =>
      send("PUT", relPath, {
        body: data,
        headers: { "content-type": "text/markdown; charset=utf-8", "content-length": String(Buffer.byteLength(data, "utf8")) },
      });

    let res = await doPut();
    // 409 = 父目录不存在（可能是缓存过期或远端被别人动过），补一次再试。
    if (res.status === 409) {
      ensured.delete(parent);
      if (parent) await ensureDir(parent);
      res = await doPut();
    }
    check(res, `上传 ${relPath}`, [200, 201, 204]);
  }

  async function get(relPath: string): Promise<string | null> {
    const res = await send("GET", relPath);
    if (res.status === 404) return null;
    check(res, `读取 ${relPath}`, [200]);
    return await res.text();
  }

  async function remove(relPath: string): Promise<void> {
    const res = await send("DELETE", relPath);
    if (res.status === 404) return;
    check(res, `删除 ${relPath}`, [200, 204]);
  }

  async function probe(): Promise<void> {
    // 探活打的是 WebDAV 根（`…/dav/`），不是 `…/dav/study-notes` ——
    // 后者要等第一次备份才会被 MKCOL 建出来，第一次点"测试连接"必然 404。
    const res = await sendTo("PROPFIND", new URL(base), { headers: { depth: "0" } });
    if (res.status === 401 || res.status === 403) {
      throw new WebdavError("AUTH", `鉴权失败（${res.status}），检查账号或应用密码`, res.status);
    }
    if (res.status === 404) {
      throw new WebdavError(
        "NOT_FOUND",
        "地址里找不到 WebDAV 服务（404），请检查服务商提供的 WebDAV 根地址",
        res.status,
      );
    }
    // 207 Multi-Status 是正常结果；200 也接受（部分实现）。
    check(res, "连接测试", [200, 207]);
  }

  return { ensureDir, put, get, remove, probe };
}
