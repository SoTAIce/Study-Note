
/**
 * 一次性迁移：把某个目录下「没有 frontmatter」的旧笔记补上一个 group 字段。
 *
 * 默认只打印将要发生什么（dry-run）；真正写盘要加 --apply。
 * 只动 frontmatter，正文一个字节都不改：
 *   - 已有 frontmatter 但没有 group：在 tags 后面插一行。
 *   - 完全没有 frontmatter：在文件最前面插一个最小块。
 *   - 已经有 group（哪怕是别的组）：跳过，不覆盖。
 *
 * 用法：
 *   node bin/migrate-groups.mjs --group "Go 学习" --dir backend-go
 *   node bin/migrate-groups.mjs --group "Go 学习" --dir backend-go --apply
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { groupLine, readFrontmatterBlock } from "./parse.ts";
import { validateGroupName } from "./groups.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NOTES_ROOT = path.join(ROOT, "data", "notes");

export type MigrateArgs = { group: string; dir: string; apply: boolean; help: boolean };

export function parseArgs(argv: string[]): MigrateArgs {
  const out: MigrateArgs = { group: "", dir: "", apply: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--group") out.group = argv[++i] ?? "";
    else if (arg === "--dir") out.dir = argv[++i] ?? "";
    else if (arg.startsWith("--group=")) out.group = arg.slice("--group=".length);
    else if (arg.startsWith("--dir=")) out.dir = arg.slice("--dir=".length);
    else throw new Error(`不认识的参数：${arg}`);
  }
  return out;
}

const USAGE = `用法：node bin/migrate-groups.mjs --group "Go 学习" [--dir backend-go] [--apply]

默认 dry-run，只列出会改哪些文件；加 --apply 才真正写盘。
只会补 frontmatter 里的 group，正文不动；已经有 group 的笔记一律跳过。`;

/** 复用应用自己的判定：正文里用 `---` 画的分隔线不算 frontmatter，不会被当块插东西。 */
export function readFrontmatter(raw: string): { block: string; lines: string[]; hasGroup: boolean } | null {
  const fm = readFrontmatterBlock(raw);
  if (!fm) return null;
  return {
    block: fm.block,
    lines: fm.lines,
    hasGroup: fm.lines.some((line) => /^group\s*:/.test(line)),
  };
}

/**
 * 算出「补上一个 group 行之后」的文件内容。
 * - 返回 null 表示跳过（已经有 group，重复跑 --apply 也安全）。
 * - 只动 frontmatter，正文逐字节保留；没有 frontmatter 就补一个最小块。
 */
export function buildNextRaw(raw: string, group: string): string | null {
  const fm = readFrontmatterBlock(raw);
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const line = groupLine(group);
  if (fm) {
    if (readFrontmatter(raw)!.hasGroup) return null; // 已有组，别覆盖
    const tagsAt = fm.lines.findIndex((item) => /^tags\s*:/.test(item));
    let insertAt = fm.lines.length;
    if (tagsAt >= 0) {
      // 块状 tags（后面跟 `  - a`）要连同列表项一起跳过，否则会插出非法 YAML
      insertAt = tagsAt + 1;
      while (insertAt < fm.lines.length && /^\s+\S/.test(fm.lines[insertAt])) insertAt += 1;
    }
    const lines = [...fm.lines.slice(0, insertAt), line, ...fm.lines.slice(insertAt)];
    return `${fm.bom}---${eol}${lines.join(eol)}${eol}---${eol}${fm.body}`;
  }
  // 没有 frontmatter：补一个最小的，正文原样接在后面
  return `${raw.startsWith("\uFEFF") ? "\uFEFF" : ""}---${eol}${line}${eol}---${eol}${eol}${raw.replace(/^\uFEFF/, "")}`;
}

export function collectMarkdown(dirAbs: string): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.toLowerCase().endsWith(".md")) out.push(child);
    }
  };
  walk(dirAbs);
  return out.sort();
}

export function main(): void {
  let args: MigrateArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (args.help || !args.group) {
    console.log(USAGE);
    if (!args.group && !args.help) process.exitCode = 1;
    return;
  }

  const check = validateGroupName(args.group);
  if (!check.ok) {
    console.error(`组名不合法：${check.error}`);
    process.exitCode = 1;
    return;
  }
  args.group = check.name;

  const dirAbs = path.resolve(NOTES_ROOT, args.dir || ".");
  // 前缀比较必须带分隔符，否则 "../notes-evil" 也能通过 startsWith
  const inside = dirAbs === NOTES_ROOT || dirAbs.startsWith(NOTES_ROOT + path.sep);
  if (!inside || !fs.existsSync(dirAbs)) {
    console.error(`目录不存在或不在笔记库里：${args.dir || "."}`);
    process.exitCode = 1;
    return;
  }

  const files = collectMarkdown(dirAbs);
  const changed: Array<{ abs: string; rel: string; raw: string; next: string }> = [];
  const skipped: string[] = [];

  for (const abs of files) {
    const raw = fs.readFileSync(abs, "utf8");
    const next = buildNextRaw(raw, args.group);
    const rel = path.relative(NOTES_ROOT, abs).split(path.sep).join("/");
    if (next === null) {
      skipped.push(rel);
      continue;
    }
    changed.push({ abs, rel, raw, next });
  }

  console.log(`目录：${path.relative(ROOT, dirAbs) || "."}`);
  console.log(`分组：${args.group}`);
  console.log(`共 ${files.length} 篇，待改 ${changed.length} 篇，跳过 ${skipped.length} 篇`);
  for (const item of changed) console.log(`  改 ${item.rel}`);
  for (const rel of skipped) console.log(`  跳过（已有 group）${rel}`);

  if (!args.apply) {
    console.log("\ndry-run：什么都没写。确认无误后加 --apply 再跑一次。");
    return;
  }

  for (const item of changed) {
    // 先写临时文件再 rename：迁移期间应用恰好保存同一篇也不会读到半个文件
    const tmp = `${item.abs}.migrating`;
    fs.writeFileSync(tmp, item.next, "utf8");
    fs.renameSync(tmp, item.abs);
  }
  console.log(`\n已写盘 ${changed.length} 篇。重启应用或点「重建索引」，左栏分组里就能看到「${args.group}」。`);
}
