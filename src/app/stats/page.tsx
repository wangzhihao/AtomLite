'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/client/api';
import type { MetricGroup, Metrics } from '@/lib/shared/metrics';

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(0)}%`);
const usd = (v: number | null) => (v === null ? '—' : `$${v.toFixed(3)}`);
const num = (v: number | null) => (v === null ? '—' : v.toFixed(2));

const TARGETS: { key: keyof MetricGroup; label: string; target: string; fmt: (v: number | null) => string; ok: (v: number) => boolean }[] = [
  { key: 'firstPassRate', label: '首次通过率', target: '≥ 60%', fmt: pct, ok: (v) => v >= 0.6 },
  { key: 'fixSuccessRate', label: '自检修复率', target: '≥ 50%', fmt: pct, ok: (v) => v >= 0.5 },
  { key: 'finalOkRate', label: '最终可用率', target: '≥ 80%', fmt: pct, ok: (v) => v >= 0.8 },
  { key: 'avgFixRounds', label: '平均修复轮数', target: '≤ 0.5', fmt: num, ok: (v) => v <= 0.5 },
  { key: 'costPerOkUsd', label: '单个可用应用成本', target: '—', fmt: usd, ok: () => true },
  { key: 'cacheHitRate', label: '缓存命中率', target: '≥ 50%（修改轮次）', fmt: pct, ok: (v) => v >= 0.5 },
];

const INTENT: Record<string, string> = { create: '新建', edit: '修改', fix: '手动修复', chat: '对话' };
const KIND: Record<string, string> = { syntax: '语法错误', runtime: '运行时异常', console: 'console 报错', blank: '白屏', qa: '验收未通过' };

export default function StatsPage() {
  const router = useRouter();
  const [m, setM] = useState<Metrics | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ metrics: Metrics }>('/api/stats').then(
      (d) => setM(d.metrics),
      (e) => (e instanceof ApiError && e.status === 401 ? router.replace('/login?next=/stats') : setError(String(e.message))),
    );
  }, [router]);

  if (error) return <p className="mt-24 text-center text-red-600">{error}</p>;
  if (!m) return <div className="skeleton mx-auto mt-8 h-64 max-w-4xl rounded-xl" />;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8" data-testid="stats">
      <h1 className="text-2xl font-semibold">质量与成本</h1>
      <p className="mt-1 text-sm text-slate-500">
        你最近的 {m.overall.runs} 个已有结论的生成（另有 {m.pending} 个等待预览运行检查）。自动修复计入同一个 run；总花费 {usd(m.totalCostUsd)}。
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {TARGETS.map((t) => {
          const v = m.overall[t.key] as number | null;
          return (
            <div key={t.key} className="rounded-xl border border-slate-200 bg-white p-4" data-testid={`stat-${t.key}`}>
              <p className="text-xs text-slate-500">{t.label}</p>
              <p className={`mt-1 text-2xl font-semibold ${v !== null && !t.ok(v) ? 'text-amber-600' : 'text-slate-900'}`}>{t.fmt(v)}</p>
              <p className="mt-1 text-xs text-slate-400">目标 {t.target}</p>
            </div>
          );
        })}
      </div>

      <h2 className="mt-10 font-semibold">按意图</h2>
      <table className="mt-3 w-full overflow-hidden rounded-xl border border-slate-200 bg-white text-sm">
        <thead className="bg-slate-50 text-left text-xs text-slate-500">
          <tr>
            {['意图', 'run 数', '首次通过', '自检修复', '最终可用', '平均修复轮数', '平均成本', '缓存命中'].map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Object.entries(m.byIntent).map(([intent, g]) => (
            <tr key={intent} className="border-t border-slate-100" data-testid={`intent-${intent}`}>
              <td className="px-3 py-2">{INTENT[intent] ?? intent}</td>
              <td className="px-3 py-2">{g.runs}</td>
              <td className="px-3 py-2">{pct(g.firstPassRate)}</td>
              <td className="px-3 py-2">{pct(g.fixSuccessRate)}</td>
              <td className="px-3 py-2">{pct(g.finalOkRate)}</td>
              <td className="px-3 py-2">{num(g.avgFixRounds)}</td>
              <td className="px-3 py-2">{usd(g.avgCostUsd)}</td>
              <td className="px-3 py-2">{pct(g.cacheHitRate)}</td>
            </tr>
          ))}
          {!Object.keys(m.byIntent).length && (
            <tr>
              <td colSpan={8} className="px-3 py-6 text-center text-slate-400">
                还没有数据。<Link href="/" className="text-brand-600">去生成一个应用</Link>
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2 className="mt-10 font-semibold">按错误类型</h2>
      <table className="mt-3 w-full overflow-hidden rounded-xl border border-slate-200 bg-white text-sm">
        <thead className="bg-slate-50 text-left text-xs text-slate-500">
          <tr>
            <th className="px-3 py-2 font-medium">错误类型</th>
            <th className="px-3 py-2 font-medium">出现的 run 数</th>
            <th className="px-3 py-2 font-medium">最终修好</th>
            <th className="px-3 py-2 font-medium">修复成功率</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(m.errorKinds).map(([k, v]) => (
            <tr key={k} className="border-t border-slate-100" data-testid={`kind-${k}`}>
              <td className="px-3 py-2">{KIND[k] ?? k}</td>
              <td className="px-3 py-2">{v.runs}</td>
              <td className="px-3 py-2">{v.fixed}</td>
              <td className="px-3 py-2">{pct(v.runs ? v.fixed / v.runs : null)}</td>
            </tr>
          ))}
          {!Object.keys(m.errorKinds).length && (
            <tr>
              <td colSpan={4} className="px-3 py-6 text-center text-slate-400">
                还没有出现过错误。
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
