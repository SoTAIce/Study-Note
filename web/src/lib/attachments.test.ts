import { test } from "node:test";
import assert from "node:assert/strict";
import { imageInsertText, MAX_IMAGE_BYTES, pickImages } from "./attachments.ts";

const f = (type: string, size = 100, name = "x") => ({ type, size, name });

test("pickImages：只收支持的图片；剪贴板有文字时以文字为准", () => {
  assert.equal(pickImages([f("image/png"), f("image/jpeg")]).accept.length, 2);
  assert.deepEqual(pickImages([f("image/png")], "从网页复制的文字"), { accept: [], rejected: null });
  const svg = pickImages([f("image/svg+xml"), f("image/png")]);
  assert.equal(svg.accept.length, 1);
  assert.match(svg.rejected ?? "", /只支持/);
  assert.match(pickImages([f("image/png", MAX_IMAGE_BYTES + 1)]).rejected ?? "", /超过 15MB/);
  assert.match(pickImages([f("application/pdf")]).rejected ?? "", /只支持/);
  assert.deepEqual(pickImages([]), { accept: [], rejected: null });
});

test("imageInsertText：多张空一行；行中间先换行", () => {
  assert.equal(imageInsertText(["![](a.png)"], ""), "![](a.png)");
  assert.equal(imageInsertText(["![](a.png)"], "\n"), "![](a.png)");
  assert.equal(imageInsertText(["![](a.png)", "![](b.png)"], "字"), "\n![](a.png)\n\n![](b.png)");
});
