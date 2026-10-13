'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AttachButton, AttachmentTray, useAttachments } from '@/components/Attachments';
import { Preview, type PreviewIssue } from '@/components/Preview';
import type { Attachment } from '@/lib/shared/attachments';
import { CodeView, PublishButton, VersionsView } from '@/components/workspace/Panels';
import { QARunner } from '@/components/workspace/QARunner';
import { loadTeam, TeamPanel } from '@/components/workspace/TeamPanel';
import { LiveItem, MessageItem, RunProgress, type LiveBlock, type LiveRun, type TimelineActions } from '@/components/workspace/Timeline';
import { api, ApiError } from '@/lib/client/api';
import { streamGenerate } from '@/lib/client/generate';
import type { AgentId, CheckError, Files, Message, Project, QAResult, QATest, TeamConfig, Version } from '@/lib/shared/types';
import { DEFAULT_TEAM, LIMITS } from '@/lib/shared/types';

type Loaded = { project: Project; messages: Message[]; version: Version | null; running: boolean };
type RunBody = {
  message?: string;
  mode?: 'auto' | 'fix';
  errors?: (string | CheckError)[];
  runId?: string;
  auto?: boolean;
  clarified?: boolean;
  resume?: boolean;
  attachments?: string[];
};

/** 自愈回路的状态：版本落库后等待运行检查，失败则自动修复（同一 run 最多 2 次，同一错误签名重复即停） */
/** mountKey：只认这次挂载的预览 iframe 发来的事件，生成过程中旧文档的迟到事件不算数 */
type HealState = { runId: string; versionId: string; mountKey: number; armed: boolean; issues: PreviewIssue[]; autoFixes: number; signatures: string[] };

const PREVIEW_DEBOUNCE_MS = 500;
const VERIFY_TIMEOUT_MS = 9000;

const signatureOf = (errors: CheckError[]) =>
  errors
    .map((e) => `${e.kind}|${e.message.slice(0, 120)}`)
    .sort()
    .join('\n');

type QAJob = { runId: string; versionId: string; tests: QATest[]; files: Files };

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
  /** 跟随模式（默认开）：生成时右侧切到代码面板跟随正在写入的文件，版本落库后回到预览 */
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  followRef.current = follow;
  /** 本轮生成中各文件的实时内容（file_delta 累积，file_done 时替换为完整内容） */
  const [streaming, setStreaming] = useState<Files>({});
  const [writingPaths, setWritingPaths] = useState<string[]>([]);
  const [followPath, setFollowPath] = useState<string | null>(null);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [reloadKey, setReloadKey] = useState(0);
  const reloadKeyRef = useRef(0);
  reloadKeyRef.current = reloadKey;
  const [issues, setIssues] = useState<PreviewIssue[]>([]);
  const [healing, setHealing] = useState(false);
  const [healLabel, setHealLabel] = useState('');
  const [qaJob, setQaJob] = useState<QAJob | null>(null);
  const [team, setTeam] = useState<TeamConfig>(DEFAULT_TEAM);
  const teamRef = useRef(team);
  teamRef.current = team;
  const [viewing, setViewing] = useState<Version | null>(null);
  const [pane, setPane] = useState<'chat' | 'preview'>('chat');
  const attach = useAttachments();

  const abortRef = useRef<AbortController | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumed = useRef(false);
  const timelineEnd = useRef<HTMLDivElement>(null);
  const heal = useRef<HealState | null>(null);
  const healTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filesRef = useRef<Files | null>(null);
  filesRef.current = files;

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

  const runRef = useRef<(body: RunBody, userText: string | null) => Promise<void>>(async () => undefined);

  /** 检查失败：还有自动修复额度且错误签名没出现过时，交给 Max 在同一个 run 里修复；否则停下来交给用户 */
  const autoFixOrStop = useCallback((h: HealState, errors: CheckError[], canAutoFix: boolean) => {
    const sig = signatureOf(errors);
    if (canAutoFix && h.autoFixes < LIMITS.maxFixRounds && !h.signatures.includes(sig)) {
      heal.current = { ...h, autoFixes: h.autoFixes + 1, signatures: [...h.signatures, sig], armed: false, issues: [] };
      setHealing(true);
      setHealLabel('Max 正在自动修复…');
      runRef.current({ mode: 'fix', auto: true, runId: h.runId, errors }, null);
    } else {
      heal.current = null;
      setHealing(false);
    }
  }, []);

  /** 运行检查结束：回写结果；通过且开启了 Quinn 时进入验收，失败则自动修复 */
  const finishVerify = useCallback(async () => {
    const h = heal.current;
    if (!h || !h.armed) return;
    h.armed = false;
    if (healTimer.current) clearTimeout(healTimer.current);
    const ok = h.issues.length === 0;
    const errors: CheckError[] = h.issues.map((i) => ({ kind: i.kind, message: i.message }));
    let canAutoFix = false;
    try {
      const r = await api<{ canAutoFix: boolean }>(`/api/runs/${h.runId}/verify`, { method: 'POST', json: { versionId: h.versionId, ok, errors } });
      canAutoFix = r.canAutoFix;
    } catch {
      /* 回写失败不影响使用 */
    }
    if (ok) {
      if (teamRef.current.qa && filesRef.current) {
        const files = filesRef.current;
        setHealing(true);
        setHealLabel('Quinn 正在按功能点验收…');
        try {
          const { tests } = await api<{ tests: QATest[] }>(`/api/runs/${h.runId}/qa`, { method: 'POST', json: { versionId: h.versionId } });
          if (heal.current === h && tests.length) {
            setQaJob({ runId: h.runId, versionId: h.versionId, tests, files });
            return;
          }
        } catch {
          /* 验收失败不影响使用 */
        }
      }
      if (heal.current === h) heal.current = null;
      setHealing(false);
      return;
    }
    autoFixOrStop(h, errors, canAutoFix);
  }, [autoFixOrStop]);

  const onQADone = useCallback(
    async (job: QAJob, results: QAResult[]) => {
      setQaJob(null);
      const h = heal.current;
      let r = { ok: true, canAutoFix: false };
      try {
        r = await api<{ ok: boolean; canAutoFix: boolean }>(`/api/runs/${job.runId}/qa-result`, { method: 'POST', json: { versionId: job.versionId, results } });
      } catch {
        /* 忽略 */
      }
      await load();
      if (!h || h.runId !== job.runId) return;
      if (r.ok) {
        heal.current = null;
        setHealing(false);
        return;
      }
      const errors: CheckError[] = results.filter((x) => !x.ok).map((x) => ({ kind: 'qa', message: `功能「${x.feature}」验收失败：${x.error ?? '未知原因'}` }));
      autoFixOrStop(h, errors, r.canAutoFix);
    },
    [autoFixOrStop, load],
  );

  const run = useCallback(
    async (body: RunBody, userText: string | null, userAttachments?: Attachment[]) => {
      if (abortRef.current) return;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      if (!body.auto) heal.current = null;
      setRunning(true);
      setNotice('');
      setIssues([]);
      setViewing(null);
      setStreaming({});
      setWritingPaths([]);
      setFollowPath(null);
      if (!followRef.current) setTab((t) => (t === 'versions' ? 'preview' : t));
      setLive({
        userText,
        userAttachments,
        runId: null,
        intent: null,
        blocks: [],
        error: null,
        usage: null,
        versionId: null,
        steps: [],
        typicalMs: null,
        step: null,
        progress: null,
        startedAt: Date.now(),
        lastEventAt: Date.now(),
      });
      let working: Files = { ...(filesRef.current ?? {}) };
      let started = false;
      let runId: string | null = null;
      let versionId: string | null = null;

      const update = (fn: (blocks: LiveBlock[]) => LiveBlock[]) => setLive((l) => l && { ...l, blocks: fn(l.blocks) });
      const lastOf = (blocks: LiveBlock[], agent?: AgentId) => {
        for (let i = blocks.length - 1; i >= 0; i--) if (!agent || blocks[i].agent === agent) return i;
        return -1;
      };
      const patchLast = (agent: AgentId | undefined, fn: (b: LiveBlock) => LiveBlock) =>
        update((blocks) => {
          const i = lastOf(blocks, agent);
          if (i < 0) return blocks;
          const next = blocks.slice();
          next[i] = fn(next[i]);
          return next;
        });

      try {
        await streamGenerate(
          id,
          { ...body, team: teamRef.current },
          (e) => {
            setLive((l) => l && { ...l, lastEventAt: Date.now() });
            switch (e.event) {
              case 'steps':
                setLive((l) => l && { ...l, steps: e.data.steps, typicalMs: e.data.typicalMs });
                break;
              case 'step':
                setLive((l) => l && { ...l, step: e.data.id });
                break;
              case 'progress':
                setLive((l) => l && { ...l, progress: e.data, step: e.data.step ?? l.step });
                break;
              case 'thinking_delta':
                update((blocks) => {
                  const i = lastOf(blocks, e.data.agent);
                  if (i < 0) return [...blocks, { agent: e.data.agent, text: '', files: [], thinking: e.data.text }];
                  const next = blocks.slice();
                  next[i] = { ...next[i], thinking: (next[i].thinking ?? '') + e.data.text };
                  return next;
                });
                break;
              case 'run_started':
                started = true;
                runId = e.data.runId;
                setLive((l) => l && { ...l, intent: e.data.intent, runId: e.data.runId });
                break;
              case 'agent_started':
                update((blocks) => [...blocks, { agent: e.data.agent, text: '', files: [] }]);
                break;
              case 'message_delta':
                patchLast(e.data.agent, (b) => ({ ...b, text: b.text + e.data.text }));
                break;
              case 'file_started':
                setStreaming((s) => ({ ...s, [e.data.path]: '' }));
                setWritingPaths((w) => [...w.filter((p) => p !== e.data.path), e.data.path]);
                setFollowPath(e.data.path);
                if (followRef.current) setTab('code');
                patchLast(e.data.agent, (b) => ({ ...b, files: [...b.files.filter((f) => f.path !== e.data.path), { path: e.data.path, status: 'writing' }] }));
                break;
              case 'file_delta': {
                const { path, text } = e.data;
                setStreaming((s) => ({ ...s, [path]: ((s[path] ?? '') + text).replace(/^\n/, '') }));
                break;
              }
              case 'file_done':
                setStreaming((s) => ({ ...s, [e.data.path]: e.data.content }));
                setWritingPaths((w) => w.filter((p) => p !== e.data.path));
                working = { ...working, [e.data.path]: e.data.content };
                patchLast(e.data.agent, (b) => ({
                  ...b,
                  files: b.files.map((f) => (f.path === e.data.path ? { ...f, status: 'done', bytes: e.data.bytes } : f)),
                }));
                schedulePreview(working);
                break;
              case 'plan':
                patchLast('planner', (b) => ({ ...b, plan: e.data.spec }));
                break;
              case 'design':
                patchLast('designer', (b) => ({ ...b, design: e.data.design }));
                break;
              case 'clarify':
                patchLast('planner', (b) => ({ ...b, clarify: e.data.questions }));
                break;
              case 'check_failed':
                update((blocks) => [...blocks, { agent: 'note', text: '', files: [], checkErrors: e.data.errors }]);
                break;
              case 'suggestions':
                patchLast('advisor', (b) => ({ ...b, suggestions: e.data.items }));
                break;
              case 'version_created':
                versionId = e.data.versionId;
                setLive((l) => l && { ...l, versionId: e.data.versionId });
                break;
              case 'error':
                setLive((l) => l && { ...l, error: e.data.message, errorCode: e.data.code });
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
        // 有新版本时进入运行检查：新版本会重新挂载预览 iframe，等它渲染后 3 秒观察窗口结束
        const mountKey = reloadKeyRef.current + 1;
        if (runId && versionId) {
          // 自动修复轮次沿用同一条自愈链的计数（即使服务端没能复用原 run，也不会无限自动修复）
          const prev = body.auto ? heal.current : null;
          heal.current = {
            runId,
            versionId,
            mountKey,
            armed: true,
            issues: [],
            autoFixes: prev?.autoFixes ?? 0,
            signatures: prev?.signatures ?? [],
          };
          if (healTimer.current) clearTimeout(healTimer.current);
          healTimer.current = setTimeout(() => void finishVerify(), VERIFY_TIMEOUT_MS);
          setHealing(true);
          setHealLabel('正在检查预览运行情况…');
        } else {
          heal.current = null;
          setHealing(false);
        }
        await load();
        // 每个新版本都重新挂载 iframe：内容与上一版相同时（例如修复没改动），srcdoc 不变也要重新运行，才能做运行检查
        if (versionId) setReloadKey(mountKey);
        setWritingPaths([]);
        setFollowPath(null);
        setStreaming({});
        if (followRef.current) setTab('preview');
        setLive(null);
        setRunning(false);
      }
    },
    [id, load, finishVerify],
  );
  runRef.current = run;

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
    setTeam(loadTeam());
    try {
      setFollow(localStorage.getItem('atoms:follow') !== '0');
    } catch {
      /* 默认开启 */
    }
  }, []);

  useEffect(() => {
    timelineEnd.current?.scrollIntoView({ block: 'end' });
  }, [data?.messages.length, live]);

  useEffect(
    () => () => {
      if (healTimer.current) clearTimeout(healTimer.current);
    },
    [],
  );

  async function stop() {
    const ctrl = abortRef.current;
    if (!ctrl) return;
    heal.current = null;
    setHealing(false);
    setQaJob(null);
    try {
      await api(`/api/projects/${id}/cancel`, { method: 'POST' });
    } catch {
      /* 兜底：直接断开连接，服务端同样会取消 */
    }
    setTimeout(() => ctrl.abort(), 3000);
  }

  function sendText(text: string, extra: Partial<RunBody> = {}, atts: Attachment[] = []) {
    if ((!text.trim() && !atts.length) || abortRef.current) return;
    run({ message: text.trim(), ...extra, ...(atts.length ? { attachments: atts.map((a) => a.id) } : {}) }, text.trim() || '（附件）', atts);
  }

  function send(e?: React.FormEvent) {
    e?.preventDefault();
    if ((!input.trim() && !attach.ready.length) || running || attach.uploading) return;
    const text = input;
    const atts = attach.ready;
    setInput('');
    attach.clear();
    sendText(text, {}, atts);
  }

  function fix() {
    const errors = issues.map((i) => ({ kind: i.kind, message: i.message }));
    run({ mode: 'fix', errors }, `让 Agent 修复：\n${errors.map((e) => e.message).join('\n')}`);
  }

  const onIssue = useCallback((issue: PreviewIssue, mountKey: number) => {
    if (abortRef.current) return; // 生成过程中的半成品报错不展示
    const h = heal.current;
    if (h?.armed && h.mountKey === mountKey && !h.issues.some((x) => x.message === issue.message)) h.issues.push(issue);
    setIssues((list) => (list.some((x) => x.message === issue.message) || list.length >= 5 ? list : [...list, issue]));
  }, []);

  const onRendered = useCallback(
    (_empty: boolean, mountKey: number) => {
      if (abortRef.current || heal.current?.mountKey !== mountKey) return;
      void finishVerify();
    },
    [finishVerify],
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

  // 只有最后一条 Agent 消息上的澄清卡片 / 建议 chip 可以交互
  const lastIdx = data.messages.length - 1;
  const lastMsg = data.messages[lastIdx];
  const interactiveId =
    !running && lastMsg && lastMsg.role === 'agent' && (lastMsg.meta?.suggestions || lastMsg.meta?.clarify)
      ? lastMsg.id
      : !running && lastMsg?.agent === 'leader' && data.messages[lastIdx - 1]?.meta?.clarify
        ? data.messages[lastIdx - 1].id
        : null;
  const originalRequest = [...data.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const actions: TimelineActions = {
    interactive: true,
    onClarify: (answers) => {
      const filled = answers?.filter((a) => a.answer);
      const text = filled?.length
        ? `${originalRequest}\n\n补充信息：\n${filled.map((a) => `- ${a.question} ${a.answer}`).join('\n')}`
        : `${originalRequest}\n\n（先帮我随便做：缺少的信息请用合理的默认值，并在改动摘要里列出所做的假设）`;
      sendText(text, { clarified: true });
    },
    onSuggest: (s) => sendText(s),
  };

  const shownFiles = viewing?.files ?? files;
  const lastBlock = live?.blocks[live.blocks.length - 1];
  const writing = lastBlock?.files.find((f) => f.status === 'writing');
  const who = lastBlock && lastBlock.agent !== 'note' && lastBlock.agent !== 'leader' ? lastBlock.agent : null;
  const NAMES: Partial<Record<AgentId, string>> = { planner: 'Nora 正在梳理需求…', designer: 'Mia 正在定设计规范…', engineer: 'Kai 正在思考…', fixer: 'Max 正在修复…', advisor: 'Sage 正在想建议…' };
  const overlay = running
    ? writing
      ? `${who === 'fixer' ? 'Max' : who === 'designer' ? 'Mia' : 'Kai'} 正在写入 ${writing.path}`
      : (who && NAMES[who]) || '团队正在准备…'
    : null;
  const showErrorBar = issues.length > 0 && !running && !healing && tab === 'preview' && !viewing;

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏：项目名、版本、发布 */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-3">
        <Link href="/projects" className="text-slate-400 hover:text-slate-700" title="返回项目列表">
          ←
        </Link>
        <ProjectName name={data.project.name} onRename={rename} />
        <span className="hidden text-xs text-slate-400 sm:inline" data-testid="version-badge">
          {data.version ? `版本 ${data.version.seq}` : '未生成'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1 md:hidden">
            {(['chat', 'preview'] as const).map((p) => (
              <button key={p} onClick={() => setPane(p)} className={`rounded px-2 py-1 text-xs ${pane === p ? 'bg-slate-900 text-white' : 'text-slate-500'}`}>
                {p === 'chat' ? '对话' : '预览'}
              </button>
            ))}
          </div>
          <TeamPanel team={team} onChange={setTeam} />
          <PublishButton project={data.project} disabled={running} onPublished={(p) => setData({ ...data, project: p })} />
        </div>
      </div>

      {qaJob && <QARunner key={qaJob.versionId} files={qaJob.files} tests={qaJob.tests} onDone={(results) => void onQADone(qaJob, results)} />}
      <div className="flex min-h-0 flex-1">
        {/* 左：对话与 Agent 时间线 */}
        <section
          className={`${pane === 'chat' ? 'flex' : 'hidden'} w-full min-w-0 flex-col border-r border-slate-200 bg-white md:flex md:w-[420px] md:shrink-0`}
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" data-testid="timeline">
            {data.messages.length === 0 && !live && <p className="mt-10 text-center text-sm text-slate-400">描述你想要的应用，比如“做一个番茄钟”。</p>}
            {data.messages.map((m) => (
              <MessageItem key={m.id} m={m} actions={m.id === interactiveId ? actions : undefined} />
            ))}
            {live && <LiveItem live={live} />}
            {healing && !running && (
              <p className="rounded-lg bg-orange-50 px-3 py-2 text-xs text-orange-700" data-testid="healing">
                {healLabel}
              </p>
            )}
            <div ref={timelineEnd} />
          </div>
          {/* 进度固定在输入框上方，时间线滚动时也始终可见 */}
          {live && (
            <div className="border-t border-slate-100 bg-slate-50/80 px-3 py-2">
              <RunProgress live={live} />
            </div>
          )}
          {notice && (
            <div className="mx-4 mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="notice">
              {notice}
            </div>
          )}
          <form onSubmit={send} className="border-t border-slate-200 p-3" {...attach.dropProps}>
            <div className="rounded-xl border border-slate-200 p-2 focus-within:border-brand-500">
              <AttachmentTray items={attach.items} onRemove={attach.remove} />
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
                onPaste={attach.onPaste}
                rows={2}
                maxLength={LIMITS.messageChars}
                placeholder={data.version ? '继续提修改，例如“主色改成绿色，加一个导出 CSV 按钮”；可以粘贴截图' : '描述你想要的应用，可以附上截图或参考图'}
                className="w-full resize-none bg-transparent px-1 text-sm outline-none placeholder:text-slate-400"
              />
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1 text-xs text-slate-400">
                  <AttachButton onFiles={(f) => void attach.add(f)} disabled={running} />
                  {input.length > 0 ? `${input.length}/${LIMITS.messageChars}` : ''}
                </span>
                {running ? (
                  <button type="button" onClick={stop} className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm text-white" data-testid="stop">
                    ■ 停止
                  </button>
                ) : (
                  <button
                    disabled={(!input.trim() && !attach.ready.length) || attach.uploading}
                    className="rounded-lg bg-brand-600 px-4 py-1.5 text-sm text-white disabled:opacity-40"
                    data-testid="send"
                  >
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
            <label className="ml-auto flex cursor-pointer items-center gap-1.5 px-2 text-xs text-slate-500" title="生成时自动切到代码面板，跟随正在写入的文件；完成后回到预览">
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => {
                  setFollow(e.target.checked);
                  try {
                    localStorage.setItem('atoms:follow', e.target.checked ? '1' : '0');
                  } catch {
                    /* 只在本次会话生效 */
                  }
                }}
                className="accent-brand-600"
                data-testid="follow-toggle"
              />
              跟随生成
            </label>
            {tab === 'preview' && (
              <div className="flex items-center gap-1">
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
              <Preview
                projectId={id}
                files={shownFiles}
                reloadKey={reloadKey}
                device={device}
                overlay={overlay}
                onIssue={viewing ? undefined : onIssue}
                onRendered={viewing ? undefined : onRendered}
              />
            </div>
            {tab === 'code' && (
              <CodeView
                files={running && !viewing ? { ...(files ?? {}), ...streaming } : shownFiles}
                name={data.project.name}
                seq={(viewing ?? data.version)?.seq ?? null}
                followPath={running && !viewing ? followPath : null}
                writing={running && !viewing ? writingPaths : []}
              />
            )}
            {tab === 'versions' && (
              <VersionsView
                projectId={id}
                project={data.project}
                refreshKey={data.version?.id ?? ''}
                busy={running}
                onView={(v) => {
                  setViewing(v.id === data.project.current_version_id ? null : v);
                  setTab('preview');
                }}
                onRestored={() => {
                  setViewing(null);
                  setIssues([]);
                  void load().then(() => setReloadKey((k) => k + 1));
                }}
              />
            )}
          </div>

          {showErrorBar && (
            <div className="flex items-start gap-3 border-t border-red-200 bg-red-50 px-3 py-2 text-sm" data-testid="error-bar">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-red-700">预览运行出错了{data.version?.source === 'autofix' ? '（自动修复未能解决）' : ''}</p>
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
