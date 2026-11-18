import { jsonBody, request } from "./api.ts";

/** 连读（book-001），字段与 server/book.ts 对齐 */
export type BookNote = {
  id: string;
  title: string;
  path: string;
  group: string | null;
  created: string;
  body: string;
  hash: string;
};

export type BookChapter = ({ kind: "note"; foreign: boolean } & BookNote) | { kind: "missing"; title: string };

export type Book = {
  group: string;
  index: BookNote | null;
  chapters: BookChapter[];
  unlisted: BookNote[];
  otherIndexes: string[];
};

export function getBook(group: string): Promise<Book> {
  return request(`/book?group=${encodeURIComponent(group)}`);
}

/** 没有目录时生成一篇（titles 缺省 = 组里全部笔记）；有目录时把 titles 追加到末尾（要 baseHash）。 */
export function writeBookIndex(input: {
  group: string;
  titles?: string[];
  baseHash?: string;
}): Promise<{ index: { id: string; hash: string }; created: boolean }> {
  return request("/book/index", { method: "POST", body: jsonBody(input) });
}

/** 在此后新建一章（book-002）：建笔记归入该组，并在目录里 after 那一章之后插入链接；没有目录就先生成。 */
export function createBookChapter(input: {
  group: string;
  title: string;
  after?: string;
  baseHash?: string;
}): Promise<{ note: { id: string; hash: string; title: string }; index: { id: string; hash: string; created: boolean } }> {
  return request("/book/chapters", { method: "POST", body: jsonBody(input) });
}
