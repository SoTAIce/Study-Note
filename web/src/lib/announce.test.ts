import assert from "node:assert/strict";
import test from "node:test";
import { ANNOUNCE_MAX, aiAnnouncement } from "./announce.ts";

test("aiAnnouncement：生成中只播一句，不读半截内容", () => {
  assert.equal(aiAnnouncement({ busy: true, text: "已经出来的半句" }), "AI 正在生成回复…");
});

test("aiAnnouncement：完成后读完整回复，空白压成一个空格", () => {
  assert.equal(aiAnnouncement({ busy: false, text: "第一行\n\n第二行" }), "AI 回复完成：第一行 第二行");
  assert.equal(aiAnnouncement({ busy: false, text: "  " }), "");
});

test("aiAnnouncement：太长截断并提示；出错优先播错误", () => {
  const long = aiAnnouncement({ busy: false, text: "字".repeat(ANNOUNCE_MAX + 50) });
  assert.ok(long.includes("内容较长"));
  assert.ok(long.length < ANNOUNCE_MAX + 40);
  assert.equal(aiAnnouncement({ busy: false, text: "x", error: "超时" }), "AI 出错：超时");
});
