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

test('designToCssVars never overrides Tailwind theme variables', () => {
  const css = designToCssVars({ spacing: '适中', color: { red: '#f00' }, colors: { primary: '#000' }, radius: '12px', font: { heading: 'serif', sans: 'x' } });
  assert.ok(!/--spacing:/.test(css));
  assert.ok(css.includes('--design-spacing: 适中;'));
  assert.ok(css.includes('--design-color-red: #f00;'));
  assert.ok(css.includes('--design-font-sans: x;'));
  // 约定的变量名保持不变
  assert.ok(css.includes('--colors-primary: #000;'));
  assert.ok(css.includes('--radius: 12px;'));
  assert.ok(css.includes('--font-heading: serif;'));
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

test('three.js is injected only when the generated code uses THREE', () => {
  const plain = buildPreviewHtml({ 'App.jsx': 'function App(){}' }, { vendorBase: '/vendor' });
  const threeD = buildPreviewHtml({ 'Scene.jsx': 'const scene = new THREE.Scene();', 'App.jsx': 'x' }, { vendorBase: '/vendor' });
  assert.ok(!plain.includes('/vendor/three.js'));
  assert.ok(threeD.includes('/vendor/three.js'));
  // 在 React / Babel 之后、应用脚本之前加载
  assert.ok(threeD.indexOf('/vendor/babel.js') < threeD.indexOf('/vendor/three.js'));
  assert.ok(threeD.indexOf('/vendor/three.js') < threeD.indexOf('data-file="Scene.jsx"'));
  // 只看脚本文件：JSON 数据里出现 THREE 不算
  assert.ok(!buildPreviewHtml({ 'App.jsx': 'x', 'posts.json': '["THREE"]' }, { vendorBase: '/vendor' }).includes('three.js'));
});

test('persist: false keeps storage writes inside the iframe (thumbnails)', () => {
  const html = buildPreviewHtml({ 'App.jsx': 'x' }, { vendorBase: '/vendor', persist: false });
  assert.ok(html.includes('makeStorage({},false)'));
  assert.ok(!html.includes('run_qa'));
});

test('qa mode injects the runner, stubs dialogs and does not persist storage', () => {
  const normal = buildPreviewHtml({ 'App.jsx': 'x' }, { vendorBase: '/vendor' });
  const qa = buildPreviewHtml({ 'App.jsx': 'x' }, { vendorBase: '/vendor', qa: true });
  assert.ok(!normal.includes('run_qa'));
  assert.ok(qa.includes('run_qa'));
  assert.ok(qa.includes('window.confirm=function(){return true;}'));
  assert.ok(normal.includes('makeStorage({},true)'));
  assert.ok(qa.includes('makeStorage({},false)'));
});
