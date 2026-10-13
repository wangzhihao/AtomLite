import { fail, json, readJson, withUser } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** 项目、对话、当前版本 */
export const GET = withUser(async ({ store }, _req: Request, { params }: Ctx) => {
  const { id } = await params;
  const project = await store.getProject(id);
  if (!project) return fail('项目不存在', 404, 'not_found');
  const [messages, version, running] = await Promise.all([
    store.listMessages(id),
    project.current_version_id ? store.getVersion(project.current_version_id) : null,
    store.findRunningRun(id),
  ]);
  return json({ project, messages, version, running: Boolean(running) });
});

export const PATCH = withUser(async ({ store }, req: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = await readJson<{ name: string }>(req);
  const name = String(body.name ?? '').trim().slice(0, 60);
  if (!name) return fail('项目名不能为空');
  const project = await store.renameProject(id, name);
  return project ? json({ project }) : fail('项目不存在', 404, 'not_found');
});

export const DELETE = withUser(async ({ store }, _req: Request, { params }: Ctx) => {
  const { id } = await params;
  return (await store.deleteProject(id)) ? json({ ok: true }) : fail('项目不存在', 404, 'not_found');
});
