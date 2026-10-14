import assert from 'node:assert/strict';
import { ownerState } from '../../src/browser/owner-lifecycle.mjs';
import { interruptibleSleep, waitForRead } from '../../src/control.mjs';
import { verifyTaskCompletion } from '../../src/chaoxing/runner.mjs';
import { markAsked, resetThrottle, waitTurn } from '../../src/ai/throttle.mjs';
import { waitAnswer, askImage } from '../../src/ai/ai.mjs';

const task = { courseId: 'test', clazzId: 'test', knowledgeId: 'test' };
let reads = 0;
const deps = {
  checkPointFinished: async () => { reads++; return { finished: false }; },
  readSectionStatus: async () => ({ done: false }),
};
let stop = true;
let verdict = await verifyTaskCompletion({ task, deps, shouldStop: () => stop, totalBudgetMs: 360000 });
assert.equal(verdict.stopped, true);
assert.equal(reads, 0, '已停止时不应再读课程页面');

stop = false;
const timer = setTimeout(() => { stop = true; }, 80);
const started = Date.now();
verdict = await verifyTaskCompletion({ task, deps, shouldStop: () => stop, totalBudgetMs: 360000, intervalMs: 10000 });
clearTimeout(timer);
assert.equal(verdict.stopped, true);
assert.ok(Date.now() - started < 1000, '长轮询等待也必须及时响应停止');

stop = false;
setTimeout(() => { stop = true; }, 50);
const readingStarted = Date.now();
verdict = await verifyTaskCompletion({ task, shouldStop: () => stop, deps: {
  checkPointFinished: () => new Promise(() => {}), readSectionStatus: deps.readSectionStatus,
} });
assert.equal(verdict.stopped, true);
assert.ok(Date.now() - readingStarted < 1000, '页面读取尚未返回时也能停止');

stop = false;
verdict = await verifyTaskCompletion({ task, shouldStop: () => stop, deps: {
  checkPointFinished: async () => { stop = true; return { finished: true }; },
  readSectionStatus: async () => { throw new Error('已确认完成时不应继续补读'); },
} });
assert.equal(verdict.done, true, '停止不能丢掉已确认的完成记录');

assert.equal(ownerState({ ownerPid: 123, lastHeartbeat: 0, now: 60000, probe: () => {} }), 'unresponsive');
assert.equal(ownerState({ ownerPid: 123, lastHeartbeat: 0, now: 60000, probe: () => { throw { code: 'EPERM' }; } }), 'unresponsive');
assert.equal(ownerState({ ownerPid: 123, lastHeartbeat: 0, now: 60000, probe: () => { throw { code: 'ESRCH' }; } }), 'gone');
assert.equal(ownerState({ ownerPid: '', probe: () => { throw new Error(); } }), 'unknown');
assert.equal(ownerState({ ownerPid: 123, probe: () => { throw { code: 'EIO' }; } }), 'unknown');

await assert.rejects(() => interruptibleSleep(300000, () => true), { code: 'STOPPED' });
await assert.rejects(() => waitForRead(() => new Promise(() => {}), { timeoutMs: 20 }), /读取超时/);
stop = false;
setTimeout(() => { stop = true; }, 50);
await assert.rejects(() => waitForRead(() => new Promise(() => {}), { shouldStop: () => stop }), { code: 'STOPPED' });
resetThrottle(); markAsked();
stop = false;
setTimeout(() => { stop = true; }, 50);
await assert.rejects(() => waitTurn({ shouldStop: () => stop }), { code: 'STOPPED' });
resetThrottle();
await assert.rejects(() => waitAnswer(null, { shouldStop: () => true }), { code: 'STOPPED' });
await assert.rejects(() => askImage({ page: null, shouldStop: () => true }), { code: 'STOPPED' });
stop = false;
setTimeout(() => { stop = true; }, 50);
await assert.rejects(() => waitAnswer(null, { shouldStop: () => stop }), { code: 'STOPPED' });
console.log('✓ 核对中止、保留完成记录、心跳超时不误杀、读操作与节流取消通过');
