'use client';
import type { SessionUser } from '@/lib/shared/types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: string } }).error;
    throw new ApiError(err?.message ?? `请求失败（${res.status}）`, res.status, err?.code);
  }
  return data as T;
}

export async function getMe() {
  return (await api<{ user: SessionUser | null }>('/api/auth/me')).user;
}

/** 未登录时自动以游客身份登录（评审无需注册即可体验） */
export async function ensureUser() {
  return (await getMe()) ?? (await api<{ user: SessionUser }>('/api/auth/guest', { method: 'POST' })).user;
}

export function notifyAuthChanged() {
  window.dispatchEvent(new Event('atoms:auth'));
}

export function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}
