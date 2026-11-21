import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { auditTree, openTree, sealTree, secretKeyPath } from "./secrets.ts";

/**
 * 通用的 `data/config.json` 读写。
 *
 * 为什么需要它：AI 与备份共用一个配置文件，而旧的 `saveAiConfig()` 是
 * 「按 AI 五个字段重建整个对象再写盘」——只要有人保存一次 AI 设置，
 * 其它段（backup）就会被静默抹掉。这里改成 read-modify-write（浅合并），
 * 保留所有未知键。
 *
 * 密钥（sec-001）：文件里的 apiKey / appPassword 是密文（见 secrets.ts）。
 * readConfig 交出去的是明文，patchConfig 写盘前加密，调用方不用管加没加密。
 */
export type ConfigFile = Record<string, unknown>;

export function configPath(dataDir: string): string {
  return path.join(dataDir, "config.json");
}

/** 文件原文（密钥是密文）；没有或损坏当空 */
function readRawConfig(dataDir: string): ConfigFile {
  const file = configPath(dataDir);
  if (!fs.existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as ConfigFile;
    return {};
  } catch {
    // 文件损坏时当作空配置：宁可丢设置，也不要让整个服务起不来。
    return {};
  }
}

/** 读配置：密钥已解密；解不开的当空串（等于没填） */
export function readConfig(dataDir: string): ConfigFile {
  return openTree(readRawConfig(dataDir)) as ConfigFile;
}

/** 原子写：先写临时文件再改名，写到一半断电也不会把文件写坏 */
function writeRawConfig(dataDir: string, value: ConfigFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = configPath(dataDir);
  const tmp = `${file}.tmp-${randomUUID().slice(0, 8)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/**
 * 浅合并写入：顶层键逐个覆盖，未提到的顶层键按文件原文保留（包括解不开的密文）。
 * 传进来的段里，密钥字段加密后再写；明文没变就沿用原来的密文。返回值是明文。
 */
export function patchConfig(dataDir: string, patch: ConfigFile): ConfigFile {
  const raw = readRawConfig(dataDir);
  const next: ConfigFile = { ...raw, ...(sealTree(patch, raw) as ConfigFile) };
  writeRawConfig(dataDir, next);
  return openTree(next) as ConfigFile;
}

/** 启动时：把还是明文的密钥改成密文（值不变）。返回改了几处；没有明文时不动文件、也不生成钥匙 */
export function migrateSecrets(dataDir: string): number {
  const raw = readRawConfig(dataDir);
  const { plain } = auditTree(raw);
  if (plain === 0) return 0;
  writeRawConfig(dataDir, sealTree(raw, raw) as ConfigFile);
  return plain;
}

/** 给设置页看：钥匙在哪、有几处已保存的密钥解不开 */
export function secretStatus(dataDir: string): { keyPath: string; keyExists: boolean; unreadable: number } {
  const keyPath = secretKeyPath();
  return { keyPath, keyExists: fs.existsSync(keyPath), unreadable: auditTree(readRawConfig(dataDir)).unreadable };
}

/** 取某个配置段（不是对象就当不存在）。 */
export function readSection<T extends object>(dataDir: string, key: string): Partial<T> {
  const value = readConfig(dataDir)[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Partial<T>;
}

export function patchSection(dataDir: string, key: string, patch: object): void {
  patchConfig(dataDir, { [key]: { ...readSection(dataDir, key), ...patch } });
}

/** 把密钥显示成 `abcd…wxyz` 的形状，用于回传给前端。 */
export function maskSecret(secret: string): string {
  if (!secret) return "";
  // 短 key 露头露尾就等于漏了一半；宁可只显示"已设置"
  if (secret.length < 12) return "•".repeat(Math.min(secret.length, 8));
  return `${secret.slice(0, 2)}${"•".repeat(Math.min(8, secret.length - 4))}${secret.slice(-2)}`;
}
