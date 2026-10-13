'use client';
import { useEffect, useState } from 'react';
import { api, timeAgo } from '@/lib/client/api';
import type { Files, Project, Version, VersionMeta } from '@/lib/shared/types';

const SOURCE_LABEL: Record<string, string> = { agent: '', autofix: '自动修复', restore: '回滚', remix: 'Remix' };

export function CodeView({ files }: { files: Files | null }) {
  const paths = Object.keys(files ?? {});
  const [sel, setSel] = useState<string | null>(null);
  const active = sel && paths.includes(sel) ? sel : (paths.find((p) => /app\.jsx$/i.test(p)) ?? paths[0]);
  if (!files || !paths.length) return <p className="p-8 text-center text-sm text-slate-400">还没有代码。</p>;
  return (
    <div className="flex h-full" data-testid="code-view">
      <ul className="w-44 shrink-0 overflow-y-auto border-r border-slate-200 bg-white py-2 text-sm">
        {paths.map((p) => (
          <li key={p}>
            <button
              onClick={() => setSel(p)}
              className={`w-full truncate px-3 py-1 text-left ${p === active ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}
            >
              {p}
            </button>
          </li>
        ))}
      </ul>
      <pre className="min-w-0 flex-1 overflow-auto bg-slate-950 p-4 text-xs leading-relaxed text-slate-100">
        <code>{files[active]}</code>
      </pre>
    </div>
  );
}

export function VersionsView({
  projectId,
  project,
  refreshKey,
  busy,
  onView,
  onRestored,
}: {
  projectId: string;
  project: Project;
  refreshKey: string;
  busy: boolean;
  onView: (v: Version) => void;
  onRestored: () => void;
}) {
  const [versions, setVersions] = useState<VersionMeta[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ versions: VersionMeta[] }>(`/api/projects/${projectId}/versions`).then(
      (d) => setVersions(d.versions),
      () => setVersions([]),
    );
  }, [projectId, refreshKey]);

  async function view(v: VersionMeta) {
    const { version } = await api<{ version: Version }>(`/api/projects/${projectId}/versions?id=${v.id}`);
    onView(version);
  }

  async function restore(v: VersionMeta) {
    setError('');
    try {
      await api(`/api/projects/${projectId}/versions/${v.id}/restore`, { method: 'POST' });
      onRestored();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!versions) return <div className="skeleton m-4 h-40 rounded-lg" />;
  if (!versions.length) return <p className="p-8 text-center text-sm text-slate-400">还没有版本。每轮生成都会保存一个版本。</p>;
  return (
    <div className="h-full overflow-y-auto p-4">
      {error && <p className="mb-2 rounded bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      <ul className="space-y-2" data-testid="version-list">
        {versions.map((v) => {
          const current = v.id === project.current_version_id;
          const published = v.id === project.published_version_id;
          return (
            <li key={v.id} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3" data-testid="version-item">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">v{v.seq}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-slate-700">{v.summary ?? '（无摘要）'}</p>
                <p className="flex flex-wrap gap-1.5 text-xs text-slate-400">
                  {timeAgo(v.created_at)}
                  {SOURCE_LABEL[v.source] && <span className="rounded bg-slate-100 px-1.5 text-slate-500">{SOURCE_LABEL[v.source]}</span>}
                  {v.verified === false && <span className="rounded bg-red-50 px-1.5 text-red-600">运行出错</span>}
                  {current && <span className="rounded bg-emerald-50 px-1.5 text-emerald-700">当前</span>}
                  {published && <span className="rounded bg-indigo-50 px-1.5 text-indigo-700">已发布</span>}
                </p>
              </div>
              <button onClick={() => view(v)} className="shrink-0 rounded px-2 py-1 text-xs text-brand-600 hover:bg-brand-50">
                预览
              </button>
              {!current && (
                <button
                  disabled={busy}
                  onClick={() => restore(v)}
                  className="shrink-0 rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                  data-testid="restore"
                >
                  回滚到此版本
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function PublishButton({ project, disabled, onPublished }: { project: Project; disabled: boolean; onPublished: (p: Project) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const upToDate = Boolean(project.published_slug && project.published_version_id === project.current_version_id);
  const url = project.published_slug ? `${typeof window === 'undefined' ? '' : window.location.origin}/s/${project.published_slug}` : '';

  async function publish() {
    setBusy(true);
    setError('');
    try {
      const { project: p } = await api<{ project: Project }>(`/api/projects/${project.id}/publish`, { method: 'POST' });
      onPublished(p);
      setOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        disabled={disabled || busy || !project.current_version_id}
        onClick={() => (upToDate ? setOpen(!open) : publish())}
        className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40 ${upToDate ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-900 text-white hover:bg-slate-700'}`}
        data-testid="publish"
      >
        {busy ? '发布中…' : upToDate ? '已发布' : project.published_slug ? '更新发布' : '发布'}
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-40 w-80 rounded-xl border border-slate-200 bg-white p-4 shadow-xl" data-testid="publish-popover">
          {error ? (
            <p className="text-sm text-red-600">{error}</p>
          ) : (
            <>
              <p className="text-sm font-medium">已发布，任何人都可以访问</p>
              <div className="mt-2 flex gap-1">
                <input readOnly value={url} className="min-w-0 flex-1 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs" data-testid="publish-url" />
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(url).then(() => setCopied(true), () => undefined);
                  }}
                  className="rounded bg-slate-100 px-2 text-xs"
                >
                  {copied ? '已复制' : '复制'}
                </button>
              </div>
              <a href={url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-brand-600" data-testid="publish-open">
                打开发布页 ↗
              </a>
              <p className="mt-2 text-xs text-slate-400">之后的修改不会影响已发布页面，再次点击发布才会更新。</p>
            </>
          )}
          <button onClick={() => setOpen(false)} className="absolute right-2 top-2 text-xs text-slate-400">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
