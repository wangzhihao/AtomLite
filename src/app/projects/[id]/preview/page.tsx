'use client';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Preview } from '@/components/Preview';
import { api } from '@/lib/client/api';
import type { Version } from '@/lib/shared/types';

/** 新窗口全屏预览当前版本（仍在沙箱 iframe 中运行） */
export default function FullPreview() {
  const { id } = useParams<{ id: string }>();
  const [version, setVersion] = useState<Version | null | undefined>(undefined);
  useEffect(() => {
    api<{ version: Version | null }>(`/api/projects/${id}`).then((d) => setVersion(d.version), () => setVersion(null));
  }, [id]);
  return (
    <div className="fixed inset-0 z-50 bg-white">
      {version === undefined ? null : <Preview projectId={id} files={version?.files ?? null} reloadKey={0} device="desktop" fullscreen />}
    </div>
  );
}
