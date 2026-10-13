/**
 * 附件（设计文档第 2、3、8 节）：用户在对话里上传图片、PDF 或文本文件给团队看，
 * 图片也可以直接放进生成的应用里使用。类型按文件内容识别，不信任文件名和浏览器给的类型。
 */
export type AttachmentKind = 'image' | 'pdf' | 'text';
export type Attachment = { id: string; name: string; type: string; size: number; kind: AttachmentKind; url: string };

export const ATTACHMENT_LIMITS = {
  perMessage: 4,
  imageBytes: 5 * 1024 * 1024,
  pdfBytes: 10 * 1024 * 1024,
  textBytes: 200 * 1024,
  /** 每个用户的附件总量 */
  userBytes: 200 * 1024 * 1024,
} as const;

export const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,.txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json';

const TEXT_EXT = /\.(txt|md|markdown|csv|json)$/i;

/** 按魔数识别类型；文本文件要求扩展名正确且内容是合法 UTF-8、没有 NUL。SVG 一律拒绝（可内嵌脚本）。 */
export function sniffType(bytes: Uint8Array, name: string): { type: string; kind: AttachmentKind } | null {
  const b = (i: number) => bytes[i];
  const starts = (sig: number[]) => sig.every((v, i) => b(i) === v);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { type: 'image/png', kind: 'image' };
  if (starts([0xff, 0xd8, 0xff])) return { type: 'image/jpeg', kind: 'image' };
  if (starts([0x47, 0x49, 0x46, 0x38])) return { type: 'image/gif', kind: 'image' };
  if (starts([0x52, 0x49, 0x46, 0x46]) && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return { type: 'image/webp', kind: 'image' };
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return { type: 'application/pdf', kind: 'pdf' };
  if (TEXT_EXT.test(name) && !/\.svg$/i.test(name)) {
    if (bytes.includes(0)) return null;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
    const ext = name.split('.').pop()!.toLowerCase();
    const type = ext === 'json' ? 'application/json' : ext === 'csv' ? 'text/csv' : ext === 'md' || ext === 'markdown' ? 'text/markdown' : 'text/plain';
    return { type, kind: 'text' };
  }
  return null;
}

export function maxBytes(kind: AttachmentKind) {
  return kind === 'image' ? ATTACHMENT_LIMITS.imageBytes : kind === 'pdf' ? ATTACHMENT_LIMITS.pdfBytes : ATTACHMENT_LIMITS.textBytes;
}

export const attachmentUrl = (id: string) => `/api/uploads/${id}`;

export function cleanFileName(name: string) {
  return (name.replace(/[\\/\u0000-\u001f]/g, '_').trim() || 'file').slice(0, 120);
}
