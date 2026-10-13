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
import { planSteps, ProgressTracker, typicalDurationMs } from './progress';
import { env } from './env';
import { addUsage, emptyUsage, extractJson, isQuotaError, modelFor, streamLLM, type LLMUsage } from './llm';
import { buildChatInput, chatSystem, ROUTER_SYSTEM } from './prompts';
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

/** Engineer / Fixer 只给了文字回复、没有文件 */
class ReplyOnly extends Error {}

const MEMBER_AGENT: Record<string, AgentId> = {
  leo: 'leader',
  nora: 'planner',
  mia: 'designer',
  kai: 'engineer',
  max: 'fixer',
  sage: 'advisor',
  quinn: 'qa',
};

class RunError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const DELTA_FLUSH_MS = 100;

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
  /** 可以走对话路径：普通的用户消息（非首页需求、非澄清回答、非修复） */
  routable?: boolean;
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

  // Leo 分派：先用快速模型判断这条消息是要改应用还是在对话，以及点名了谁（失败时按修改处理）
  let chatAgent: AgentId = 'leader';
  let routeUsage: LLMUsage | null = null;
  /** 分派时就发现额度用完：不再继续调用其他角色，直接告诉用户 */
  let quotaErr: unknown = null;
  if (opts.routable && intent !== 'fix') {
    try {
      const res = await streamLLM({
        role: 'leader',
        tier: 'fast',
        system: ROUTER_SYSTEM,
        input: `## 用户消息\n\n${opts.instruction}`,
        maxTokens: 1000,
        signal,
      });
      routeUsage = res.usage;
      const route = extractJson<{ intent?: string; member?: string | null }>(res.text);
      if (route?.intent === 'chat') {
        intent = 'chat';
        chatAgent = MEMBER_AGENT[String(route.member ?? '').toLowerCase()] ?? 'leader';
        await store.updateRun(run.id, { intent, model: modelFor('fast') });
      }
    } catch (err) {
      if (signal.aborted) throw err;
      if (isQuotaError(err)) quotaErr = err;
      else console.warn('[router]', err);
    }
  }
  emit({ event: 'run_started', data: { runId: run.id, intent } });

  // 进度：步骤清单 + 通常耗时，之后每 2 秒一次心跳（设计文档第 3 节）
  const progress = new ProgressTracker(emit);
  progress.start(
    planSteps(intent, {
      planner: Boolean(rolesFor('create', 'plan', opts.team)[0]),
      designer: Boolean(rolesFor('create', 'design', opts.team)[0]),
      advisor: Boolean(rolesFor(intent, 'after', opts.team).find((r) => r.id === 'advisor')),
    }),
    await typicalDurationMs(store, intent),
  );

  const base: LLMUsage = reused
    ? { inputTokens: run.input_tokens, outputTokens: run.output_tokens, cacheReadTokens: run.cache_read_tokens, costUsd: Number(run.cost_usd ?? 0) }
    : emptyUsage();
  let usage = routeUsage ?? emptyUsage();
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

  /** 最近一次调用的思路摘要（强模型），随消息保存 */
  let lastThinking = '';

  async function call(r: AgentRole, onText?: (t: string) => void) {
    const p = r.buildPrompt(ctx);
    progress.callStarted(r.id);
    lastThinking = '';
    const res = await streamLLM({
      role: r.id,
      tier: r.model,
      system: p.system,
      input: p.input,
      maxTokens: p.maxTokens,
      taskBudget: p.taskBudget,
      signal,
      onText: (t) => {
        progress.output(t.length);
        onText?.(t);
      },
      onThinking: (t) => {
        progress.output(t.length);
        lastThinking += t;
        emit({ event: 'thinking_delta', data: { agent: r.id, text: t } });
      },
    });
    usage = addUsage(usage, res.usage);
    const t = totalUsage();
    if (t.inputTokens + t.cacheReadTokens + t.outputTokens > LIMITS.runTokenBudget) {
      throw new RunError('budget', `本轮生成超出 token 预算（${LIMITS.runTokenBudget / 1000}K），已停止。可以把需求拆小一点再试`);
    }
    return res;
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
    // 文件增量合并后最多每 100 毫秒下发一次，代码面板据此实时跟随
    let deltaBuf = { path: '', text: '' };
    let lastFlush = 0;
    const flushDelta = () => {
      if (!deltaBuf.text) return;
      emit({ event: 'file_delta', data: { path: deltaBuf.path, text: deltaBuf.text, agent: id } });
      deltaBuf = { path: deltaBuf.path, text: '' };
      lastFlush = Date.now();
    };
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
        case 'file_delta':
          if (deltaBuf.path !== e.path) {
            flushDelta();
            deltaBuf.path = e.path;
          }
          deltaBuf.text += e.text;
          if (Date.now() - lastFlush >= DELTA_FLUSH_MS) flushDelta();
          break;
        case 'file_end':
          flushDelta();
          changed[e.path] = e.content;
          progress.fileDone(Buffer.byteLength(e.content));
          emit({ event: 'file_done', data: { path: e.path, bytes: Buffer.byteLength(e.content), content: e.content, agent: id } });
          break;
        case 'delete':
          deleted.push(e.path);
          break;
      }
    };
    ctx.files = files;
    const res = await call(r, (t) => parser.push(t).forEach(onTag));
    const fin = parser.finish();
    fin.events.forEach(onTag);
    if (signal.aborted) throw signal.reason ?? new Error('aborted');
    const who = id === 'fixer' ? 'Max' : 'Kai';
    if (!Object.keys(changed).length && !deleted.length) {
      // 如实告诉用户发生了什么：被长度上限截断 / 用文字回答了 / 真的什么都没给
      if (res.stopReason === 'max_tokens') {
        throw new RunError(
          'truncated',
          `${who} 的输出超出了单次长度上限（${LIMITS.maxOutputTokens / 1000}K tokens，思考也计入其中），在写完文件之前被截断，本轮没有保存任何改动。可以把需求拆成几步分别提出，或者先做一个简化版本。`,
        );
      }
      if (narrative.trim()) {
        pending.push({
          role: 'agent',
          agent: id,
          content: narrative.trim(),
          meta: { replyOnly: true, ...(lastThinking ? { thinking: lastThinking.trim().slice(0, 4000) } : {}) },
          version_id: null,
        });
        throw new ReplyOnly();
      }
      throw new RunError(
        'empty_output',
        fin.unclosedFile ? `${who} 写到 ${fin.unclosedFile} 时输出中断，没有得到完整的文件，请重试` : `${who} 没有给出任何内容，请换个说法再试`,
      );
    }
    if (res.stopReason === 'max_tokens' && fin.unclosedFile) {
      // 有完整的文件，但最后一个被截断：照常检查已完成的部分，并在消息里说明
      emit({ event: 'message_delta', data: { agent: id, text: `\n（输出达到长度上限，${fin.unclosedFile} 没有写完，已丢弃）` } });
    }
    files = { ...files, ...changed };
    for (const p of deleted) delete files[p];
    ctx.files = files;
    const notes = fin.unclosedFile ? [`文件 ${fin.unclosedFile} 输出不完整，已丢弃`] : [];
    pending.push({
      role: 'agent',
      agent: id,
      content: narrative.trim() || summary,
      meta: { summary, files: Object.keys(changed), deleted, notes, ...(lastThinking ? { thinking: lastThinking.trim().slice(0, 4000) } : {}) },
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
    if (quotaErr) throw quotaErr;
    let summary = '';
    if (intent === 'chat') {
      // 对话：被点名的成员（默认 Leo）直接回答，不改应用、不生成版本
      progress.step('reply');
      progress.callStarted(chatAgent);
      emit({ event: 'agent_started', data: { agent: chatAgent } });
      let reply = '';
      const res = await streamLLM({
        role: chatAgent,
        tier: 'fast',
        system: chatSystem(chatAgent),
        input: buildChatInput({ message: opts.instruction, spec: ctx.spec, files, history }),
        maxTokens: 2000,
        signal,
        onText: (t) => {
          reply += t;
          progress.output(t.length);
          emit({ event: 'message_delta', data: { agent: chatAgent, text: t } });
        },
      });
      usage = addUsage(usage, res.usage);
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
      pending.push({ role: 'agent', agent: chatAgent, content: reply.trim() || '（没有回复）', meta: { chat: true, usage: usageOut() }, version_id: null });
      await finish('replied');
      await persist();
      return;
    }
    if (intent === 'create') {
      const planner = rolesFor('create', 'plan', opts.team)[0];
      const designer = rolesFor('create', 'design', opts.team)[0];
      const crew = [planner && 'Nora 先梳理需求', designer && 'Mia 定风格', '然后 Kai 开工'].filter(Boolean).join('，');
      leader(`收到。${crew}。`);

      if (planner) {
        progress.step('plan');
        emit({ event: 'agent_started', data: { agent: 'planner' } });
        const out = extractJson<PlannerOut>((await call(planner)).text);
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
          progress.stop();
          return;
        }
        emit({ event: 'plan', data: { spec } });
        pending.push({ role: 'agent', agent: 'planner', content: say, meta: { plan: spec }, version_id: null });
        ctx.spec = spec;
        progress.planFiles(spec.files?.filter((f) => f !== 'design.json').length ?? null);
      }

      if (designer) {
        progress.step('design');
        emit({ event: 'agent_started', data: { agent: 'designer' } });
        const out = extractJson<Record<string, unknown>>((await call(designer)).text);
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
      progress.step('code');
      summary = await runFilesAgent('engineer');
    } else if (intent === 'edit') {
      leader('收到。Kai 直接在现有版本上改，只动需要变更的文件。');
      progress.step('code');
      summary = await runFilesAgent('engineer');
    } else {
      fixRounds++;
      for (const e of opts.errors) errorKinds.add(e.kind);
      leader(reused ? `预览运行时报错，Max 来自动修复（第 ${fixRounds} 次）。` : '收到。Max 先定位报错原因，再修复相关文件。');
      progress.step('fix');
      summary = await runFilesAgent('fixer');
    }

    // ---------- 第一道关：服务端检查 + 修复回路
    let firstCheckPassed = true;
    let lastSig = '';
    progress.step('check');
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

    progress.step('save');
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
        progress.step('suggest');
        ctx.summary = summary;
        emit({ event: 'agent_started', data: { agent: 'advisor' } });
        const out = extractJson<{ suggestions?: string[] }>((await call(advisor)).text);
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
    if (err instanceof ReplyOnly && !signal.aborted) {
      // Kai / Max 用文字回答而没有写文件：作为正常回复保存，不算失败，也不生成版本
      await finish('replied');
      await persist();
      return;
    }
    if (signal.aborted) {
      await finish('cancelled');
      await persist({ role: 'system', agent: null, content: '已停止生成，保留上一个版本。', meta: { runId: run.id, status: 'cancelled' }, version_id: null });
      return;
    }
    const readable = err instanceof RunError ? err : isQuotaError(err) ? quotaError() : new RunError('llm_error', friendlyLLMError(err));
    if (!(err instanceof RunError)) console.error('[generate]', readable.code === 'quota' ? 'model quota exhausted' : err);
    emit({ event: 'error', data: { code: readable.code, message: readable.message } });
    await finish('failed', { final_ok: false, first_pass: reused ? run.first_pass : false }, readable.message);
    await persist({ role: 'system', agent: null, content: readable.message, meta: { runId: run.id, status: 'failed', code: readable.code }, version_id: null });
  } finally {
    progress.stop();
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

/** 模型额度用完：告诉用户是我们的账户没钱了（不是他们的问题），并留下联系方式 */
function quotaError() {
  return new RunError(
    'quota',
    `抱歉，我们的模型服务额度已经用完（账户余额不足），暂时无法生成，这不是你的操作问题。请联系作者 ${env.supportEmail} 为账户充值，充值后即可继续使用，已有的项目和版本都不会丢失。`,
  );
}

function friendlyLLMError(err: unknown): string {
  const status = (err as { status?: number })?.status;
  if (status === 429) return '模型服务繁忙（限流），请稍后再试';
  if (status === 401 || status === 403) return '模型服务鉴权失败，请检查服务端配置';
  if (status && status >= 500) return '模型服务暂时不可用，请稍后再试';
  return '生成失败：' + (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

export type { AgentId };
