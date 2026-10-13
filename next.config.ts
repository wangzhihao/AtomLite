import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 本地存储模式把数据写到 .data/，不需要被打包
  outputFileTracingExcludes: { '*': ['.data/**'] },
};

export default nextConfig;
