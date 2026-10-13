import 'server-only';
import type { AgentId, AgentEvent, ProgressStep, RunIntent, StepId } from '@/lib/shared/types';
import { env } from './env';
import type { Store } from './store';

/**
 * 进度跟踪（设计文档第 3、8 节）：
 *  - 开始时下发步骤清单和“通常耗时”（取该用户同类 run 的中位数，样本不足用默认值）
 *  - 每 2 秒下发一次 progress：当前步骤、已用时间、已输出字符、距上次输出多久、文件进度
 * 前端据此显示步骤条、计时和“模型响应较慢”提示，不再只有一个闪烁的光标。
 */
const TICK_MS = 2000;
const DEFAULT_TYPICAL_MS: Record<RunIntent, number> = { create: 60_000, edit: 35_000, fix: 30_000 };

const LABELS: Record<StepId, string> = {
  plan: '规划',
  design: '设计',
  code: '编码',
  fix: '修复',
  check: '检查',
  save: '保存',
  suggest: '建议',
};

export function planSteps(intent: RunIntent, roles: { planner: boolean; designer: boolean; advisor: boolean }): ProgressStep[] {
  const ids: StepId[] =
    intent === 'create'
      ? [...(roles.planner ? (['plan'] as const) : []), ...(roles.designer ? (['design'] as const) : []), 'code', 'check', 'save']
      : intent === 'edit'
        ? ['code', 'check', 'save']
        : ['fix', 'check', 'save'];
  if (roles.advisor) ids.push('suggest');
  return ids.map((id) => ({ id, label: LABELS[id] }));
}

export async function typicalDurationMs(store: Store, intent: RunIntent): Promise<number> {
  try {
    const ds = (await store.listRuns(50))
      .filter((r) => r.intent === intent && r.status === 'succeeded' && r.finished_at)
      .map((r) => Date.parse(r.finished_at!) - Date.parse(r.started_at))
      .filter((d) => d > 0)
      .sort((a, b) => a - b);
    if (ds.length >= 3) return ds[Math.floor(ds.length / 2)];
  } catch {
    /* 用默认值 */
  }
  return DEFAULT_TYPICAL_MS[intent];
}

export class ProgressTracker {
  private startedAt = Date.now();
  private lastOutputAt = Date.now();
  private outputChars = 0;
  private stepId: StepId | null = null;
  private agentId: AgentId | null = null;
  private filesDone = 0;
  private filesPlanned: number | null = null;
  private bytes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private emit: (e: AgentEvent) => void) {}

  start(steps: ProgressStep[], typicalMs: number) {
    this.emit({ event: 'steps', data: { steps, typicalMs } });
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  step(id: StepId) {
    if (this.stepId === id) return;
    this.stepId = id;
    this.emit({ event: 'step', data: { id } });
    this.tick();
  }

  /** 某个角色开始一次模型调用：从现在起计算“多久没有输出” */
  callStarted(agent: AgentId) {
    this.agentId = agent;
    this.lastOutputAt = Date.now();
  }

  output(chars: number) {
    this.outputChars += chars;
    this.lastOutputAt = Date.now();
  }

  planFiles(n: number | null) {
    this.filesPlanned = n && n > 0 ? n : null;
  }

  fileDone(bytes: number) {
    this.filesDone++;
    this.bytes += bytes;
  }

  tick() {
    const now = Date.now();
    this.emit({
      event: 'progress',
      data: {
        step: this.stepId,
        agent: this.agentId,
        elapsedMs: now - this.startedAt,
        outputChars: this.outputChars,
        idleMs: now - this.lastOutputAt,
        stallAfterMs: env.stallWarnMs,
        filesDone: this.filesDone,
        filesPlanned: this.filesPlanned,
        bytes: this.bytes,
      },
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
