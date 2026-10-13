import { fail, json, readJson, withUser } from '@/lib/server/http';
import { LIMITS } from '@/lib/shared/types';

export const dynamic = 'force-dynamic';

export const GET = withUser(async ({ store }) => json({ projects: await store.listProjects() }));

/** 创建项目，可携带首条需求：需求作为待处理的用户消息保存，进入工作区后自动开始生成 */
export const POST = withUser(async ({ store }, req: Request) => {
  const body = await readJson<{ name: string; prompt: string }>(req);
  const prompt = String(body.prompt ?? '').trim();
  if (prompt.length > LIMITS.messageChars) return fail(`需求不能超过 ${LIMITS.messageChars} 字`);
  const name = String(body.name ?? '').trim().slice(0, 60) || (prompt ? prompt.slice(0, 20) : '未命名项目');
  const project = await store.createProject(name);
  if (prompt) {
    await store.addMessage({
      project_id: project.id,
      role: 'user',
      agent: null,
      content: prompt,
      meta: { pending: true },
      version_id: null,
    });
  }
  return json({ project }, 201);
});
