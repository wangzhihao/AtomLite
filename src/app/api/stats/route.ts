import { json, withUser } from '@/lib/server/http';
import { computeMetrics } from '@/lib/shared/metrics';

export const dynamic = 'force-dynamic';

/** 当前用户最近 500 个 run 的质量与成本指标 */
export const GET = withUser(async ({ store }) => json({ metrics: computeMetrics(await store.listRuns(500)) }));
