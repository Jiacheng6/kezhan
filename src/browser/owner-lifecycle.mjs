import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { PATHS } from '../config.mjs';

// Windows 中 signal 0 可能仍能打开已退出但有句柄未释放的进程。
// 固定原生进程句柄等待退出，避免把「仍能按 PID 打开」误当成仍在运行。
export function startOwnerMonitor(ownerPid, onState = () => {}) {
  let state = 'unknown';
  const child = spawn(path.join(PATHS.root, 'desktop', 'native', 'BrowserWindowControl.exe'),
    ['--watch-owner', String(ownerPid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const update = (next) => { state = next; onState(next); };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => { if (['alive', 'gone', 'unknown'].includes(line.trim())) update(line.trim()); });
  child.on('error', () => update('unknown'));
  child.on('exit', () => { if (state !== 'gone') update('unknown'); });
  return {
    probe: () => {
      if (state === 'gone') throw Object.assign(new Error('桌面进程已退出'), { code: 'ESRCH' });
      if (state !== 'alive') throw Object.assign(new Error('无法确认桌面进程状态'), { code: 'EAGAIN' });
    },
    stop: () => { if (child.exitCode === null) child.kill(); },
  };
}

// 心跳只说明响应是否及时；必须确认桌面进程已消失，才能清理后台。
export function ownerState({ ownerPid, lastHeartbeat = 0, now = Date.now(), probe = (pid) => process.kill(pid, 0) }) {
  const pid = Number(ownerPid);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return 'unknown';
  try { probe(pid); }
  catch (err) {
    if (err.code === 'ESRCH') return 'gone';
    if (err.code !== 'EPERM') return 'unknown';
  }
  return now - lastHeartbeat > 15000 ? 'unresponsive' : 'alive';
}
