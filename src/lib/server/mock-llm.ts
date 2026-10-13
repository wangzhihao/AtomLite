import 'server-only';
import { env } from './env';
import type { EngineerCall, LLMResult } from './llm';

/**
 * 确定性的 Mock LLM：未配置 ANTHROPIC_API_KEY 时使用，便于离线演示和端到端测试。
 * 输出与真实 Engineer 相同的标签协议，按小块流式返回。
 *  - 新建：生成一个可交互的清单应用（标题取自需求）
 *  - 修改：识别颜色关键词改 design.json，并把指令追加到 changes.json
 *  - 指令含 [slow] 时放慢输出（用于测试“停止”），含 [broken] 时生成会报错的代码
 */
const COLORS: [RegExp, string, string][] = [
  [/绿|green/i, '#16a34a', '绿色'],
  [/红|red/i, '#dc2626', '红色'],
  [/蓝|blue/i, '#2563eb', '蓝色'],
  [/紫|purple/i, '#7c3aed', '紫色'],
  [/橙|orange/i, '#ea580c', '橙色'],
  [/粉|pink/i, '#db2777', '粉色'],
  [/黑|深色|dark/i, '#111827', '深色'],
];

const APP_JSX = `const { useState, useEffect } = React;

const DATA = window.__APP_DATA__ || {};
const META = DATA.app || { title: '我的应用', subtitle: '' };
const CHANGES = DATA.changes || [];

function loadItems() {
  try {
    return JSON.parse(localStorage.getItem('items') || '[]');
  } catch {
    return [];
  }
}

function App() {
  const [items, setItems] = useState(loadItems);
  const [text, setText] = useState('');

  useEffect(() => {
    try { localStorage.setItem('items', JSON.stringify(items)); } catch {}
  }, [items]);

  function add(e) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setItems([...items, { id: Date.now(), text: t, done: false }]);
    setText('');
  }

  function toggle(id) {
    setItems(items.map((it) => (it.id === id ? { ...it, done: !it.done } : it)));
  }

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-xl">
        <h1 data-testid="app-title" className="text-3xl font-bold" style={{ color: 'var(--colors-primary)' }}>
          {META.title}
        </h1>
        <p className="mt-2 text-slate-500">{META.subtitle}</p>
        <form onSubmit={add} className="mt-6 flex gap-2">
          <input
            data-testid="item-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="添加一项…"
            className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 outline-none focus:border-slate-400"
          />
          <button
            data-testid="add-btn"
            className="rounded-lg px-4 py-2 font-medium text-white"
            style={{ background: 'var(--colors-primary)' }}
          >
            添加
          </button>
        </form>
        <ul data-testid="items" className="mt-4 space-y-2">
          {items.length === 0 && <li className="text-sm text-slate-400">还没有内容，先添加一项吧。</li>}
          {items.map((it) => (
            <li
              key={it.id}
              onClick={() => toggle(it.id)}
              className={'cursor-pointer rounded-lg bg-white px-3 py-2 shadow-sm ' + (it.done ? 'text-slate-400 line-through' : '')}
            >
              {it.text}
            </li>
          ))}
        </ul>
        {CHANGES.length > 0 && (
          <section data-testid="changes" className="mt-8 rounded-lg border border-dashed border-slate-300 p-4">
            <h2 className="text-sm font-semibold text-slate-600">修改记录</h2>
            <ul className="mt-2 list-disc pl-5 text-sm text-slate-500">
              {CHANGES.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);`;

function titleFrom(req: string) {
  const t = req.replace(/\[(slow|broken)\]/g, '').replace(/^(帮我|请|给我)?(做|生成|创建|写)(一个|个)?/, '').trim();
  return (t || '我的应用').slice(0, 24);
}

function extractInstruction(input: string) {
  const m = /## (?:本轮修改要求|用户需求)\n\n([\s\S]*?)(?:\n\n只输出需要变更的文件|$)/.exec(input);
  return (m?.[1] ?? input).trim();
}

function extractFile(input: string, path: string) {
  const m = new RegExp(`<file path="${path.replace('.', '\\.')}">\\n([\\s\\S]*?)\\n</file>`).exec(input);
  return m?.[1] ?? null;
}

function buildOutput(input: string): string {
  const instruction = extractInstruction(input);
  const isEdit = input.includes('## 本轮修改要求');
  const broken = instruction.includes('[broken]');
  const out: string[] = [];

  if (!isEdit) {
    const title = titleFrom(instruction);
    out.push(`收到。我来做「${title}」：一个可以添加和勾选条目的清单应用，数据保存在本地。\n`);
    out.push(`<summary>新建应用「${title}」，支持添加、勾选条目，数据本地保存</summary>\n`);
    out.push(`<file path="design.json">\n${JSON.stringify({ colors: { primary: '#4f46e5' } })}\n</file>\n`);
    out.push(`<file path="app.json">\n${JSON.stringify({ title, subtitle: `根据需求生成：${instruction.slice(0, 60)}` }, null, 2)}\n</file>\n`);
    out.push(`<file path="App.jsx">\n${broken ? APP_JSX.replace('const [text, setText]', 'const boom = undefined.value;\n  const [text, setText]') : APP_JSX}\n</file>\n`);
    return out.join('');
  }

  const changes: string[] = (() => {
    try {
      return JSON.parse(extractFile(input, 'changes.json') ?? '[]');
    } catch {
      return [];
    }
  })();
  const clean = instruction.replace(/\[(slow|broken)\]/g, '').trim();
  changes.push(clean.slice(0, 80));
  const fixing = /报错|修复|error/i.test(clean);
  if (fixing) {
    out.push('原因是渲染时读取了 undefined 的属性。我去掉了这行有问题的代码，其余逻辑不变。\n');
    out.push('<summary>修复渲染时访问 undefined 属性导致的报错</summary>\n');
    out.push(`<file path="App.jsx">\n${APP_JSX}\n</file>\n`);
    return out.join('');
  }
  const color = COLORS.find(([re]) => re.test(clean));
  const what = color ? `把主色改成${color[2]}，并记录这次修改` : '记录这次修改';
  out.push(`好的，我来${what}。\n`);
  out.push(`<summary>${color ? `主色改为${color[2]}；` : ''}新增修改记录：${clean.slice(0, 40)}</summary>\n`);
  if (color) out.push(`<file path="design.json">\n${JSON.stringify({ colors: { primary: color[1] } })}\n</file>\n`);
  out.push(`<file path="changes.json">\n${JSON.stringify(changes, null, 2)}\n</file>\n`);
  if (broken) out.push(`<file path="App.jsx">\n${APP_JSX.replace('const [text, setText]', 'const boom = undefined.value;\n  const [text, setText]')}\n</file>\n`);
  return out.join('');
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });
}

export async function mockEngineerStream(call: EngineerCall): Promise<LLMResult> {
  const text = buildOutput(call.input);
  const slow = extractInstruction(call.input).includes('[slow]');
  const delay = slow ? 250 : env.mockDelayMs;
  const size = 48;
  for (let i = 0; i < text.length; i += size) {
    await sleep(delay, call.signal);
    call.onText(text.slice(i, i + size));
  }
  return {
    model: 'mock',
    usage: {
      inputTokens: Math.ceil((call.system.length + call.input.length) / 4),
      outputTokens: Math.ceil(text.length / 4),
      cacheReadTokens: 0,
    },
  };
}
