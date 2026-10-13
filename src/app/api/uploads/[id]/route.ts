import { getUpload } from '@/lib/server/uploads';

export const dynamic = 'force-dynamic';

/** 读取附件：链接即凭证（128 位随机 id），内容不变，可长期缓存 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const f = getUpload((await params).id);
  if (!f) return new Response('Not found', { status: 404 });
  const type = f.meta.kind === 'text' ? `${f.meta.type}; charset=utf-8` : f.meta.type;
  return new Response(new Uint8Array(f.bytes), {
    headers: {
      'Content-Type': type,
      'Content-Length': String(f.bytes.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.meta.name)}`,
    },
  });
}
