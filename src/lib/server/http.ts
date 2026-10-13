import 'server-only';
import { NextResponse } from 'next/server';
import type { SessionUser } from '@/lib/shared/types';
import { AuthError, getUser } from './auth';
import { getStore, type Store } from './store';

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status });
export const fail = (message: string, status = 400, code = 'bad_request') => json({ error: { code, message } }, status);

export async function readJson<T>(req: Request): Promise<Partial<T>> {
  try {
    return (await req.json()) as Partial<T>;
  } catch {
    return {};
  }
}

/** 包装路由：统一处理未登录与异常 */
export function withUser<A extends unknown[]>(
  handler: (ctx: { user: SessionUser; store: Store }, ...args: A) => Promise<Response>,
) {
  return async (...args: A) => {
    try {
      const user = await getUser();
      if (!user) return fail('请先登录', 401, 'unauthorized');
      return await handler({ user, store: getStore(user) }, ...args);
    } catch (err) {
      return handleError(err);
    }
  };
}

export function handleError(err: unknown) {
  if (err instanceof AuthError) return fail(err.message, err.status, 'auth');
  console.error('[api]', err);
  return fail('服务器开小差了，请稍后再试', 500, 'internal');
}
