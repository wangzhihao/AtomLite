import 'server-only';

export const env = {
  authSecret: process.env.AUTH_SECRET ?? 'atoms-lite-dev-secret',
  dataDir: process.env.ATOMS_DATA_DIR ?? '.data',
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
  strongModel: process.env.ATOMS_STRONG_MODEL ?? 'claude-opus-5-5',
  fastModel: process.env.ATOMS_FAST_MODEL ?? 'claude-haiku-5-5',
  effort: (process.env.ATOMS_EFFORT ?? 'medium') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  /** 每百万 token 美元单价 */
  prices: {
    strong: {
      in: Number(process.env.ATOMS_PRICE_IN ?? 4),
      out: Number(process.env.ATOMS_PRICE_OUT ?? 20),
      cacheRead: Number(process.env.ATOMS_PRICE_CACHE_READ ?? 0.2),
    },
    fast: {
      in: Number(process.env.ATOMS_FAST_PRICE_IN ?? 0.1),
      out: Number(process.env.ATOMS_FAST_PRICE_OUT ?? 0.5),
      cacheRead: Number(process.env.ATOMS_FAST_PRICE_CACHE_READ ?? 0.01),
    },
  },
  /** 模型多久没有输出时提示“响应较慢”（毫秒） */
  stallWarnMs: Number(process.env.ATOMS_STALL_WARN_MS ?? 20_000),
  /** Mock LLM 遇到 [stall] 标记时停顿多久（毫秒），用于测试慢响应提示 */
  mockStallMs: Number(process.env.ATOMS_MOCK_STALL_MS ?? 6000),
  /** Mock LLM 每个分块之间的延迟（毫秒） */
  mockDelayMs: Number(process.env.ATOMS_MOCK_DELAY_MS ?? 15),
};

export const useMockLLM = () => !env.anthropicKey;
