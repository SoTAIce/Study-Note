/**
 * 密钥加密存放（sec-001）：config.json 里的 apiKey / appPassword 存成密文，钥匙文件放在 data 外面的用户目录。
 *
 * - 钥匙：32 字节随机数，`%APPDATA%\StudyNotes\secret.key`（其他系统 `~/.config/study-notes/secret.key`），
 *   环境变量 STUDY_SECRET_DIR 可以改位置（测试、E2E 指到临时目录）。第一次要加密时才生成。
 * - 密文：`enc:v1:<钥匙指纹>:<iv>:<tag>:<密文>`，AES-256-GCM（node:crypto，不加依赖）。
 * - 能防：只复制 / 同步 / 分享 data 文件夹、截图或贴出 config.json。不能防：用本人账户运行的程序、管理员。
 *
 * 钥匙每次用时现读（文件很小）：钥匙文件被删掉或换掉，马上就表现为「读不出来」，不会被内存里的旧钥匙掩盖。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 这些字段名的字符串值按密钥处理（在配置里任何层级） */
export const SECRET_FIELDS: ReadonlySet<string> = new Set(["apiKey", "appPassword"]);

const PREFIX = "enc:v1:";
const KEY_FILE = "secret.key";

export function secretDir(): string {
  const override = process.env.STUDY_SECRET_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "StudyNotes");
  }
  return path.join(os.homedir(), ".config", "study-notes");
}

export function secretKeyPath(): string {
  return path.join(secretDir(), KEY_FILE);
}

type Key = { bytes: Buffer; id: string };

function keyFrom(bytes: Buffer): Key {
  return { bytes, id: crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 8) };
}

function readKey(): Key | null {
  let text: string;
  try {
    text = fs.readFileSync(secretKeyPath(), "utf8");
  } catch {
    return null;
  }
  const bytes = Buffer.from(text.trim(), "base64");
  return bytes.length === 32 ? keyFrom(bytes) : null;
}

/** 读钥匙；没有就生成一把（「不存在才写」，两个进程同时生成时以先写成的为准） */
function ensureKey(): Key {
  const existing = readKey();
  if (existing) return existing;
  const file = secretKeyPath();
  if (fs.existsSync(file)) {
    // 文件在但内容不对：不覆盖（可能是用户放错了文件），让调用方报错
    throw new Error(`钥匙文件内容不对：${file}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const bytes = crypto.randomBytes(32);
  try {
    fs.writeFileSync(file, `${bytes.toString("base64")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const key = readKey();
  if (!key) throw new Error(`钥匙文件写不进去：${file}`);
  return key;
}

export function isSealed(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function sealSecret(plain: string): string {
  const key = ensureKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key.bytes, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${key.id}:${iv.toString("base64")}:${tag.toString("base64")}:${data.toString("base64")}`;
}

/** 解密；钥匙不在、钥匙不对、密文被改过都返回 null */
export function openSecret(sealed: string): string | null {
  if (!isSealed(sealed)) return null;
  const parts = sealed.slice(PREFIX.length).split(":");
  if (parts.length !== 4) return null;
  const key = readKey();
  if (!key || key.id !== parts[0]) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key.bytes, Buffer.from(parts[1], "base64"));
    decipher.setAuthTag(Buffer.from(parts[2], "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 把配置里的密文换成明文；解不开的当空串（调用方看到的就是「没填」） */
export function openTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(openTree);
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_FIELDS.has(key) && isSealed(item) ? openSecret(item) ?? "" : openTree(item);
  }
  return out;
}

/** 旧数组里和新元素对应的那一个：有 id 按 id，没有按位置 */
function counterpart(old: unknown[], item: unknown, index: number): unknown {
  if (isObject(item) && typeof item.id === "string") {
    return old.find((candidate) => isObject(candidate) && candidate.id === item.id);
  }
  return old[index];
}

/**
 * 写盘前把密钥字段加密。old 是文件里同一位置的原文：明文没变就沿用原来的密文，免得每次保存都改动文件。
 * 空串保持空串（= 没填）。
 */
export function sealTree(value: unknown, old?: unknown): unknown {
  if (Array.isArray(value)) {
    const oldList = Array.isArray(old) ? old : [];
    return value.map((item, index) => sealTree(item, counterpart(oldList, item, index)));
  }
  if (!isObject(value)) return value;
  const oldObj = isObject(old) ? old : {};
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELDS.has(key) && typeof item === "string" && item !== "" && !isSealed(item)) {
      const previous = oldObj[key];
      out[key] = isSealed(previous) && openSecret(previous) === item ? previous : sealSecret(item);
    } else {
      out[key] = sealTree(item, oldObj[key]);
    }
  }
  return out;
}

/** 数一数：还是明文的密钥、解不开的密文 */
export function auditTree(value: unknown): { plain: number; unreadable: number; sealed: number } {
  const count = { plain: 0, unreadable: 0, sealed: 0 };
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isObject(node)) return;
    for (const [key, item] of Object.entries(node)) {
      if (SECRET_FIELDS.has(key) && typeof item === "string" && item !== "") {
        if (!isSealed(item)) count.plain += 1;
        else if (openSecret(item) === null) count.unreadable += 1;
        else count.sealed += 1;
      } else walk(item);
    }
  };
  walk(value);
  return count;
}
