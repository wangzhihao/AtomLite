'use client';
import { useEffect, useRef, useState } from 'react';
import { ACCEPT, ATTACHMENT_LIMITS, type Attachment } from '@/lib/shared/attachments';

/** 输入框里待发送的附件：上传中 / 已上传 / 失败 */
export type PendingAttachment = { key: string; name: string; status: 'uploading' | 'done' | 'error'; error?: string; att?: Attachment; preview?: string };

async function upload(file: File): Promise<Attachment> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/uploads', { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: { message?: string } }).error?.message ?? `上传失败（${res.status}）`);
  return (data as { attachment: Attachment }).attachment;
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
        try {
          const att = await upload(f);
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
            <span className="block truncate text-[10px] opacity-70">{i.status === 'uploading' ? '上传中…' : i.status === 'error' ? i.error : '已上传'}</span>
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
