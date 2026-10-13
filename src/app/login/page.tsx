'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, getMe, notifyAuthChanged } from '@/lib/client/api';
import type { SessionUser } from '@/lib/shared/types';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/projects';
  const [me, setMe] = useState<SessionUser | null | undefined>(undefined);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getMe().then(setMe, () => setMe(null));
  }, []);

  const binding = Boolean(me?.is_anonymous);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const path = binding ? '/api/auth/link' : mode === 'login' ? '/api/auth/login' : '/api/auth/signup';
      await api(path, { method: 'POST', json: { email, password } });
      notifyAuthChanged();
      router.push(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function guest() {
    setBusy(true);
    try {
      await api('/api/auth/guest', { method: 'POST' });
      notifyAuthChanged();
      router.push(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  if (me === undefined) return <div className="skeleton mx-auto mt-24 h-80 max-w-sm rounded-2xl" />;

  if (me && !me.is_anonymous) {
    return (
      <div className="mx-auto mt-24 max-w-sm rounded-2xl border border-slate-200 bg-white p-6 text-center">
        <p className="text-slate-600">你已登录：{me.email}</p>
        <button onClick={() => router.push('/projects')} className="mt-4 rounded-lg bg-brand-600 px-4 py-2 text-sm text-white">
          进入我的项目
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-16 max-w-sm px-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">{binding ? '绑定邮箱' : mode === 'login' ? '登录 Atoms Lite' : '注册账号'}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {binding ? '你正在以游客身份使用。绑定邮箱后，现有项目会完整保留，可在其他设备登录。' : '登录后可在任意设备继续你的项目。'}
        </p>
        {!binding && (
          <div className="mt-5 grid grid-cols-2 rounded-lg bg-slate-100 p-1 text-sm">
            {(['login', 'signup'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-md py-1.5 ${mode === m ? 'bg-white font-medium shadow-sm' : 'text-slate-500'}`}
                data-testid={`tab-${m}`}
              >
                {m === 'login' ? '登录' : '注册'}
              </button>
            ))}
          </div>
        )}
        <form onSubmit={submit} className="mt-5 space-y-3">
          <input
            data-testid="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="邮箱"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 outline-none focus:border-brand-500"
          />
          <input
            data-testid="password"
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码（至少 6 位）"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 outline-none focus:border-brand-500"
          />
          {error && <p className="text-sm text-red-600" data-testid="auth-error">{error}</p>}
          <button
            data-testid="auth-submit"
            disabled={busy}
            className="w-full rounded-lg bg-brand-600 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? '请稍候…' : binding ? '绑定邮箱' : mode === 'login' ? '登录' : '注册并登录'}
          </button>
        </form>
        {!me && (
          <>
            <div className="my-4 flex items-center gap-3 text-xs text-slate-400">
              <span className="h-px flex-1 bg-slate-200" />或<span className="h-px flex-1 bg-slate-200" />
            </div>
            <button
              data-testid="guest"
              onClick={guest}
              disabled={busy}
              className="w-full rounded-lg border border-slate-200 py-2 text-slate-700 hover:bg-slate-50"
            >
              以游客继续
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
