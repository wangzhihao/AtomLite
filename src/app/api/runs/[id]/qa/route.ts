import { fail, json, readJson, withUser } from '@/lib/server/http';
import { generateQATests } from '@/lib/server/qa';

export const maxDuration = 120;

/** 验收 QA（Quinn）：根据规格功能点生成声明式交互测试，由前端在隔离的沙箱 iframe 中执行 */
export const POST = withUser(async ({ store }, req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const run = await store.getRun(id);
  if (!run) return fail('run 不存在', 404, 'not_found');
  const body = await readJson<{ versionId: string }>(req);
  const version = body.versionId ? await store.getVersion(body.versionId) : null;
  if (!version || version.run_id !== run.id) return fail('版本不属于该 run', 400);
  try {
    return json({ tests: await generateQATests(store, run, version, req.signal) });
  } catch (err) {
    console.warn('[qa]', err);
    return json({ tests: [], error: '验收测试生成失败' });
  }
});
