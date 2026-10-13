import type { Run } from './types';

/**
 * 质量与成本度量（设计文档第 10 节）。以 run 为统计单位，自动修复计入同一个 run。
 *   首次通过率 P_first = N首次通过 / N_run
 *   自检修复率 R_fix   = N修复成功 / (N_run − N首次通过)
 *   最终可用率 P_final = N最终可用 / N_run
 *   单个可用应用成本 C_ok = Σ C_run / N最终可用
 * 只统计已有结论的 run（final_ok 不为空）；澄清、取消的 run 不计入。
 */
export type MetricGroup = {
  runs: number;
  firstPassRate: number | null;
  fixSuccessRate: number | null;
  finalOkRate: number | null;
  avgFixRounds: number | null;
  avgCostUsd: number | null;
  costPerOkUsd: number | null;
  cacheHitRate: number | null;
};

export type Metrics = {
  overall: MetricGroup;
  byIntent: Record<string, MetricGroup>;
  errorKinds: Record<string, { runs: number; fixed: number }>;
  pending: number;
  totalCostUsd: number;
};

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

export function groupMetrics(runs: Run[]): MetricGroup {
  const n = runs.length;
  const first = runs.filter((r) => r.first_pass === true).length;
  const ok = runs.filter((r) => r.final_ok === true).length;
  const fixedAfterFail = runs.filter((r) => r.first_pass !== true && r.final_ok === true).length;
  const cost = runs.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
  const input = runs.reduce((s, r) => s + r.input_tokens + r.cache_read_tokens, 0);
  const cached = runs.reduce((s, r) => s + r.cache_read_tokens, 0);
  return {
    runs: n,
    firstPassRate: ratio(first, n),
    fixSuccessRate: ratio(fixedAfterFail, n - first),
    finalOkRate: ratio(ok, n),
    avgFixRounds: ratio(runs.reduce((s, r) => s + r.fix_rounds, 0), n),
    avgCostUsd: ratio(cost, n),
    costPerOkUsd: ratio(cost, ok),
    cacheHitRate: ratio(cached, input),
  };
}

export function computeMetrics(all: Run[]): Metrics {
  const decided = all.filter((r) => (r.status === 'succeeded' || r.status === 'failed') && r.final_ok !== null);
  const pending = all.filter((r) => r.status === 'succeeded' && r.final_ok === null).length;
  const byIntent: Record<string, MetricGroup> = {};
  for (const intent of ['create', 'edit', 'fix']) {
    const rs = decided.filter((r) => r.intent === intent);
    if (rs.length) byIntent[intent] = groupMetrics(rs);
  }
  const errorKinds: Record<string, { runs: number; fixed: number }> = {};
  for (const r of decided) {
    for (const k of r.error_kinds ?? []) {
      errorKinds[k] ??= { runs: 0, fixed: 0 };
      errorKinds[k].runs++;
      if (r.final_ok) errorKinds[k].fixed++;
    }
  }
  return {
    overall: groupMetrics(decided),
    byIntent,
    errorKinds,
    pending,
    totalCostUsd: all.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0),
  };
}
