import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import type { AgentId } from '@/lib/shared/types';
import { env, useMockLLM } from './env';
import { mockStream } from './mock-llm';

export type ModelTier = 'fast' | 'strong';
export type LLMUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number };
export type LLMResult = { usage: LLMUsage; model: string; text: string };

export type LLMCall = {
  role: AgentId;
  tier: ModelTier;
  system: string;
  input: string;
  maxTokens: number;
  signal: AbortSignal;
  onText?: (text: string) => void;
};

let client: Anthropic | null = null;

export function modelFor(tier: ModelTier) {
  if (useMockLLM()) return 'mock';
  return tier === 'strong' ? env.strongModel : env.fastModel;
}

export const emptyUsage = (): LLMUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 });

export function addUsage(a: LLMUsage, b: LLMUsage): LLMUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

function cost(tier: ModelTier, inputTokens: number, cacheRead: number, output: number) {
  if (useMockLLM()) return 0;
  const p = tier === 'strong' ? env.prices.strong : env.prices.fast;
  return (inputTokens * p.in + cacheRead * p.cacheRead + output * p.out) / 1e6;
}

/** 流式调用模型；无 ANTHROPIC_API_KEY 时使用确定性的 Mock */
export async function streamLLM(call: LLMCall): Promise<LLMResult> {
  if (useMockLLM()) return mockStream(call);
  client ??= new Anthropic({ apiKey: env.anthropicKey, maxRetries: 2 });

  const model = modelFor(call.tier);
  // 系统提示是稳定前缀，打上 cache_control 以便多轮修改命中缓存。
  // 开启服务端 fallbacks：主模型因安全分类器拒绝时自动换模型继续（Haiku 不支持，只给强模型开）。
  const params: Record<string, unknown> = {
    model,
    max_tokens: call.maxTokens,
    system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: call.input }],
    output_config: { effort: call.tier === 'strong' ? env.effort : 'low' },
  };
  if (call.tier === 'strong') {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  const stream = client.beta.messages.stream(params as unknown as Parameters<typeof client.beta.messages.stream>[0], {
    signal: call.signal,
  });
  let text = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text;
      call.onText?.(event.delta.text);
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') throw new Error('模型拒绝了这个请求，请换一种说法');
  const u = final.usage as unknown as {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  const inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const cacheReadTokens = u.cache_read_input_tokens ?? 0;
  const outputTokens = u.output_tokens ?? 0;
  return {
    model: final.model,
    text,
    usage: { inputTokens, outputTokens, cacheReadTokens, costUsd: cost(call.tier, inputTokens, cacheReadTokens, outputTokens) },
  };
}

/** 从模型输出中取出第一个 JSON 对象 */
export function extractJson<T>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const src = fenced ? fenced[1] : text;
  const start = src.indexOf('{');
  const end = src.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(src.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
