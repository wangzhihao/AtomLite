import { fail, json, withUser } from '@/lib/server/http';
import { activeRuns } from '@/lib/server/orchestrator';

/** 回滚：不删除历史，复制目标版本生成一个 source = restore 的新版本 */
export const POST = withUser(async ({ store }, _req: Request, { params }: { params: Promise<{ id: string; vid: string }> }) => {
  const { id, vid } = await params;
  const project = await store.getProject(id);
  if (!project) return fail('项目不存在', 404, 'not_found');
  if (activeRuns.has(id) || (await store.findRunningRun(id))) return fail('正在生成中，请先停止再回滚', 409, 'busy');
  const target = await store.getVersion(vid);
  if (!target || target.project_id !== id) return fail('版本不存在', 404, 'not_found');
  if (project.current_version_id === vid) return fail('已经是当前版本');
  const version = await store.createVersion(id, {
    files: target.files,
    summary: `回滚到版本 ${target.seq}`,
    source: 'restore',
    run_id: null,
  });
  await store.addMessage({
    project_id: id,
    role: 'system',
    agent: null,
    content: `已回滚到版本 ${target.seq}，保存为版本 ${version.seq}。`,
    meta: { restore: { from: target.seq, to: version.seq } },
    version_id: version.id,
  });
  const { files: _files, ...meta } = version;
  return json({ version: meta });
});
