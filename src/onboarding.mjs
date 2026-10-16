import fs from 'node:fs';
import { PATHS, PERSON_ID, loadSettings } from './config.mjs';
import { loadState, mutateState } from './state.mjs';

const providers = new Set(['qianwen', 'doubao', 'deepseek']);

// Persist with account/progress data: an app update or port change isn't first use.
export function getOnboarding() {
  const state = loadState();
  if (state.onboarding?.version === 1) return { ...state.onboarding };
  const used = !!PERSON_ID || fs.existsSync(PATHS.taskReport)
    || Object.keys(state.taskPoints || {}).length > 0
    || (state.reviewQueue || []).length > 0 || Object.keys(state.quizzes || {}).length > 0;
  const now = new Date().toISOString();
  const record = {
    version: 1, startedAt: now, completedAt: used ? now : null, migrated: used,
  };
  // Existing installations don't need a write just to suppress the welcome UI.
  if (used) return record;
  return mutateState(s => (s.onboarding = record));
}

export function completeOnboarding(body, status) {
  if (!body || body.action !== 'complete' || !providers.has(body.provider)) throw new Error('请选择有效的做题 AI');
  if (status.running || status.reconRunning) throw new Error('请先停止任务或等待扫描完成');
  if (!status.login?.loggedIn) throw new Error('请先检测学习通登录状态');
  if (loadSettings().ai.provider !== body.provider) throw new Error('请先保存所选 AI');
  getOnboarding();
  return mutateState(s => (s.onboarding = {
    ...s.onboarding, version: 1, completedAt: new Date().toISOString(), provider: body.provider,
  }));
}
