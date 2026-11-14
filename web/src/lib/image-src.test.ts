import { test } from "node:test";
import assert from "node:assert/strict";
import { apiFileUrl, embedTarget, imageTarget, normalizeRel } from "./image-src.ts";

test("normalizeRel", () => {
  assert.equal(normalizeRel("a/./b/../c.png"), "a/c.png");
  assert.equal(normalizeRel("/attachments/x.png"), "attachments/x.png");
  assert.equal(normalizeRel("../x.png"), null);
  assert.equal(normalizeRel("a/../../x.png"), null);
});

test("imageTarget：相对笔记目录换算；网络图片、data:image 原样；危险协议和越界不显示", () => {
  assert.deepEqual(imageTarget("attachments/x.png", "note.md"), { local: ["attachments/x.png"] });
  assert.deepEqual(imageTarget("../attachments/x.png", "inbox/idea.md"), { local: ["attachments/x.png"] });
  assert.deepEqual(imageTarget("pic%20one.png", "a/b.md"), { local: ["a/pic one.png"] });
  assert.deepEqual(imageTarget("<attachments/x y.png>", "n.md"), { local: ["attachments/x y.png"] });
  assert.deepEqual(imageTarget("/attachments/x.png", "inbox/idea.md"), { local: ["attachments/x.png"] });
  assert.deepEqual(imageTarget("https://example.com/a.png", "n.md"), { remote: "https://example.com/a.png" });
  assert.deepEqual(imageTarget("data:image/png;base64,AAA", "n.md"), { remote: "data:image/png;base64,AAA" });
  assert.equal(imageTarget("javascript:alert(1)", "n.md"), null);
  assert.equal(imageTarget("file:///C:/secret.png", "n.md"), null);
  assert.equal(imageTarget("//evil.com/x.png", "n.md"), null);
  assert.equal(imageTarget("../../secret.png", "inbox/idea.md"), null);
  assert.equal(imageTarget("..\\..\\secret.png", "inbox/idea.md"), null);
});

test("embedTarget：先笔记目录再 attachments/；带目录的按库根；不是图片不处理", () => {
  assert.deepEqual(embedTarget("x.png", "inbox/idea.md"), { local: ["inbox/x.png", "attachments/x.png"] });
  assert.deepEqual(embedTarget("x.png", "note.md"), { local: ["x.png", "attachments/x.png"] });
  assert.deepEqual(embedTarget("attachments/x.png", "inbox/a.md"), { local: ["attachments/x.png"] });
  assert.equal(embedTarget("某篇笔记", "a.md"), null);
  assert.equal(embedTarget("../x.png", "a.md"), null);
});

test("apiFileUrl：逐段编码，备选位置放 fallback", () => {
  assert.equal(apiFileUrl(["attachments/板书 1.png"]), "/api/files/attachments/%E6%9D%BF%E4%B9%A6%201.png");
  assert.equal(apiFileUrl(["inbox/x.png", "attachments/x.png"]), "/api/files/inbox/x.png?fallback=attachments%2Fx.png");
});
