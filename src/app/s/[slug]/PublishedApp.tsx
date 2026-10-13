'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Preview } from '@/components/Preview';
import { api, ensureUser, notifyAuthChanged } from '@/lib/client/api';
import type { Files, Project } from '@/lib/shared/types';

/** 发布页：全屏运行应用（仍在沙箱 iframe 中，绝不把生成的 HTML 直接作为主域名页面返回） */
export function PublishedApp({ projectId, slug, name, files }: { projectId: string; slug: string; name: string; files: Files }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function remix() {
    setBusy(true);
    setError('');
    try {
      await ensureUser();
      notifyAuthChanged();
      const { project } = await api<{ project: Project }>(`/api/projects/${projectId}/remix`, { method: 'POST' });
      router.push(`/projects/${project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-white" data-testid="published-page">
      <Preview projectId={`pub:${slug}`} files={files} reloadKey={0} device="desktop" fullscreen />
      <div className="pointer-events-none fixed bottom-4 right-4 flex items-center gap-2">
        {error && <span className="pointer-events-auto rounded-full bg-red-50 px-3 py-1.5 text-xs text-red-700 shadow">{error}</span>}
        <a
          href="/"
          className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-slate-900/90 px-3 py-1.5 text-xs text-white shadow-lg backdrop-blur hover:bg-slate-900"
          title={name}
          data-testid="built-with"
        >
          <span className="grid h-4 w-4 place-items-center rounded bg-indigo-500 text-[10px] font-bold">A</span>
          Built with Atoms Lite
        </a>
        <button
          onClick={remix}
          disabled={busy}
          className="pointer-events-auto rounded-full bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white shadow-lg hover:bg-indigo-700 disabled:opacity-60"
          data-testid="remix"
        >
          {busy ? 'Remix 中…' : 'Remix 一份'}
        </button>
      </div>
    </div>
  );
}
