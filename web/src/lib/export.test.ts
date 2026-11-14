import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_EXPORT_PREFS, fileNameFromDisposition, parseExportPrefs } from "./export.ts";

test("导出选项：默认手机版式、浅色、带标题信息；坏数据回到默认", () => {
  assert.deepEqual(parseExportPrefs(null), DEFAULT_EXPORT_PREFS);
  assert.deepEqual(DEFAULT_EXPORT_PREFS, { layout: "phone", dark: false, meta: true });
  assert.deepEqual(parseExportPrefs("not json"), DEFAULT_EXPORT_PREFS);
  assert.deepEqual(parseExportPrefs("null"), DEFAULT_EXPORT_PREFS);
  assert.deepEqual(parseExportPrefs('{"layout":"a4","dark":true,"meta":false}'), { layout: "a4", dark: true, meta: false });
  assert.deepEqual(parseExportPrefs('{"layout":"letter","dark":"yes"}'), DEFAULT_EXPORT_PREFS);
});

test("下载文件名：优先 UTF-8 编码的中文名，其次普通 filename，都没有用兜底", () => {
  const header = `attachment; filename="note.pdf"; filename*=UTF-8''${encodeURIComponent("反向传播.pdf")}`;
  assert.equal(fileNameFromDisposition(header, "x.pdf"), "反向传播.pdf");
  assert.equal(fileNameFromDisposition('attachment; filename="note.pdf"', "x.pdf"), "note.pdf");
  assert.equal(fileNameFromDisposition("attachment; filename*=UTF-8''%E0%A4%A", "x.pdf"), "x.pdf");
  assert.equal(fileNameFromDisposition(null, "x.pdf"), "x.pdf");
});
