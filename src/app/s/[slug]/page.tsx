import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getPublished } from '@/lib/server/public-store';
import { PublishedApp } from './PublishedApp';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string }> };

/** 发布时自动生成页面标题和描述，算是轻量的 SEO */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = await getPublished({ slug: (await params).slug });
  if (!p) return { title: '作品不存在 · Atoms Lite' };
  return { title: `${p.name} · Built with Atoms Lite`, description: p.summary ?? `${p.name}，用 Atoms Lite 一句话生成。` };
}

export default async function PublishedPage({ params }: Props) {
  const p = await getPublished({ slug: (await params).slug });
  if (!p) notFound();
  return <PublishedApp projectId={p.projectId} slug={p.slug} name={p.name} files={p.files} />;
}
