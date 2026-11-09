import { toAppError } from '../errors.js';
import { interruptibleSleep } from '../sleep.js';
import { randomInt } from '../plan/time-plan.js';
import { keepSco, type ScoContext } from '../api/sco.js';
import type { Session } from '../http/session.js';
import type { Logger } from '../../logging/logger.js';

/**
 * 等待 + 心跳。
 *
 * 为什么不用一个 setTimeout(target) 了事：
 * 平台按心跳里上报的 session_time/total_time 累计学习时长，长时间没有任何上报，
 * 这段时长可能不计入。所以按 30–40s 的随机间隔上报，且在结束时补一次。
 *
 * 可测性：sleep 与随机源都可注入。测试里用假 sleep 瞬间走完 60 秒，
 * 断言心跳次数与 session_time 单调递增，不用真的等一分钟。
 */

export interface KeepaliveParams {
  session: Session;
  ctx: ScoContext;
  /** 进入本节前的历史累计秒数 */
  totalBefore: number;
  /** 本次需要等待的秒数 */
  targetSec: number;
  signal?: AbortSignal;
  logger?: Logger;
}

export interface KeepaliveDeps {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  beatMinSec?: number;
  beatMaxSec?: number;
}

export interface KeepaliveResult {
  elapsed: number;
  heartbeats: number;
  failures: number;
  /** false 表示平台不接受心跳，已降级为纯等待 */
  supported: boolean;
}

export async function runKeepalive(
  params: KeepaliveParams,
  deps: KeepaliveDeps = {},
): Promise<KeepaliveResult> {
  const sleep = deps.sleep ?? interruptibleSleep;
  const random = deps.random ?? Math.random;
  const beatMin = deps.beatMinSec ?? 30;
  const beatMax = deps.beatMaxSec ?? 40;

  let elapsed = 0;
  let heartbeats = 0;
  let failures = 0;
  let supported = true;
  let consecutiveNetworkErrors = 0;

  const target = Math.max(0, Math.round(params.targetSec));
  let nextBeat = randomInt(beatMin, beatMax, random);

  const beat = async (): Promise<void> => {
    try {
      const ok = await keepSco(
        params.session,
        params.ctx,
        { sessionTime: elapsed, totalTime: params.totalBefore + elapsed },
        { signal: params.signal },
      );
      if (ok) {
        heartbeats++;
        consecutiveNetworkErrors = 0;
        params.logger?.stage('HB', `+${elapsed}s / ${target}s  total=${params.totalBefore + elapsed}s  ok`);
      } else if (supported) {
        // 平台明确拒绝：降级为纯等待，只提示一次，避免每节刷日志
        supported = false;
        params.logger?.warn('平台不接受心跳（ret 非 0），本节降级为纯等待');
      }
    } catch (err) {
      const appErr = toAppError(err);
      if (appErr.code === 'INTERRUPTED' || appErr.code === 'AUTH_EXPIRED') throw appErr;

      failures++;
      consecutiveNetworkErrors++;
      params.logger?.warn(`心跳失败（${appErr.code}），继续等待：${appErr.message}`);
      if (consecutiveNetworkErrors >= 3 && supported) {
        supported = false;
        params.logger?.warn('心跳连续失败 3 次，本节降级为纯等待');
      }
    }
  };

  while (elapsed < target) {
    const step = Math.min(1, target - elapsed);
    await sleep(Math.round(step * 1000), params.signal);
    elapsed += step;

    // 循环内的最后一次 tick 已经等于 target，交给收尾统一发，避免重复心跳
    if (elapsed >= nextBeat && elapsed < target) {
      await beat();
      nextBeat = elapsed + randomInt(beatMin, beatMax, random);
    }
  }

  // 结束时补一次，确保服务端拿到最终时长
  if (target > 0) await beat();

  return { elapsed, heartbeats, failures, supported };
}
