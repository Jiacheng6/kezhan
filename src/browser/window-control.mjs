import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { PATHS } from '../config.mjs';
import { embedded, embeddedRequest, embeddedVisible } from './embedded.mjs';

let helper = null;
let pending = null;
let visible = true;

export async function startWindowControl(browser) {
  if (embedded) return;
  if (process.env.XXT_DESKTOP !== '1') return;
  const executable = path.join(PATHS.root, 'desktop', 'native', 'BrowserWindowControl.exe');
  if (!fs.existsSync(executable)) throw new Error('缺少浏览器窗口管理组件，请重新构建桌面版');
  const session = await browser.newBrowserCDPSession();
  let pid;
  try {
    const result = await session.send('SystemInfo.getProcessInfo');
    pid = result.processInfo.find((p) => p.type === 'browser')?.id;
  } finally { await session.detach(); }
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('无法确认专用浏览器进程');
  helper = spawn(executable, [String(pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  helper.stdin.on('error', () => {});
  const lines = createInterface({ input: helper.stdout });
  lines.on('line', (line) => {
    try {
      const result = JSON.parse(line);
      if (pending) { visible = result.visible; pending.resolve(result); pending = null; }
    } catch { /* 不是协议消息 */ }
  });
  const failed = (error) => {
    if (pending) { pending.reject(error); pending = null; }
    helper = null;
  };
  helper.on('error', failed);
  helper.on('exit', () => failed(new Error('浏览器窗口管理组件已退出')));
  await setBrowserVisible(true);
}

export function isBrowserVisible() { return embedded ? embeddedVisible() : visible; }

export async function setBrowserVisible(show) {
  if (embedded) return embeddedRequest('visible', { visible: !!show });
  if (!helper || helper.exitCode !== null) throw new Error('浏览器窗口管理尚未就绪');
  if (pending) throw new Error('正在切换浏览器窗口，请稍候');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending = null;
      reject(new Error('浏览器窗口切换超时'));
    }, 4000);
    pending = {
      resolve: (result) => {
        clearTimeout(timer);
        if (!result.count) return reject(new Error('没有找到专用浏览器窗口'));
        resolve(result);
      },
      reject: (err) => { clearTimeout(timer); reject(err); },
    };
    helper.stdin.write(show ? 'show\n' : 'hide\n');
  });
}

export function stopWindowControl() {
  if (helper) { helper.stdin.end('restore\n'); }
}
