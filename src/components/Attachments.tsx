'use client';
import { useEffect, useRef, useState } from 'react';
import { ACCEPT, ATTACHMENT_LIMITS, type Attachment } from '@/lib/shared/attachments';

/** 输入框里待发送的附件：上传中 / 已上传 / 失败 */
export type PendingAttachment = {
  key: string;
  name: string;
  status: 'uploading' | 'done' | 'error';
  /** 上传进度 0–1；compressing 表示正在本地压缩 */
  progress?: number;
  compressing?: boolean;
  error?: string;
  att?: Attachment;
  preview?: string;
};

/** 模型看图时会把长边缩到约 1568 像素，更大的图只会让上传和推理更慢 */
const MAX_SIDE = 1568;

/**
 * 上传前在浏览器里压缩大图：长边超过 1568 或文件超过 1 MB 的 PNG / JPEG / WebP 缩到 1568 以内
 * （PNG 转 WebP 保留透明，其余转 JPEG），压完反而更大就用原图。GIF 可能是动图，不处理。
 */
export async function shrinkImage(file: File): Promise<File> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return file;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return file;
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size <= 1024 * 1024) return file;
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  const keepAlpha = file.type === 'image/png';
  if (!keepAlpha) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const type = keepAlpha ? 'image/webp' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.88));
  if (!blob || blob.size >= file.size) return file;
  const ext = blob.type === 'image/webp' ? 'webp' : blob.type === 'image/png' ? 'png' : 'jpg';
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.' + ext, { type: blob.type });
}

/** 用 XHR 上传，才能拿到上传进度（fetch 拿不到） */
function upload(file: File, onProgress: (p: number) => void): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/uploads');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: { attachment?: Attachment; error?: { message?: string } } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* 非 JSON 响应 */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.attachment) resolve(data.attachment);
      else reject(new Error(data.error?.message ?? `上传失败（${xhr.status}）`));
    };
    xhr.onerror = () => reject(new Error('网络中断，上传失败'));
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
}

/**
 * 附件状态：选择、粘贴、拖拽都走 add()；文件选中后立即上传，发送时只带已上传成功的附件。
 * beforeUpload：首页还没登录时先以游客身份登录。
 */
export function useAttachments(beforeUpload?: () => Promise<unknown>) {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => () => itemsRef.current.forEach((i) => i.preview && URL.revokeObjectURL(i.preview)), []);

  async function add(files: FileList | File[] | null | undefined) {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    const room = ATTACHMENT_LIMITS.perMessage - itemsRef.current.filter((i) => i.status !== 'error').length;
    const accepted = list.slice(0, Math.max(0, room));
    const rejected = list.slice(accepted.length);
    const added: PendingAttachment[] = accepted.map((f, n) => ({
      key: `${Date.now()}-${n}-${f.name}`,
      name: f.name || '粘贴的图片.png',
      status: 'uploading',
      progress: 0,
      compressing: f.type.startsWith('image/'),
      preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
    }));
    const overflow: PendingAttachment[] = rejected.map((f, n) => ({
      key: `${Date.now()}-x${n}`,
      name: f.name,
      status: 'error',
      error: `每条消息最多 ${ATTACHMENT_LIMITS.perMessage} 个附件`,
    }));
    setItems((s) => [...s, ...added, ...overflow]);
    try {
      await beforeUpload?.();
    } catch {
      /* 由上传报错 */
    }
    await Promise.all(
      accepted.map(async (f, n) => {
        const key = added[n].key;
        const patch = (p: Partial<PendingAttachment>) => setItems((s) => s.map((i) => (i.key === key ? { ...i, ...p } : i)));
        try {
          const small = await shrinkImage(f);
          patch({ compressing: false });
          const att = await upload(small, (p) => patch({ progress: p }));
          setItems((s) => s.map((i) => (i.key === key ? { ...i, status: 'done', att } : i)));
        } catch (e) {
          setItems((s) => s.map((i) => (i.key === key ? { ...i, status: 'error', error: e instanceof Error ? e.message : String(e) } : i)));
        }
      }),
    );
  }

  return {
    items,
    add,
    remove: (key: string) => setItems((s) => s.filter((i) => i.key !== key)),
    clear: () => setItems([]),
    uploading: items.some((i) => i.status === 'uploading'),
    ready: items.flatMap((i) => (i.status === 'done' && i.att ? [i.att] : [])),
    /** 粘贴图片 */
    onPaste: (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length) {
        e.preventDefault();
        void add(files);
      }
    },
    /** 拖拽文件到输入区域 */
    dropProps: {
      onDragOver: (e: React.DragEvent) => {
        if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
      },
      onDrop: (e: React.DragEvent) => {
        if (e.dataTransfer?.files?.length) {
          e.preventDefault();
          void add(e.dataTransfer.files);
        }
      },
    },
  };
}

export function AttachButton({ onFiles, disabled }: { onFiles: (f: FileList | null) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        className="rounded-lg px-2 py-1 text-lg leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40"
        title="添加附件：图片、PDF、文本（也可以直接粘贴或拖进来）"
        aria-label="添加附件"
        data-testid="attach"
      >
        📎
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        data-testid="attach-input"
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );
}

/** 输入框上方的待发送附件 */
export function AttachmentTray({ items, onRemove }: { items: PendingAttachment[]; onRemove: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <ul className="mb-2 flex flex-wrap gap-2" data-testid="attach-tray">
      {items.map((i) => (
        <li
          key={i.key}
          className={`flex max-w-[220px] items-center gap-2 rounded-lg border px-2 py-1 text-xs ${i.status === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-slate-200 bg-slate-50 text-slate-600'}`}
          data-testid="attach-chip"
          data-status={i.status}
          title={i.error ?? i.name}
        >
          {i.preview ? <img src={i.preview} alt="" className="h-8 w-8 shrink-0 rounded object-cover" /> : <span className="text-base">📄</span>}
          <span className="min-w-0 flex-1">
            <span className="block truncate">{i.name}</span>
            <span className="block truncate text-[10px] opacity-70" data-testid="attach-chip-status">
              {i.status === 'uploading'
                ? i.compressing
                  ? '压缩中…'
                  : `上传中 ${Math.round((i.progress ?? 0) * 100)}%`
                : i.status === 'error'
                  ? i.error
                  : `已上传${i.att ? ` · ${i.att.size >= 1024 * 1024 ? `${(i.att.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(i.att.size / 1024))} KB`}` : ''}`}
            </span>
          </span>
          <button type="button" onClick={() => onRemove(i.key)} className="shrink-0 text-slate-400 hover:text-slate-700" aria-label={`移除 ${i.name}`}>
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 消息里的附件：图片显示缩略图，其他显示文件名，点击在新窗口打开 */
export function AttachmentList({ atts, onDark = false }: { atts: Attachment[]; onDark?: boolean }) {
  if (!atts?.length) return null;
  return (
    <div className="mt-1 flex flex-wrap justify-end gap-1.5" data-testid="message-attachments">
      {atts.map((a) =>
        a.kind === 'image' ? (
          <a key={a.id} href={a.url} target="_blank" rel="noreferrer" title={a.name} data-testid="message-attachment">
            <img src={a.url} alt={a.name} className="h-20 w-20 rounded-lg border border-slate-200 object-cover" />
          </a>
        ) : (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noreferrer"
            className={`flex items-center gap-1 rounded-lg px-2 py-1 text-xs ${onDark ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600'}`}
            data-testid="message-attachment"
          >
            📄 <span className="max-w-[160px] truncate">{a.name}</span>
          </a>
        ),
      )}
    </div>
  );
}
