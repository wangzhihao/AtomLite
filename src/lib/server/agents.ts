import 'server-only';
import type { AgentId, CheckError, Files, Message, RunIntent, Spec, TeamConfig } from '@/lib/shared/types';
import { LIMITS } from '@/lib/shared/types';
import type { ModelTier } from './llm';
import {
  ADVISOR_SYSTEM,
  buildAdvisorInput,
  buildDesignerInput,
  buildEngineerInput,
  buildFixerInput,
  buildPlannerInput,
  buildQAInput,
  DESIGNER_SYSTEM,
  ENGINEER_SYSTEM,
  FIXER_SYSTEM,
  PLANNER_SYSTEM,
  QA_SYSTEM,
} from './prompts';

/**
 * Agent 角色注册表（设计文档第 5 节）：每个角色是一条声明式配置，编排器按 stage 顺序执行、按 enabled 开关跳过。
 * 新增一个 Agent 只需在这里注册一条配置和一个 prompt，不改编排逻辑。
 */
export type RunContext = {
  intent: RunIntent;
  instruction: string;
  files: Files;
  history: Message[];
  spec: Spec | null;
  allowClarify: boolean;
  errors: CheckError[];
  summary: string;
};

export type PromptInput = { system: string; input: string; maxTokens: number };

export type AgentRole = {
  id: Exclude<AgentId, 'leader'>;
  /** verify：在浏览器运行检查通过之后，由前端发起 */
  stage: 'plan' | 'design' | 'build' | 'repair' | 'after' | 'verify';
  intents: RunIntent[];
  model: ModelTier;
  buildPrompt: (ctx: RunContext) => PromptInput;
  output: 'json' | 'files' | 'suggestions';
  enabled: boolean;
};

const flag = (name: string, def = true) => {
  const v = process.env[`ATOMS_AGENT_${name.toUpperCase()}`];
  return v === undefined ? def : v !== '0' && v !== 'false';
};

export const ROLES: AgentRole[] = [
  {
    id: 'planner',
    stage: 'plan',
    intents: ['create'],
    model: 'fast',
    output: 'json',
    enabled: flag('planner'),
    buildPrompt: (ctx) => ({
      system: PLANNER_SYSTEM,
      input: buildPlannerInput({ instruction: ctx.instruction, allowClarify: ctx.allowClarify, history: ctx.history }),
      maxTokens: 4000,
    }),
  },
  {
    id: 'designer',
    stage: 'design',
    intents: ['create'],
    model: 'fast',
    output: 'json',
    enabled: flag('designer'),
    buildPrompt: (ctx) => ({
      system: DESIGNER_SYSTEM,
      input: buildDesignerInput({ spec: ctx.spec ?? { appName: '', features: [] }, instruction: ctx.instruction }),
      maxTokens: 3000,
    }),
  },
  {
    id: 'engineer',
    stage: 'build',
    intents: ['create', 'edit'],
    model: 'strong',
    output: 'files',
    enabled: true,
    buildPrompt: (ctx) => ({
      system: ENGINEER_SYSTEM,
      input: buildEngineerInput({ instruction: ctx.instruction, files: ctx.files, history: ctx.history, spec: ctx.spec }),
      maxTokens: LIMITS.maxOutputTokens,
    }),
  },
  {
    id: 'fixer',
    stage: 'repair',
    intents: ['fix'],
    model: 'strong',
    output: 'files',
    enabled: true,
    buildPrompt: (ctx) => ({
      system: FIXER_SYSTEM,
      input: buildFixerInput({ errors: ctx.errors, files: ctx.files }),
      maxTokens: LIMITS.maxOutputTokens,
    }),
  },
  {
    id: 'advisor',
    stage: 'after',
    intents: ['create', 'edit', 'fix'],
    model: 'fast',
    output: 'suggestions',
    enabled: flag('advisor'),
    buildPrompt: (ctx) => ({
      system: ADVISOR_SYSTEM,
      input: buildAdvisorInput({ spec: ctx.spec, summary: ctx.summary, history: ctx.history }),
      maxTokens: 1500,
    }),
  },
  {
    id: 'qa',
    stage: 'verify',
    intents: ['create', 'edit', 'fix'],
    model: 'strong',
    output: 'json',
    enabled: flag('qa'),
    buildPrompt: (ctx) => ({ system: QA_SYSTEM, input: buildQAInput({ spec: ctx.spec, files: ctx.files }), maxTokens: 4000 }),
  },
];

export function role(id: AgentRole['id']) {
  return ROLES.find((r) => r.id === id)!;
}

/** 某条路径上、某个阶段启用的角色；team 是用户在团队配置面板里的开关 */
export function rolesFor(intent: RunIntent, stage: AgentRole['stage'], team?: Partial<TeamConfig>) {
  return ROLES.filter(
    (r) => r.enabled && r.stage === stage && r.intents.includes(intent) && (team?.[r.id as keyof TeamConfig] ?? true) !== false,
  );
}
