'use client';
import { useEffect, useState } from 'react';
import { PERSONAS } from '@/components/persona';
import { timeAgo } from '@/lib/client/api';
import type { AgentId, CheckError, ClarifyQuestion, Message, ProgressData, ProgressStep, QAResult, RunIntent, Spec, StepId, Usage } from '@/lib/shared/types';

export type LiveFile = { path: string; status: 'writing' | 'done'; bytes?: number };
export type LiveBlock = {
  agent: AgentId | 'note';
  text: string;
  files: LiveFile[];
  plan?: Spec;
  design?: Record<string, unknown>;
  clarify?: ClarifyQuestion[];
  suggestions?: string[];
  checkErrors?: CheckError[];
  /** 模型思路摘要（强模型） */
  thinking?: string;
};
export type LiveRun = {
  userText: string | null;
  runId: string | null;
  intent: RunIntent | null;
  blocks: LiveBlock[];
  error: string | null;
  errorCode?: string;
  usage: Usage | null;
  versionId: string | null;
  /** 进度：步骤清单、当前步骤、最近一次心跳、最近一次收到任何事件的时间 */
  steps: ProgressStep[];
  typicalMs: number | null;
  step: StepId | null;
  progress: ProgressData | null;
  startedAt: number;
  lastEventAt: number;
};

/** 交互动作：澄清卡片提交 / 跳过、建议 chip 点击 */
export type TimelineActions = {
  interactive: boolean;
  onClarify: (answers: { question: string; answer: string }[] | null) => void;
  onSuggest: (text: string) => void;
};

function Avatar({ agent }: { agent: AgentId }) {
  const p = PERSONAS[agent];
  return (
    <span
      className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold text-white"
      style={{ background: p.color }}
      title={`${p.name} · ${p.title}`}
    >
      {p.name[0]}
    </span>
  );
}

function AgentBlock({ agent, children, testId }: { agent: AgentId; children: React.ReactNode; testId?: string }) {
  const p = PERSONAS[agent];
  return (
    <div className="flex gap-2.5" data-testid={testId} data-agent={agent}>
      <Avatar agent={agent} />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-slate-400">
          <span className="font-medium text-slate-600">{p.name}</span> · {p.title}
        </p>
        <div className="mt-1 text-sm leading-relaxed text-slate-700">{children}</div>
      </div>
    </div>
  );
}

function LeaderLine({ text, live }: { text: string; live?: boolean }) {
  return (
    <div className="flex items-start gap-2 text-xs text-slate-500" data-testid="leader-message">
      <Avatar agent="leader" />
      <p className={`pt-1.5 ${live && !text ? 'caret' : ''}`}>
        <span className="font-medium text-slate-600">Leo</span>　{text}
      </p>
    </div>
  );
}

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-brand-600 px-3.5 py-2 text-sm text-white" data-testid="user-message">
        {text}
      </p>
    </div>
  );
}

export function formatUsage(u: Usage) {
  const total = u.inputTokens + u.outputTokens;
  const tokens = total >= 10000 ? `${(total / 10000).toFixed(1)} 万` : String(total);
  const fix = u.fixRounds ? ` · 自动修复 ${u.fixRounds} 次` : '';
  return `${tokens} tokens · 约 $${u.costUsd.toFixed(3)}${fix}`;
}

function FileChip({ path, status }: { path: string; status: 'writing' | 'done' }) {
  return (
    <li className="flex items-center gap-2 text-xs text-slate-500" data-testid="file-progress">
      {status === 'writing' ? <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" /> : <span className="text-emerald-500">✓</span>}
      {status === 'writing' ? '正在写入' : '已写入'} <code className="rounded bg-slate-100 px-1">{path}</code>
    </li>
  );
}

function PlanCard({ spec }: { spec: Spec }) {
  return (
    <div className="mt-2 rounded-lg border border-violet-100 bg-violet-50/50 p-3 text-xs" data-testid="plan-card">
      <p className="font-medium text-slate-700">
        {spec.appName}
        {spec.summary && <span className="ml-1 font-normal text-slate-500">— {spec.summary}</span>}
      </p>
      {spec.features.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-4 text-slate-600">
          {spec.features.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      {spec.files && spec.files.length > 0 && <p className="mt-2 text-slate-400">文件计划：{spec.files.join('、')}</p>}
      {spec.assumptions && spec.assumptions.length > 0 && <p className="mt-1 text-amber-600">假设：{spec.assumptions.join('；')}</p>}
    </div>
  );
}

function DesignCard({ design }: { design: Record<string, unknown> }) {
  const colors = (design.colors ?? {}) as Record<string, string>;
  const font = (design.font ?? {}) as Record<string, string>;
  return (
    <div className="mt-2 rounded-lg border border-pink-100 bg-pink-50/40 p-3 text-xs" data-testid="design-card">
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(colors).map(([k, v]) => (
          <span key={k} className="flex items-center gap-1 rounded-full bg-white px-1.5 py-0.5 text-slate-500 shadow-sm" title={`${k}: ${v}`}>
            <span className="h-3 w-3 rounded-full ring-1 ring-black/10" style={{ background: v }} />
            {k}
          </span>
        ))}
      </div>
      {(font.heading || design.radius) ? (
        <p className="mt-2 text-slate-500">
          {font.heading && <span style={{ fontFamily: font.heading }}>标题字体 Aa</span>}
          {design.radius ? <span className="ml-2">圆角 {String(design.radius)}</span> : null}
        </p>
      ) : null}
    </div>
  );
}

function ClarifyCard({ questions, actions }: { questions: ClarifyQuestion[]; actions?: TimelineActions }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const active = Boolean(actions?.interactive);
  return (
    <form
      className="mt-2 space-y-2 rounded-lg border border-violet-200 bg-white p-3"
      data-testid="clarify-card"
      onSubmit={(e) => {
        e.preventDefault();
        actions?.onClarify(questions.map((q) => ({ question: q.question, answer: (answers[q.id] ?? '').trim() })));
      }}
    >
      {questions.map((q) => (
        <label key={q.id} className="block text-xs">
          <span className="text-slate-600">{q.question}</span>
          <input
            disabled={!active}
            value={answers[q.id] ?? ''}
            onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
            placeholder={q.placeholder}
            className="mt-1 w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-violet-400 disabled:bg-slate-50"
            data-testid="clarify-input"
          />
        </label>
      ))}
      {active && (
        <div className="flex gap-2 pt-1">
          <button className="rounded-md bg-violet-600 px-3 py-1.5 text-xs text-white" data-testid="clarify-submit">
            开始生成
          </button>
          <button type="button" onClick={() => actions?.onClarify(null)} className="rounded-md px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100" data-testid="clarify-skip">
            先帮我随便做
          </button>
        </div>
      )}
    </form>
  );
}

function Suggestions({ items, actions }: { items: string[]; actions?: TimelineActions }) {
  const active = Boolean(actions?.interactive);
  return (
    <div className="mt-2 flex flex-wrap gap-1.5" data-testid="suggestions">
      {items.map((s) => (
        <button
          key={s}
          disabled={!active}
          onClick={() => actions?.onSuggest(s)}
          className="rounded-full border border-cyan-200 bg-cyan-50 px-3 py-1 text-xs text-cyan-800 transition enabled:hover:bg-cyan-100 disabled:opacity-60"
          data-testid="suggestion-chip"
        >
          {s}
        </button>
      ))}
    </div>
  );
}

/** 模型额度用完：醒目的提示卡片，邮箱可直接点击 */
export function QuotaCard({ text }: { text: string }) {
  const email = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(text)?.[0];
  const [before, after] = email ? text.split(email) : [text, ''];
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" data-testid="quota-card" role="alert">
      <p className="font-semibold">模型服务额度已用完</p>
      <p className="mt-1 leading-relaxed">
        {before}
        {email && (
          <a href={`mailto:${email}?subject=${encodeURIComponent('Atoms Lite 额度充值')}`} className="font-medium text-brand-700 underline" data-testid="quota-email">
            {email}
          </a>
        )}
        {after}
      </p>
    </div>
  );
}

/** 思路摘要：默认折叠成一行，点开看全文 */
function Thinking({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const t = text.trim();
  if (!t) return null;
  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      className="mb-1 block w-full rounded-md bg-slate-50 px-2 py-1 text-left text-xs text-slate-500 hover:bg-slate-100"
      data-testid="thinking"
      aria-expanded={open}
    >
      <span className="mr-1 font-medium text-slate-400">{open ? '▾' : '▸'} 思路</span>
      <span className={open ? 'whitespace-pre-wrap' : 'line-clamp-1'} data-testid="thinking-text">
        {t}
        {live && <span className="caret" />}
      </span>
    </button>
  );
}

const fmtSec = (ms: number) => `${Math.max(0, Math.round(ms / 1000))} 秒`;
const fmtTokens = (chars: number) => {
  const t = Math.round(chars / 2.5);
  return t >= 1000 ? `${(t / 1000).toFixed(1)}K` : String(t);
};
const DISCONNECT_MS = 8000;

/** 进度面板：步骤条 + 当前在做什么、用时、输出量 + 文件进度 + 慢响应 / 断线提示 */
export function RunProgress({ live }: { live: LiveRun }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!live.steps.length) return null;
  const p = live.progress;
  const elapsed = now - live.startedAt;
  const sinceEvent = now - live.lastEventAt;
  const lastBlock = live.blocks[live.blocks.length - 1];
  const writing = lastBlock?.files.find((f) => f.status === 'writing');
  const curIdx = live.steps.findIndex((s) => s.id === live.step);
  const doing = (() => {
    switch (live.step) {
      case 'plan':
        return 'Nora 正在梳理需求';
      case 'design':
        return 'Mia 正在定设计规范';
      case 'code':
        return writing ? `Kai 正在写 ${writing.path}` : lastBlock?.agent === 'engineer' && lastBlock.text.trim() ? 'Kai 正在说明方案' : 'Kai 正在思考';
      case 'fix':
        return writing ? `Max 正在改 ${writing.path}` : 'Max 正在定位问题';
      case 'check':
        return p?.agent === 'fixer' || lastBlock?.agent === 'fixer' ? 'Max 正在修复语法问题' : '正在做语法检查';
      case 'save':
        return '正在保存版本';
      case 'suggest':
        return 'Sage 正在想下一步建议';
      case 'reply':
        return `${PERSONAS[p?.agent ?? 'leader'].name} 正在回复`;
      default:
        return '团队正在准备';
    }
  })();
  const stalled = p && p.idleMs > p.stallAfterMs && !live.usage;
  const disconnected = sinceEvent > DISCONNECT_MS && !live.usage;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs shadow-sm" data-testid="progress-bar">
      <ol className="flex flex-wrap items-center gap-1">
        {live.steps.map((s, i) => {
          const status = live.usage ? 'done' : i < curIdx ? 'done' : i === curIdx ? 'active' : 'todo';
          return (
            <li key={s.id} className="flex items-center gap-1" data-testid="progress-step" data-status={status} data-step={s.id}>
              {i > 0 && <span className={`h-px w-3 ${status === 'todo' ? 'bg-slate-200' : 'bg-brand-500'}`} />}
              <span
                className={`rounded-full px-2 py-0.5 ${
                  status === 'done' ? 'bg-brand-50 text-brand-700' : status === 'active' ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-400'
                }`}
              >
                {status === 'done' ? '✓ ' : ''}
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 flex flex-wrap items-center gap-x-2 text-slate-600" data-testid="progress-status">
        {!live.usage && <span className="h-2 w-2 animate-pulse rounded-full bg-brand-500" />}
        <span className="font-medium text-slate-700">{live.usage ? '已完成' : doing}</span>
        <span>· 已用 <span data-testid="progress-elapsed">{fmtSec(elapsed)}</span></span>
        {p && p.outputChars > 0 && <span>· 约 {fmtTokens(p.outputChars)} tokens</span>}
        {p && (p.filesPlanned || p.filesDone > 0) && (
          <span data-testid="progress-files">
            · 文件 {p.filesDone}
            {p.filesPlanned ? `/${p.filesPlanned}` : ''}
            {p.bytes > 0 ? ` · ${(p.bytes / 1024).toFixed(1)} KB` : ''}
          </span>
        )}
        {live.typicalMs && !live.usage && (
          <span className="text-slate-400" data-testid="progress-typical">
            · 通常约 {fmtSec(live.typicalMs)}
            {elapsed > live.typicalMs * 1.5 ? '，这次慢一些' : ''}
          </span>
        )}
      </p>
      {disconnected ? (
        <p className="mt-2 rounded-md bg-red-50 px-2 py-1 text-red-700" data-testid="progress-disconnected">
          {fmtSec(sinceEvent)}没有收到服务器的任何消息，连接可能中断了。可以停止后重试。
        </p>
      ) : stalled ? (
        <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-amber-700" data-testid="progress-stall">
          模型响应较慢：已 {fmtSec(p!.idleMs)}没有新输出，连接正常，仍在等待…
        </p>
      ) : null}
    </div>
  );
}

function CheckErrors({ errors }: { errors: CheckError[] }) {
  return (
    <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="check-failed">
      <p className="font-medium">服务端语法检查未通过</p>
      {errors.slice(0, 3).map((e, i) => (
        <p key={i} className="truncate" title={e.message}>
          {e.file ? `${e.file}${e.line ? `:${e.line}` : ''} ` : ''}
          {e.message}
        </p>
      ))}
    </div>
  );
}

/** 已持久化的一条消息；actions 只传给最后一条可交互的消息 */
export function MessageItem({ m, actions }: { m: Message; actions?: TimelineActions }) {
  if (m.role === 'user') return <UserBubble text={m.content} />;
  if (m.role === 'system') {
    if (m.meta?.code === 'quota') return <QuotaCard text={m.content} />;
    const failed = m.meta?.status === 'failed';
    return (
      <p className={`rounded-lg px-3 py-2 text-xs ${failed ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-500'}`} data-testid="system-message">
        {m.content}
      </p>
    );
  }
  const agent = (m.agent as AgentId) ?? 'engineer';
  if (agent === 'leader') return <LeaderLine text={m.content} />;
  const meta = (m.meta ?? {}) as {
    summary?: string;
    files?: string[];
    usage?: Usage;
    seq?: number;
    notes?: string[];
    plan?: Spec;
    design?: Record<string, unknown>;
    clarify?: ClarifyQuestion[];
    suggestions?: string[];
    qa?: QAResult[];
    thinking?: string;
  };
  return (
    <AgentBlock agent={agent} testId={`msg-${agent}`}>
      {meta.thinking && <Thinking text={meta.thinking} />}
      <p className="whitespace-pre-wrap" data-testid="agent-message">
        {m.content}
      </p>
      {meta.summary && meta.summary !== m.content && <p className="mt-1 font-medium text-slate-800" data-testid="agent-summary">{meta.summary}</p>}
      {meta.plan && <PlanCard spec={meta.plan} />}
      {meta.design && <DesignCard design={meta.design} />}
      {meta.clarify && <ClarifyCard questions={meta.clarify} actions={actions} />}
      {meta.suggestions && <Suggestions items={meta.suggestions} actions={actions} />}
      {meta.qa && (
        <ul className="mt-2 space-y-1 text-xs" data-testid="qa-results">
          {meta.qa.map((r) => (
            <li key={r.feature} className={r.ok ? 'text-emerald-700' : 'text-red-600'} data-testid="qa-result">
              {r.ok ? '✓' : '✗'} {r.feature}
              {r.error && <span className="ml-1 text-slate-500">— {r.error}</span>}
            </li>
          ))}
        </ul>
      )}
      {meta.files && meta.files.length > 0 && !meta.design && (
        <ul className="mt-2 space-y-1">
          {meta.files.map((f) => (
            <FileChip key={f} path={f} status="done" />
          ))}
        </ul>
      )}
      {meta.notes?.map((n) => (
        <p key={n} className="mt-1 text-xs text-amber-600">
          {n}
        </p>
      ))}
      {(meta.seq || meta.usage) && (
        <p className="mt-2 flex flex-wrap gap-x-2 text-[11px] text-slate-400">
          {meta.seq && (
            <span className="rounded bg-emerald-50 px-1.5 text-emerald-700" data-testid="version-tag">
              版本 {meta.seq}
            </span>
          )}
          {meta.usage && <span data-testid="usage-tag">{formatUsage(meta.usage)}</span>}
          <span>{timeAgo(m.created_at)}</span>
        </p>
      )}
    </AgentBlock>
  );
}

export function LiveItem({ live }: { live: LiveRun }) {
  const lastIdx = live.blocks.length - 1;
  return (
    <div className="space-y-4" data-testid="live-run">
      {live.userText && <UserBubble text={live.userText} />}
      {live.blocks.length === 0 && <LeaderLine text="" live />}
      {live.blocks.map((b, i) => {
        if (b.agent === 'note') return b.checkErrors ? <CheckErrors key={i} errors={b.checkErrors} /> : null;
        if (b.agent === 'leader') return <LeaderLine key={i} text={b.text} live />;
        const streaming = i === lastIdx && !live.usage;
        return (
          <AgentBlock key={i} agent={b.agent}>
            {b.thinking && <Thinking text={b.thinking} live={streaming && !b.text.trim()} />}
            <p className={`whitespace-pre-wrap ${streaming && b.text.trim() ? 'caret' : ''}`}>{b.text.trim()}</p>
            {b.plan && <PlanCard spec={b.plan} />}
            {b.design && <DesignCard design={b.design} />}
            {b.clarify && <ClarifyCard questions={b.clarify} />}
            {b.suggestions && <Suggestions items={b.suggestions} />}
            {b.files.length > 0 && !b.design && (
              <ul className="mt-2 space-y-1">
                {b.files.map((f) => (
                  <FileChip key={f.path} path={f.path} status={f.status} />
                ))}
              </ul>
            )}
          </AgentBlock>
        );
      })}
      {live.error &&
        (live.errorCode === 'quota' ? (
          <QuotaCard text={live.error} />
        ) : (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{live.error}</p>
        ))}
    </div>
  );
}
