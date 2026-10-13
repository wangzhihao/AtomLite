/**
 * Engineer / Fixer 输出协议的增量解析器（设计文档第 5 节）：
 *   说明文字 <summary>…</summary> <file path="App.jsx">…</file> <delete path="x"/>
 * 可以边流边解析；未闭合的 file 标签在 finish() 时整段丢弃，其余文件不受影响。
 */
export type TagEvent =
  | { type: 'text'; text: string }
  | { type: 'summary'; text: string }
  | { type: 'file_start'; path: string }
  | { type: 'file_end'; path: string; content: string }
  | { type: 'delete'; path: string };

const OPENERS = ['<summary>', '</summary>', '<file ', '<delete '];

export class TagParser {
  private buf = '';
  private state: 'text' | 'summary' | 'file' = 'text';
  private filePath = '';
  private summary = '';

  push(chunk: string): TagEvent[] {
    this.buf += chunk;
    const out: TagEvent[] = [];
    for (;;) {
      if (this.state === 'file') {
        const end = this.buf.indexOf('</file>');
        if (end < 0) return out; // 文件内容只在闭合时一次性下发
        out.push({ type: 'file_end', path: this.filePath, content: cleanContent(this.buf.slice(0, end)) });
        this.buf = this.buf.slice(end + '</file>'.length);
        this.state = 'text';
        continue;
      }
      if (this.state === 'summary') {
        const end = this.buf.indexOf('</summary>');
        if (end < 0) {
          const safe = this.buf.length - ('</summary>'.length - 1);
          if (safe > 0) {
            this.emitSummary(out, this.buf.slice(0, safe));
            this.buf = this.buf.slice(safe);
          }
          return out;
        }
        this.emitSummary(out, this.buf.slice(0, end));
        out.push({ type: 'summary', text: this.summary.trim() });
        this.buf = this.buf.slice(end + '</summary>'.length);
        this.state = 'text';
        continue;
      }
      // state === 'text'
      const lt = this.buf.indexOf('<');
      if (lt < 0) {
        if (this.buf) out.push({ type: 'text', text: this.buf });
        this.buf = '';
        return out;
      }
      if (lt > 0) {
        out.push({ type: 'text', text: this.buf.slice(0, lt) });
        this.buf = this.buf.slice(lt);
      }
      const rest = this.buf;
      if (rest.startsWith('<summary>')) {
        this.state = 'summary';
        this.buf = rest.slice('<summary>'.length);
        continue;
      }
      const file = /^<file\s+path\s*=\s*"([^"]+)"\s*>/.exec(rest);
      if (file) {
        this.state = 'file';
        this.filePath = normalizePath(file[1]);
        this.buf = rest.slice(file[0].length);
        out.push({ type: 'file_start', path: this.filePath });
        continue;
      }
      const del = /^<delete\s+path\s*=\s*"([^"]+)"\s*\/?>/.exec(rest);
      if (del) {
        out.push({ type: 'delete', path: normalizePath(del[1]) });
        this.buf = rest.slice(del[0].length);
        continue;
      }
      if (couldBecomeTag(rest)) return out; // 等待更多输入
      out.push({ type: 'text', text: '<' });
      this.buf = rest.slice(1);
    }
  }

  /** 结束解析；返回被丢弃的未闭合文件路径（若有） */
  finish(): { events: TagEvent[]; unclosedFile: string | null } {
    const events: TagEvent[] = [];
    let unclosedFile: string | null = null;
    if (this.state === 'file') unclosedFile = this.filePath;
    else if (this.state === 'summary') {
      this.emitSummary(events, this.buf);
      events.push({ type: 'summary', text: this.summary.trim() });
    } else if (this.buf) events.push({ type: 'text', text: this.buf });
    this.buf = '';
    this.state = 'text';
    return { events, unclosedFile };
  }

  private emitSummary(out: TagEvent[], text: string) {
    if (!text) return;
    this.summary += text;
    out.push({ type: 'text', text });
  }
}

function couldBecomeTag(s: string): boolean {
  // 还没收到 '>' 且是某个开标签的前缀，就继续等
  if (s.includes('>')) return false;
  if (s.length > 300) return false;
  return OPENERS.some((o) => o.startsWith(s) || s.startsWith(o));
}

function normalizePath(p: string): string {
  return p.trim().replace(/^\.?\/+/, '');
}

/** 去掉首尾空行，以及模型偶尔包裹的 ``` 代码围栏 */
export function cleanContent(raw: string): string {
  let s = raw.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
  const fence = /^\s*```[\w.-]*\r?\n([\s\S]*?)\r?\n\s*```\s*$/.exec(s);
  if (fence) s = fence[1];
  return s;
}
