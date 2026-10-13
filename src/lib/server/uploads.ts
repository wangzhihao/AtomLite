import 'server-only';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionUser } from '@/lib/shared/types';
import { ATTACHMENT_LIMITS, attachmentUrl, cleanFileName, maxBytes, sniffType, type Attachment } from '@/lib/shared/attachments';
import { env } from './env';
import { db, now, save, type LocalUpload } from './local-db';

/**
 * 附件存储：元数据在本机数据存储的 uploads 表，文件在 <数据目录>/uploads/<id>。
 * id 是 128 位随机数，链接本身就是访问凭证（生成的应用、发布页里的 <img> 不带登录态也能显示）。
 */
const dir = () => join(env.dataDir, 'uploads');
const ID = /^[0-9a-f]{32}$/;

export class UploadError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export const toAttachment = (u: LocalUpload): Attachment => ({ id: u.id, name: u.name, type: u.type, size: u.size, kind: u.kind, url: attachmentUrl(u.id) });

export function saveUpload(user: SessionUser, name: string, bytes: Uint8Array): Attachment {
  const fileName = cleanFileName(name);
  const sniffed = sniffType(bytes, fileName);
  if (!sniffed) throw new UploadError('只支持 PNG / JPEG / GIF / WebP 图片、PDF，以及 txt / md / csv / json 文本文件');
  const limit = maxBytes(sniffed.kind);
  if (bytes.length > limit) {
    const what = sniffed.kind === 'image' ? '图片' : sniffed.kind === 'pdf' ? 'PDF' : '文本文件';
    const max = limit >= 1024 * 1024 ? `${limit / 1024 / 1024} MB` : `${limit / 1024} KB`;
    throw new UploadError(`文件太大：${what}最大 ${max}`, 413);
  }
  if (bytes.length === 0) throw new UploadError('文件是空的');
  const used = db().uploads.filter((u) => u.owner_id === user.id).reduce((n, u) => n + u.size, 0);
  if (used + bytes.length > ATTACHMENT_LIMITS.userBytes) throw new UploadError('附件总量已达上限（200 MB）', 413);

  const id = randomBytes(16).toString('hex');
  mkdirSync(dir(), { recursive: true });
  writeFileSync(join(dir(), id), bytes);
  const u: LocalUpload = { id, owner_id: user.id, name: fileName, type: sniffed.type, kind: sniffed.kind, size: bytes.length, created_at: now() };
  db().uploads.push(u);
  save();
  return toAttachment(u);
}

export function getUpload(id: string): { meta: LocalUpload; bytes: Buffer } | null {
  if (!ID.test(id)) return null;
  const meta = db().uploads.find((u) => u.id === id);
  if (!meta) return null;
  try {
    return { meta, bytes: readFileSync(join(dir(), id)) };
  } catch {
    return null;
  }
}

/** 本轮消息引用的附件：必须是当前用户上传的，最多 4 个 */
export function ownedAttachments(user: SessionUser, ids: unknown): Attachment[] {
  if (!Array.isArray(ids)) return [];
  const list = [...new Set(ids.map(String))].slice(0, ATTACHMENT_LIMITS.perMessage);
  return list.flatMap((id) => {
    const u = ID.test(id) ? db().uploads.find((x) => x.id === id && x.owner_id === user.id) : null;
    return u ? [toAttachment(u)] : [];
  });
}

/** 发给模型的附件内容：图片 / PDF 为 base64，文本为字符串 */
export type ModelAttachment =
  | { kind: 'image' | 'pdf'; name: string; type: string; url: string; base64: string }
  | { kind: 'text'; name: string; type: string; url: string; text: string };

export function loadForModel(atts: Attachment[]): ModelAttachment[] {
  return atts.flatMap((a): ModelAttachment[] => {
    const f = getUpload(a.id);
    if (!f) return [];
    return a.kind === 'text'
      ? [{ kind: 'text' as const, name: a.name, type: a.type, url: a.url, text: f.bytes.toString('utf8') }]
      : [{ kind: a.kind, name: a.name, type: a.type, url: a.url, base64: f.bytes.toString('base64') }];
  });
}
