import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";

/** 只服务本机：挡住 DNS rebinding（攻击者域名解析到 127.0.0.1 时 Host 是它自己的域名）。 */
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1", "0.0.0.0"]);

function hostnameOf(host: string | undefined): string {
  if (!host) return "";
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(0, end + 1) : value;
  }
  return value.split(":")[0];
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return ALLOWED_HOSTNAMES.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 请求闸门：
 * - Host 必须是本机名（否则 403）：挡 DNS rebinding。
 * - 写请求若带 Origin，必须同源（否则 403）：挡跨站 CSRF。
 * - 带 body 的写请求必须是 application/json（否则 415）：跨站简单请求只能发 text/plain、表单，
 *   从而连 /api/capture、/api/ai/* 这类「无害 GET + 简单 POST」也打不进来。
 */
function checkGuard(req: IncomingMessage, res: ServerResponse): boolean {
  if (!ALLOWED_HOSTNAMES.has(hostnameOf(req.headers.host))) {
    sendJson(res, 403, { error: "只接受本机访问" });
    return false;
  }
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return true;

  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    sendJson(res, 403, { error: "跨站请求被拒绝" });
    return false;
  }

  const contentLength = Number(req.headers["content-length"] ?? "0");
  const hasBody = contentLength > 0 || Boolean(req.headers["transfer-encoding"]);
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (hasBody && !contentType.includes("application/json")) {
    sendJson(res, 415, { error: "写接口只接受 application/json" });
    return false;
  }
  return true;
}

export type AppDeps = {
  dataDir: string;
  notesRoot: string;
  distDir?: string;
  now?: () => Date;
  /** 由 api.ts 提供的 /api/* 处理器；返回 true 表示已处理 */
  api?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

export function createApp(deps: AppDeps) {
  const distDir =
    deps.distDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

  return async function app(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (!checkGuard(req, res)) return;
      if (url.pathname === "/api/health") {
        sendJson(res, 200, { ok: true, version: VERSION });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (deps.api) {
          const handled = await deps.api(req, res, url);
          if (handled) return;
        }
        sendJson(res, 404, { error: `接口不存在：${url.pathname}` });
        return;
      }
      serveStatic(req, res, url.pathname, distDir);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  };
}

function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  distDir: string,
): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "只支持 GET" });
    return;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: "路径编码不合法" });
    return;
  }
  const rel = decoded.replace(/^\/+/, "");
  const requested = path.resolve(distDir, rel || "index.html");
  if (requested !== distDir && !requested.startsWith(distDir + path.sep)) {
    sendJson(res, 403, { error: "路径越界" });
    return;
  }
  const exists = fs.existsSync(requested) && fs.statSync(requested).isFile();
  const file = exists ? requested : path.join(distDir, "index.html");
  if (!fs.existsSync(file)) {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end("前端尚未构建，请先运行 pnpm build");
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}
