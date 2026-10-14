export function throwIfStopped(shouldStop) {
  if (shouldStop?.()) throw Object.assign(new Error('被用户中止'), { code: 'STOPPED' });
}

export async function interruptibleSleep(ms, shouldStop) {
  const until = Date.now() + ms;
  do {
    throwIfStopped(shouldStop);
    if (Date.now() >= until) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, until - Date.now())));
  } while (true);
}

// 仅用于只读操作；取消后由调用方关闭 CDP session，不能用于提交等写操作。
export function waitForRead(operation, { shouldStop, timeoutMs = 8000, message = '页面读取超时' } = {}) {
  throwIfStopped(shouldStop);
  return new Promise((resolve, reject) => {
    let finished = false;
    const end = (error, value) => {
      if (finished) return;
      finished = true; clearInterval(poll); clearTimeout(timeout);
      if (error) reject(error); else resolve(value);
    };
    const poll = setInterval(() => { try { throwIfStopped(shouldStop); } catch (err) { end(err); } }, 100);
    const timeout = setTimeout(() => end(new Error(message)), timeoutMs);
    Promise.resolve().then(operation).then((value) => end(null, value), (err) => end(err));
  });
}
