/**
 * 笔记里图片地址的换算（media-001），前端预览和后端导出共用。
 * 本地图片一律换算成「笔记库内的相对路径」；跑出笔记库、或是不安全的协议，就不显示。
 */

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

export type ImageTarget = { remote: string } | { local: string[] };

function dirOf(notePath: string): string {
  const clean = notePath.split("\\").join("/");
  const slash = clean.lastIndexOf("/");
  return slash < 0 ? "" : clean.slice(0, slash);
}

/** 把 a/b/../c 规范成 a/c；跑到库外（开头还剩 ..）返回 null */
export function normalizeRel(rel: string): string | null {
  const out: string[] = [];
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.length ? out.join("/") : null;
}

function safeDecode(text: string): string {
  try {
    return decodeURI(text);
  } catch {
    return text;
  }
}

/**
 * `![](地址)` 里的地址 → 网络图片原样、本地图片换成库内相对路径、其他（javascript: 等）null。
 * 本地路径相对于笔记所在目录；以 / 开头的当作相对于笔记库根目录。
 */
export function imageTarget(href: string, notePath: string): ImageTarget | null {
  const raw = href.trim().replace(/^<|>$/g, "");
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return { remote: raw };
  if (/^data:image\//i.test(raw)) return { remote: raw };
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) return null;
  const pathPart = safeDecode(raw.split(/[?#]/)[0]).split("\\").join("/");
  const joined = pathPart.startsWith("/") ? pathPart : `${dirOf(notePath)}/${pathPart}`;
  const rel = normalizeRel(joined);
  return rel ? { local: [rel] } : null;
}

/**
 * `![[图片.png]]`（Obsidian 写法）→ 依次去找的位置：先笔记所在目录，再 attachments/。
 * 写了目录（含 /）就当作相对于笔记库根目录。不是图片扩展名返回 null。
 */
export function embedTarget(name: string, notePath: string): ImageTarget | null {
  const clean = name.trim().split("\\").join("/");
  if (!IMAGE_EXT.test(clean)) return null;
  if (clean.includes("/")) {
    const rel = normalizeRel(clean);
    return rel ? { local: [rel] } : null;
  }
  const near = normalizeRel(`${dirOf(notePath)}/${clean}`);
  const inAttachments = `attachments/${clean}`;
  const candidates = [near, inAttachments].filter((v, i, all): v is string => Boolean(v) && all.indexOf(v) === i);
  return candidates.length ? { local: candidates } : null;
}

/** 库内相对路径 → 读文件接口的地址；有备选位置时带上 fallback */
export function apiFileUrl(candidates: string[]): string {
  const encode = (rel: string): string => rel.split("/").map(encodeURIComponent).join("/");
  const url = `/api/files/${encode(candidates[0])}`;
  return candidates.length > 1 ? `${url}?fallback=${encodeURIComponent(candidates[1])}` : url;
}
