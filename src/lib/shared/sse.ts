/** 极简 SSE 解析：输入任意分块的文本，输出完整事件；以 ':' 开头的注释行（心跳）被忽略 */
export class SSEParser {
  private buf = '';

  push(chunk: string): { event: string; data: unknown }[] {
    this.buf += chunk.replace(/\r\n/g, '\n');
    const out: { event: string; data: unknown }[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (!data.length) continue;
      const text = data.join('\n');
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* 保留原始文本 */
      }
      out.push({ event, data: parsed });
    }
    return out;
  }
}

export function encodeSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
