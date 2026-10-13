import 'server-only';
import { createHmac, randomUUID, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import type { SessionUser } from '@/lib/shared/types';
import { env, useSupabase } from './env';
import { db, now, save } from './local-db';
import { supabaseServer } from './supabase';

/**
 * 账号体系：邮箱登录 + 游客模式（设计文档第 2、3 节）。
 * 配置了 Supabase 时使用 Supabase Auth（匿名登录、邮箱密码、绑定邮箱）；
 * 否则使用本地实现：签名 Cookie + 文件存储的用户表。
 */
export class AuthError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const COOKIE = 'atoms_session';

function sign(uid: string) {
  return createHmac('sha256', env.authSecret).update(uid).digest('base64url');
}

async function setLocalSession(uid: string) {
  const store = await cookies();
  store.set(COOKIE, `${uid}.${sign(uid)}`, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production' && process.env.ATOMS_INSECURE_COOKIE !== '1',
    maxAge: 60 * 60 * 24 * 365,
  });
}

function hashPassword(pw: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 32).toString('hex')}`;
}

function verifyPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(pw, salt, 32);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateCredentials(email: string, password: string) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError('邮箱格式不正确');
  if (password.length < 6) throw new AuthError('密码至少 6 位');
}

export async function getUser(): Promise<SessionUser | null> {
  if (useSupabase()) {
    const sb = await supabaseServer();
    const { data } = await sb.auth.getUser();
    if (!data.user) return null;
    return { id: data.user.id, email: data.user.email ?? null, is_anonymous: Boolean(data.user.is_anonymous) };
  }
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  const uid = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = sign(uid);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const u = db().users.find((x) => x.id === uid);
  return u ? { id: u.id, email: u.email, is_anonymous: u.is_anonymous } : null;
}

export async function signInGuest(): Promise<SessionUser> {
  if (useSupabase()) {
    const sb = await supabaseServer();
    const { data, error } = await sb.auth.signInAnonymously();
    if (error || !data.user) throw new AuthError(error?.message ?? '游客登录失败', 500);
    return { id: data.user.id, email: null, is_anonymous: true };
  }
  const u = { id: randomUUID(), email: null, password_hash: null, is_anonymous: true, created_at: now() };
  db().users.push(u);
  save();
  await setLocalSession(u.id);
  return { id: u.id, email: null, is_anonymous: true };
}

export async function signUp(email: string, password: string): Promise<SessionUser> {
  email = email.trim().toLowerCase();
  validateCredentials(email, password);
  if (useSupabase()) {
    const sb = await supabaseServer();
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error || !data.user) throw new AuthError(error?.message ?? '注册失败');
    if (!data.session) throw new AuthError('注册成功，请先到邮箱完成验证后再登录', 202);
    return { id: data.user.id, email, is_anonymous: false };
  }
  if (db().users.some((u) => u.email === email)) throw new AuthError('该邮箱已注册，请直接登录', 409);
  const u = { id: randomUUID(), email, password_hash: hashPassword(password), is_anonymous: false, created_at: now() };
  db().users.push(u);
  save();
  await setLocalSession(u.id);
  return { id: u.id, email, is_anonymous: false };
}

export async function signIn(email: string, password: string): Promise<SessionUser> {
  email = email.trim().toLowerCase();
  if (useSupabase()) {
    const sb = await supabaseServer();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error || !data.user) throw new AuthError('邮箱或密码错误', 401);
    return { id: data.user.id, email, is_anonymous: false };
  }
  const u = db().users.find((x) => x.email === email);
  if (!u?.password_hash || !verifyPassword(password, u.password_hash)) throw new AuthError('邮箱或密码错误', 401);
  await setLocalSession(u.id);
  return { id: u.id, email, is_anonymous: false };
}

/** 游客绑定邮箱：保留同一个用户 ID，数据不丢 */
export async function linkEmail(email: string, password: string): Promise<SessionUser> {
  email = email.trim().toLowerCase();
  validateCredentials(email, password);
  const me = await getUser();
  if (!me) throw new AuthError('请先登录', 401);
  if (!me.is_anonymous) throw new AuthError('当前账号已绑定邮箱');
  if (useSupabase()) {
    const sb = await supabaseServer();
    const { error } = await sb.auth.updateUser({ email, password });
    if (error) throw new AuthError(error.message);
    return { id: me.id, email, is_anonymous: false };
  }
  if (db().users.some((u) => u.email === email)) throw new AuthError('该邮箱已被使用', 409);
  const u = db().users.find((x) => x.id === me.id)!;
  u.email = email;
  u.password_hash = hashPassword(password);
  u.is_anonymous = false;
  save();
  return { id: u.id, email, is_anonymous: false };
}

export async function signOut() {
  if (useSupabase()) {
    const sb = await supabaseServer();
    await sb.auth.signOut();
    return;
  }
  (await cookies()).delete(COOKIE);
}
