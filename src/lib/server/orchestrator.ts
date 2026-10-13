import 'server-only';
import type { AgentEvent, Files, Message, Project, RunIntent, SessionUser, Usage } from '@/lib/shared/types';
import { LIMITS } from '@/lib/shared/types';
import { TagParser, type TagEvent } from '@/lib/shared/tag-parser';
import { costUsd, modelName, streamEngineer, type LLMUsage } from './llm';
import { buildEngineerInput, ENGINEER_SYSTEM } from './prompts';
import type { Store } from './store';

/**
 * 代码编排器（设计文档第 5 节）。Must 阶段的主链路：
 *   新建：Engineer 生成全部文件 → 校验 → 落库为新版本
 *   修改：Engineer 基于现有文件只输出变更文件 → 与当前版本合并 → 落库为新版本
 * 中途取消或失败都不产生新版本，上一版本保持可用。
 */
export type Emit = (e: AgentEvent) => void;

/** 进行中的 run，用于 /cancel 接口（单实例内有效；客户端断开也会触发取消） */
const g = globalThis as unknown as { __atomsRuns?: Map<string, AbortController> };
export const activeRuns = (g.__atomsRuns ??= new Map());

class RunError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const LEADER = {
  create: '收到。Kai 开始搭建应用，写完的文件会实时出现在右侧预览里。',
  edit: '收到。Kai 会在现有版本上修改，只改动需要变更的文件。',
  fix: '收到。Kai 先定位报错原因，再修复相关文件。',
};

export async function runGeneration(opts: {
  store: Store;
  user: SessionUser;
  project: Project;
  instruction: string;
  intentHint: 'auto' | 'fix';
  signal: AbortSignal;
  emit: Emit;
}) {
  const { store, project, instruction, signal, emit } = opts;
  const current = project.current_version_id ? await store.getVersion(project.current_version_id) : null;
  const intent: RunIntent = opts.intentHint === 'fix' && current ? 'fix' : current ? 'edit' : 'create';
  const run = await store.createRun({ project_id: project.id, intent, model: modelName() });
  emit({ event: 'run_started', data: { runId: run.id, intent } });

  const say = (text: string) => emit({ event: 'message_delta', data: { agent: 'leader', text } });
  emit({ event: 'agent_started', data: { agent: 'leader' } });
  say(LEADER[intent]);

  let usage: LLMUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const changed: Files = {};
  const deleted: string[] = [];
  let narrative = '';
  let summary = '';

  const onTag = (e: TagEvent) => {
    switch (e.type) {
      case 'text':
        narrative += e.text;
        emit({ event: 'message_delta', data: { agent: 'engineer', text: e.text } });
        break;
      case 'summary':
        summary = e.text;
        break;
      case 'file_start':
        emit({ event: 'file_started', data: { path: e.path } });
        break;
      case 'file_end':
        changed[e.path] = e.content;
        emit({ event: 'file_done', data: { path: e.path, bytes: Buffer.byteLength(e.content), content: e.content } });
        break;
      case 'delete':
        deleted.push(e.path);
        break;
    }
  };

  const finish = async (status: 'succeeded' | 'failed' | 'cancelled', error?: string) => {
    const cost = costUsd(usage);
    await store.updateRun(run.id, {
      status,
      error: error ?? null,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_tokens: usage.cacheReadTokens,
      cost_usd: cost,
      first_pass: status === 'succeeded' ? true : status === 'failed' ? false : null,
      final_ok: status === 'succeeded' ? true : status === 'failed' ? false : null,
      finished_at: new Date().toISOString(),
    });
    const u: Usage = { inputTokens: usage.inputTokens + usage.cacheReadTokens, outputTokens: usage.outputTokens, costUsd: cost };
    emit({ event: 'run_finished', data: { status, usage: u } });
    return u;
  };

  try {
    emit({ event: 'agent_started', data: { agent: 'engineer' } });
    const history: Message[] = await store.listMessages(project.id);
    const parser = new TagParser();
    const result = await streamEngineer({
      system: ENGINEER_SYSTEM,
      input: buildEngineerInput({
        instruction: intent === 'fix' ? `预览运行时报错，请修复：\n${instruction}` : instruction,
        files: current?.files ?? null,
        history: history.slice(0, -1), // 最后一条是本轮的用户消息，已经作为指令单独给出
      }),
      maxTokens: LIMITS.maxOutputTokens,
      signal,
      onText: (t) => parser.push(t).forEach(onTag),
    });
    usage = result.usage;
    const fin = parser.finish();
    fin.events.forEach(onTag);
    if (signal.aborted) throw signal.reason ?? new Error('aborted');

    // ---------- 合并与校验
    const files: Files = { ...(current?.files ?? {}), ...changed };
    for (const p of deleted) delete files[p];
    const changedPaths = Object.keys(changed);
    if (!changedPaths.length && !deleted.length) {
      throw new RunError('empty_output', fin.unclosedFile ? '生成被截断，没有得到完整的文件，请重试' : 'Agent 没有输出任何文件，请换个说法再试');
    }
    if (!Object.keys(files).some((p) => /(^|\/)app\.(jsx|js)$/i.test(p))) {
      throw new RunError('no_entry', '生成结果缺少入口文件 App.jsx，请重试');
    }
    const total = Object.values(files).reduce((n, c) => n + Buffer.byteLength(c), 0);
    if (total > LIMITS.totalFileBytes) throw new RunError('too_large', '生成的文件总大小超过 200 KB，请精简需求');

    const notes: string[] = [];
    if (fin.unclosedFile) notes.push(`文件 ${fin.unclosedFile} 输出不完整，已丢弃`);

    const version = await store.createVersion(project.id, {
      files,
      summary: summary || narrative.trim().slice(0, 120) || null,
      source: 'agent',
      run_id: run.id,
    });
    const u = await finish('succeeded');
    const msg = await store.addMessage({
      project_id: project.id,
      role: 'agent',
      agent: 'engineer',
      content: narrative.trim() || summary,
      meta: {
        summary,
        files: changedPaths,
        deleted,
        notes,
        usage: u,
        runId: run.id,
        seq: version.seq,
        intent,
      },
      version_id: version.id,
    });
    emit({ event: 'version_created', data: { versionId: version.id, seq: version.seq, deleted, messageId: msg.id } });
  } catch (err) {
    if (signal.aborted) {
      await finish('cancelled');
      await store.addMessage({
        project_id: project.id,
        role: 'system',
        agent: null,
        content: '已停止生成，保留上一个版本。',
        meta: { runId: run.id, status: 'cancelled', partial: narrative.trim().slice(0, 2000) },
        version_id: null,
      });
      return;
    }
    const readable = err instanceof RunError ? err : new RunError('llm_error', friendlyLLMError(err));
    console.error('[generate]', err);
    emit({ event: 'error', data: { code: readable.code, message: readable.message } });
    await finish('failed', readable.message);
    await store.addMessage({
      project_id: project.id,
      role: 'system',
      agent: null,
      content: readable.message,
      meta: { runId: run.id, status: 'failed', code: readable.code, partial: narrative.trim().slice(0, 2000) },
      version_id: null,
    });
  }
}

function friendlyLLMError(err: unknown): string {
  const status = (err as { status?: number })?.status;
  if (status === 429) return '模型服务繁忙（限流），请稍后再试';
  if (status === 401 || status === 403) return '模型服务鉴权失败，请检查服务端配置';
  if (status && status >= 500) return '模型服务暂时不可用，请稍后再试';
  return '生成失败：' + (err instanceof Error ? err.message : String(err)).slice(0, 200);
}
