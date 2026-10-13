import 'server-only';
import type {
  AgentEvent,
  AgentId,
  CheckError,
  ClarifyQuestion,
  Files,
  Message,
  Project,
  Run,
  RunIntent,
  RunStatus,
  SessionUser,
  Spec,
  TeamConfig,
  Usage,
} from '@/lib/shared/types';
import { LIMITS } from '@/lib/shared/types';
import { TagParser, type TagEvent } from '@/lib/shared/tag-parser';
import { role, rolesFor, type AgentRole, type RunContext } from './agents';
import { checkFiles, errorSignature } from './check';
import { addUsage, emptyUsage, extractJson, modelFor, streamLLM, type LLMUsage } from './llm';
import type { Store } from './store';

/**
 * 代码编排器（设计文档第 5 节）：用代码而不是让模型自主调度，顺序固定、可预测。
 *   新建：Planner →（信息不足则澄清，本轮结束）→ Designer → Engineer → 服务端检查 →（出错则 Fixer，最多 2 轮）→ 版本 → Advisor
 *   修改：Engineer（只输出变更文件）→ 服务端检查 → 修复回路 → 版本 → Advisor
 *   修复：Fixer（由前端运行时报错触发，带 runId 时计入同一个 run）→ 服务端检查 → 版本 → Advisor
 * 版本只在服务端检查通过后写入；中途取消或失败都不产生新版本。Leo 的播报全部按模板生成，不调用 LLM。
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

type PendingMessage = Omit<Message, 'id' | 'created_at' | 'project_id'>;

type PlannerOut = Spec & { message?: string; needsClarification?: boolean; questions?: ClarifyQuestion[] };

export async function runGeneration(opts: {
  store: Store;
  user: SessionUser;
  project: Project;
  instruction: string;
  mode: 'auto' | 'fix';
  errors: CheckError[];
  parentRunId: string | null;
  clarified: boolean;
  team?: Partial<TeamConfig>;
  signal: AbortSignal;
  emit: Emit;
}) {
  const { store, project, signal, emit } = opts;
  const current = project.current_version_id ? await store.getVersion(project.current_version_id) : null;

  // ---------- 选择路径与 run
  let intent: RunIntent;
  let run: Run;
  let reused = false;
  if (opts.mode === 'fix' && current) {
    intent = 'fix';
    const parent = opts.parentRunId ? await store.getRun(opts.parentRunId) : null;
    if (parent && parent.project_id === project.id && parent.status !== 'running') {
      run = parent;
      reused = true;
      await store.updateRun(run.id, { status: 'running', finished_at: null });
    } else run = await store.createRun({ project_id: project.id, intent, model: modelFor('strong') });
  } else {
    intent = current ? 'edit' : 'create';
    run = await store.createRun({ project_id: project.id, intent, model: modelFor('strong') });
  }
  emit({ event: 'run_started', data: { runId: run.id, intent } });

  const base: LLMUsage = reused
    ? { inputTokens: run.input_tokens, outputTokens: run.output_tokens, cacheReadTokens: run.cache_read_tokens, costUsd: Number(run.cost_usd ?? 0) }
    : emptyUsage();
  let usage = emptyUsage();
  let fixRounds = reused ? run.fix_rounds : 0;
  const errorKinds = new Set<string>(run.error_kinds ?? []);
  const pending: PendingMessage[] = [];
  let files: Files = { ...(current?.files ?? {}) };
  const history = (await store.listMessages(project.id)).slice(0, -1); // 最后一条是本轮的用户消息
  const ctx: RunContext = {
    intent,
    instruction: opts.instruction,
    files,
    history,
    spec: findSpec(history),
    allowClarify: !opts.clarified && !history.some((m) => m.meta?.clarify),
    errors: opts.errors,
    summary: '',
  };

  const leader = (text: string) => {
    emit({ event: 'agent_started', data: { agent: 'leader' } });
    emit({ event: 'message_delta', data: { agent: 'leader', text } });
    pending.push({ role: 'agent', agent: 'leader', content: text, meta: null, version_id: null });
  };

  const totalUsage = () => addUsage(base, usage);
  const usageOut = (): Usage => {
    const t = totalUsage();
    return { inputTokens: t.inputTokens + t.cacheReadTokens, outputTokens: t.outputTokens, costUsd: t.costUsd, fixRounds };
  };

  async function call(r: AgentRole, onText?: (t: string) => void) {
    const p = r.buildPrompt(ctx);
    const res = await streamLLM({ role: r.id, tier: r.model, system: p.system, input: p.input, maxTokens: p.maxTokens, signal, onText });
    usage = addUsage(usage, res.usage);
    const t = totalUsage();
    if (t.inputTokens + t.cacheReadTokens + t.outputTokens > LIMITS.runTokenBudget) {
      throw new RunError('budget', `本轮生成超出 token 预算（${LIMITS.runTokenBudget / 1000}K），已停止。可以把需求拆小一点再试`);
    }
    return res.text;
  }

  /** 运行输出文件的角色（Engineer / Fixer），返回本轮摘要 */
  async function runFilesAgent(id: 'engineer' | 'fixer') {
    const r = role(id);
    emit({ event: 'agent_started', data: { agent: id } });
    const parser = new TagParser();
    let narrative = '';
    let summary = '';
    const changed: Files = {};
    const deleted: string[] = [];
    const onTag = (e: TagEvent) => {
      switch (e.type) {
        case 'text':
          if (!e.inSummary) narrative += e.text;
          emit({ event: 'message_delta', data: { agent: id, text: e.text } });
          break;
        case 'summary':
          summary = e.text;
          break;
        case 'file_start':
          emit({ event: 'file_started', data: { path: e.path, agent: id } });
          break;
        case 'file_end':
          changed[e.path] = e.content;
          emit({ event: 'file_done', data: { path: e.path, bytes: Buffer.byteLength(e.content), content: e.content, agent: id } });
          break;
        case 'delete':
          deleted.push(e.path);
          break;
      }
    };
    ctx.files = files;
    await call(r, (t) => parser.push(t).forEach(onTag));
    const fin = parser.finish();
    fin.events.forEach(onTag);
    if (signal.aborted) throw signal.reason ?? new Error('aborted');
    if (!Object.keys(changed).length && !deleted.length) {
      throw new RunError(
        'empty_output',
        fin.unclosedFile ? '生成被截断，没有得到完整的文件，请重试' : `${id === 'fixer' ? 'Max' : 'Kai'} 没有输出任何文件，请换个说法再试`,
      );
    }
    files = { ...files, ...changed };
    for (const p of deleted) delete files[p];
    ctx.files = files;
    const notes = fin.unclosedFile ? [`文件 ${fin.unclosedFile} 输出不完整，已丢弃`] : [];
    pending.push({
      role: 'agent',
      agent: id,
      content: narrative.trim() || summary,
      meta: { summary, files: Object.keys(changed), deleted, notes },
      version_id: null,
    });
    return summary;
  }

  const finish = async (status: RunStatus, extra: Partial<Run> = {}, error?: string) => {
    const t = totalUsage();
    await store.updateRun(run.id, {
      status,
      error: error ?? null,
      input_tokens: t.inputTokens,
      output_tokens: t.outputTokens,
      cache_read_tokens: t.cacheReadTokens,
      cost_usd: t.costUsd,
      fix_rounds: fixRounds,
      error_kinds: [...errorKinds],
      finished_at: new Date().toISOString(),
      ...extra,
    });
    emit({ event: 'run_finished', data: { status, usage: usageOut() } });
  };

  const persist = async (extra?: PendingMessage) => {
    for (const m of extra ? [...pending, extra] : pending) await store.addMessage({ ...m, project_id: project.id });
    pending.length = 0;
  };

  try {
    let summary = '';
    if (intent === 'create') {
      const planner = rolesFor('create', 'plan', opts.team)[0];
      const designer = rolesFor('create', 'design', opts.team)[0];
      const crew = [planner && 'Nora 先梳理需求', designer && 'Mia 定风格', '然后 Kai 开工'].filter(Boolean).join('，');
      leader(`收到。${crew}。`);

      if (planner) {
        emit({ event: 'agent_started', data: { agent: 'planner' } });
        const out = extractJson<PlannerOut>(await call(planner));
        if (signal.aborted) throw signal.reason ?? new Error('aborted');
        const spec: Spec = sanitizeSpec(out, opts.instruction);
        const say = out?.message?.trim() || `需求拆成 ${spec.features.length} 个功能点。`;
        emit({ event: 'message_delta', data: { agent: 'planner', text: say } });
        const questions = (out?.questions ?? []).filter((q) => q?.question).slice(0, 4);
        if (out?.needsClarification && ctx.allowClarify && questions.length) {
          const qs = questions.map((q, i) => ({ id: String(q.id || `q${i + 1}`), question: String(q.question), placeholder: q.placeholder ? String(q.placeholder) : undefined }));
          emit({ event: 'clarify', data: { questions: qs } });
          pending.push({ role: 'agent', agent: 'planner', content: say, meta: { clarify: qs, spec }, version_id: null });
          leader('Nora 有几个问题想先确认，回答后马上开工；也可以点“先帮我随便做”直接开始。');
          await finish('needs_input');
          await persist();
          return;
        }
        emit({ event: 'plan', data: { spec } });
        pending.push({ role: 'agent', agent: 'planner', content: say, meta: { plan: spec }, version_id: null });
        ctx.spec = spec;
      }

      if (designer) {
        emit({ event: 'agent_started', data: { agent: 'designer' } });
        const out = extractJson<Record<string, unknown>>(await call(designer));
        if (signal.aborted) throw signal.reason ?? new Error('aborted');
        if (out) {
          const { message, ...design } = out;
          const say = typeof message === 'string' && message.trim() ? message.trim() : '设计规范已就绪。';
          emit({ event: 'message_delta', data: { agent: 'designer', text: say } });
          const content = JSON.stringify(design, null, 2);
          files['design.json'] = content;
          emit({ event: 'file_started', data: { path: 'design.json', agent: 'designer' } });
          emit({ event: 'file_done', data: { path: 'design.json', bytes: Buffer.byteLength(content), content, agent: 'designer' } });
          emit({ event: 'design', data: { design } });
          pending.push({ role: 'agent', agent: 'designer', content: say, meta: { design, files: ['design.json'] }, version_id: null });
        }
      }
      summary = await runFilesAgent('engineer');
    } else if (intent === 'edit') {
      leader('收到。Kai 直接在现有版本上改，只动需要变更的文件。');
      summary = await runFilesAgent('engineer');
    } else {
      fixRounds++;
      for (const e of opts.errors) errorKinds.add(e.kind);
      leader(reused ? `预览运行时报错，Max 来自动修复（第 ${fixRounds} 次）。` : '收到。Max 先定位报错原因，再修复相关文件。');
      summary = await runFilesAgent('fixer');
    }

    // ---------- 第一道关：服务端检查 + 修复回路
    let firstCheckPassed = true;
    let lastSig = '';
    for (;;) {
      const errs = checkFiles(files);
      if (!errs.length) break;
      firstCheckPassed = false;
      errorKinds.add('syntax');
      const sig = errorSignature(errs);
      emit({ event: 'check_failed', data: { errors: errs, round: fixRounds + 1 } });
      if (fixRounds >= LIMITS.maxFixRounds || sig === lastSig) {
        throw new RunError('check_failed', `自动修复后仍未通过语法检查：${errs[0].file ? `${errs[0].file} ` : ''}${errs[0].message}`);
      }
      lastSig = sig;
      fixRounds++;
      leader(`语法检查发现 ${errs.length} 个问题，交给 Max 修复（第 ${fixRounds} 次）。`);
      ctx.errors = errs;
      summary = await runFilesAgent('fixer');
    }

    const total = Object.values(files).reduce((n, c) => n + Buffer.byteLength(c), 0);
    if (total > LIMITS.totalFileBytes) throw new RunError('too_large', '生成的文件总大小超过 200 KB，请精简需求');

    const version = await store.createVersion(project.id, {
      files,
      summary: summary || null,
      source: intent === 'fix' && reused ? 'autofix' : 'agent',
      run_id: run.id,
    });
    // 最后一条写代码的消息挂上版本号与本轮用量
    const codeMsg = [...pending].reverse().find((m) => m.agent === 'engineer' || m.agent === 'fixer');
    if (codeMsg) {
      codeMsg.version_id = version.id;
      codeMsg.meta = { ...(codeMsg.meta ?? {}), seq: version.seq, usage: usageOut(), runId: run.id, intent };
    }
    leader(`完成，已保存为版本 ${version.seq}。`);
    // 运行检查（浏览器端）结果通过 verify 接口回写；首次通过要等运行检查确认
    await finish('succeeded', {
      first_pass: reused ? run.first_pass : firstCheckPassed ? null : false,
      final_ok: null,
    });
    await persist();
    emit({ event: 'version_created', data: { versionId: version.id, seq: version.seq, deleted: [], messageId: '' } });

    // ---------- 建议者：在版本落库之后调用，不阻塞主流程，失败也不影响本轮结果
    const advisor = rolesFor(intent, 'after', opts.team).find((r) => r.id === 'advisor');
    if (advisor && !signal.aborted) {
      try {
        ctx.summary = summary;
        emit({ event: 'agent_started', data: { agent: 'advisor' } });
        const out = extractJson<{ suggestions?: string[] }>(await call(advisor));
        const items = (out?.suggestions ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 3);
        if (items.length) {
          emit({ event: 'suggestions', data: { items } });
          await store.addMessage({ project_id: project.id, role: 'agent', agent: 'advisor', content: '下一步可以试试：', meta: { suggestions: items }, version_id: null });
        }
        const t = totalUsage();
        await store.updateRun(run.id, { input_tokens: t.inputTokens, output_tokens: t.outputTokens, cache_read_tokens: t.cacheReadTokens, cost_usd: t.costUsd });
      } catch (err) {
        if (!signal.aborted) console.warn('[advisor]', err);
      }
    }
  } catch (err) {
    if (signal.aborted) {
      await finish('cancelled');
      await persist({ role: 'system', agent: null, content: '已停止生成，保留上一个版本。', meta: { runId: run.id, status: 'cancelled' }, version_id: null });
      return;
    }
    const readable = err instanceof RunError ? err : new RunError('llm_error', friendlyLLMError(err));
    if (!(err instanceof RunError)) console.error('[generate]', err);
    emit({ event: 'error', data: { code: readable.code, message: readable.message } });
    await finish('failed', { final_ok: false, first_pass: reused ? run.first_pass : false }, readable.message);
    await persist({ role: 'system', agent: null, content: readable.message, meta: { runId: run.id, status: 'failed', code: readable.code }, version_id: null });
  }
}

/** 修改轮次复用最近一次规划 */
export function findSpec(history: Message[]): Spec | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const spec = (m.meta?.plan ?? m.meta?.spec) as Spec | undefined;
    if (spec) return spec;
  }
  return null;
}

function sanitizeSpec(out: PlannerOut | null, instruction: string): Spec {
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 12) : []);
  return {
    appName: String(out?.appName || instruction.slice(0, 12)),
    summary: out?.summary ? String(out.summary) : undefined,
    features: list(out?.features),
    components: list(out?.components),
    files: list(out?.files),
    dataModel: out?.dataModel ? String(out.dataModel) : undefined,
    style: out?.style ? String(out.style) : undefined,
    assumptions: list(out?.assumptions),
  };
}

function friendlyLLMError(err: unknown): string {
  const status = (err as { status?: number })?.status;
  if (status === 429) return '模型服务繁忙（限流），请稍后再试';
  if (status === 401 || status === 403) return '模型服务鉴权失败，请检查服务端配置';
  if (status && status >= 500) return '模型服务暂时不可用，请稍后再试';
  return '生成失败：' + (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

export type { AgentId };
