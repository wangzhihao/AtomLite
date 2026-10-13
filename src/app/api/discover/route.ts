import { json } from '@/lib/server/http';
import { listPublished } from '@/lib/server/public-store';

export const dynamic = 'force-dynamic';

/** 公开作品列表（无需登录） */
export async function GET(req: Request) {
  const limit = Math.min(48, Math.max(1, Number(new URL(req.url).searchParams.get('limit')) || 24));
  return json({ items: await listPublished(limit) });
}
