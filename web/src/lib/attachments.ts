/** 粘贴 / 拖入图片（media-001）：前端的纯函数部分 */

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const SUPPORTED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type FileLike = { type: string; name: string; size: number };

/**
 * 从剪贴板 / 拖入的文件里挑出要上传的图片。
 * - 剪贴板里同时有文字（例如从网页复制）：以文字为准，不上传（返回空，调用方照常粘贴）
 * - 不支持的类型、超过大小：放进 rejected，给用户提示
 */
export function pickImages<T extends FileLike>(files: T[], text = ""): { accept: T[]; rejected: string | null } {
  if (text.trim()) return { accept: [], rejected: null };
  const images = files.filter((file) => file.type.startsWith("image/"));
  const accept: T[] = [];
  let rejected: string | null = null;
  for (const file of images) {
    if (!SUPPORTED.has(file.type)) rejected = "只支持 PNG、JPG、GIF、WebP 图片";
    else if (file.size > MAX_IMAGE_BYTES) rejected = `图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`;
    else accept.push(file);
  }
  if (images.length === 0 && files.length > 0) rejected = "只支持 PNG、JPG、GIF、WebP 图片";
  return { accept, rejected };
}

/** 插入的文字：多张图之间空一行；光标在一行中间时先换行，让图片单独占一行 */
export function imageInsertText(markdowns: string[], charBefore: string): string {
  const body = markdowns.join("\n\n");
  return charBefore && charBefore !== "\n" ? `\n${body}` : body;
}
