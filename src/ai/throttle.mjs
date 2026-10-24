/**
 * AI提问节流器（防触发风控）。
 *
 * 背景：实测一小时内连续几十次自动化提问会触发阿里 baxia 风控，
 * 要求人工滑块验证；此时页面永远停在"接收中"，整条答题链路就断了。
 *
 * 策略：
 *   1) 两次提问之间强制最小间隔 + 随机抖动（避免固定节奏像机器）
 *   2) 遇到"卡在生成中"→ 进入长时间冷却
 *   3) 连续失败达到上限 → 报告需要人工介入，由上层暂停
 */
import { loadSettings } from '../config.mjs';
import { log } from '../logbus.mjs';
import { interruptibleSleep, throwIfStopped } from '../control.mjs';

const providers = new Map();
function state() {
  const id=loadSettings().ai?.provider||'qianwen';
  if(!providers.has(id))providers.set(id,{lastAskAt:0,cooldownUntil:0,consecutiveFail:0});
  return providers.get(id);
}

function cfg() {
  const s = loadSettings();
  return {
    minIntervalMs: 45000,
    jitterMs: 15000,
    stuckCooldownMs: 300000,
    consecutiveFailLimit: 2,
    ...(s.ai || {}),
  };
}

/**
 * 等到达可提问时刻。返回实际等待毫秒数。
 */
export async function waitTurn({ onWait, shouldStop } = {}) {
  throwIfStopped(shouldStop);
  const c = cfg();
  const {lastAskAt,cooldownUntil}=state();
  const now = Date.now();

  // 冷却期（被限流后）
  if (cooldownUntil > now) {
    const wait = cooldownUntil - now;
    log(`    节流：处于冷却期，还需等待 ${Math.round(wait / 1000)} 秒`, 'warn');
    if (onWait) onWait({ reason: 'cooldown', waitMs: wait });
    await interruptibleSleep(wait, shouldStop);
  }

  const since = Date.now() - lastAskAt;
  const jitter = Math.floor(Math.random() * c.jitterMs);
  const need = Math.max(0, c.minIntervalMs + jitter - since);
  if (need > 0) {
    log(`    节流：等待 ${Math.round(need / 1000)} 秒后提问（保护AI账号）`, 'info');
    if (onWait) onWait({ reason: 'interval', waitMs: need });
    await interruptibleSleep(need, shouldStop);
  }
  return need;
}

/** 记录一次提问发生 */
export function markAsked() {
  state().lastAskAt = Date.now();
}

/** 报告一次成功（清零连续失败） */
export function reportSuccess() {
  state().consecutiveFail = 0;
}

/**
 * 报告一次失败。
 * @returns {{shouldPause:boolean, reason?:string}}
 */
export function reportFailure({ errorCode, error } = {}) {
  const c = cfg();
  const current=state();

  if (errorCode === 'verification-required' || errorCode === 'rate-limited') {
    // 风控验证必须人工处理，直接要求暂停
    current.cooldownUntil = Date.now() + c.stuckCooldownMs;
    return { shouldPause: true, reason: 'needs-human-verification' };
  }

  if (errorCode === 'stuck-receiving' || errorCode === 'empty-answer') {
    current.cooldownUntil = Date.now() + c.stuckCooldownMs;
    current.consecutiveFail += 1;
    log(`    AI未正常返回（${errorCode}）→ 冷却 ${Math.round(c.stuckCooldownMs / 60000)} 分钟`, 'warn');
    return {
      shouldPause: current.consecutiveFail >= c.consecutiveFailLimit,
      reason: current.consecutiveFail >= c.consecutiveFailLimit ? 'AI连续未返回，疑似被限流' : undefined,
    };
  }

  // Editor/upload/send/identity failures are not evidence of provider rate
  // limiting. Keep their actual error instead of poisoning future draft restores.
  return { shouldPause: false };
}

export function throttleState() {
  const {lastAskAt,cooldownUntil,consecutiveFail}=state();
  return {
    lastAskAt,
    cooldownUntil,
    cooldownLeftMs: Math.max(0, cooldownUntil - Date.now()),
    consecutiveFail,
  };
}

export function resetThrottle() {
  providers.clear();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
