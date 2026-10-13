import 'server-only';
import { createClient } from '@supabase/supabase-js';
import type { Files } from '@/lib/shared/types';
import { env, useSupabase } from './env';
import { db } from './local-db';

/**
 * 发布页与 Remix 的只读访问（设计文档第 7 节）：不开放公共 RLS，
 * 由服务端按 slug 只读取 published_version_id 对应的那一行（Supabase 模式下用 service role）。
 */
export type Published = {
  projectId: string;
  name: string;
  slug: string;
  versionId: string;
  seq: number;
  summary: string | null;
  files: Files;
};

function admin() {
  if (!env.supabaseServiceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY 未配置，无法读取发布内容');
  return createClient(env.supabaseUrl, env.supabaseServiceKey, { auth: { persistSession: false } });
}

export async function getPublished(by: { slug: string } | { projectId: string }): Promise<Published | null> {
  if (!useSupabase()) {
    const p = db().projects.find((x) => ('slug' in by ? x.published_slug === by.slug : x.id === by.projectId));
    if (!p?.published_version_id || !p.published_slug) return null;
    const v = db().versions.find((x) => x.id === p.published_version_id);
    if (!v) return null;
    return { projectId: p.id, name: p.name, slug: p.published_slug, versionId: v.id, seq: v.seq, summary: v.summary, files: v.files };
  }
  const sb = admin();
  const q = sb.from('projects').select('id, name, published_slug, published_version_id');
  const { data: p } = await ('slug' in by ? q.eq('published_slug', by.slug) : q.eq('id', by.projectId)).maybeSingle();
  if (!p?.published_version_id || !p.published_slug) return null;
  const { data: v } = await sb.from('versions').select('id, seq, summary, files').eq('id', p.published_version_id).maybeSingle();
  if (!v) return null;
  return { projectId: p.id, name: p.name, slug: p.published_slug, versionId: v.id, seq: v.seq, summary: v.summary, files: v.files as Files };
}

export type PublishedCard = { projectId: string; name: string; slug: string; seq: number; summary: string | null; updatedAt: string; remixedFrom: string | null };

/** Discover 广场：最近更新的公开作品 */
export async function listPublished(limit = 24): Promise<PublishedCard[]> {
  if (!useSupabase()) {
    const versions = new Map(db().versions.map((v) => [v.id, v]));
    return db()
      .projects.filter((p) => p.published_slug && p.published_version_id && versions.has(p.published_version_id))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit)
      .map((p) => {
        const v = versions.get(p.published_version_id!)!;
        return { projectId: p.id, name: p.name, slug: p.published_slug!, seq: v.seq, summary: v.summary, updatedAt: p.updated_at, remixedFrom: p.remixed_from };
      });
  }
  if (!env.supabaseServiceKey) return [];
  const { data } = await admin()
    .from('projects')
    .select('id, name, published_slug, updated_at, remixed_from, versions!projects_published_version_fk(seq, summary)')
    .not('published_slug', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(limit);
  return (data ?? []).map((p) => {
    const v = (Array.isArray(p.versions) ? p.versions[0] : p.versions) as { seq: number; summary: string | null } | null;
    return {
      projectId: p.id as string,
      name: p.name as string,
      slug: p.published_slug as string,
      seq: v?.seq ?? 0,
      summary: v?.summary ?? null,
      updatedAt: p.updated_at as string,
      remixedFrom: (p.remixed_from as string | null) ?? null,
    };
  });
}
