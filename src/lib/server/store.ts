import 'server-only';
import { randomUUID } from 'node:crypto';
import type {
  Files,
  Message,
  Project,
  Run,
  SessionUser,
  Version,
  VersionMeta,
  VersionSource,
} from '@/lib/shared/types';
import { useSupabase } from './env';
import { db, now, save } from './local-db';
import { supabaseServer } from './supabase';

/**
 * 数据访问层（设计文档第 7 节）。所有方法都以当前用户身份执行：
 * Supabase 模式下由 RLS 保证只能访问自己的数据，本地模式下由代码检查 owner。
 */
export interface Store {
  listProjects(): Promise<Project[]>;
  createProject(name: string, remixedFrom?: string | null): Promise<Project>;
  getProject(id: string): Promise<Project | null>;
  renameProject(id: string, name: string): Promise<Project | null>;
  deleteProject(id: string): Promise<boolean>;
  /** 发布：只移动指针（published_version_id），之后的修改不影响已发布页面 */
  publishProject(id: string, slug: string, versionId: string): Promise<Project | null>;

  listMessages(projectId: string): Promise<Message[]>;
  addMessage(m: Omit<Message, 'id' | 'created_at'>): Promise<Message>;
  updateMessage(id: string, patch: Partial<Pick<Message, 'meta' | 'content' | 'version_id'>>): Promise<void>;

  getVersion(id: string): Promise<Version | null>;
  setVersionVerified(id: string, verified: boolean): Promise<void>;
  listVersions(projectId: string): Promise<VersionMeta[]>;
  /** 写入新版本（seq 自增）并把项目的当前版本指向它 */
  createVersion(
    projectId: string,
    v: { files: Files; summary: string | null; source: VersionSource; run_id: string | null },
  ): Promise<Version>;

  createRun(r: Pick<Run, 'project_id' | 'intent' | 'model'>): Promise<Run>;
  getRun(id: string): Promise<Run | null>;
  updateRun(id: string, patch: Partial<Omit<Run, 'id' | 'project_id' | 'user_id'>>): Promise<void>;
  findRunningRun(projectId: string): Promise<Run | null>;
  countRunsSince(sinceIso: string): Promise<number>;
}

export function getStore(user: SessionUser): Store {
  return useSupabase() ? supabaseStore(user) : localStore(user);
}

// ---------------------------------------------------------------- 本地实现

/** 本地模式下，进行中但服务重启后不可能再完成的 run 视为失效 */
const STALE_RUN_MS = 10 * 60 * 1000;

function localStore(user: SessionUser): Store {
  const owned = (projectId: string) => db().projects.some((p) => p.id === projectId && p.owner_id === user.id);
  const touch = (projectId: string) => {
    const p = db().projects.find((x) => x.id === projectId);
    if (p) p.updated_at = now();
  };
  return {
    async listProjects() {
      return db()
        .projects.filter((p) => p.owner_id === user.id)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    },
    async createProject(name, remixedFrom = null) {
      const p: Project = {
        id: randomUUID(),
        owner_id: user.id,
        name,
        current_version_id: null,
        published_slug: null,
        published_version_id: null,
        remixed_from: remixedFrom,
        created_at: now(),
        updated_at: now(),
      };
      db().projects.push(p);
      save();
      return p;
    },
    async getProject(id) {
      return db().projects.find((p) => p.id === id && p.owner_id === user.id) ?? null;
    },
    async renameProject(id, name) {
      const p = db().projects.find((x) => x.id === id && x.owner_id === user.id);
      if (!p) return null;
      p.name = name;
      p.updated_at = now();
      save();
      return p;
    },
    async deleteProject(id) {
      if (!owned(id)) return false;
      const d = db();
      d.projects = d.projects.filter((p) => p.id !== id);
      d.versions = d.versions.filter((v) => v.project_id !== id);
      d.messages = d.messages.filter((m) => m.project_id !== id);
      d.runs = d.runs.filter((r) => r.project_id !== id);
      save();
      return true;
    },
    async publishProject(id, slug, versionId) {
      const p = db().projects.find((x) => x.id === id && x.owner_id === user.id);
      if (!p) return null;
      if (db().projects.some((x) => x.published_slug === slug && x.id !== id)) throw new Error('slug taken');
      p.published_slug = slug;
      p.published_version_id = versionId;
      p.updated_at = now();
      save();
      return p;
    },
    async listMessages(projectId) {
      if (!owned(projectId)) return [];
      return db().messages.filter((m) => m.project_id === projectId);
    },
    async addMessage(m) {
      if (!owned(m.project_id)) throw new Error('forbidden');
      const msg: Message = { ...m, id: randomUUID(), created_at: now() };
      db().messages.push(msg);
      save();
      return msg;
    },
    async updateMessage(id, patch) {
      const m = db().messages.find((x) => x.id === id);
      if (!m || !owned(m.project_id)) return;
      Object.assign(m, patch);
      save();
    },
    async getVersion(id) {
      const v = db().versions.find((x) => x.id === id);
      return v && owned(v.project_id) ? v : null;
    },
    async setVersionVerified(id, verified) {
      const v = db().versions.find((x) => x.id === id);
      if (!v || !owned(v.project_id)) return;
      v.verified = verified;
      save();
    },
    async listVersions(projectId) {
      if (!owned(projectId)) return [];
      return db()
        .versions.filter((v) => v.project_id === projectId)
        .sort((a, b) => b.seq - a.seq)
        .map(({ files: _files, ...meta }) => meta);
    },
    async createVersion(projectId, v) {
      if (!owned(projectId)) throw new Error('forbidden');
      const seq = Math.max(0, ...db().versions.filter((x) => x.project_id === projectId).map((x) => x.seq)) + 1;
      const version: Version = { ...v, id: randomUUID(), project_id: projectId, seq, verified: null, created_at: now() };
      db().versions.push(version);
      const p = db().projects.find((x) => x.id === projectId)!;
      p.current_version_id = version.id;
      touch(projectId);
      save();
      return version;
    },
    async createRun(r) {
      if (!owned(r.project_id)) throw new Error('forbidden');
      const run: Run = {
        ...r,
        id: randomUUID(),
        user_id: user.id,
        status: 'running',
        first_pass: null,
        fix_rounds: 0,
        final_ok: null,
        error_kinds: null,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cost_usd: null,
        error: null,
        started_at: now(),
        finished_at: null,
      };
      db().runs.push(run);
      save();
      return run;
    },
    async getRun(id) {
      return db().runs.find((x) => x.id === id && x.user_id === user.id) ?? null;
    },
    async updateRun(id, patch) {
      const r = db().runs.find((x) => x.id === id && x.user_id === user.id);
      if (!r) return;
      Object.assign(r, patch);
      save();
    },
    async findRunningRun(projectId) {
      const cutoff = Date.now() - STALE_RUN_MS;
      return (
        db().runs.find(
          (r) => r.project_id === projectId && r.status === 'running' && Date.parse(r.started_at) > cutoff,
        ) ?? null
      );
    },
    async countRunsSince(sinceIso) {
      return db().runs.filter((r) => r.user_id === user.id && r.started_at >= sinceIso).length;
    },
  };
}

// ---------------------------------------------------------------- Supabase 实现

function supabaseStore(user: SessionUser): Store {
  const sb = supabaseServer();
  const check = <T>(res: { data: T; error: { message: string } | null }) => {
    if (res.error) throw new Error(res.error.message);
    return res.data;
  };
  const touch = async (projectId: string, extra: Partial<Project> = {}) =>
    check(
      await (await sb)
        .from('projects')
        .update({ ...extra, updated_at: now() })
        .eq('id', projectId),
    );
  return {
    async listProjects() {
      return check(await (await sb).from('projects').select('*').order('updated_at', { ascending: false })) as Project[];
    },
    async createProject(name, remixedFrom = null) {
      return check(
        await (await sb).from('projects').insert({ name, owner_id: user.id, remixed_from: remixedFrom }).select('*').single(),
      ) as Project;
    },
    async publishProject(id, slug, versionId) {
      return check(
        await (await sb)
          .from('projects')
          .update({ published_slug: slug, published_version_id: versionId, updated_at: now() })
          .eq('id', id)
          .select('*')
          .maybeSingle(),
      ) as Project | null;
    },
    async getProject(id) {
      return check(await (await sb).from('projects').select('*').eq('id', id).maybeSingle()) as Project | null;
    },
    async renameProject(id, name) {
      return check(
        await (await sb).from('projects').update({ name, updated_at: now() }).eq('id', id).select('*').maybeSingle(),
      ) as Project | null;
    },
    async deleteProject(id) {
      const rows = check(await (await sb).from('projects').delete().eq('id', id).select('id')) as { id: string }[];
      return rows.length > 0;
    },
    async listMessages(projectId) {
      return check(
        await (await sb).from('messages').select('*').eq('project_id', projectId).order('created_at'),
      ) as Message[];
    },
    async addMessage(m) {
      return check(await (await sb).from('messages').insert(m).select('*').single()) as Message;
    },
    async updateMessage(id, patch) {
      check(await (await sb).from('messages').update(patch).eq('id', id));
    },
    async getVersion(id) {
      return check(await (await sb).from('versions').select('*').eq('id', id).maybeSingle()) as Version | null;
    },
    async setVersionVerified(id, verified) {
      check(await (await sb).from('versions').update({ verified }).eq('id', id));
    },
    async listVersions(projectId) {
      return check(
        await (await sb)
          .from('versions')
          .select('id, project_id, seq, summary, source, verified, run_id, created_at')
          .eq('project_id', projectId)
          .order('seq', { ascending: false }),
      ) as VersionMeta[];
    },
    async createVersion(projectId, v) {
      const last = check(
        await (await sb)
          .from('versions')
          .select('seq')
          .eq('project_id', projectId)
          .order('seq', { ascending: false })
          .limit(1),
      ) as { seq: number }[];
      const version = check(
        await (await sb)
          .from('versions')
          .insert({ ...v, project_id: projectId, seq: (last[0]?.seq ?? 0) + 1 })
          .select('*')
          .single(),
      ) as Version;
      await touch(projectId, { current_version_id: version.id });
      return version;
    },
    async createRun(r) {
      return check(
        await (await sb)
          .from('runs')
          .insert({ ...r, user_id: user.id, status: 'running' })
          .select('*')
          .single(),
      ) as Run;
    },
    async getRun(id) {
      return check(await (await sb).from('runs').select('*').eq('id', id).maybeSingle()) as Run | null;
    },
    async updateRun(id, patch) {
      check(await (await sb).from('runs').update(patch).eq('id', id));
    },
    async findRunningRun(projectId) {
      const cutoff = new Date(Date.now() - STALE_RUN_MS).toISOString();
      const rows = check(
        await (await sb)
          .from('runs')
          .select('*')
          .eq('project_id', projectId)
          .eq('status', 'running')
          .gt('started_at', cutoff)
          .limit(1),
      ) as Run[];
      return rows[0] ?? null;
    },
    async countRunsSince(sinceIso) {
      const res = await (await sb)
        .from('runs')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .gte('started_at', sinceIso);
      if (res.error) throw new Error(res.error.message);
      return res.count ?? 0;
    },
  };
}
