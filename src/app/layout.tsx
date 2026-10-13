import type { Metadata } from 'next';
import './globals.css';
import { Header } from '@/components/Header';

export const metadata: Metadata = {
  title: 'Atoms Lite — 一句话生成 Web 应用',
  description: '用一句话需求驱动 AI 团队生成 Web 应用，实时预览，多轮迭代。',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="flex h-full flex-col antialiased">
        <Header />
        <div className="min-h-0 flex-1">{children}</div>
      </body>
    </html>
  );
}
