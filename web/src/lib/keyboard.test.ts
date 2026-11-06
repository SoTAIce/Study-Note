import assert from "node:assert/strict";
import test from "node:test";
import { resolveKey } from "./keyboard.ts";

const none = { ctrlKey: false, shiftKey: false, metaKey: false, altKey: false };

test("Ctrl+K → search", () => {
  assert.equal(resolveKey({ ...none, key: "k", ctrlKey: true }), "search");
});

test("Ctrl+N → new", () => {
  assert.equal(resolveKey({ ...none, key: "n", ctrlKey: true }), "new");
});

test("Ctrl+S → save（不是 search）", () => {
  assert.equal(resolveKey({ ...none, key: "s", ctrlKey: true }), "save");
});

test("Ctrl+J → ai", () => {
  assert.equal(resolveKey({ ...none, key: "j", ctrlKey: true }), "ai");
});

test("Ctrl+Shift+Space → capture", () => {
  assert.equal(resolveKey({ ...none, key: " ", ctrlKey: true, shiftKey: true }), "capture");
});

test("Ctrl+Alt+K → null", () => {
  assert.equal(resolveKey({ ...none, key: "k", ctrlKey: true, altKey: true }), null);
});

test("Ctrl+Shift+K → null（严格匹配，不误触发搜索）", () => {
  assert.equal(resolveKey({ ...none, key: "k", ctrlKey: true, shiftKey: true }), null);
});

test("没有修饰键 → null", () => {
  assert.equal(resolveKey({ ...none, key: "k" }), null);
});

test("Meta+K 视同 Ctrl+K（mac 兼容）", () => {
  assert.equal(resolveKey({ ...none, key: "k", metaKey: true }), "search");
});

test("大写 key（CapsLock）也能识别", () => {
  assert.equal(resolveKey({ ...none, key: "K", ctrlKey: true }), "search");
});

test("Ctrl+Shift+F → preview（全屏预览）", () => {
  assert.equal(resolveKey({ ...none, key: "f", ctrlKey: true, shiftKey: true }), "preview");
  assert.equal(resolveKey({ ...none, key: "F", ctrlKey: true, shiftKey: true }), "preview");
});

test("Ctrl+Shift+P → null（只有 F 例外，别顺手接管其它 Shift 组合）", () => {
  assert.equal(resolveKey({ ...none, key: "p", ctrlKey: true, shiftKey: true }), null);
});
