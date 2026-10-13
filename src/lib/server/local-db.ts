import 'server-only';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, Project, Run, Version } from '@/lib/shared/types';
import { env } from './env';

/**
 * 本地开发 / 测试用的文件数据库：整个库在内存里，每次写操作后原子落盘。
 * 线上环境请配置 Supabase。
 */
export type LocalUser = {
  id: string;
  email: string | null;
  password_hash: string | null;
  is_anonymous: boolean;
  created_at: string;
};

export type LocalData = {
  users: LocalUser[];
  projects: Project[];
  versions: Version[];
  messages: Message[];
  runs: Run[];
};

const g = globalThis as unknown as { __atomsDb?: LocalData };

function file() {
  return join(env.dataDir, 'db.json');
}

export function db(): LocalData {
  if (!g.__atomsDb) {
    const empty: LocalData = { users: [], projects: [], versions: [], messages: [], runs: [] };
    try {
      g.__atomsDb = existsSync(file()) ? { ...empty, ...JSON.parse(readFileSync(file(), 'utf8')) } : empty;
    } catch {
      g.__atomsDb = empty;
    }
  }
  return g.__atomsDb!;
}

export function save() {
  mkdirSync(env.dataDir, { recursive: true });
  const tmp = file() + '.tmp';
  writeFileSync(tmp, JSON.stringify(db()));
  renameSync(tmp, file());
}

export const now = () => new Date().toISOString();
