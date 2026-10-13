import { getUser } from '@/lib/server/auth';
import { fail, handleError, readJson } from '@/lib/server/http';
import { activeRuns, runGeneration } from '@/lib/server/orchestrator';
import { getStore } from '@/lib/server/store';
import { encodeSSE } from '@/lib/shared/sse';
import type { AgentEvent, CheckError, ErrorKind } from '@/lib/shared/types';
import { LIMITS } from '@/lib/shared/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * SSE 生成接口（设计文档第 8 节）。body：
 *   message    本轮用户消息
 *   mode       auto | fix
 *   errors     fix 模式下的报错（字符串或 {kind, message}）
 *   runId      fix 模式下的原 run：自动修复计入同一个 run
 *   auto       true 表示由前端自愈回路自动发起（不记录用户消息、不计入限流）
 *   clarified  true 表示这是对澄清卡片的回答 / 跳过，本轮不再提问
 *   resume     true 时处理项目里待处理的首条需求（首页创建项目时保存）
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUser();
    if (!user) return fail('请先登录', 401, 'unauthorized');
    const store = getStore(user);
    const { id } = await params;
    const project = await store.getProject(id);
    if (!project) return fail('项目不存在', 404, 'not_found');

    const body = await readJson<{
      message: string;
      mode: 'auto' | 'fix';
      errors: (string | CheckError)[];
      runId: string;
      auto: boolean;
      clarified: boolean;
      resume: boolean;
      team: Record<string, unknown>;
    }>(req);
    const team = Object.fromEntries(
      (['planner', 'designer', 'advisor', 'qa'] as const).filter((k) => typeof body.team?.[k] === 'boolean').map((k) => [k, body.team![k] as boolean]),
    );
    const mode = body.mode === 'fix' ? 'fix' : 'auto';
    const auto = mode === 'fix' && body.auto === true && typeof body.runId === 'string';
    const kinds: ErrorKind[] = ['syntax', 'runtime', 'console', 'blank', 'qa'];
    const errors: CheckError[] = (Array.isArray(body.errors) ? body.errors : []).slice(0, 10).map((e) =>
      typeof e === 'string'
        ? { kind: 'runtime', message: e.slice(0, 500) }
        : { kind: kinds.includes(e?.kind) ? e.kind : 'runtime', message: String(e?.message ?? '').slice(0, 500) },
    );
    if (mode === 'fix' && !project.current_version_id) return fail('还没有可修复的版本');
    if (mode === 'fix' && !errors.length) return fail('请提供报错信息');
    let instruction = String(body.message ?? '').trim();
    let pendingId: string | null = null;
    if (body.resume) {
      const msgs = await store.listMessages(id);
      const last = msgs[msgs.length - 1];
      if (!last || last.role !== 'user' || !last.meta?.pending) return fail('没有待处理的需求', 409, 'nothing_pending');
      instruction = last.content;
      pendingId = last.id;
    }
    if (mode === 'fix') instruction = [instruction, ...errors.map((e) => `- ${e.message}`)].filter(Boolean).join('\n');
    if (!instruction) return fail('请输入需求');
    if (instruction.length > LIMITS.messageChars) return fail(`单条消息不能超过 ${LIMITS.messageChars} 字`);

    if (activeRuns.has(id) || (await store.findRunningRun(id))) {
      return fail('这个项目正在生成中，请等待完成或先停止', 409, 'busy');
    }
    // 限流：登录用户每小时 20 次，游客每天 10 次
    const since = new Date(Date.now() - (user.is_anonymous ? 24 : 1) * 3600_000).toISOString();
    const limit = user.is_anonymous ? LIMITS.runsPerDayGuest : LIMITS.runsPerHourUser;
    if (!auto && process.env.ATOMS_DISABLE_RATE_LIMIT !== '1' && (await store.countRunsSince(since)) >= limit) {
      return fail(
        user.is_anonymous ? '游客每天最多生成 10 次，绑定邮箱后可获得更多额度' : '生成太频繁了，请一小时后再试',
        429,
        'rate_limited',
      );
    }

    if (pendingId) await store.updateMessage(pendingId, { meta: { pending: false } });
    else if (!auto)
      await store.addMessage({
        project_id: id,
        role: 'user',
        agent: null,
        content: mode === 'fix' ? `让 Agent 修复：\n${instruction}` : instruction,
        meta: mode === 'fix' ? { mode } : body.clarified ? { clarified: true } : null,
        version_id: null,
      });
    else
      // 自动修复不记录用户消息；占一条系统消息，保证“最后一条是本轮触发消息”的约定
      await store.addMessage({ project_id: id, role: 'system', agent: null, content: `预览运行时报错，自动修复中：${errors[0].message.slice(0, 200)}`, meta: { autofix: true, errors }, version_id: null });

    const ctrl = new AbortController();
    activeRuns.set(id, ctrl);
    req.signal.addEventListener('abort', () => ctrl.abort(new Error('client disconnected')), { once: true });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const write = (s: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(s));
          } catch {
            closed = true;
          }
        };
        // 每 15 秒一行注释作为心跳，防止代理断开空闲连接
        const heartbeat = setInterval(() => write(': ping\n\n'), 15_000);
        write(': connected\n\n');
        try {
          await runGeneration({
            store,
            user,
            project,
            instruction,
            mode,
            errors,
            parentRunId: mode === 'fix' && typeof body.runId === 'string' ? body.runId : null,
            clarified: body.clarified === true,
            team,
            signal: ctrl.signal,
            emit: (e: AgentEvent) => write(encodeSSE(e.event, e.data)),
          });
        } catch (err) {
          console.error('[generate] unexpected', err);
          write(encodeSSE('error', { code: 'internal', message: '服务器开小差了，请稍后再试' }));
        } finally {
          clearInterval(heartbeat);
          if (activeRuns.get(id) === ctrl) activeRuns.delete(id);
          closed = true;
          try {
            controller.close();
          } catch {
            /* 已关闭 */
          }
        }
      },
      cancel() {
        ctrl.abort(new Error('client disconnected'));
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    return handleError(err);
  }
}
