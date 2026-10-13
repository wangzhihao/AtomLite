'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ensureUser, notifyAuthChanged, timeAgo } from '@/lib/client/api';
import type { Project } from '@/lib/shared/types';

export type PublishedCard = { projectId: string; name: string; slug: string; seq: number; summary: string | null; updatedAt: string; remixedFrom: string | null };

const GRADIENTS = [
  'from-indigo-100 to-sky-50 text-indigo-600',
  'from-rose-100 to-amber-50 text-rose-600',
  'from-emerald-100 to-teal-50 text-emerald-700',
  'from-violet-100 to-fuchsia-50 text-violet-600',
  'from-amber-100 to-orange-50 text-amber-700',
];

export function PublishedGrid({ items }: { items: PublishedCard[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function remix(item: PublishedCard) {
    setBusy(item.projectId);
    setError('');
    try {
      await ensureUser();
      notifyAuthChanged();
      const { project } = await api<{ project: Project }>(`/api/projects/${item.projectId}/remix`, { method: 'POST' });
      router.push(`/projects/${project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  return (
    <>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="published-grid">
        {items.map((item, i) => (
          <li key={item.projectId} className="flex flex-col rounded-xl border border-slate-200 bg-white p-4 transition hover:shadow-md" data-testid="published-card">
            <a href={`/s/${item.slug}`} className={`grid h-24 place-items-center rounded-lg bg-gradient-to-br text-3xl font-bold ${GRADIENTS[i % GRADIENTS.length]}`}>
              {item.name.slice(0, 1)}
            </a>
            <a href={`/s/${item.slug}`} className="mt-3 truncate font-medium hover:text-brand-700" data-testid="published-name">
              {item.name}
            </a>
            <p className="mt-1 line-clamp-2 min-h-[2.5em] text-xs text-slate-500">{item.summary ?? ''}</p>
            <div className="mt-3 flex items-center justify-between text-xs">
              <span className="text-slate-400">
                v{item.seq} · {timeAgo(item.updatedAt)}
                {item.remixedFrom ? ' · Remix' : ''}
              </span>
              <span className="flex gap-1">
                <a href={`/s/${item.slug}`} className="rounded px-2 py-1 text-slate-600 hover:bg-slate-100">
                  打开
                </a>
                <button
                  onClick={() => remix(item)}
                  disabled={busy !== null}
                  className="rounded bg-brand-50 px-2 py-1 text-brand-700 hover:bg-brand-100 disabled:opacity-50"
                  data-testid="published-remix"
                >
                  {busy === item.projectId ? 'Remix 中…' : 'Remix'}
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
