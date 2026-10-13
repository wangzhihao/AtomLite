'use client';
import { useEffect, useMemo, useRef } from 'react';
import { buildPreviewHtml, PARENT_SOURCE, PREVIEW_SANDBOX, PREVIEW_SOURCE } from '@/lib/shared/preview';
import type { Files, QAResult, QATest } from '@/lib/shared/types';

const QA_TIMEOUT_MS = 30_000;

/**
 * 验收执行器：在屏幕外的独立沙箱 iframe 里运行同一版本（存储从空开始、不回写），
 * 渲染完成后下发声明式测试，收集结果。不会影响用户在预览里的数据。
 */
export function QARunner({ files, tests, onDone }: { files: Files; tests: QATest[]; onDone: (results: QAResult[]) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const done = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const html = useMemo(() => buildPreviewHtml(files, { vendorBase: `${window.location.origin}/vendor`, qa: true }), [files]);

  useEffect(() => {
    const finish = (results: QAResult[]) => {
      if (done.current) return;
      done.current = true;
      onDoneRef.current(results);
    };
    function onMessage(e: MessageEvent) {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win) return;
      const msg = e.data as { source?: string; type?: string; data?: { results?: QAResult[] } };
      if (msg?.source !== PREVIEW_SOURCE) return;
      if (msg.type === 'rendered') win.postMessage({ source: PARENT_SOURCE, type: 'run_qa', tests }, '*');
      if (msg.type === 'qa_result') finish(msg.data?.results ?? []);
    }
    window.addEventListener('message', onMessage);
    const timer = setTimeout(() => finish(tests.map((t) => ({ feature: t.feature, ok: false, error: '验收超时' }))), QA_TIMEOUT_MS);
    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
    };
  }, [tests]);

  return (
    <iframe
      ref={frame}
      title="qa"
      aria-hidden
      tabIndex={-1}
      sandbox={PREVIEW_SANDBOX}
      srcDoc={html}
      style={{ position: 'fixed', left: -10000, top: 0, width: 1024, height: 768, border: 0 }}
      data-testid="qa-frame"
    />
  );
}
