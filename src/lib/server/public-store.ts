import 'server-only';
import type { Files } from '@/lib/shared/types';
import { db } from './local-db';

/**
 * 发布页与 Remix 的只读访问（设计文档第 7 节）：不走用户归属检查，
 * 由服务端按 slug 或项目只读取 published_version_id 对应的那一行，不暴露其他数据。
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

export async function getPublished(by: { slug: string } | { projectId: string }): Promise<Published | null> {
  const p = db().projects.find((x) => ('slug' in by ? x.published_slug === by.slug : x.id === by.projectId));
  if (!p?.published_version_id || !p.published_slug) return null;
  const v = db().versions.find((x) => x.id === p.published_version_id);
  if (!v) return null;
  return { projectId: p.id, name: p.name, slug: p.published_slug, versionId: v.id, seq: v.seq, summary: v.summary, files: v.files };
}

export type PublishedCard = { projectId: string; name: string; slug: string; seq: number; summary: string | null; updatedAt: string; remixedFrom: string | null };

/** Discover 广场：最近更新的公开作品 */
export async function listPublished(limit = 24): Promise<PublishedCard[]> {
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
