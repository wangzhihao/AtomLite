import 'server-only';
import type { QAStep, QATest, Run, Version } from '@/lib/shared/types';
import { LIMITS } from '@/lib/shared/types';
import { role } from './agents';
import { extractJson, streamLLM } from './llm';
import { findSpec } from './orchestrator';
import type { Store } from './store';

/** 清洗 QA 模型输出：只保留合法的声明式步骤 */
export function sanitizeTests(raw: unknown): QATest[] {
  const tests = (raw as { tests?: unknown })?.tests;
  if (!Array.isArray(tests)) return [];
  const out: QATest[] = [];
  for (const t of tests.slice(0, 5)) {
    const feature = String((t as { feature?: unknown })?.feature ?? '').slice(0, 60);
    const steps: QAStep[] = [];
    for (const s of ((t as { steps?: unknown[] })?.steps ?? []).slice(0, 8)) {
      const st = s as Record<string, unknown>;
      const target = String(st.target ?? '').slice(0, 120);
      switch (st.action) {
        case 'fill':
          if (target) steps.push({ action: 'fill', target, value: String(st.value ?? '').slice(0, 200) });
          break;
        case 'click':
          if (target) steps.push({ action: 'click', target });
          break;
        case 'expectVisible':
          if (target) steps.push({ action: 'expectVisible', target });
          break;
        case 'expectText':
          if (st.text) steps.push({ action: 'expectText', text: String(st.text).slice(0, 120) });
          break;
        case 'wait':
          steps.push({ action: 'wait', ms: Math.min(2000, Math.max(0, Number(st.ms) || 300)) });
          break;
      }
    }
    if (feature && steps.length) out.push({ feature, steps });
  }
  return out;
}

/** 为某个版本生成验收测试，用量计入同一个 run */
export async function generateQATests(store: Store, run: Run, version: Version, signal: AbortSignal): Promise<QATest[]> {
  const spent = run.input_tokens + run.cache_read_tokens + run.output_tokens;
  if (spent > LIMITS.runTokenBudget) return [];
  const spec = findSpec(await store.listMessages(run.project_id));
  const r = role('qa');
  const p = r.buildPrompt({
    intent: run.intent ?? 'edit',
    instruction: '',
    files: version.files,
    history: [],
    spec,
    allowClarify: false,
    errors: [],
    summary: '',
  });
  const res = await streamLLM({ role: 'qa', tier: r.model, system: p.system, input: p.input, maxTokens: p.maxTokens, signal });
  await store.updateRun(run.id, {
    input_tokens: run.input_tokens + res.usage.inputTokens,
    output_tokens: run.output_tokens + res.usage.outputTokens,
    cache_read_tokens: run.cache_read_tokens + res.usage.cacheReadTokens,
    cost_usd: Number(run.cost_usd ?? 0) + res.usage.costUsd,
  });
  return sanitizeTests(extractJson(res.text));
}
