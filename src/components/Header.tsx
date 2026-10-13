'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, getMe, notifyAuthChanged } from '@/lib/client/api';
import type { SessionUser } from '@/lib/shared/types';

export function Header() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const load = () => getMe().then(setUser, () => setUser(null));
    load();
    window.addEventListener('atoms:auth', load);
    return () => window.removeEventListener('atoms:auth', load);
  }, [pathname]);

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    setUser(null);
    notifyAuthChanged();
    router.push('/');
  }

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4">
      <Link href="/" className="flex items-center gap-2 font-semibold text-slate-900">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-600 text-sm text-white">A</span>
        Atoms Lite
      </Link>
      <nav className="flex items-center gap-3 text-sm">
        {user && (
          <Link href="/projects" className="rounded-md px-2 py-1 text-slate-600 hover:bg-slate-100" data-testid="nav-projects">
            我的项目
          </Link>
        )}
        {user === undefined ? (
          <span className="skeleton h-6 w-20 rounded" />
        ) : user ? (
          <>
            {user.is_anonymous ? (
              <Link href="/login?bind=1" className="rounded-md bg-amber-50 px-2 py-1 text-amber-700 hover:bg-amber-100" data-testid="user-badge">
                游客 · 绑定邮箱保留数据
              </Link>
            ) : (
              <span className="hidden text-slate-500 sm:inline" data-testid="user-badge">
                {user.email}
              </span>
            )}
            <button onClick={logout} className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100" data-testid="logout">
              退出
            </button>
          </>
        ) : (
          <Link href="/login" className="rounded-md bg-slate-900 px-3 py-1.5 text-white hover:bg-slate-700" data-testid="nav-login">
            登录
          </Link>
        )}
      </nav>
    </header>
  );
}
