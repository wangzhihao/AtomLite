import 'server-only';

export const env = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  authSecret: process.env.AUTH_SECRET ?? 'atoms-lite-dev-secret',
  dataDir: process.env.ATOMS_DATA_DIR ?? '.data',
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
  strongModel: process.env.ATOMS_STRONG_MODEL ?? 'claude-opus-5-5',
  effort: (process.env.ATOMS_EFFORT ?? 'medium') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  priceIn: Number(process.env.ATOMS_PRICE_IN ?? 4),
  priceOut: Number(process.env.ATOMS_PRICE_OUT ?? 20),
  priceCacheRead: Number(process.env.ATOMS_PRICE_CACHE_READ ?? 0.2),
  /** Mock LLM 每个分块之间的延迟（毫秒） */
  mockDelayMs: Number(process.env.ATOMS_MOCK_DELAY_MS ?? 15),
};

export const useSupabase = () => Boolean(env.supabaseUrl && env.supabaseAnonKey);
export const useMockLLM = () => !env.anthropicKey;
