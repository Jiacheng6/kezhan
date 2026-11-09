import fs from 'node:fs';
import { PATHS, PERSON_ID, loadSettings } from './config.mjs';
import { loadState, mutateState } from './state.mjs';
import {PLATFORMS,enabledPlatformIds,assertPlatformChange,platformBusy} from './ui/platforms.js';

const providers = new Set(['qianwen', 'doubao', 'deepseek','api']);

// Version 2 introduces the embedded-web setup. Legacy completion only covered
// external-browser accounts, so upgrades need this guide once as well.
const ONBOARDING_VERSION = 3;
export function getOnboarding() {
  const state = loadState();
  if (state.onboarding?.version === ONBOARDING_VERSION) return { ...state.onboarding };
  const used = !!PERSON_ID || fs.existsSync(PATHS.taskReport)
    || Object.keys(state.taskPoints || {}).length > 0
    || (state.reviewQueue || []).length > 0 || Object.keys(state.quizzes || {}).length > 0;
  const now = new Date().toISOString();
  if(state.onboarding?.version===2&&state.onboarding.completedAt)return mutateState(s=>(s.onboarding={...s.onboarding,version:ONBOARDING_VERSION,platforms:enabledPlatformIds(loadSettings()),aiWanted:true}));
  const record = {
    version: ONBOARDING_VERSION, startedAt: now, completedAt: null,
    migrated: used || !!state.onboarding,
  };
  // Course lists and progress are not proof that embedded login setup completed.
  return mutateState(s => (s.onboarding = record));
}

export function completeOnboarding(body, status) {
  if (!body || body.action !== 'complete') throw new Error('无效的向导操作');
  if(!Array.isArray(body.platforms)||!body.platforms.length||new Set(body.platforms).size!==body.platforms.length||body.platforms.some(id=>!Object.hasOwn(PLATFORMS,id)))throw Error('请至少选择一个学习平台');
  const before=loadSettings(),platforms=Object.fromEntries(Object.keys(PLATFORMS).map(id=>[id,body.platforms.includes(id)]));
  assertPlatformChange(before,{...before,platforms},status);
  if(Object.keys(PLATFORMS).some(id=>platformBusy(status,id)))throw Error('请先停止任务或等待扫描完成');
  const aiWanted=body.aiWanted===true&&body.platforms.some(id=>id!=='welearn');
  if(aiWanted&&(!providers.has(body.provider)||before.ai.provider!==body.provider))throw Error('请先保存有效的做题 AI');
  getOnboarding();
  return mutateState(s => {s.settings||={};s.settings.platforms=platforms;return s.onboarding={
    ...s.onboarding, version: ONBOARDING_VERSION, completedAt: new Date().toISOString(),platforms:body.platforms,aiWanted,...(aiWanted?{provider:body.provider}:{}),
  };});
}
