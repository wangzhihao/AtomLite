export type Files = Record<string, string>;

export type Project = {
  id: string;
  owner_id: string;
  name: string;
  current_version_id: string | null;
  published_slug: string | null;
  published_version_id: string | null;
  remixed_from: string | null;
  created_at: string;
  updated_at: string;
};

export type VersionSource = 'agent' | 'autofix' | 'restore' | 'remix';

export type Version = {
  id: string;
  project_id: string;
  seq: number;
  files: Files;
  summary: string | null;
  source: VersionSource;
  verified: boolean | null;
  run_id: string | null;
  created_at: string;
};

export type VersionMeta = Omit<Version, 'files'>;

export type MessageRole = 'user' | 'agent' | 'system';
export type AgentId = 'leader' | 'planner' | 'designer' | 'engineer' | 'fixer' | 'advisor' | 'qa';

export type Message = {
  id: string;
  project_id: string;
  role: MessageRole;
  agent: AgentId | null;
  content: string;
  meta: Record<string, unknown> | null;
  version_id: string | null;
  created_at: string;
};

export type RunIntent = 'create' | 'edit' | 'fix';
/** needs_input：Planner 发起了需求澄清，本轮不生成代码 */
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'needs_input';

export type Run = {
  id: string;
  project_id: string;
  user_id: string;
  intent: RunIntent | null;
  status: RunStatus;
  model: string | null;
  first_pass: boolean | null;
  fix_rounds: number;
  final_ok: boolean | null;
  error_kinds: string[] | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

export type SessionUser = { id: string; email: string | null; is_anonymous: boolean };

export type Usage = { inputTokens: number; outputTokens: number; costUsd: number; fixRounds?: number };

/** Planner 的规格 JSON */
export type Spec = {
  appName: string;
  summary?: string;
  features: string[];
  components?: string[];
  files?: string[];
  dataModel?: string;
  style?: string;
  assumptions?: string[];
};

export type ClarifyQuestion = { id: string; question: string; placeholder?: string };

/** 运行检查发现的问题 */
export type ErrorKind = 'syntax' | 'runtime' | 'console' | 'blank' | 'qa';
export type CheckError = { kind: ErrorKind; message: string; file?: string; line?: number | null };

/** 团队配置：可选角色的开关（Kai、Max 必需） */
export type TeamConfig = { planner: boolean; designer: boolean; advisor: boolean; qa: boolean };
export const DEFAULT_TEAM: TeamConfig = { planner: true, designer: true, advisor: true, qa: false };

/** 验收 QA：声明式交互步骤，在沙箱 iframe 内执行 */
export type QAStep =
  | { action: 'fill'; target: string; value: string }
  | { action: 'click'; target: string }
  | { action: 'expectText'; text: string }
  | { action: 'expectVisible'; target: string }
  | { action: 'wait'; ms: number };
export type QATest = { feature: string; steps: QAStep[] };
export type QAResult = { feature: string; ok: boolean; error?: string };

/** SSE 事件协议（设计文档第 8 节） */
export type AgentEvent =
  | { event: 'run_started'; data: { runId: string; intent: RunIntent } }
  | { event: 'agent_started'; data: { agent: AgentId } }
  | { event: 'message_delta'; data: { agent: AgentId; text: string } }
  | { event: 'file_started'; data: { path: string; agent?: AgentId } }
  | { event: 'file_done'; data: { path: string; bytes: number; content: string; agent?: AgentId } }
  | { event: 'version_created'; data: { versionId: string; seq: number; deleted: string[]; messageId: string } }
  | { event: 'run_finished'; data: { status: RunStatus; usage: Usage } }
  | { event: 'error'; data: { code: string; message: string } }
  | { event: 'plan'; data: { spec: Spec } }
  | { event: 'design'; data: { design: Record<string, unknown> } }
  | { event: 'clarify'; data: { questions: ClarifyQuestion[] } }
  | { event: 'check_failed'; data: { errors: CheckError[]; round: number } }
  | { event: 'suggestions'; data: { items: string[] } };

export const LIMITS = {
  messageChars: 4000,
  totalFileBytes: 200 * 1024,
  maxFiles: 6,
  recentMessages: 6,
  maxOutputTokens: 16000,
  runsPerHourUser: 20,
  runsPerDayGuest: 10,
  /** 同一个 run 内自动修复的最大轮数（服务端检查 + 运行时检查合计） */
  maxFixRounds: 2,
  /** 一个 run 含修复的总 token 预算 */
  runTokenBudget: 60_000,
} as const;
