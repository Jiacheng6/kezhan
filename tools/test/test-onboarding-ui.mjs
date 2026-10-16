// Actual Electron renderer + actual local onboarding API; only account/browser
// actions are synthetic. No real login, coursework or installed app is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
import { requestTestExit, revealTestTools } from './desktop-test-helpers.mjs';
const root = process.cwd(); fs.mkdirSync('.desktop-test', { recursive: true });
const data = fs.mkdtempSync(path.resolve('.desktop-test/onboarding-ui-'));
const output = path.join(root, '.desktop-test/onboarding'); fs.mkdirSync(output, { recursive: true });
process.env.XXT_DATA_DIR = data;
const { loadSettings, DEFAULT_SETTINGS } = await import('../../src/config.mjs');
const { mutateState } = await import('../../src/state.mjs');
const { normalizeSettings, toSparseSettings } = await import('../../src/settings.mjs');
const { patchStatus, bus } = await import('../../src/logbus.mjs');
const { startServer } = await import('../../src/server.mjs');
let loggedIn = false, aiLoggedIn = false, failSave = false;
const actions = [];
const service = await startServer({
  openChaoxing: async () => { actions.push('openChaoxing'); },
  refreshLogin: async () => { patchStatus({ login: { loggedIn } }); },
  saveSettings: async patch => {
    if (failSave) throw new Error('示例保存失败');
    const next = normalizeSettings(patch, loadSettings()).settings;
    mutateState(s => { s.settings = toSparseSettings(next, DEFAULT_SETTINGS); });
    patchStatus({ settings: loadSettings(), ai: { provider: next.ai.provider, loggedIn: false } });
    return { ok: true };
  },
  openAI: async () => { actions.push('openAI:' + loadSettings().ai.provider); },
  checkQianwen: async () => { patchStatus({ ai: { provider: loadSettings().ai.provider, loggedIn: aiLoggedIn } }); },
});
patchStatus({ ready: true, bootError: null, edge: { connected: true }, login: { loggedIn: false }, settings: loadSettings() });
const electronData = fs.mkdtempSync(path.resolve('.desktop-test/onboarding-electron-'));
const packagedExe = process.env.XXT_ONBOARDING_TEST_EXE;
const app = await electron.launch({ executablePath: packagedExe || path.join(root, 'node_modules/electron/dist/electron.exe'), args: [...(packagedExe ? [] : [root]), '--test-mode'], env: { ...process.env, XXT_TEST_DATA_DIR: electronData } });
const errors = [], sockets = new Set();
const send = data => { for (const ws of sockets) ws.send(JSON.stringify({ type: 'status', data })); };
bus.on('status', send);
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.waitForURL('http://127.0.0.1:*/');
  await page.route('**/api/**', async route => {
    const req = route.request();
    const result = await fetch(new URL(new URL(req.url()).pathname, service.url), { method: req.method(), headers: { 'content-type': 'application/json' }, ...(req.method() === 'POST' ? { body: req.postData() } : {}) });
    await route.fulfill({ status: result.status, contentType: 'application/json', body: await result.text() });
  });
  await page.routeWebSocket('**/ws', ws => { sockets.add(ws); ws.onClose(() => sockets.delete(ws)); });
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1320, 900); w.showInactive(); });
  await page.reload(); await page.locator('#onboardingPanel[open]').waitFor();
  assert.equal(await page.locator('#onboardingNext').isDisabled(), true);
  await page.screenshot({ path: path.join(output, '01-login.png') });
  await page.locator('#onboardingOpenLogin').click(); await page.waitForFunction(() => !document.getElementById('onboardingOpenLogin').disabled);
  assert.deepEqual(actions, ['openChaoxing']);
  await page.locator('#onboardingCheckLogin').click(); await page.locator('#onboardingError').filter({ hasText: '还未检测到学习通' }).waitFor();
  assert.equal(await page.locator('#onboardingNext').isDisabled(), true);
  await page.locator('#onboardingLater').click(); assert.equal((await (await fetch(new URL('/api/onboarding', service.url))).json()).result.completedAt, null);
  await page.reload(); await page.locator('#onboardingPanel[open]').waitFor();
  loggedIn = true; await page.locator('#onboardingCheckLogin').click(); await page.waitForFunction(() => !document.getElementById('onboardingNext').disabled);
  await page.locator('#onboardingNext').click(); await page.locator('input[value=doubao]').check();
  failSave = true; await page.locator('#onboardingOpenAI').click(); await page.locator('#onboardingError').filter({ hasText: '示例保存失败' }).waitFor();
  assert.equal(actions.some(a => a.startsWith('openAI')), false);
  failSave = false; await page.locator('#onboardingOpenAI').click(); await page.waitForFunction(() => !document.getElementById('onboardingOpenAI').disabled);
  assert.equal(actions.at(-1), 'openAI:doubao');
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8')).settings.ai.provider, 'doubao');
  aiLoggedIn = true; await page.locator('#onboardingCheckAI').click(); await page.locator('#onboardingAIStatus').filter({ hasText: '豆包已登录' }).waitFor();
  await page.screenshot({ path: path.join(output, '02-ai.png') });
  await page.locator('input[value=deepseek]').check(); assert.match(await page.locator('#onboardingAIStatus').innerText(), /尚未/);
  patchStatus({ running: true }); await page.waitForFunction(() => document.getElementById('onboardingNext').disabled);
  assert.equal(await page.locator('input[value=doubao]').isDisabled(), true);
  patchStatus({ running: false }); await page.waitForFunction(() => !document.getElementById('onboardingNext').disabled);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await page.locator('#desktopClosePanel[open]').waitFor(); await page.locator('#closeCancel').click();
  assert.equal(await page.locator('#onboardingPanel').evaluate(e => e.open), true);
  await page.locator('#onboardingNext').click(); await page.locator('#onboardingPanel').waitFor({ state: 'hidden' });
  const saved = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
  assert.equal(saved.onboarding.provider, 'deepseek'); assert.ok(saved.onboarding.completedAt);
  await page.reload(); await page.waitForFunction(() => document.documentElement.dataset.onboardingPending === 'false');
  assert.equal(await page.locator('#onboardingPanel').evaluate(e => e.open), false);
  await revealTestTools(page); await page.locator('[data-tab=settings]').click(); await page.locator('#reopenOnboarding').click();
  await page.locator('#onboardingNext').click(); assert.equal(await page.locator('input[value=deepseek]').isChecked(), true);
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(500, 500); w.setContentSize(600, 760); });
  await page.screenshot({ path: path.join(output, '03-narrow.png') });
  assert.equal(await page.locator('#onboardingPanel').evaluate(e => e.scrollWidth <= e.clientWidth), true);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#onboardingPanel').evaluate(e => e.open), false);
  assert.deepEqual(errors, []);
  console.log('✓ 真实桌面向导：首次弹出、未登录阻断、跳过重开、失败反馈、三通道选择、登录隔离、运行保护、关闭覆盖、完成持久化、设置重开和窄窗通过');
} finally {
  await requestTestExit(app).catch(() => {}); await app.close().catch(() => {});
  bus.off('status', send); for (const client of service.wss.clients) client.terminate();
  await new Promise(resolve => service.wss.close(resolve)); service.server.closeAllConnections(); await new Promise(resolve => service.server.close(resolve));
}
