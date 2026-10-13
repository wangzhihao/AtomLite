'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildPreviewHtml, PREVIEW_SANDBOX, PREVIEW_SOURCE } from '@/lib/shared/preview';
import type { Files } from '@/lib/shared/types';

export type PreviewIssue = { kind: 'runtime' | 'console' | 'blank'; message: string };

const storageKey = (projectId: string) => `atoms:kv:${projectId}`;

function readStorage(projectId: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(storageKey(projectId)) || '{}');
  } catch {
    return {};
  }
}

function writeStorage(projectId: string, kv: Record<string, string>) {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(kv));
  } catch {
    /* 父页面存储不可用时只保留在内存里 */
  }
}

/**
 * 沙箱预览（设计文档第 6 节）：srcdoc + 不含 allow-same-origin 的 sandbox。
 * 只接受 source 为 atoms-preview 且来自当前 iframe 的消息；应用的 localStorage 写入同步到父页面按项目持久化。
 */
export function Preview({
  projectId,
  files,
  reloadKey,
  device,
  overlay,
  onIssue,
  fullscreen = false,
}: {
  projectId: string;
  files: Files | null;
  reloadKey: number;
  device: 'desktop' | 'mobile';
  overlay?: string | null;
  onIssue?: (issue: PreviewIssue) => void;
  fullscreen?: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const onIssueRef = useRef(onIssue);
  onIssueRef.current = onIssue;
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);

  const html = useMemo(() => {
    if (!files || !origin) return null;
    return buildPreviewHtml(files, { vendorBase: `${origin}/vendor`, storage: readStorage(projectId) });
    // reloadKey 变化时重新读取存储并重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, origin, projectId, reloadKey]);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const msg = e.data as { source?: string; type?: string; data?: Record<string, unknown> };
      if (!msg || msg.source !== PREVIEW_SOURCE) return;
      const d = msg.data ?? {};
      switch (msg.type) {
        case 'storage_set': {
          const kv = readStorage(projectId);
          kv[String(d.key)] = String(d.value);
          writeStorage(projectId, kv);
          break;
        }
        case 'storage_remove': {
          const kv = readStorage(projectId);
          delete kv[String(d.key)];
          writeStorage(projectId, kv);
          break;
        }
        case 'storage_clear':
          writeStorage(projectId, {});
          break;
        case 'runtime_error':
          onIssueRef.current?.({ kind: 'runtime', message: String(d.message ?? '未知错误') });
          break;
        case 'console_error':
          onIssueRef.current?.({ kind: 'console', message: String(d.message ?? '') });
          break;
        case 'rendered':
          if (d.empty) onIssueRef.current?.({ kind: 'blank', message: '页面渲染后是空白的（根节点没有内容）' });
          break;
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [projectId]);

  return (
    <div className={`relative flex h-full w-full justify-center overflow-auto ${fullscreen ? 'bg-white' : 'bg-slate-100'}`}>
      {html ? (
        <iframe
          ref={frame}
          key={reloadKey}
          title="preview"
          data-testid="preview-frame"
          sandbox={PREVIEW_SANDBOX}
          srcDoc={html}
          className={`shrink-0 border-0 bg-white ${
            device === 'mobile' ? 'my-4 h-[calc(100%-2rem)] w-[375px] rounded-[1.5rem] shadow-xl ring-8 ring-slate-800' : 'h-full w-full'
          }`}
        />
      ) : (
        <div className="grid h-full w-full place-items-center p-8 text-center text-sm text-slate-400" data-testid="preview-empty">
          {overlay ? '' : '还没有生成内容。在左侧描述你想要的应用吧。'}
        </div>
      )}
      {overlay && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-white/60 backdrop-blur-[1px]" data-testid="preview-overlay">
          <div className="flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm text-slate-600 shadow">
            <span className="h-2 w-2 animate-pulse rounded-full bg-brand-500" />
            {overlay}
          </div>
        </div>
      )}
    </div>
  );
}
