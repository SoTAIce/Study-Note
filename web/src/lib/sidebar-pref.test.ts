import assert from "node:assert/strict";
import test from "node:test";
import { readSidebarCollapsed, SIDEBAR_KEY, writeSidebarCollapsed } from "./sidebar-pref.ts";

function memory(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

test("左栏收起状态：默认展开，写了能读回来", () => {
  const s = memory();
  assert.equal(readSidebarCollapsed(s), false);
  writeSidebarCollapsed(s, true);
  assert.equal(s.getItem(SIDEBAR_KEY), "1");
  assert.equal(readSidebarCollapsed(s), true);
  writeSidebarCollapsed(s, false);
  assert.equal(readSidebarCollapsed(s), false);
});

test("左栏收起状态：存储不可用或抛错时当展开，写入不抛", () => {
  assert.equal(readSidebarCollapsed(null), false);
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  } as unknown as Storage;
  assert.equal(readSidebarCollapsed(broken), false);
  assert.doesNotThrow(() => writeSidebarCollapsed(broken, true));
});
