import 'server-only';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, Project, Run, Version } from '@/lib/shared/types';
import { env } from './env';

/**
 * 本机数据存储（设计文档第 4、7 节）：整个库常驻内存，每次写操作后先写临时文件再原子替换。
 * 演示规模足够；数据量增长后按同一结构迁到 SQLite（只需替换 store.ts 的实现）。
 */
export type LocalUser = {
  id: string;
  email: string | null;
  password_hash: string | null;
  is_anonymous: boolean;
  created_at: string;
};

/** 附件元数据；文件本体在 <数据目录>/uploads/<id> */
export type LocalUpload = {
  id: string;
  owner_id: string;
  name: string;
  type: string;
  kind: 'image' | 'pdf' | 'text';
  size: number;
  created_at: string;
};

export type LocalData = {
  uploads: LocalUpload[];
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
    const empty: LocalData = { uploads: [], users: [], projects: [], versions: [], messages: [], runs: [] };
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
