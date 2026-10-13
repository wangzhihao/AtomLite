import { fail, json, withUser } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/** 版本列表（不含文件内容）；带 ?id= 时返回该版本的完整文件 */
export const GET = withUser(async ({ store }, req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  if (!(await store.getProject(id))) return fail('项目不存在', 404, 'not_found');
  const vid = new URL(req.url).searchParams.get('id');
  if (vid) {
    const version = await store.getVersion(vid);
    return version && version.project_id === id ? json({ version }) : fail('版本不存在', 404, 'not_found');
  }
  return json({ versions: await store.listVersions(id) });
});
