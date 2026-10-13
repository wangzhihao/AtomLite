import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPreviewHtml, designToCssVars, scriptOrder } from '../../src/lib/shared/preview.ts';
import { SSEParser, encodeSSE } from '../../src/lib/shared/sse.ts';

const files = {
  'App.jsx': 'function App(){return <div>hi</div>}\nReactDOM.createRoot(document.getElementById("root")).render(<App/>);',
  'components.jsx': 'function Card(){return null}',
  'styles.css': 'body{margin:0}',
  'posts.json': '[{"title":"</script><script>alert(1)</script>"}]',
  'design.json': '{"colors":{"primary":"#16a34a"},"radius":"8px"}',
};

test('script order puts App.jsx last', () => {
  assert.deepEqual(scriptOrder(files), ['components.jsx', 'App.jsx']);
});

test('assembles html with bridge first, vendor libs, data, css vars', () => {
  const html = buildPreviewHtml(files, { vendorBase: 'https://x.test/vendor/' });
  const iBridge = html.indexOf('atoms-preview');
  const iReact = html.indexOf('https://x.test/vendor/react.js');
  const iData = html.indexOf('window.__APP_DATA__');
  const iComp = html.indexOf('data-file="components.jsx"');
  const iApp = html.indexOf('data-file="App.jsx"');
  assert.ok(iBridge > 0 && iBridge < iReact && iReact < iData && iData < iComp && iComp < iApp);
  assert.ok(html.includes('--colors-primary: #16a34a;'));
  assert.ok(html.includes('--radius: 8px;'));
  assert.ok(html.includes('body{margin:0}'));
  // 数据里的 </script> 不能提前闭合标签
  assert.ok(!html.includes('</script><script>alert(1)'));
  assert.ok(html.includes('<div id="root"></div>'));
});

test('invalid json reports a runtime error instead of crashing', () => {
  const html = buildPreviewHtml({ 'App.jsx': 'x', 'bad.json': '{' }, { vendorBase: '/vendor' });
  assert.ok(html.includes('bad.json'));
});

test('designToCssVars ignores arrays and sanitises values', () => {
  assert.equal(designToCssVars({ a: [1], b: 'red;}' }), ':root { --b: red; }');
});

test('sse round trip with heartbeat and arbitrary chunking', () => {
  const wire = ': ping\n\n' + encodeSSE('file_done', { path: 'App.jsx', bytes: 3 }) + encodeSSE('run_finished', { status: 'succeeded' });
  const p = new SSEParser();
  const got = [...wire].flatMap((c) => p.push(c));
  assert.deepEqual(got, [
    { event: 'file_done', data: { path: 'App.jsx', bytes: 3 } },
    { event: 'run_finished', data: { status: 'succeeded' } },
  ]);
});
