import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics } from '../../src/lib/shared/metrics.ts';
import type { Run } from '../../src/lib/shared/types.ts';

const run = (p: Partial<Run>): Run => ({
  id: Math.random().toString(),
  project_id: 'p',
  user_id: 'u',
  intent: 'create',
  status: 'succeeded',
  model: 'm',
  first_pass: true,
  fix_rounds: 0,
  final_ok: true,
  error_kinds: [],
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_tokens: 0,
  cost_usd: 0.1,
  error: null,
  started_at: new Date().toISOString(),
  finished_at: null,
  ...p,
});

test('computes the section 10 formulas', () => {
  const m = computeMetrics([
    run({}),
    run({}),
    run({ first_pass: false, fix_rounds: 1, final_ok: true, error_kinds: ['runtime'] }),
    run({ first_pass: false, fix_rounds: 2, final_ok: false, status: 'failed', error_kinds: ['syntax', 'runtime'] }),
    run({ intent: 'edit', cache_read_tokens: 3000, input_tokens: 1000 }),
    run({ status: 'needs_input', final_ok: null, first_pass: null }), // 澄清不计入
    run({ final_ok: null, first_pass: null }), // 等待运行检查
  ]);
  assert.equal(m.overall.runs, 5);
  assert.equal(m.pending, 1);
  assert.equal(m.overall.firstPassRate, 3 / 5);
  assert.equal(m.overall.fixSuccessRate, 1 / 2);
  assert.equal(m.overall.finalOkRate, 4 / 5);
  assert.equal(m.overall.avgFixRounds, 3 / 5);
  assert.ok(Math.abs(m.overall.costPerOkUsd! - 0.5 / 4) < 1e-9);
  assert.equal(m.byIntent.edit.cacheHitRate, 3000 / 4000);
  assert.deepEqual(m.errorKinds.runtime, { runs: 2, fixed: 1 });
  assert.deepEqual(m.errorKinds.syntax, { runs: 1, fixed: 0 });
});
