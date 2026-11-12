import assert from "node:assert/strict";
import test from "node:test";
import { diffLines, diffStats, foldUnchanged } from "./diff.ts";

const kinds = (text: string, next: string) => diffLines(text, next).map((l) => `${l.kind[0]}:${l.text}`);

test("完全相同：全是 same", () => {
  assert.deepEqual(kinds("a\nb", "a\nb"), ["s:a", "s:b"]);
});

test("新增、删除、修改", () => {
  assert.deepEqual(kinds("a\nb\nc", "a\nx\nc\nd"), ["s:a", "d:b", "a:x", "s:c", "a:d"]);
  assert.deepEqual(diffStats(diffLines("a\nb\nc", "a\nx\nc\nd")), { added: 2, removed: 1 });
});

test("空文本", () => {
  assert.deepEqual(kinds("", "a\nb"), ["a:a", "a:b"]);
  assert.deepEqual(kinds("a", ""), ["d:a"]);
  assert.deepEqual(kinds("", ""), []);
});

test("中间插入不打乱前后相同行", () => {
  assert.deepEqual(kinds("1\n2\n3\n4", "1\n2\nnew\n3\n4"), ["s:1", "s:2", "a:new", "s:3", "s:4"]);
});

test("CRLF 与 LF 视为同一行", () => {
  assert.deepEqual(kinds("a\r\nb", "a\nb"), ["s:a", "s:b"]);
});

test("折叠远离改动的相同行", () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
  const after = before.replace("l10", "changed");
  const rows = foldUnchanged(diffLines(before, after), 2);
  assert.deepEqual(rows[0], { kind: "fold", count: 8 });
  assert.equal(rows.filter((r) => r.kind === "same").length, 4);
  assert.deepEqual(rows[rows.length - 1], { kind: "fold", count: 7 });
});

test("超大中间段退化为整段删 + 整段增", () => {
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
  const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
  const stats = diffStats(diffLines(a, b));
  assert.deepEqual(stats, { added: 3000, removed: 3000 });
});
