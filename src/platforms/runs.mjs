// Separate controllers: stopping/failing one platform cannot cancel another.
import {runWithTaskRestart} from '../task-recovery.mjs';
import {platformSkipReason} from './task-skip.mjs';
export function planPlatformRun(tasks, progress={}) {
  const pending=tasks.filter(t=>t.finished!==true&&t.completion?.finished!==true&&progress[t.key]?.status!=='done');
  return {tasks:pending,skipped:tasks.length-pending.length,selected:tasks.length};
}
export class PlatformRuns {
  constructor({ execute, changed = () => {}, onRestart=()=>{},restartDelayMs=1500, restartMaxAttempts=3 }) { this.execute = execute; this.changed = changed; this.onRestart=onRestart;this.restartDelayMs=restartDelayMs;this.sessions = new Map(); }
  snapshot() { return Object.fromEntries([...this.sessions].map(([id, s]) => [id, { startedAt:s.startedAt,running: s.running, stopping: s.stop,
    done: s.done, skipped:s.skipped,review: s.review, total: s.total, current: s.current, progress: s.progress, error: s.error, phase: s.phase }])); }
  stop(id) { const s = this.sessions.get(id); if (s?.running) { s.stop = true; this.changed(this.snapshot()); } }
  stopAll() { for (const id of this.sessions.keys()) this.stop(id); }
  start(id, tasks, context) {
    const previous = this.sessions.get(id);
    if (previous?.running) throw Error('该平台的任务已在运行');
    if (!tasks.length || tasks.some(t => t.platform !== id || typeof t.key !== 'string' || !t.key) || new Set(tasks.map(t => t.key)).size !== tasks.length) throw Error('平台任务范围无效');
    const resuming = ['stopped', 'needs-human', 'failed'].includes(previous?.phase) && previous.taskKey === tasks[0].key;
    const s = { startedAt:Date.now(),running: true, stop: false, done: 0, skipped:0,review: 0, total: tasks.length, current: resuming ? tasks[0].name : null,
      progress: resuming && previous.progress ? { ...previous.progress, resuming: true } : null, error: null, phase: 'running' };
    this.sessions.set(id, s); this.changed(this.snapshot());
    s.finished = (async () => {
      try {
        for (const task of tasks) {
          if (s.stop) break;
          if (task !== tasks[0]) s.progress = null;
          s.taskKey = task.key; s.current = task.name; this.changed(this.snapshot());
          if(platformSkipReason(task)){s.skipped++;this.changed(this.snapshot());continue;}
          const result = await runWithTaskRestart(recovery=>this.execute({ platform: id, task, context, ...recovery,shouldStop: () => s.stop,
            onProgress: progress => { s.progress = progress; this.changed(this.snapshot()); } }),{
              task,shouldStop:()=>s.stop,delayMs:this.restartDelayMs,maxAttempts:this.restartMaxAttempts,onRestart:info=>{s.progress=null;this.changed(this.snapshot());return this.onRestart({...info,platform:id});}
            });
          if (result?.phase === 'stopped') {s.stop=true;break;}
          if (result?.phase === 'skipped') {s.skipped++;this.changed(this.snapshot());continue;}
          if (result?.phase === 'awaiting-review') { s.review++; this.changed(this.snapshot()); continue; }
          if (!result?.ok) { s.error = result?.error || '任务未完成，请查看原网页'; s.phase = 'needs-human'; break; }
          s.done++;if(result?.phase==='already-finished')s.skipped++;this.changed(this.snapshot());
          if (s.stop) break;
        }
      } catch (error) { s.error = error.message; s.phase = 'failed'; }
      finally { s.running = false; if (s.stop) s.phase = 'stopped'; else if (!s.error) s.phase = s.review ? 'awaiting-review' : 'completed'; this.changed(this.snapshot()); }
      return this.snapshot()[id];
    })();
    return { started: true, platform: id, count: tasks.length };
  }
  async wait(id) { return this.sessions.get(id)?.finished; }
}
