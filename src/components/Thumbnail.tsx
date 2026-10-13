'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildPreviewHtml } from '@/lib/shared/preview';
import type { Files } from '@/lib/shared/types';

const W = 800;
const H = 500;

/**
 * 应用缩略图：进入视口后才加载文件，在只读的沙箱 iframe 里按桌面宽度渲染再整体缩小。
 * 只给 allow-scripts（不能弹窗、不能提交表单），存储不回写，不接收任何消息。
 */
export function Thumbnail({ load, fallback }: { load: () => Promise<Files | null>; fallback: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [files, setFiles] = useState<Files | null | undefined>(undefined);
  const [scale, setScale] = useState(0.25);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: '200px' });
    io.observe(el);
    const ro = new ResizeObserver(() => setScale(el.clientWidth / W));
    ro.observe(el);
    return () => {
      io.disconnect();
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    loadRef.current().then(
      (f) => !cancelled && setFiles(f),
      () => !cancelled && setFiles(null),
    );
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const html = useMemo(
    () => (files ? buildPreviewHtml(files, { vendorBase: `${window.location.origin}/vendor`, persist: false }) : null),
    [files],
  );

  return (
    <div ref={box} className="relative aspect-[16/10] w-full overflow-hidden rounded-lg bg-gradient-to-br from-brand-50 to-slate-100" data-testid="thumbnail">
      {html ? (
        <iframe
          title="缩略图"
          aria-hidden
          tabIndex={-1}
          sandbox="allow-scripts"
          srcDoc={html}
          loading="lazy"
          className="pointer-events-none absolute left-0 top-0 origin-top-left border-0 bg-white"
          style={{ width: W, height: H, transform: `scale(${scale})` }}
          data-testid="thumb-frame"
        />
      ) : (
        <div className={`grid h-full place-items-center text-2xl font-bold text-brand-600 ${files === undefined && visible ? 'skeleton' : ''}`}>
          {files === undefined && visible ? '' : fallback}
        </div>
      )}
    </div>
  );
}
