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
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

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

export type Usage = { inputTokens: number; outputTokens: number; costUsd: number };

/** SSE 事件协议（设计文档第 8 节） */
export type AgentEvent =
  | { event: 'run_started'; data: { runId: string; intent: RunIntent } }
  | { event: 'agent_started'; data: { agent: AgentId } }
  | { event: 'message_delta'; data: { agent: AgentId; text: string } }
  | { event: 'file_started'; data: { path: string } }
  | { event: 'file_done'; data: { path: string; bytes: number; content: string } }
  | { event: 'version_created'; data: { versionId: string; seq: number; deleted: string[]; messageId: string } }
  | { event: 'run_finished'; data: { status: RunStatus; usage: Usage } }
  | { event: 'error'; data: { code: string; message: string } };

export const LIMITS = {
  messageChars: 4000,
  totalFileBytes: 200 * 1024,
  maxFiles: 6,
  recentMessages: 6,
  maxOutputTokens: 16000,
  runsPerHourUser: 20,
  runsPerDayGuest: 10,
} as const;
