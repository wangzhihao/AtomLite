import type { Files } from './types';

/**
 * 预览组装器（设计文档第 6 节）：把版本文件组装成一份 HTML，以 srcdoc 注入
 * 不含 allow-same-origin 的沙箱 iframe。顺序：桥接脚本 → 白名单库 → CSS → 数据 → JSX。
 */
export const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups';
export const PREVIEW_SOURCE = 'atoms-preview';
/** 父页面发给 iframe 的消息来源标记（验收 QA 指令） */
export const PARENT_SOURCE = 'atoms-parent';

export type PreviewOptions = {
  /** 自托管库的绝对地址前缀，如 https://example.com/vendor */
  vendorBase: string;
  /** 存储垫片的初始数据（父页面按项目持久化） */
  storage?: Record<string, string>;
  /** 验收模式：存储不回写父页面、屏蔽弹窗，并接受父页面下发的交互测试 */
  qa?: boolean;
  /** false 时存储写入不回写父页面（缩略图等只读场景），默认 true */
  persist?: boolean;
};

const DEFAULT_INDEX = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>App</title>
</head>
<body>
<div id="root"></div>
</body>
</html>`;

export function isScriptFile(p: string) {
  return /\.(jsx|js|tsx)$/i.test(p);
}

/** JSX 按文件名排序拼接，App.jsx 最后加载并负责挂载 */
export function scriptOrder(files: Files): string[] {
  const scripts = Object.keys(files).filter(isScriptFile);
  const app = scripts.filter((p) => /(^|\/)app\.(jsx|js|tsx)$/i.test(p));
  const rest = scripts.filter((p) => !app.includes(p)).sort();
  return [...rest, ...app];
}

/**
 * Tailwind v4 用这些主题变量计算工具类（例如 p-4 = calc(var(--spacing) * 4)）。
 * design.json 里的同名键（如 "spacing": "适中"）会把整套间距弄坏，所以加上 design- 前缀避开。
 */
const TAILWIND_RESERVED = /^(spacing|color-|text-|font-(sans|serif|mono|weight)|radius-|shadow-|inset-shadow-|drop-shadow-|blur-|breakpoint-|container-|leading-|tracking-|ease-|animate-|perspective-|aspect-|default-|tw-)/;

export function cssVarName(path: string[]) {
  const name = path.map((p) => p.replace(/[^a-zA-Z0-9-]/g, '-')).join('-');
  return TAILWIND_RESERVED.test(name) || name === 'spacing' ? `design-${name}` : name;
}

export function designToCssVars(design: unknown): string {
  const vars: string[] = [];
  const walk = (v: unknown, path: string[]) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) walk(child, [...path, k]);
    } else if (typeof v === 'string' || typeof v === 'number') {
      const name = cssVarName(path);
      const value = String(v).replace(/[;{}<>]/g, '');
      if (path.length) vars.push(`--${name}: ${value};`);
    }
  };
  walk(design, []);
  return vars.length ? `:root { ${vars.join(' ')} }` : '';
}

/** 防止文件内容提前闭合 <script> / <style> */
function escapeScript(s: string) {
  return s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}
function escapeStyle(s: string) {
  return s.replace(/<\/(style)/gi, '<\\/$1');
}
function jsonForScript(v: unknown) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * 验收 QA 执行器（注入 iframe）：按声明式步骤操作真实页面并回报结果。
 * 定位：testid= / placeholder= / text= / css=；每步最多等待 1.5 秒元素出现。
 */
const QA_RUNNER = `
function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}
function visible(el){if(!el)return false;var r=el.getBoundingClientRect();var st=getComputedStyle(el);return (r.width>0||r.height>0)&&st.visibility!=='hidden'&&st.display!=='none';}
function txt(x){return (x.innerText||x.textContent||'').replace(/\\s+/g,' ').trim();}
function find(target){
  var i=target.indexOf('=');var kind=i>0?target.slice(0,i):'text';var v=i>0?target.slice(i+1):target;
  if(kind==='testid')return document.querySelector('[data-testid="'+CSS.escape(v)+'"]');
  if(kind==='css'){try{return document.querySelector(v);}catch(e){return null;}}
  if(kind==='placeholder'){var ins=[].slice.call(document.querySelectorAll('input,textarea'));return ins.filter(function(x){return (x.placeholder||'').indexOf(v)>=0;})[0]||null;}
  var all=[].slice.call(document.querySelectorAll('button,a,[role=button],label,summary,li,span,div,p,h1,h2,h3,h4,td,th'));
  var exact=all.filter(function(x){return txt(x)===v&&visible(x);});
  var pref=function(x){return x.tagName==='BUTTON'||x.tagName==='A'||x.getAttribute('role')==='button'?1:0;};
  exact.sort(function(a,b){return pref(b)-pref(a);});
  if(exact.length)return exact[0];
  var inc=all.filter(function(x){return txt(x).indexOf(v)>=0&&visible(x);});
  inc.sort(function(a,b){return txt(a).length-txt(b).length;});
  return inc[0]||null;
}
async function waitFor(fn,ms){var end=Date.now()+ms;while(Date.now()<end){var r=fn();if(r)return r;await sleep(100);}return fn();}
function setValue(el,v){var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;var d=Object.getOwnPropertyDescriptor(proto,'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
async function runQA(tests){
  var results=[];
  for(var t of tests){
    var err=null;
    try{
      for(var s of t.steps){
        if(s.action==='wait'){await sleep(s.ms);continue;}
        if(s.action==='expectText'){var ok=await waitFor(function(){return txt(document.body).indexOf(s.text)>=0;},1500);if(!ok)throw new Error('页面上没有出现「'+s.text+'」');continue;}
        var el=await waitFor(function(){return find(s.target);},1500);
        if(!el)throw new Error('找不到元素 '+s.target);
        if(s.action==='expectVisible'){if(!visible(el))throw new Error('元素不可见 '+s.target);continue;}
        if(s.action==='fill'){el.focus();setValue(el,s.value);await sleep(50);continue;}
        if(s.action==='click'){el.click();await sleep(200);continue;}
      }
    }catch(e){err=String(e&&e.message||e);}
    results.push({feature:t.feature,ok:!err,error:err||undefined});
  }
  return results;
}
window.addEventListener('message',function(e){
  if(e.source!==parent)return;var m=e.data;
  if(!m||m.source!==${JSON.stringify(PARENT_SOURCE)}||m.type!=='run_qa')return;
  runQA(m.tests||[]).then(function(r){post('qa_result',{results:r});},function(err){post('qa_result',{results:[],error:String(err)});});
});
window.alert=function(){};window.confirm=function(){return true;};window.prompt=function(){return '';};
`;

export function bridgeScript(storage: Record<string, string>, qa = false, persist = true): string {
  return `(function(){
var SOURCE=${JSON.stringify(PREVIEW_SOURCE)};
function post(type,data){try{parent.postMessage({source:SOURCE,type:type,data:data},'*');}catch(e){}}
window.__atomsPost=post;
window.addEventListener('error',function(e){post('runtime_error',{message:String(e.message||e.error||'Script error'),line:e.lineno||null});});
window.addEventListener('unhandledrejection',function(e){post('runtime_error',{message:String(e.reason&&e.reason.message||e.reason)});});
var rawError=console.error;
console.error=function(){var a=[].slice.call(arguments);post('console_error',{message:a.map(function(x){try{return x instanceof Error?x.message:typeof x==='object'?JSON.stringify(x):String(x);}catch(_){return String(x);}}).join(' ').slice(0,2000)});rawError.apply(console,a);};
function makeStorage(seed,persist){var m=new Map(Object.entries(seed||{}));var api={
getItem:function(k){k=String(k);return m.has(k)?m.get(k):null;},
setItem:function(k,v){m.set(String(k),String(v));if(persist)post('storage_set',{key:String(k),value:String(v)});},
removeItem:function(k){m.delete(String(k));if(persist)post('storage_remove',{key:String(k)});},
clear:function(){m.clear();if(persist)post('storage_clear',{});},
key:function(i){return Array.from(m.keys())[i]||null;}};
Object.defineProperty(api,'length',{get:function(){return m.size;}});return api;}
try{Object.defineProperty(window,'localStorage',{value:makeStorage(${jsonForScript(storage)},${qa || !persist ? 'false' : 'true'}),configurable:true});}catch(e){}
try{Object.defineProperty(window,'sessionStorage',{value:makeStorage({},false),configurable:true});}catch(e){}
window.addEventListener('load',function(){setTimeout(function(){var r=document.getElementById('root');post('rendered',{empty:!!(r&&!r.children.length&&!r.textContent.trim())});},${qa ? 800 : 3000});});
${qa ? QA_RUNNER : ''}
})();`;
}

export function buildPreviewHtml(files: Files, opts: PreviewOptions): string {
  const base = opts.vendorBase.replace(/\/$/, '');
  const head: string[] = [];
  const body: string[] = [];

  head.push(`<script>${escapeScript(bridgeScript(opts.storage ?? {}, opts.qa, opts.persist ?? true))}</script>`);
  for (const lib of ['react.js', 'react-dom.js', 'babel.js', 'tailwind.js']) {
    head.push(`<script src="${base}/${lib}"></script>`);
  }

  const data: Record<string, unknown> = {};
  for (const [path, content] of Object.entries(files)) {
    if (!/\.json$/i.test(path)) continue;
    try {
      const parsed = JSON.parse(content);
      data[path] = parsed;
      data[path.replace(/^.*\//, '').replace(/\.json$/i, '')] = parsed;
      if (/(^|\/)design\.json$/i.test(path)) {
        const css = designToCssVars(parsed);
        if (css) head.push(`<style data-file="${path}">${escapeStyle(css)}</style>`);
      }
    } catch {
      body.push(
        `<script>window.__atomsPost&&window.__atomsPost('runtime_error',{message:${JSON.stringify(`数据文件 ${path} 不是合法的 JSON`)}});</script>`,
      );
    }
  }
  for (const [path, content] of Object.entries(files)) {
    if (/\.css$/i.test(path)) head.push(`<style data-file="${path}">${escapeStyle(content)}</style>`);
  }
  body.push(`<script>window.__APP_DATA__=${jsonForScript(data)};</script>`);
  for (const path of scriptOrder(files)) {
    body.push(`<script type="text/babel" data-presets="react" data-file="${path}">\n${escapeScript(files[path])}\n</script>`);
  }

  let html = files['index.html'] && /<\/body>/i.test(files['index.html']) ? files['index.html'] : DEFAULT_INDEX;
  html = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => `${m}\n${head.join('\n')}`)
    : `${head.join('\n')}\n${html}`;
  const lastBody = html.toLowerCase().lastIndexOf('</body>');
  html = html.slice(0, lastBody) + body.join('\n') + '\n' + html.slice(lastBody);
  return html;
}
