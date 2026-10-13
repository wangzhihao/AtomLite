'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Preview, type PreviewIssue } from '@/components/Preview';
import { PERSONAS } from '@/components/persona';
import { api, ApiError, timeAgo } from '@/lib/client/api';
import { streamGenerate } from '@/lib/client/generate';
import type { AgentId, Files, Message, Project, RunIntent, Usage, Version, VersionMeta } from '@/lib/shared/types';
import { LIMITS } from '@/lib/shared/types';

type Loaded = { project: Project; messages: Message[]; version: Version | null; running: boolean };

type LiveFile = { path: string; status: 'writing' | 'done'; bytes?: number };
type LiveRun = {
  userText: string | null;
  intent: RunIntent | null;
  leader: string;
  engineer: string;
  files: LiveFile[];
  error: string | null;
  usage: Usage | null;
};

const PREVIEW_DEBOUNCE_MS = 500;

export default function Workspace() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState('');
  const [files, setFiles] = useState<Files | null>(null);
  const [live, setLive] = useState<LiveRun | null>(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState('');
  const [input, setInput] = useState('');
  const [tab, setTab] = useState<'preview' | 'code' | 'versions'>('preview');
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [reloadKey, setReloadKey] = useState(0);
  const [issues, setIssues] = useState<PreviewIssue[]>([]);
  const [viewing, setViewing] = useState<Version | null>(null);
  const [pane, setPane] = useState<'chat' | 'preview'>('chat');

  const abortRef = useRef<AbortController | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumed = useRef(false);
  const timelineEnd = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<Loaded>(`/api/projects/${id}`);
      setData(d);
      setFiles(d.version?.files ?? null);
      return d;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.replace(`/login?next=/projects/${id}`);
      else setLoadError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [id, router]);

  const schedulePreview = (next: Files) => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => setFiles(next), PREVIEW_DEBOUNCE_MS);
  };

  const run = useCallback(
    async (body: { message?: string; mode?: 'auto' | 'fix'; errors?: string[]; resume?: boolean }, userText: string | null) => {
      if (abortRef.current) return;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setRunning(true);
      setNotice('');
      setIssues([]);
      setViewing(null);
      setTab('preview');
      setLive({ userText, intent: null, leader: '', engineer: '', files: [], error: null, usage: null });
      let working: Files = { ...(files ?? {}) };
      let started = false;
      try {
        await streamGenerate(
          id,
          body,
          (e) => {
            switch (e.event) {
              case 'run_started':
                started = true;
                setLive((l) => l && { ...l, intent: e.data.intent });
                break;
              case 'message_delta':
                setLive((l) => {
                  if (!l) return l;
                  return e.data.agent === 'leader'
                    ? { ...l, leader: l.leader + e.data.text }
                    : { ...l, engineer: l.engineer + e.data.text };
                });
                break;
              case 'file_started':
                setLive((l) => l && { ...l, files: [...l.files.filter((f) => f.path !== e.data.path), { path: e.data.path, status: 'writing' }] });
                break;
              case 'file_done':
                working = { ...working, [e.data.path]: e.data.content };
                setLive((l) => l && { ...l, files: l.files.map((f) => (f.path === e.data.path ? { ...f, status: 'done', bytes: e.data.bytes } : f)) });
                schedulePreview(working);
                break;
              case 'version_created':
                for (const p of e.data.deleted) delete working[p];
                schedulePreview(working);
                break;
              case 'error':
                setLive((l) => l && { ...l, error: e.data.message });
                break;
              case 'run_finished':
                setLive((l) => l && { ...l, usage: e.data.usage });
                break;
            }
          },
          ctrl.signal,
        );
      } catch (e) {
        if (!ctrl.signal.aborted) {
          setNotice(e instanceof Error ? e.message : String(e));
          if (!started && userText && body.mode !== 'fix') setInput(userText); // 请求被拒绝时把输入还给用户
        }
      } finally {
        if (previewTimer.current) clearTimeout(previewTimer.current);
        abortRef.current = null;
        await load();
        setLive(null);
        setRunning(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, files, load],
  );

  useEffect(() => {
    load().then((d) => {
      if (!d || resumed.current) return;
      const last = d.messages[d.messages.length - 1];
      if (last?.role === 'user' && last.meta?.pending && !d.running) {
        resumed.current = true;
        run({ resume: true }, null);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    timelineEnd.current?.scrollIntoView({ block: 'end' });
  }, [data?.messages.length, live?.engineer, live?.leader, live?.files.length]);

  async function stop() {
    const ctrl = abortRef.current;
    if (!ctrl) return;
    try {
      await api(`/api/projects/${id}/cancel`, { method: 'POST' });
    } catch {
      /* 兜底：直接断开连接，服务端同样会取消 */
    }
    setTimeout(() => ctrl.abort(), 3000);
  }

  function send(e?: React.FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || running) return;
    setInput('');
    run({ message: text }, text);
  }

  function fix() {
    const errors = issues.map((i) => i.message);
    run({ mode: 'fix', errors }, `让 Agent 修复：\n${errors.join('\n')}`);
  }

  const onIssue = useCallback(
    (issue: PreviewIssue) => {
      if (abortRef.current) return; // 生成过程中的半成品报错不展示
      setIssues((list) => (list.some((x) => x.message === issue.message) || list.length >= 5 ? list : [...list, issue]));
    },
    [],
  );

  async function rename(name: string) {
    if (!data || !name.trim() || name === data.project.name) return;
    setData({ ...data, project: { ...data.project, name } });
    await api(`/api/projects/${id}`, { method: 'PATCH', json: { name } }).catch((e) => setNotice(String(e.message)));
  }

  if (loadError) {
    return (
      <div className="mx-auto mt-24 max-w-sm text-center" data-testid="load-error">
        <p className="text-slate-600">{loadError}</p>
        <Link href="/projects" className="mt-4 inline-block text-sm text-brand-600">
          返回项目列表
        </Link>
      </div>
    );
  }
  if (!data) return <div className="skeleton m-4 h-[calc(100%-2rem)] rounded-xl" />;

  const shownFiles = viewing?.files ?? files;
  const writing = live?.files.find((f) => f.status === 'writing');
  const overlay = running
    ? writing
      ? `Kai 正在写入 ${writing.path}`
      : live?.files.length
        ? 'Kai 正在收尾…'
        : 'Kai 正在思考…'
    : null;

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏：项目名、设备切换 */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-3">
        <Link href="/projects" className="text-slate-400 hover:text-slate-700" title="返回项目列表">
          ←
        </Link>
        <ProjectName name={data.project.name} onRename={rename} />
        <span className="hidden text-xs text-slate-400 sm:inline" data-testid="version-badge">
          {data.version ? `版本 ${data.version.seq}` : '未生成'}
        </span>
        <div className="ml-auto flex items-center gap-1 md:hidden">
          {(['chat', 'preview'] as const).map((p) => (
            <button key={p} onClick={() => setPane(p)} className={`rounded px-2 py-1 text-xs ${pane === p ? 'bg-slate-900 text-white' : 'text-slate-500'}`}>
              {p === 'chat' ? '对话' : '预览'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左：对话与 Agent 时间线 */}
        <section className={`${pane === 'chat' ? 'flex' : 'hidden'} w-full min-w-0 flex-col border-r border-slate-200 bg-white md:flex md:w-[420px] md:shrink-0`}>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" data-testid="timeline">
            {data.messages.length === 0 && !live && (
              <p className="mt-10 text-center text-sm text-slate-400">描述你想要的应用，比如“做一个番茄钟”。</p>
            )}
            {data.messages.map((m) => (
              <MessageItem key={m.id} m={m} />
            ))}
            {live && <LiveItem live={live} />}
            <div ref={timelineEnd} />
          </div>
          {notice && (
            <div className="mx-4 mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="notice">
              {notice}
            </div>
          )}
          <form onSubmit={send} className="border-t border-slate-200 p-3">
            <div className="rounded-xl border border-slate-200 p-2 focus-within:border-brand-500">
              <textarea
                data-testid="chat-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={2}
                maxLength={LIMITS.messageChars}
                placeholder={data.version ? '继续提修改，例如“主色改成绿色，加一个导出 CSV 按钮”' : '描述你想要的应用'}
                className="w-full resize-none bg-transparent px-1 text-sm outline-none placeholder:text-slate-400"
              />
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-400">{input.length > 0 ? `${input.length}/${LIMITS.messageChars}` : ''}</span>
                {running ? (
                  <button type="button" onClick={stop} className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm text-white" data-testid="stop">
                    ■ 停止
                  </button>
                ) : (
                  <button disabled={!input.trim()} className="rounded-lg bg-brand-600 px-4 py-1.5 text-sm text-white disabled:opacity-40" data-testid="send">
                    发送
                  </button>
                )}
              </div>
            </div>
          </form>
        </section>

        {/* 右：预览 / 代码 / 版本 */}
        <section className={`${pane === 'preview' ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col md:flex`}>
          <div className="flex h-10 shrink-0 items-center gap-1 border-b border-slate-200 bg-white px-2 text-sm">
            {(
              [
                ['preview', '预览'],
                ['code', '代码'],
                ['versions', '版本'],
              ] as const
            ).map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-md px-3 py-1 ${tab === t ? 'bg-slate-100 font-medium text-slate-900' : 'text-slate-500 hover:text-slate-800'}`}
                data-testid={`tab-${t}`}
              >
                {label}
              </button>
            ))}
            {tab === 'preview' && (
              <div className="ml-auto flex items-center gap-1">
                <button onClick={() => setReloadKey((k) => k + 1)} className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100" title="刷新" data-testid="refresh">
                  ⟳
                </button>
                <div className="flex rounded-md bg-slate-100 p-0.5 text-xs">
                  {(['desktop', 'mobile'] as const).map((d) => (
                    <button
                      key={d}
                      onClick={() => setDevice(d)}
                      className={`rounded px-2 py-0.5 ${device === d ? 'bg-white shadow-sm' : 'text-slate-500'}`}
                      data-testid={`device-${d}`}
                    >
                      {d === 'desktop' ? '桌面' : '手机'}
                    </button>
                  ))}
                </div>
                <a href={`/projects/${id}/preview`} target="_blank" rel="noreferrer" className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100" title="新窗口打开">
                  ↗
                </a>
              </div>
            )}
          </div>

          {viewing && (
            <div className="flex items-center justify-between bg-amber-50 px-3 py-1.5 text-xs text-amber-800" data-testid="viewing-banner">
              正在查看历史版本 {viewing.seq}（只读）
              <button onClick={() => setViewing(null)} className="rounded bg-white px-2 py-0.5 shadow-sm">
                回到最新版本
              </button>
            </div>
          )}

          <div className="relative min-h-0 flex-1">
            <div className={tab === 'preview' ? 'h-full' : 'hidden'}>
              <Preview projectId={id} files={shownFiles} reloadKey={reloadKey} device={device} overlay={overlay} onIssue={onIssue} />
            </div>
            {tab === 'code' && <CodeView files={shownFiles} />}
            {tab === 'versions' && (
              <VersionsView
                projectId={id}
                currentId={data.project.current_version_id}
                refreshKey={data.version?.id ?? ''}
                onView={(v) => {
                  setViewing(v.id === data.project.current_version_id ? null : v);
                  setTab('preview');
                }}
              />
            )}
          </div>

          {issues.length > 0 && !running && tab === 'preview' && (
            <div className="flex items-start gap-3 border-t border-red-200 bg-red-50 px-3 py-2 text-sm" data-testid="error-bar">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-red-700">预览运行出错了</p>
                {issues.map((i) => (
                  <p key={i.message} className="truncate text-xs text-red-600" title={i.message}>
                    {i.message}
                  </p>
                ))}
              </div>
              <button onClick={fix} className="shrink-0 rounded-lg bg-red-600 px-3 py-1.5 text-xs text-white" data-testid="fix">
                让 Agent 修复
              </button>
              <button onClick={() => setIssues([])} className="shrink-0 text-xs text-red-400">
                忽略
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 子组件

function Avatar({ agent }: { agent: AgentId }) {
  const p = PERSONAS[agent];
  return (
    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold text-white" style={{ background: p.color }} title={`${p.name} · ${p.title}`}>
      {p.name[0]}
    </span>
  );
}

function AgentBlock({ agent, children }: { agent: AgentId; children: React.ReactNode }) {
  const p = PERSONAS[agent];
  return (
    <div className="flex gap-2.5">
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

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-brand-600 px-3.5 py-2 text-sm text-white" data-testid="user-message">
        {text}
      </p>
    </div>
  );
}

function formatUsage(u: Usage) {
  const total = u.inputTokens + u.outputTokens;
  const tokens = total >= 10000 ? `${(total / 10000).toFixed(1)} 万` : String(total);
  return `${tokens} tokens · 约 $${u.costUsd.toFixed(3)}`;
}

function FileChip({ path, status }: { path: string; status: 'writing' | 'done' }) {
  return (
    <li className="flex items-center gap-2 text-xs text-slate-500" data-testid="file-progress">
      {status === 'writing' ? <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" /> : <span className="text-emerald-500">✓</span>}
      {status === 'writing' ? '正在写入' : '已写入'} <code className="rounded bg-slate-100 px-1">{path}</code>
    </li>
  );
}

function MessageItem({ m }: { m: Message }) {
  if (m.role === 'user') return <UserBubble text={m.content} />;
  if (m.role === 'system') {
    const failed = m.meta?.status === 'failed';
    return (
      <p className={`rounded-lg px-3 py-2 text-xs ${failed ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-500'}`} data-testid="system-message">
        {m.content}
      </p>
    );
  }
  const meta = (m.meta ?? {}) as { summary?: string; files?: string[]; usage?: Usage; seq?: number; notes?: string[] };
  return (
    <AgentBlock agent={(m.agent as AgentId) ?? 'engineer'}>
      <p className="whitespace-pre-wrap" data-testid="agent-message">
        {m.content}
      </p>
      {meta.files && meta.files.length > 0 && (
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
      <p className="mt-2 flex flex-wrap gap-x-2 text-[11px] text-slate-400">
        {meta.seq && <span className="rounded bg-emerald-50 px-1.5 text-emerald-700" data-testid="version-tag">版本 {meta.seq}</span>}
        {meta.usage && <span data-testid="usage-tag">{formatUsage(meta.usage)}</span>}
        <span>{timeAgo(m.created_at)}</span>
      </p>
    </AgentBlock>
  );
}

function LiveItem({ live }: { live: LiveRun }) {
  return (
    <div className="space-y-4" data-testid="live-run">
      {live.userText && <UserBubble text={live.userText} />}
      <AgentBlock agent="leader">
        <p className={live.leader ? '' : 'caret'}>{live.leader}</p>
      </AgentBlock>
      {(live.engineer || live.files.length > 0 || !live.error) && (
        <AgentBlock agent="engineer">
          <p className={`whitespace-pre-wrap ${live.usage ? '' : 'caret'}`}>{live.engineer.trim()}</p>
          {live.files.length > 0 && (
            <ul className="mt-2 space-y-1">
              {live.files.map((f) => (
                <FileChip key={f.path} path={f.path} status={f.status} />
              ))}
            </ul>
          )}
        </AgentBlock>
      )}
      {live.error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{live.error}</p>}
    </div>
  );
}

function ProjectName({ name, onRename }: { name: string; onRename: (n: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  useEffect(() => setValue(name), [name]);
  if (!editing) {
    return (
      <button onClick={() => setEditing(true)} className="truncate rounded px-1 font-medium hover:bg-slate-100" title="点击重命名" data-testid="project-title">
        {name}
      </button>
    );
  }
  const done = () => {
    setEditing(false);
    onRename(value.trim());
  };
  return (
    <input
      autoFocus
      value={value}
      maxLength={60}
      onChange={(e) => setValue(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => e.key === 'Enter' && done()}
      className="rounded border border-brand-500 px-1 font-medium outline-none"
      data-testid="project-title-input"
    />
  );
}

function CodeView({ files }: { files: Files | null }) {
  const paths = Object.keys(files ?? {});
  const [sel, setSel] = useState<string | null>(null);
  const active = sel && paths.includes(sel) ? sel : (paths.find((p) => /app\.jsx$/i.test(p)) ?? paths[0]);
  if (!files || !paths.length) return <p className="p-8 text-center text-sm text-slate-400">还没有代码。</p>;
  return (
    <div className="flex h-full" data-testid="code-view">
      <ul className="w-44 shrink-0 overflow-y-auto border-r border-slate-200 bg-white py-2 text-sm">
        {paths.map((p) => (
          <li key={p}>
            <button onClick={() => setSel(p)} className={`w-full truncate px-3 py-1 text-left ${p === active ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}>
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

function VersionsView({
  projectId,
  currentId,
  refreshKey,
  onView,
}: {
  projectId: string;
  currentId: string | null;
  refreshKey: string;
  onView: (v: Version) => void;
}) {
  const [versions, setVersions] = useState<VersionMeta[] | null>(null);
  useEffect(() => {
    api<{ versions: VersionMeta[] }>(`/api/projects/${projectId}/versions`).then((d) => setVersions(d.versions), () => setVersions([]));
  }, [projectId, refreshKey]);

  async function view(v: VersionMeta) {
    const { version } = await api<{ version: Version }>(`/api/projects/${projectId}/versions?id=${v.id}`);
    onView(version);
  }

  if (!versions) return <div className="skeleton m-4 h-40 rounded-lg" />;
  if (!versions.length) return <p className="p-8 text-center text-sm text-slate-400">还没有版本。每轮生成都会保存一个版本。</p>;
  return (
    <ul className="h-full space-y-2 overflow-y-auto p-4" data-testid="version-list">
      {versions.map((v) => (
        <li key={v.id} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3" data-testid="version-item">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">v{v.seq}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-slate-700">{v.summary ?? '（无摘要）'}</p>
            <p className="text-xs text-slate-400">
              {timeAgo(v.created_at)}
              {v.id === currentId && <span className="ml-2 rounded bg-emerald-50 px-1.5 text-emerald-700">当前</span>}
            </p>
          </div>
          <button onClick={() => view(v)} className="shrink-0 rounded px-2 py-1 text-xs text-brand-600 hover:bg-brand-50">
            预览
          </button>
        </li>
      ))}
    </ul>
  );
}
