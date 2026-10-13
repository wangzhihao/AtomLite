import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 自包含的服务端产物，便于在 EC2 等机器上直接 node server.js 运行
  output: 'standalone',
  // 本地存储模式把数据写到 .data/，不需要被打包
  outputFileTracingExcludes: { '*': ['.data/**'] },
  // CI 里由单独的 typecheck 步骤负责类型检查，构建时跳过以便一次跑完所有步骤
  typescript: { ignoreBuildErrors: process.env.ATOMS_SKIP_BUILD_TYPECHECK === '1' },
};

export default nextConfig;
