'use client';
import { useState } from 'react';
import { PERSONAS } from '@/components/persona';
import { timeAgo } from '@/lib/client/api';
import type { AgentId, CheckError, ClarifyQuestion, Message, QAResult, RunIntent, Spec, Usage } from '@/lib/shared/types';

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
};
export type LiveRun = {
  userText: string | null;
  runId: string | null;
  intent: RunIntent | null;
  blocks: LiveBlock[];
  error: string | null;
  usage: Usage | null;
  versionId: string | null;
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
  };
  return (
    <AgentBlock agent={agent} testId={`msg-${agent}`}>
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
            <p className={`whitespace-pre-wrap ${streaming ? 'caret' : ''}`}>{b.text.trim()}</p>
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
      {live.error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{live.error}</p>}
    </div>
  );
}
