import { randomBytes } from 'node:crypto';
import { fail, json, withUser } from '@/lib/server/http';

/** 发布当前版本：只记录 published_version_id，之后继续修改不会影响已发布页面，再次发布才更新 */
export const POST = withUser(async ({ store }, _req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const project = await store.getProject(id);
  if (!project) return fail('项目不存在', 404, 'not_found');
  if (!project.current_version_id) return fail('还没有可发布的版本');
  for (let i = 0; i < 5; i++) {
    const slug = project.published_slug ?? randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    if (slug.length < 6) continue;
    try {
      const updated = await store.publishProject(id, slug, project.current_version_id);
      if (!updated) return fail('项目不存在', 404, 'not_found');
      return json({ project: updated, slug, url: `/s/${slug}` });
    } catch {
      if (project.published_slug) throw new Error('publish failed');
    }
  }
  return fail('发布失败，请重试', 500, 'internal');
});
