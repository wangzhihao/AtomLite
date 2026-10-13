import 'server-only';
import { parse } from '@babel/parser';
import type { CheckError, Files } from '@/lib/shared/types';
import { isScriptFile } from '@/lib/shared/preview';

/**
 * 服务端语法检查（设计文档第 5 节自愈回路的第一道关）：
 *  - 每个 JSX / JS 文件用 @babel/parser 解析（经典脚本 + JSX）
 *  - 数据文件用 JSON.parse 校验
 *  - 所有脚本共享全局作用域，跨文件重复声明的顶层 const / let / class 会在浏览器里报错，这里提前拦下
 *  - 必须有 App.jsx，且包含挂载代码
 */
export function checkFiles(files: Files): CheckError[] {
  const errors: CheckError[] = [];
  const lexical = new Map<string, string>(); // 顶层 const/let/class 名称 → 文件

  for (const [path, content] of Object.entries(files)) {
    if (/\.json$/i.test(path)) {
      try {
        JSON.parse(content);
      } catch (e) {
        errors.push({ kind: 'syntax', file: path, message: `JSON 格式错误：${(e as Error).message}` });
      }
      continue;
    }
    if (!isScriptFile(path)) continue;
    try {
      const ast = parse(content, { sourceType: 'script', plugins: ['jsx'], errorRecovery: false });
      for (const node of ast.program.body) {
        const names: string[] = [];
        if (node.type === 'VariableDeclaration' && node.kind !== 'var') {
          for (const d of node.declarations) collectNames(d.id, names);
        } else if (node.type === 'ClassDeclaration' && node.id) names.push(node.id.name);
        for (const n of names) {
          const prev = lexical.get(n);
          if (prev && prev !== path) {
            errors.push({
              kind: 'syntax',
              file: path,
              line: node.loc?.start.line ?? null,
              message: `顶层变量 ${n} 在 ${prev} 和 ${path} 中重复声明（所有脚本共享全局作用域）`,
            });
          } else lexical.set(n, path);
        }
      }
    } catch (e) {
      const err = e as Error & { loc?: { line: number; column: number } };
      errors.push({
        kind: 'syntax',
        file: path,
        line: err.loc?.line ?? null,
        message: `语法错误：${err.message.replace(/\s*\(\d+:\d+\)$/, '')}`,
      });
    }
  }

  const app = Object.keys(files).find((p) => /(^|\/)app\.(jsx|js)$/i.test(p));
  if (!app) errors.push({ kind: 'syntax', message: '缺少入口文件 App.jsx' });
  else if (!/createRoot|ReactDOM\.render/.test(files[app])) {
    errors.push({ kind: 'syntax', file: app, message: 'App.jsx 没有挂载根组件（缺少 ReactDOM.createRoot(...).render(<App />)）' });
  }
  return errors;
}

type Pattern = { type: string; name?: string; properties?: unknown[]; elements?: unknown[]; value?: unknown; argument?: unknown; left?: unknown };

function collectNames(node: unknown, out: string[]) {
  const n = node as Pattern | null;
  if (!n) return;
  switch (n.type) {
    case 'Identifier':
      out.push(n.name!);
      break;
    case 'ObjectPattern':
      for (const p of n.properties ?? []) {
        const prop = p as Pattern;
        collectNames(prop.type === 'RestElement' ? prop.argument : prop.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const el of n.elements ?? []) collectNames(el, out);
      break;
    case 'AssignmentPattern':
      collectNames(n.left, out);
      break;
    case 'RestElement':
      collectNames(n.argument, out);
      break;
  }
}

/** 错误签名：同一签名连续出现两次就停止自动修复，避免空转烧 token */
export function errorSignature(errors: CheckError[]) {
  return errors
    .map((e) => `${e.kind}|${e.file ?? ''}|${e.line ?? ''}|${e.message.slice(0, 120)}`)
    .sort()
    .join('\n');
}
