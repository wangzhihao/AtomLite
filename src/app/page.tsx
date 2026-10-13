'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ensureUser, notifyAuthChanged } from '@/lib/client/api';
import type { Project } from '@/lib/shared/types';
import { LIMITS } from '@/lib/shared/types';

const EXAMPLES = [
  { label: '个人博客', prompt: '帮我做一个漂亮的个人定制化博客网站，有首页文章列表、文章详情页和关于页' },
  { label: '记账本', prompt: '做一个简洁的记账本，可以记录收入和支出，按月汇总，并显示分类占比' },
  { label: '番茄钟', prompt: '做一个番茄钟，25 分钟专注 + 5 分钟休息，可以记录今天完成了几个番茄' },
  { label: '待办清单', prompt: '做一个待办清单，支持添加、完成、删除和按状态筛选' },
  { label: '抽奖转盘', prompt: '做一个抽奖转盘，可以自定义奖项，点击开始后转动并显示结果' },
];

export default function Home() {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function start(text: string) {
    const p = text.trim();
    if (!p || busy) return;
    setBusy(true);
    setError('');
    try {
      await ensureUser();
      notifyAuthChanged();
      const { project } = await api<{ project: Project }>('/api/projects', { method: 'POST', json: { prompt: p } });
      router.push(`/projects/${project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col items-center px-4 pb-16 pt-16 sm:pt-24">
      <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700">AI 团队 · 实时预览 · 多轮迭代</span>
      <h1 className="mt-5 text-center text-3xl font-bold tracking-tight text-slate-900 sm:text-5xl">一句话，做出一个能用的应用</h1>
      <p className="mt-4 text-center text-slate-500">描述你想要的应用，Agent 团队会当场写代码，右侧实时看到它长出来。</p>

      <form
        className="mt-10 w-full rounded-2xl border border-slate-200 bg-white p-3 shadow-sm focus-within:border-brand-500"
        onSubmit={(e) => {
          e.preventDefault();
          start(prompt);
        }}
      >
        <textarea
          data-testid="home-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              start(prompt);
            }
          }}
          rows={3}
          maxLength={LIMITS.messageChars}
          placeholder="例如：做一个记账本，可以记录收入和支出，按月汇总"
          className="w-full resize-none bg-transparent px-2 py-1 text-base outline-none placeholder:text-slate-400"
        />
        <div className="flex items-center justify-between">
          <span className="px-2 text-xs text-slate-400">Enter 发送 · Shift+Enter 换行 · 无需注册</span>
          <button
            data-testid="home-submit"
            disabled={!prompt.trim() || busy}
            className="rounded-xl bg-brand-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? '正在创建…' : '生成应用'}
          </button>
        </div>
      </form>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex.label}
            disabled={busy}
            onClick={() => {
              setPrompt(ex.prompt);
              start(ex.prompt);
            }}
            className="rounded-full border border-slate-200 bg-white px-4 py-1.5 text-sm text-slate-600 transition hover:border-brand-500 hover:text-brand-700 disabled:opacity-50"
            data-testid="example-chip"
          >
            {ex.label}
          </button>
        ))}
      </div>
    </main>
  );
}
