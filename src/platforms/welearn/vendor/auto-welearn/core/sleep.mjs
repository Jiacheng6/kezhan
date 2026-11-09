// Auto-WeLearn; GPL-3.0; see ../../NOTICE.md and original source.
/**
 * 可中断的等待。整个项目里所有 sleep 都必须走这里，
 * 禁止裸 setTimeout —— 否则 Ctrl+C 时进程会被最长 8 分钟的等待卡住。
 */

export function abortError(message = '操作已被中断')        {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function throwIfAborted(signal              )       {
  if (signal?.aborted) throw abortError();
}

/**
 * 等待 ms 毫秒，期间监听 signal。
 * 无论正常结束还是被中断，都会清理定时器与监听器，避免长期运行时的监听器泄漏。
 */
export function interruptibleSleep(ms        , signal              )                {
  return new Promise      ((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const onAbort = ()       => {
      clearTimeout(timer);
      reject(abortError());
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
