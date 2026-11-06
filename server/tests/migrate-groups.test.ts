import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildNextRaw, collectMarkdown, parseArgs, readFrontmatter } from "../migrate-groups.ts";
import { parseNote } from "../parse.ts";

test("parseArgs 默认 dry-run，认识 --apply / --group / --dir", () => {
  assert.deepEqual(parseArgs(["--group", "Go 学习", "--dir", "backend-go"]), {
    group: "Go 学习",
    dir: "backend-go",
    apply: false,
    help: false,
  });
  assert.equal(parseArgs(["--group=Go 学习", "--apply"]).apply, true);
  assert.throws(() => parseArgs(["--whatever"]), /不认识的参数/);
});

test("没有 frontmatter 的旧笔记：补最小块，正文原样", () => {
  const raw = "# 标题\n\n正文\n";
  assert.equal(buildNextRaw(raw, "Go 学习"), "---\ngroup: Go 学习\n---\n\n# 标题\n\n正文\n");
});

test("已有 frontmatter 但没 group：插在 tags 后面，其它键不动", () => {
  const raw = "---\nid: n1\ntitle: 甲\ntags: [a]\n---\n正文\n";
  assert.equal(buildNextRaw(raw, "Go 学习"), "---\nid: n1\ntitle: 甲\ntags: [a]\ngroup: Go 学习\n---\n正文\n");
});

test("已经有 group 的笔记返回 null（不覆盖、可重复跑）", () => {
  const raw = "---\nid: n1\ngroup: 别的组\n---\n正文\n";
  assert.equal(readFrontmatter(raw)?.hasGroup, true);
  assert.equal(buildNextRaw(raw, "Go 学习"), null);

  // 幂等：把第一次的结果再喂回去，应当判定为「已处理」
  const once = buildNextRaw("---\nid: n1\n---\n正文\n", "Go 学习");
  assert.ok(once);
  assert.equal(buildNextRaw(once!, "Go 学习"), null);
});

test("CRLF 文件保持 CRLF", () => {
  const raw = "---\r\nid: n1\r\n---\r\n正文\r\n";
  assert.equal(buildNextRaw(raw, "Go 学习"), "---\r\nid: n1\r\ngroup: Go 学习\r\n---\r\n正文\r\n");
});

test("BOM 文件：BOM 留在开头，块内插 group", () => {
  const raw = "\uFEFF---\nid: n1\n---\n正文\n";
  const next = buildNextRaw(raw, "Go 学习");
  assert.ok(next);
  assert.ok(next!.startsWith("\uFEFF---\n"), next!);
  assert.match(next!, /group: Go 学习/);
});

test("collectMarkdown 递归、跳过点目录、只收 .md", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-migrate-"));
  try {
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a.md"), "# a\n");
    fs.writeFileSync(path.join(dir, "sub", "b.md"), "# b\n");
    fs.writeFileSync(path.join(dir, "sub", "c.txt"), "x");
    fs.writeFileSync(path.join(dir, ".hidden", "d.md"), "# d\n");
    const files = collectMarkdown(dir).map((abs: string) => path.relative(dir, abs).split(path.sep).join("/"));
    assert.deepEqual(files, ["a.md", "sub/b.md"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("正文里用 --- 画的分隔线不算 frontmatter：不往里插 group，正文不动", () => {
  const raw = "---\n\n第一段\n\n---\n\n第二段\n";
  const next = buildNextRaw(raw, "Go 学习");
  assert.ok(next);
  // 补的是一个真正在文件最前面的最小块，原来的分隔线原样留在正文里
  assert.equal(next, "---\ngroup: Go 学习\n---\n\n---\n\n第一段\n\n---\n\n第二段\n");
  const parsed = parseNote(next!, { path: "x.md", mtime: "2026-11-02T02:00:00Z" });
  assert.equal(parsed.meta.group, "Go 学习");
  assert.equal(parsed.body, raw, "正文一个字节都不该变");
});

test("组名会被校验（非法字符 / 保留名 / 超长）", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sn-migrate-bad-"));
  try {
    // validateGroupName 在 main() 里调用；这里直接验证它拦得住这些名字
    const { validateGroupName } = await import("../groups.ts");
    assert.equal(validateGroupName("Go/学习").ok, false);
    assert.equal(validateGroupName("未分组").ok, false);
    assert.equal(validateGroupName("none").ok, false);
    assert.equal(validateGroupName("一".repeat(41)).ok, false);
    assert.equal(validateGroupName("Agent: 入门").ok, false, "冒号也不许（跨平台文件名保留字符）");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("块状 tags（后面跟 - a）时 group 插在列表项之后，YAML 仍然合法", () => {
  const raw = "---\nid: n1\ntags:\n  - a\n  - b\n---\n正文\n";
  const next = buildNextRaw(raw, "Go 学习");
  assert.equal(next, "---\nid: n1\ntags:\n  - a\n  - b\ngroup: Go 学习\n---\n正文\n");
});

test("组名需要引号时（比如以 - 开头）写进 YAML 会加引号，应用仍能读回来", () => {
  const next = buildNextRaw("# 标题\n", "-待整理");
  assert.ok(next);
  assert.match(next!, /group: "-待整理"/);
  const parsed = parseNote(next!, { path: "x.md", mtime: "2026-11-02T02:00:00Z" });
  assert.equal(parsed.meta.group, "-待整理");
});
