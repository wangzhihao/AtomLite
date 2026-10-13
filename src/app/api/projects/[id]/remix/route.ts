import { fail, json, withUser } from '@/lib/server/http';
import { getPublished } from '@/lib/server/public-store';

/** Remix：把某个项目已发布的版本复制到当前用户的新项目 */
export const POST = withUser(async ({ store }, _req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const published = await getPublished({ projectId: id });
  if (!published) return fail('这个作品没有公开发布', 404, 'not_found');
  const project = await store.createProject(`${published.name}（Remix）`.slice(0, 60), published.projectId);
  const version = await store.createVersion(project.id, {
    files: published.files,
    summary: `从「${published.name}」版本 ${published.seq} Remix`,
    source: 'remix',
    run_id: null,
  });
  await store.addMessage({
    project_id: project.id,
    role: 'system',
    agent: null,
    content: `已从「${published.name}」Remix 一份到你的账号，可以继续对话修改。`,
    meta: { remix: { from: published.projectId, slug: published.slug } },
    version_id: version.id,
  });
  return json({ project: { ...project, current_version_id: version.id } }, 201);
});
