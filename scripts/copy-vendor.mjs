// 把预览沙箱需要的白名单库复制到 public/vendor/，自托管，不依赖海外 CDN
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'public', 'vendor');
mkdirSync(out, { recursive: true });

function findTailwind() {
  const dist = join(nm, '@tailwindcss', 'browser', 'dist');
  if (!existsSync(dist)) return null;
  const f = readdirSync(dist).find((n) => n.endsWith('.global.js')) ?? readdirSync(dist).find((n) => n.endsWith('.js'));
  return f ? join(dist, f) : null;
}

const files = [
  [join(nm, 'react-umd', 'umd', 'react.production.min.js'), 'react.js'],
  [join(nm, 'react-dom-umd', 'umd', 'react-dom.production.min.js'), 'react-dom.js'],
  [join(nm, '@babel', 'standalone', 'babel.min.js'), 'babel.js'],
  [findTailwind(), 'tailwind.js'],
];

let missing = 0;
for (const [src, name] of files) {
  if (src && existsSync(src)) cpSync(src, join(out, name));
  else {
    missing++;
    console.warn(`[copy-vendor] missing source for ${name}`);
  }
}
console.log(`[copy-vendor] ${files.length - missing}/${files.length} vendor files copied to public/vendor`);
