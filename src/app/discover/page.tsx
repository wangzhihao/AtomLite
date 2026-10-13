import Link from 'next/link';
import { PublishedGrid } from '@/components/PublishedGrid';
import { listPublished } from '@/lib/server/public-store';

export const dynamic = 'force-dynamic';
export const metadata = { title: '广场 · Atoms Lite', description: '大家用 Atoms Lite 一句话做出来的应用，可以直接打开，也可以 Remix 一份继续改。' };

export default async function DiscoverPage() {
  const items = await listPublished(48);
  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-semibold">广场</h1>
      <p className="mt-1 text-sm text-slate-500">大家一句话做出来的应用。打开即可使用，也可以 Remix 一份继续改。</p>
      <div className="mt-6">
        {items.length ? (
          <PublishedGrid items={items} />
        ) : (
          <div className="mt-16 text-center text-slate-500" data-testid="empty-discover">
            <p>还没有公开作品。</p>
            <Link href="/" className="mt-3 inline-block rounded-lg bg-brand-600 px-4 py-2 text-sm text-white">
              做第一个并发布
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
