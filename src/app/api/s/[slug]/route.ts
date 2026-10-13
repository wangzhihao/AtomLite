import { fail, json } from '@/lib/server/http';
import { getPublished } from '@/lib/server/public-store';

export const dynamic = 'force-dynamic';

/** 已发布版本的文件（公开，无需登录），用于广场和首页卡片的缩略图 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const p = await getPublished({ slug: (await params).slug });
  if (!p) return fail('作品不存在', 404, 'not_found');
  const res = json({ name: p.name, seq: p.seq, files: p.files });
  res.headers.set('Cache-Control', 'public, max-age=60');
  return res;
}
