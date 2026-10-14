import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright-core';
import { ROOT } from '../../src/config.mjs';
import { startOwnerMonitor } from '../../src/browser/owner-lifecycle.mjs';
const testRoot = path.join(ROOT, '.desktop-test');
fs.mkdirSync(testRoot, { recursive: true });
const data = fs.mkdtempSync(path.join(testRoot, 'heartbeat-'));
const application = await electron.launch({ executablePath: path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: [ROOT, '--test-mode'], env: { ...process.env, XXT_TEST_DATA_DIR: data, XXT_TEST_SKIP_HEARTBEAT: '1' } });
try {
  const page = await application.firstWindow();
  await page.waitForURL('http://127.0.0.1:*/');
  const before = await page.evaluate(() => fetch('/api/status').then((r) => r.json()));
  await new Promise((resolve) => setTimeout(resolve, 19000));
  const after = await page.evaluate(() => fetch('/api/status').then((r) => r.json()));
  assert.equal(after.pid, before.pid, '超过旧心跳期限也不能重启或退出后台');
  const logs = await page.evaluate(() => fetch('/api/logs').then((r) => r.json()));
  assert.ok(logs.some((item) => /心跳暂时超时.*后台继续运行/.test(item.message)));
  console.log('✓ 桌面进程活着、19 秒没有心跳，后台仍正常服务');
  // 仅终止本测试创建的 Electron 主进程，验证真正失去父进程时清理后台。
  // Windows 的 Playwright 启动器可能是 cmd.exe，必须结束实际 Electron 主进程。
  const ownerPid = await application.evaluate(() => process.pid);
  execFileSync('taskkill.exe', ['/PID', String(ownerPid), '/F'], { windowsHide: true, stdio: 'ignore' });
  let observer;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('确认桌面退出后测试后台仍在运行')), 10000);
      observer = startOwnerMonitor(after.pid, (state) => { if (state === 'gone') { clearTimeout(timer); resolve(); } });
    });
  } finally { observer?.stop(); }
  console.log('✓ 桌面进程确实退出时，测试后台没有残留');
} finally { await application.close().catch(() => {}); }
