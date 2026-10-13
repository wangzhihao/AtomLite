import { fail, json, readJson, withUser } from '@/lib/server/http';
import type { QAResult } from '@/lib/shared/types';
import { LIMITS } from '@/lib/shared/types';

/** 记录验收结果：Quinn 播报一条消息；有失败项时把 run 标记为未通过，前端可交给 Max 修复 */
export const POST = withUser(async ({ store }, req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const run = await store.getRun(id);
  if (!run) return fail('run 不存在', 404, 'not_found');
  const body = await readJson<{ versionId: string; results: QAResult[] }>(req);
  const version = body.versionId ? await store.getVersion(body.versionId) : null;
  if (!version || version.run_id !== run.id) return fail('版本不属于该 run', 400);
  const results = (Array.isArray(body.results) ? body.results : []).slice(0, 5).map((r) => ({
    feature: String(r?.feature ?? '').slice(0, 60),
    ok: r?.ok === true,
    error: r?.error ? String(r.error).slice(0, 200) : undefined,
  }));
  if (!results.length) return json({ ok: true, canAutoFix: false });

  const failed = results.filter((r) => !r.ok);
  const content = failed.length
    ? `${results.length} 个功能点测了 ${results.length} 个，${failed.map((f) => `「${f.feature}」`).join('、')}没有通过。`
    : `${results.length} 个功能点测了 ${results.length} 个，全部通过。`;
  await store.addMessage({ project_id: run.project_id, role: 'agent', agent: 'qa', content, meta: { qa: results }, version_id: version.id });
  if (failed.length) {
    await store.setVersionVerified(version.id, false);
    await store.updateRun(run.id, {
      final_ok: false,
      first_pass: run.fix_rounds === 0 ? false : run.first_pass,
      error_kinds: [...new Set([...(run.error_kinds ?? []), 'qa'])],
    });
  }
  return json({ ok: !failed.length, canAutoFix: failed.length > 0 && run.fix_rounds < LIMITS.maxFixRounds });
});
