'use client';
import { useEffect, useRef, useState } from 'react';
import { api, timeAgo } from '@/lib/client/api';
import { buildPreviewHtml } from '@/lib/shared/preview';
import { buildZip } from '@/lib/shared/zip';
import type { Files, Project, Version, VersionMeta } from '@/lib/shared/types';

const SOURCE_LABEL: Record<string, string> = { agent: '', autofix: '自动修复', restore: '回滚', remix: 'Remix' };

/** 下载源码 zip：源文件 + 可直接打开的 index.html（库从本站 /vendor 加载）+ 说明 */
function downloadZip(files: Files, name: string, seq: number | null) {
  const origin = window.location.origin;
  const bundle: Record<string, string> = {};
  for (const [p, c] of Object.entries(files)) bundle[`src/${p}`] = c;
  if (!files['index.html']) bundle['index.html'] = buildPreviewHtml(files, { vendorBase: `${origin}/vendor` });
  bundle['README.md'] = `# ${name}\n\n由 Atoms Lite 生成${seq ? `（版本 ${seq}）` : ''}。\n\n- \`src/\`：源文件（React 18 + Tailwind，浏览器端 Babel 编译，无需构建）\n- \`index.html\`：双击即可在浏览器中打开（React、Babel、Tailwind 从 ${origin}/vendor 加载）\n`;
  const blob = new Blob([buildZip(bundle) as BlobPart], { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || 'app'}${seq ? `-v${seq}` : ''}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/**
 * 代码面板。生成过程中 followPath 指向正在写入的文件：面板自动切到它，内容随 file_delta 增长并滚到末尾。
 * 用户手动点别的文件后暂停跟随，直到下一个文件开始写入。
 */
export function CodeView({
  files,
  name = 'app',
  seq = null,
  followPath = null,
  writing = [],
}: {
  files: Files | null;
  name?: string;
  seq?: number | null;
  followPath?: string | null;
  writing?: string[];
}) {
  const paths = Object.keys(files ?? {});
  const [sel, setSel] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (followPath) {
      setSel(followPath);
      setPinned(false);
    }
  }, [followPath]);
  const active = sel && paths.includes(sel) ? sel : (paths.find((p) => /app\.jsx$/i.test(p)) ?? paths[0]);
  const following = Boolean(followPath && active === followPath && !pinned);
  const content = active ? (files?.[active] ?? '') : '';
  useEffect(() => {
    if (following && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [following, content]);
  if (!files || !paths.length) return <p className="p-8 text-center text-sm text-slate-400">还没有代码。</p>;
  return (
    <div className="flex h-full" data-testid="code-view">
      <div className="flex w-44 shrink-0 flex-col border-r border-slate-200 bg-white">
        <ul className="min-h-0 flex-1 overflow-y-auto py-2 text-sm">
          {paths.map((p) => (
            <li key={p}>
              <button
                onClick={() => {
                  setSel(p);
                  setPinned(p !== followPath);
                }}
                className={`flex w-full items-center gap-1.5 truncate px-3 py-1 text-left ${p === active ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}
                data-testid="code-file"
              >
                {writing.includes(p) && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400" title="正在写入" />}
                <span className="truncate">{p}</span>
              </button>
            </li>
          ))}
        </ul>
        <button onClick={() => downloadZip(files, name, seq)} className="m-2 rounded-lg border border-slate-200 py-1.5 text-xs text-slate-600 hover:bg-slate-50" data-testid="download-zip">
          ⬇ 下载 zip
        </button>
      </div>
      <div className="relative flex min-w-0 flex-1 flex-col">
        {followPath && (
          <div className="flex items-center justify-between bg-slate-900 px-4 py-1.5 text-xs text-slate-300" data-testid="code-following">
            <span>
              {following ? '正在跟随' : '已暂停跟随'} · <span className="text-amber-300" data-testid="code-active">{active}</span>
              {writing.includes(active) && <span className="ml-1 text-slate-400">写入中…</span>}
            </span>
            {!following && (
              <button onClick={() => { setSel(followPath); setPinned(false); }} className="rounded bg-slate-700 px-2 py-0.5 text-slate-100">
                回到 {followPath}
              </button>
            )}
          </div>
        )}
        <pre ref={pre} className="min-h-0 flex-1 overflow-auto bg-slate-950 p-4 text-xs leading-relaxed text-slate-100" data-testid="code-content">
          <code>{content}</code>
          {writing.includes(active) && <span className="caret" />}
        </pre>
      </div>
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
