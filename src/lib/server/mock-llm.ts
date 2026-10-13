import 'server-only';
import { env } from './env';
import type { LLMCall, LLMResult } from './llm';

/**
 * 确定性的 Mock LLM：未配置 ANTHROPIC_API_KEY 时使用，便于离线演示和端到端测试。
 * 每个角色输出与真实模型相同的协议（JSON 或文件标签），按小块流式返回。
 *  - Planner：个人博客类需求（或含 [clarify]）且允许提问时发起澄清，否则给出规格
 *  - Designer：给出设计规范（主色 #4f46e5）
 *  - Engineer 新建：生成一个可交互的清单应用（标题取自需求）
 *  - Engineer 修改：识别颜色关键词改 design.json，并把指令追加到 changes.json
 *  - Fixer：输出修好的 App.jsx
 *  - Advisor：3 条下一步建议
 * 指令含 [slow] 时放慢输出（测试“停止”），含 [broken] 时生成运行时报错的代码，
 * 含 [syntax] 时生成语法错误的代码（测试服务端检查 + 修复回路），含 [stubborn] 时 Fixer 修不好。
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

const MARKERS = /\[(slow|broken|syntax|clarify|stubborn)\]/g;

const BROKEN_JSX = APP_JSX.replace('const [text, setText]', 'const boom = undefined.value;\n  const [text, setText]');
const SYNTAX_JSX = APP_JSX.replace('function add(e) {', 'function add(e) {{');

function titleFrom(req: string) {
  const t = req
    .replace(MARKERS, '')
    .replace(/^(帮我|请|给我)?(做|生成|创建|写)(一个|个)?/, '')
    .trim();
  return (t || '我的应用').slice(0, 24);
}

function section(input: string, title: string) {
  const m = new RegExp(`## ${title}\\n\\n([\\s\\S]*?)(?=\\n\\n## |\\n\\n只输出|\\n\\n允许提问|\\n\\n不允许提问|$)`).exec(input);
  return m?.[1]?.trim() ?? '';
}

function extractFile(input: string, path: string) {
  const m = new RegExp(`<file path="${path.replace('.', '\\.')}">\\n([\\s\\S]*?)\\n</file>`).exec(input);
  return m?.[1] ?? null;
}

function planner(input: string) {
  const req = section(input, '用户需求');
  const allow = input.includes('允许提问：是');
  const title = titleFrom(req.split('\n')[0]);
  const wantsClarify = allow && (/\[clarify\]/.test(req) || /个人.*博客|博客.*个人/.test(req));
  return JSON.stringify(
    {
      message: wantsClarify
        ? '需求拆成 3 个功能点，不过还有几个问题想先确认，好让应用更贴合你。'
        : `需求拆成 3 个功能点：添加条目、勾选完成、本地保存。`,
      needsClarification: wantsClarify,
      questions: wantsClarify
        ? [
            { id: 'name', question: '博客主人的名字或笔名？', placeholder: '例如：小王' },
            { id: 'topics', question: '主要写哪些主题？', placeholder: '例如：量化交易、分布式系统' },
            { id: 'style', question: '喜欢什么风格？', placeholder: '例如：杂志风、极简、深色' },
          ]
        : [],
      appName: title,
      summary: `根据需求生成：${req.replace(MARKERS, '').slice(0, 60)}`,
      features: ['添加条目', '勾选完成', '本地保存'],
      components: ['App'],
      files: ['App.jsx', 'app.json'],
      dataModel: 'items: {id, text, done}[]',
      style: '',
      assumptions: allow ? [] : ['未提供的个人信息使用占位内容'],
    },
    null,
    2,
  );
}

function designer() {
  return JSON.stringify(
    {
      message: '清单类工具适合干净的浅色界面：靛蓝主色、白色卡片、适中圆角，让内容成为焦点。',
      colors: { primary: '#4f46e5', accent: '#f59e0b', background: '#f8fafc', surface: '#ffffff', text: '#0f172a', muted: '#64748b', border: '#e2e8f0' },
      font: { heading: "system-ui, -apple-system, 'PingFang SC', sans-serif", body: "system-ui, -apple-system, 'PingFang SC', sans-serif" },
      radius: '12px',
      spacing: '适中',
      layout: '单列居中，最大宽度 576px',
      componentStyle: '主色实心按钮，白色卡片带轻阴影',
    },
    null,
    2,
  );
}

function engineer(input: string) {
  const editing = input.includes('## 本轮修改要求');
  const instruction = section(input, editing ? '本轮修改要求' : '用户需求');
  const out: string[] = [];

  if (!editing) {
    const specName = /"appName":\s*"([^"]*)"/.exec(input)?.[1];
    const title = specName || titleFrom(instruction);
    let jsx = instruction.includes('[broken]') ? BROKEN_JSX : instruction.includes('[syntax]') ? SYNTAX_JSX : APP_JSX;
    if (instruction.includes('[stubborn]')) jsx = `// [stubborn]\n${jsx}`;
    out.push(`收到。我来做「${title}」：一个可以添加和勾选条目的清单应用，数据保存在本地。\n`);
    out.push(`<summary>新建应用「${title}」，支持添加、勾选条目，数据本地保存</summary>\n`);
    if (!input.includes('<file path="design.json">')) {
      out.push(`<file path="design.json">\n${JSON.stringify({ colors: { primary: '#4f46e5' } })}\n</file>\n`);
    }
    out.push(`<file path="app.json">\n${JSON.stringify({ title, subtitle: `根据需求生成：${instruction.replace(MARKERS, '').slice(0, 60)}` }, null, 2)}\n</file>\n`);
    out.push(`<file path="App.jsx">\n${jsx}\n</file>\n`);
    return out.join('');
  }

  const changes: string[] = (() => {
    try {
      return JSON.parse(extractFile(input, 'changes.json') ?? '[]');
    } catch {
      return [];
    }
  })();
  const clean = instruction.replace(MARKERS, '').trim();
  changes.push(clean.slice(0, 80));
  const color = COLORS.find(([re]) => re.test(clean));
  const what = color ? `把主色改成${color[2]}，并记录这次修改` : '记录这次修改';
  out.push(`好的，我来${what}。\n`);
  out.push(`<summary>${color ? `主色改为${color[2]}；` : ''}新增修改记录：${clean.slice(0, 40)}</summary>\n`);
  if (color) {
    let design: Record<string, unknown> = {};
    try {
      design = JSON.parse(extractFile(input, 'design.json') ?? '{}');
    } catch {
      /* 用空规范 */
    }
    const colors = { ...((design.colors as Record<string, string>) ?? {}), primary: color[1] };
    out.push(`<file path="design.json">\n${JSON.stringify({ ...design, colors }, null, 2)}\n</file>\n`);
  }
  out.push(`<file path="changes.json">\n${JSON.stringify(changes, null, 2)}\n</file>\n`);
  if (instruction.includes('[broken]')) out.push(`<file path="App.jsx">\n${BROKEN_JSX}\n</file>\n`);
  if (instruction.includes('[syntax]')) out.push(`<file path="App.jsx">\n${SYNTAX_JSX}\n</file>\n`);
  return out.join('');
}

function fixer(input: string) {
  const app = extractFile(input, 'App.jsx') ?? '';
  // [stubborn]：保留原样（用于测试“同一错误重复即停止”）
  if (app.includes('[stubborn]') || input.includes('[stubborn]')) {
    return `我看了一下，问题比较隐蔽，先尝试保持原样。\n<summary>尝试修复（未成功）</summary>\n<file path="App.jsx">\n${app}\n</file>\n`;
  }
  const syntax = input.includes('[syntax]');
  const reason = syntax ? '原因是 add 函数里多了一个花括号，导致语法错误' : '原因是渲染时读取了 undefined 的属性';
  return `${reason}。我去掉了出错的代码，其余逻辑不变。\n<summary>修复：${syntax ? '多余花括号导致的语法错误' : '渲染时访问 undefined 属性的报错'}</summary>\n<file path="App.jsx">\n${APP_JSX}\n</file>\n`;
}

function advisor() {
  return JSON.stringify({ suggestions: ['主色改成绿色', '加一个导出 CSV 按钮', '改成深色主题'] });
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

export async function mockStream(call: LLMCall): Promise<LLMResult> {
  const text =
    call.role === 'planner'
      ? planner(call.input)
      : call.role === 'designer'
        ? designer()
        : call.role === 'fixer'
          ? fixer(call.input)
          : call.role === 'advisor'
            ? advisor()
            : engineer(call.input);
  const slow = call.role === 'engineer' && /\[slow\]/.test(section(call.input, '本轮修改要求') + section(call.input, '用户需求'));
  const delay = slow ? 250 : env.mockDelayMs;
  const size = 48;
  for (let i = 0; i < text.length; i += size) {
    await sleep(delay, call.signal);
    call.onText?.(text.slice(i, i + size));
  }
  return {
    model: 'mock',
    text,
    usage: {
      inputTokens: Math.ceil((call.system.length + call.input.length) / 4),
      outputTokens: Math.ceil(text.length / 4),
      cacheReadTokens: 0,
      costUsd: 0,
    },
  };
}
