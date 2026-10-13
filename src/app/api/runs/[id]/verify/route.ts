import { fail, json, readJson, withUser } from '@/lib/server/http';
import type { CheckError, ErrorKind } from '@/lib/shared/types';

/**
 * 前端回写运行检查结果（设计文档第 5、10 节）：渲染后 3 秒观察窗口内有无运行时错误 / 白屏。
 * 更新版本的 verified，以及 run 的首次通过、最终可用、错误类型。
 */
export const POST = withUser(async ({ store }, req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const run = await store.getRun(id);
  if (!run) return fail('run 不存在', 404, 'not_found');
  const body = await readJson<{ versionId: string; ok: boolean; errors: CheckError[] }>(req);
  const version = body.versionId ? await store.getVersion(body.versionId) : null;
  if (!version || version.project_id !== run.project_id || version.run_id !== run.id) return fail('版本不属于该 run', 400);
  const ok = body.ok === true;
  const kinds: ErrorKind[] = ['syntax', 'runtime', 'console', 'blank'];
  const errorKinds = new Set(run.error_kinds ?? []);
  for (const e of Array.isArray(body.errors) ? body.errors : []) if (kinds.includes(e?.kind)) errorKinds.add(e.kind);

  await store.setVersionVerified(version.id, ok);
  const patch = {
    final_ok: ok,
    first_pass: run.first_pass === null ? ok && run.fix_rounds === 0 : run.first_pass,
    error_kinds: [...errorKinds],
  };
  await store.updateRun(run.id, patch);
  return json({ run: { ...run, ...patch }, canAutoFix: !ok && run.fix_rounds < 2 });
});
