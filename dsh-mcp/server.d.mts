/**
 * `dsh-mcp/server.mjs` 的类型声明：供 server/tests/mcp.test.ts 与 `pnpm typecheck` 使用，
 * 运行时没有任何代码。实现见同目录 server.mjs。
 */

export type SessionOptions = {
  /** 仓库根目录，默认 process.env.STUDY_NOTES_DIR ?? "D:\\work\\study-notes" */
  root?: string;
  /** 数据目录，默认 process.env.STUDY_DATA ?? <root>/data */
  dataDir?: string;
  /** 笔记目录，默认 <dataDir>/notes */
  notesDir?: string;
  /** 索引库路径，默认 <dataDir>/index.db（只读打开） */
  dbFile?: string;
  /** App 的单文件重建索引接口，默认 http://127.0.0.1:7777/api/index/file */
  indexUrl?: string;
  /** 时钟注入，测试用 */
  now?: () => Date;
  /** fetch 注入，测试用 */
  fetchImpl?: typeof fetch;
};

export type McpSession = {
  /** 处理一行 JSON-RPC；返回要写回 stdout 的 JSON 字符串，通知/空行返回 null。 */
  handle(line: string): Promise<string | null>;
};

export declare function createSession(opts?: SessionOptions): McpSession;
