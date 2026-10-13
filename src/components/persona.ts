import type { AgentId } from '@/lib/shared/types';

/** 团队成员人设（设计文档第 5 节）：名字首字母 + 角色色块，自绘头像 */
export const PERSONAS: Record<AgentId, { name: string; title: string; color: string }> = {
  leader: { name: 'Leo', title: '团队负责人', color: '#1e3a8a' },
  planner: { name: 'Nora', title: '规划', color: '#7c3aed' },
  designer: { name: 'Mia', title: '设计', color: '#db2777' },
  engineer: { name: 'Kai', title: '工程师', color: '#16a34a' },
  fixer: { name: 'Max', title: '修复', color: '#ea580c' },
  advisor: { name: 'Sage', title: '建议', color: '#0891b2' },
  qa: { name: 'Quinn', title: '验收', color: '#64748b' },
};
