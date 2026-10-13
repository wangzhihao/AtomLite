'use client';
import { SSEParser } from '@/lib/shared/sse';
import type { AgentEvent } from '@/lib/shared/types';
import { ApiError } from './api';

/** 调用 SSE 生成接口，逐个回调事件；返回时流已结束 */
export async function streamGenerate(
  projectId: string,
  body: { message?: string; mode?: 'auto' | 'fix'; errors?: string[]; resume?: boolean },
  onEvent: (e: AgentEvent) => void,
  signal: AbortSignal,
) {
  const res = await fetch(`/api/projects/${projectId}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    const err = (data as { error?: { message?: string; code?: string } }).error;
    throw new ApiError(err?.message ?? `请求失败（${res.status}）`, res.status, err?.code);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const parser = new SSEParser();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const e of parser.push(value)) onEvent(e as AgentEvent);
  }
}
