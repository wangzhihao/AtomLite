import { activeRuns } from '@/lib/server/orchestrator';
import { fail, json, withUser } from '@/lib/server/http';

/** 取消进行中的 run */
export const POST = withUser(async ({ store }, _req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  if (!(await store.getProject(id))) return fail('项目不存在', 404, 'not_found');
  const ctrl = activeRuns.get(id);
  ctrl?.abort(new Error('cancelled'));
  return json({ cancelled: Boolean(ctrl) });
});
