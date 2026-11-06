/**
 * SSE 分块：只负责把字节流切成一个个事件，纯函数，方便单测。
 * 兼容 CRLF（有的代理/网关会把 `\n\n` 改写成 `\r\n\r\n`）和跨 chunk 的半包。
 */
export type SseBlock = { event: string; data: string };

export class SseSplitter {
  private buffer = "";

  /** 吃进一段文本，吐出已经完全成形的块；最后不完整的留在内部缓冲里。 */
  push(chunk: string): SseBlock[] {
    this.buffer += chunk;
    const blocks: SseBlock[] = [];
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      const raw = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const parsed = parseBlock(raw);
      if (parsed) blocks.push(parsed);
    }
    return blocks;
  }

  /** 流结束时把残留的最后一块也交出来（服务器可能不补末尾空行）。 */
  flush(): SseBlock[] {
    const rest = this.buffer;
    this.buffer = "";
    const parsed = rest ? parseBlock(rest) : null;
    return parsed ? [parsed] : [];
  }
}

export function parseBlock(raw: string): SseBlock | null {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}
