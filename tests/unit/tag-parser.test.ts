import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TagParser, type TagEvent } from '../../src/lib/shared/tag-parser.ts';

const SAMPLE = `好的，我来做一个待办应用。
<summary>新增导出 CSV 按钮，主色改为绿色</summary>
<file path="App.jsx">
const { useState } = React;
function App() { return <div className="p-4">{1 < 2 ? 'a' : 'b'}</div>; }
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
</file>
<file path="./data.json">
{"a": 1}
</file>
<delete path="legacy.js"/>
完成。`;

function run(chunks: string[]) {
  const p = new TagParser();
  const events: TagEvent[] = [];
  for (const c of chunks) events.push(...p.push(c));
  const fin = p.finish();
  events.push(...fin.events);
  return { events, unclosed: fin.unclosedFile };
}

function summarize(events: TagEvent[]) {
  const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
  const files = Object.fromEntries(
    events.filter((e) => e.type === 'file_end').map((e) => [(e as { path: string }).path, (e as { content: string }).content]),
  );
  const starts = events.filter((e) => e.type === 'file_start').map((e) => (e as { path: string }).path);
  const deletes = events.filter((e) => e.type === 'delete').map((e) => (e as { path: string }).path);
  const summary = events.find((e) => e.type === 'summary') as { text: string } | undefined;
  return { text, files, starts, deletes, summary: summary?.text };
}

test('parses the full protocol in one chunk', () => {
  const r = summarize(run([SAMPLE]).events);
  assert.equal(r.summary, '新增导出 CSV 按钮，主色改为绿色');
  assert.deepEqual(r.starts, ['App.jsx', 'data.json']);
  assert.deepEqual(r.deletes, ['legacy.js']);
  assert.match(r.files['App.jsx'], /^const \{ useState \} = React;/);
  assert.match(r.files['App.jsx'], /render\(<App \/>\);$/);
  assert.equal(r.files['data.json'], '{"a": 1}');
  assert.ok(r.text.startsWith('好的，我来做一个待办应用。'));
  assert.ok(r.text.includes('新增导出 CSV 按钮'));
  assert.ok(r.text.trim().endsWith('完成。'));
});

test('gives identical results for every chunking (char by char and random)', () => {
  const whole = summarize(run([SAMPLE]).events);
  const byChar = summarize(run([...SAMPLE]).events);
  assert.deepEqual(byChar, whole);
  for (let seed = 1; seed < 40; seed++) {
    const chunks: string[] = [];
    let i = 0;
    let x = seed;
    while (i < SAMPLE.length) {
      x = (x * 1103515245 + 12345) % 2147483648;
      const n = 1 + (x % 17);
      chunks.push(SAMPLE.slice(i, i + n));
      i += n;
    }
    assert.deepEqual(summarize(run(chunks).events), whole, `seed ${seed}`);
  }
});

test('drops an unclosed file but keeps the others', () => {
  const r = run(['<file path="a.jsx">ok</file><file path="b.jsx">const x = ']);
  assert.equal(r.unclosed, 'b.jsx');
  assert.deepEqual(summarize(r.events).files, { 'a.jsx': 'ok' });
});

test('strips markdown fences inside a file', () => {
  const r = summarize(run(['<file path="App.jsx">\n```jsx\nconst a = 1;\n```\n</file>']).events);
  assert.equal(r.files['App.jsx'], 'const a = 1;');
});

test('treats stray angle brackets in text as text', () => {
  const r = summarize(run(['a < b and <div> and <de', 'f>']).events);
  assert.equal(r.text, 'a < b and <div> and <def>');
});
