import fs from "node:fs";
import path from "node:path";

/**
 * 通用的 `data/config.json` 读写。
 *
 * 为什么需要它：AI 与备份共用一个配置文件，而旧的 `saveAiConfig()` 是
 * 「按 AI 五个字段重建整个对象再写盘」——只要有人保存一次 AI 设置，
 * 其它段（backup）就会被静默抹掉。这里改成 read-modify-write（浅合并），
 * 保留所有未知键。
 */
export type ConfigFile = Record<string, unknown>;

export function configPath(dataDir: string): string {
  return path.join(dataDir, "config.json");
}

export function readConfig(dataDir: string): ConfigFile {
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

/** 浅合并写入：顶层键逐个覆盖，未提到的顶层键原样保留。 */
export function patchConfig(dataDir: string, patch: ConfigFile): ConfigFile {
  const next: ConfigFile = { ...readConfig(dataDir), ...patch };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configPath(dataDir), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
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
