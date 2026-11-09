import type { RatePlan, WaitPlan } from '../../types/domain.js';

/**
 * 时间与正确率的抽样。纯函数 + 可注入随机源，保证测试可复现。
 *
 * 一条重要语义：区间型正确率**每节只抽一次**，本节所有题共用同一个 crate。
 * 如果每题单独抽，整节实际正确率会向均值回归，与"设定 90-100%"的预期不符。
 */

export type RandomFn = () => number;

/** 闭区间随机整数 */
export function randomInt(min: number, max: number, random: RandomFn = Math.random): number {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  if (hi <= lo) return lo;
  return Math.floor(random() * (hi - lo + 1)) + lo;
}

export function pickWait(plan: WaitPlan, random: RandomFn = Math.random): number {
  return plan.mode === 'fixed' ? plan.seconds : randomInt(plan.min, plan.max, random);
}

export function pickCrate(plan: RatePlan, random: RandomFn = Math.random): number {
  const value = plan.mode === 'fixed' ? plan.value : randomInt(plan.min, plan.max, random);
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** 节间间隔（秒，允许小数） */
export function pickInterval(range: { min: number; max: number }, random: RandomFn = Math.random): number {
  if (range.max <= range.min) return range.min;
  return range.min + random() * (range.max - range.min);
}

export interface Estimate {
  /** 总秒数的下界与上界 */
  min: number;
  max: number;
}

/** 队列耗时预估，用于开跑前给用户预期 */
export function estimateDuration(
  wait: WaitPlan,
  interval: { min: number; max: number },
  count: number,
): Estimate {
  const waitMin = wait.mode === 'fixed' ? wait.seconds : wait.min;
  const waitMax = wait.mode === 'fixed' ? wait.seconds : wait.max;
  return {
    min: count * (waitMin + interval.min),
    max: count * (waitMax + interval.max),
  };
}
