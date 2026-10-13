'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, timeAgo } from '@/lib/client/api';
import type { Project } from '@/lib/shared/types';

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);

  async function load() {
    try {
      setProjects((await api<{ projects: Project[] }>('/api/projects')).projects);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.replace('/login?next=/projects');
      else setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const { project } = await api<{ project: Project }>('/api/projects', { method: 'POST', json: { name: newName } });
    router.push(`/projects/${project.id}`);
  }

  async function rename(p: Project, name: string) {
    setEditing(null);
    name = name.trim();
    if (!name || name === p.name) return;
    setProjects((list) => list?.map((x) => (x.id === p.id ? { ...x, name } : x)) ?? null);
    try {
      await api(`/api/projects/${p.id}`, { method: 'PATCH', json: { name } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      load();
    }
  }

  async function remove(p: Project) {
    setDeleting(null);
    setProjects((list) => list?.filter((x) => x.id !== p.id) ?? null);
    try {
      await api(`/api/projects/${p.id}`, { method: 'DELETE' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      load();
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">我的项目</h1>
        <button
          onClick={() => setCreating(true)}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          data-testid="new-project"
        >
          新建项目
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {creating && (
        <form onSubmit={create} className="mt-4 flex gap-2 rounded-xl border border-slate-200 bg-white p-3">
          <input
            autoFocus
            data-testid="new-project-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="项目名称（可留空）"
            className="flex-1 rounded-lg border border-slate-200 px-3 py-2 outline-none focus:border-brand-500"
          />
          <button className="rounded-lg bg-slate-900 px-4 text-sm text-white" data-testid="new-project-submit">
            创建
          </button>
          <button type="button" onClick={() => setCreating(false)} className="rounded-lg px-3 text-sm text-slate-500">
            取消
          </button>
        </form>
      )}

      {projects === null ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-32 rounded-xl" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="mt-16 text-center text-slate-500" data-testid="empty-projects">
          <p>还没有项目。</p>
          <Link href="/" className="mt-3 inline-block rounded-lg bg-brand-600 px-4 py-2 text-sm text-white">
            用一句话创建第一个应用
          </Link>
        </div>
      ) : (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="project-list">
          {projects.map((p) => (
            <li key={p.id} className="group relative rounded-xl border border-slate-200 bg-white p-4 transition hover:shadow-md" data-testid="project-card">
              <div className="mb-3 grid h-16 place-items-center rounded-lg bg-gradient-to-br from-brand-50 to-slate-100 text-2xl font-bold text-brand-600">
                {p.name.slice(0, 1)}
              </div>
              {editing === p.id ? (
                <RenameInput initial={p.name} onDone={(name) => rename(p, name)} />
              ) : (
                <Link href={`/projects/${p.id}`} className="block truncate font-medium hover:text-brand-700" data-testid="project-name">
                  {p.name}
                </Link>
              )}
              <p className="mt-1 text-xs text-slate-400">
                {p.current_version_id ? '已生成' : '未生成'} · 更新于 {timeAgo(p.updated_at)}
              </p>
              <div className="mt-3 flex gap-2 text-xs">
                <button onClick={() => setEditing(p.id)} className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100" data-testid="rename">
                  重命名
                </button>
                <button onClick={() => setDeleting(p)} className="rounded px-2 py-1 text-red-500 hover:bg-red-50" data-testid="delete">
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {deleting && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 px-4" onClick={() => setDeleting(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-6" onClick={(e) => e.stopPropagation()} role="dialog">
            <h2 className="font-semibold">删除项目？</h2>
            <p className="mt-2 text-sm text-slate-500">「{deleting.name}」的对话和所有版本都会被删除，且无法恢复。</p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setDeleting(null)} className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">
                取消
              </button>
              <button onClick={() => remove(deleting)} className="rounded-lg bg-red-600 px-4 py-2 text-sm text-white" data-testid="confirm-delete">
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (name: string) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (v: string) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      autoFocus
      data-testid="rename-input"
      value={value}
      maxLength={60}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(value);
        if (e.key === 'Escape') finish(initial);
      }}
      className="w-full rounded border border-brand-500 px-2 py-0.5 font-medium outline-none"
    />
  );
}
