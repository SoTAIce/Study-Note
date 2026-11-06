import { test } from "node:test";
import assert from "node:assert/strict";
import { SseSplitter } from "./sse.ts";

test("按 \\n\\n 切块并取 event/data", () => {
  const splitter = new SseSplitter();
  const blocks = splitter.push('event: text\ndata: {"delta":"你"}\n\nevent: done\ndata: {"type":"done"}\n\n');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].event, "text");
  assert.equal(blocks[0].data, '{"delta":"你"}');
  assert.equal(blocks[1].event, "done");
});

test("CRLF 也能切开（有些代理会把换行改写）", () => {
  const splitter = new SseSplitter();
  const blocks = splitter.push('event: text\r\ndata: {"delta":"a"}\r\n\r\nevent: text\r\ndata: {"delta":"b"}\r\n\r\n');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].data, '{"delta":"b"}');
});

test("跨 chunk 的半包要攒起来再切", () => {
  const splitter = new SseSplitter();
  assert.equal(splitter.push('event: text\ndata: {"del').length, 0);
  const blocks = splitter.push('ta":"x"}\n\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].data, '{"delta":"x"}');
});

test("心跳注释行被忽略", () => {
  const splitter = new SseSplitter();
  const blocks = splitter.push(": ping\n\n: ping\n\nevent: text\ndata: {}\n\n");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].event, "text");
});

test("末尾没有空行的最后一块，flush 时也要交出来", () => {
  const splitter = new SseSplitter();
  const blocks = splitter.push('event: done\ndata: {"type":"done"}');
  assert.equal(blocks.length, 0);
  const tail = splitter.flush();
  assert.equal(tail.length, 1);
  assert.equal(tail[0].event, "done");
});
