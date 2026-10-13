import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { env, useMockLLM } from './env';
import { mockEngineerStream } from './mock-llm';

export type LLMUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number };
export type LLMResult = { usage: LLMUsage; model: string };

export type EngineerCall = {
  system: string;
  input: string;
  maxTokens: number;
  signal: AbortSignal;
  onText: (text: string) => void;
};

let client: Anthropic | null = null;

export function modelName() {
  return useMockLLM() ? 'mock' : env.strongModel;
}

export function costUsd(u: LLMUsage) {
  if (useMockLLM()) return 0;
  return (u.inputTokens * env.priceIn + u.cacheReadTokens * env.priceCacheRead + u.outputTokens * env.priceOut) / 1e6;
}

/** 流式调用 Engineer；无 ANTHROPIC_API_KEY 时使用确定性的 Mock */
export async function streamEngineer(call: EngineerCall): Promise<LLMResult> {
  if (useMockLLM()) return mockEngineerStream(call);
  client ??= new Anthropic({ apiKey: env.anthropicKey, maxRetries: 2 });

  // 系统提示是稳定前缀，打上 cache_control 以便多轮修改命中缓存。
  // 开启服务端 fallbacks：主模型因安全分类器拒绝时自动换模型继续。
  const params = {
    model: env.strongModel,
    max_tokens: call.maxTokens,
    system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: call.input }],
    output_config: { effort: env.effort },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };
  const stream = client.beta.messages.stream(params as unknown as Parameters<typeof client.beta.messages.stream>[0], {
    signal: call.signal,
  });
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') call.onText(event.delta.text);
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') throw new Error('模型拒绝了这个请求，请换一种说法');
  const u = final.usage as unknown as {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  return {
    model: final.model,
    usage: {
      inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
    },
  };
}
