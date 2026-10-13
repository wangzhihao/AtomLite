'use client';
import { useEffect, useState } from 'react';
import { PERSONAS } from '@/components/persona';
import type { AgentId, TeamConfig } from '@/lib/shared/types';
import { DEFAULT_TEAM } from '@/lib/shared/types';

const KEY = 'atoms:team';

export function loadTeam(): TeamConfig {
  try {
    return { ...DEFAULT_TEAM, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return DEFAULT_TEAM;
  }
}

const ROWS: { id: AgentId; desc: string; toggle?: keyof TeamConfig }[] = [
  { id: 'leader', desc: '串场播报，不调用模型' },
  { id: 'planner', desc: '新建时拆解需求、必要时先提问', toggle: 'planner' },
  { id: 'designer', desc: '新建时给出配色、字体、圆角等设计规范', toggle: 'designer' },
  { id: 'engineer', desc: '编写和修改代码' },
  { id: 'fixer', desc: '语法检查或运行出错时自动修复' },
  { id: 'advisor', desc: '每轮结束给出 3 条下一步建议', toggle: 'advisor' },
  { id: 'qa', desc: '运行通过后按功能点做交互测试，失败交给 Max（多一次强模型调用）', toggle: 'qa' },
];

/** 团队配置面板：开关各 Agent，对比效果（保存在本浏览器） */
export function TeamPanel({ team, onChange }: { team: TeamConfig; onChange: (t: TeamConfig) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(team));
    } catch {
      /* 存储不可用时只在本次会话生效 */
    }
  }, [team]);
  const on = ROWS.filter((r) => !r.toggle || team[r.toggle]);
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-100" data-testid="team">
        <span className="flex -space-x-1.5">
          {on.slice(0, 5).map((r) => (
            <span key={r.id} className="grid h-5 w-5 place-items-center rounded-full text-[10px] font-semibold text-white ring-2 ring-white" style={{ background: PERSONAS[r.id].color }}>
              {PERSONAS[r.id].name[0]}
            </span>
          ))}
        </span>
        团队
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-40 w-80 rounded-xl border border-slate-200 bg-white p-3 shadow-xl" data-testid="team-panel">
          <p className="px-1 pb-2 text-sm font-medium">团队配置</p>
          <ul className="space-y-1">
            {ROWS.map((r) => {
              const p = PERSONAS[r.id];
              return (
                <li key={r.id} className="flex items-center gap-2 rounded-lg px-1 py-1.5">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold text-white" style={{ background: p.color }}>
                    {p.name[0]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      {p.name} <span className="text-xs text-slate-400">· {p.title}</span>
                    </p>
                    <p className="text-xs text-slate-500">{r.desc}</p>
                  </div>
                  {r.toggle ? (
                    <button
                      role="switch"
                      aria-checked={team[r.toggle]}
                      onClick={() => onChange({ ...team, [r.toggle!]: !team[r.toggle!] })}
                      className={`relative h-5 w-9 shrink-0 rounded-full transition ${team[r.toggle] ? 'bg-brand-600' : 'bg-slate-300'}`}
                      data-testid={`toggle-${r.id}`}
                    >
                      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${team[r.toggle] ? 'left-[18px]' : 'left-0.5'}`} />
                    </button>
                  ) : (
                    <span className="shrink-0 text-xs text-slate-400">必需</span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-2 px-1 text-xs text-slate-400">下一轮生成生效；修改轮次只有 Kai 参与。</p>
          <button onClick={() => setOpen(false)} className="absolute right-2 top-2 text-xs text-slate-400">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
