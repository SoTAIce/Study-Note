import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const e2ePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "e2e.mjs");

/**
 * test-002：Playwright 的 page.waitForFunction 遇到 async 判断函数不会等它的结果
 * （返回的 Promise 本身算真值，立刻放行），这样写的「等落盘」其实没在等。
 * 要等服务端状态时用 e2e.mjs 里的 until()（在 Node 这边轮询）。
 */
test("E2E 脚本里没有 async 判断函数的 waitForFunction", () => {
  const source = fs.readFileSync(e2ePath, "utf8");
  const offenders: number[] = [];
  for (const match of source.matchAll(/waitForFunction\(\s*async\b/g)) {
    offenders.push(source.slice(0, match.index).split("\n").length);
  }
  assert.deepEqual(offenders, [], `scripts/e2e.mjs 第 ${offenders.join("、")} 行：改用 until() 轮询`);
});
