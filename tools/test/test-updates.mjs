import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { UpdateController, backupUserData } = require('../../desktop/updates.cjs');
const { waitForOwnedExit } = await import('../../src/browser/launch.mjs');
const browserProcess = new EventEmitter();
Object.assign(browserProcess, { pid: 1, exitCode: null, signalCode: null });
setTimeout(() => { browserProcess.exitCode = 0; browserProcess.emit('exit', 0); }, 20);
assert.equal(await waitForOwnedExit(browserProcess, 500), true, '等待正常关闭完成，避免打断登录状态落盘');
const stuckBrowser = new EventEmitter();
Object.assign(stuckBrowser, { pid: 2, exitCode: null, signalCode: null });
assert.equal(await waitForOwnedExit(stuckBrowser, 20), false, '关闭超时才允许后续清理');
assert.equal(stuckBrowser.listenerCount('exit'), 0);
class FakeUpdater extends EventEmitter {
  installs = 0;
  async checkForUpdates() { this.emit('checking-for-update'); this.emit('update-available', { version: '0.4.0' }); return {}; }
  async downloadUpdate() { this.emit('download-progress', { percent: 50 }); this.emit('update-downloaded', { version: '0.4.0' }); return ['installer.exe']; }
  quitAndInstall() { this.installs++; }
}
const events = [];
const fake = new FakeUpdater();
let cancel = true;
const update = new UpdateController(fake, { version: '0.3.0', prepareInstall: async () => {
  if (cancel) return false;
  events.push('saved');
  return true;
} });
assert.equal(fake.autoDownload, false);
assert.equal(fake.autoInstallOnAppQuit, false, '下载完成不能在普通退出时偷偷安装');
await update.install();
assert.equal(fake.installs, 0, '未校验下载不可安装');
await update.check();
assert.equal(update.snapshot().phase, 'available');
assert.equal(fake.installs, 0);
await update.download();
assert.equal(update.snapshot().phase, 'ready');
await update.install();
assert.equal(fake.installs, 0, '选择稍后不会安装或退出');
assert.equal(update.snapshot().downloadReady, true);
cancel = false;
fake.quitAndInstall = () => { events.push('installer'); fake.installs++; };
await update.install();
assert.deepEqual(events, ['saved', 'installer'], '完成保存后才启动安装器');
assert.equal(fake.installs, 1);
await update.install();
assert.equal(fake.installs, 1, '安装开始后重复点击不会再次安装');

let recovered = false;
const failed = new FakeUpdater();
const failure = new UpdateController(failed, { version: '0.3.0', prepareInstall: async () => { throw new Error('保存失败'); }, recoverInstall: async () => { recovered = true; } });
await failure.check(); await failure.download(); await failure.install();
assert.equal(failed.installs, 0, '保存失败时绝不启动安装器');
assert.equal(recovered, true);
assert.equal(failure.snapshot().phase, 'error');

const corrupt = new FakeUpdater();
corrupt.downloadUpdate = async () => { throw new Error('sha512 checksum mismatch'); };
const corruption = new UpdateController(corrupt, { version: '0.3.0', prepareInstall: async () => true });
await corruption.check(); await corruption.download(); await corruption.install();
assert.equal(corrupt.installs, 0, '校验失败不可安装');
assert.equal(corruption.snapshot().downloadReady, false);
assert.match(corruption.snapshot().message, /校验失败/);

const data = fs.mkdtempSync(path.join(process.env.XXT_DATA_DIR || '.desktop-test', 'update-data-'));
fs.mkdirSync(path.join(data, 'edge-profile'), { recursive: true });
fs.mkdirSync(path.join(data, 'data', 'probe-out'), { recursive: true });
const fixture = {
  'state.json': { version: 3, taskPoints: { sample: { status: 'done' } }, settings: { maxRetries: 4 } },
  'local.json': { personId: 'fixture-user' },
  'recon-selection.json': { excluded: ['fixture-task'] },
  'data/probe-out/task-report.json': { courses: [{ name: '示例课程甲' }] },
};
for (const [name, contents] of Object.entries(fixture)) fs.writeFileSync(path.join(data, name), JSON.stringify(contents));
fs.writeFileSync(path.join(data, 'edge-profile', 'Cookies'), 'fixture-login-data');
const backup = backupUserData(data, '0.3.0');
for (const name of Object.keys(fixture)) assert.equal(fs.readFileSync(path.join(data, name), 'utf8'), fs.readFileSync(path.join(backup, name), 'utf8'));
assert.equal(fs.readFileSync(path.join(data, 'edge-profile', 'Cookies'), 'utf8'), 'fixture-login-data');
fs.writeFileSync(path.join(data, 'state.json'), '{broken');
assert.throws(() => backupUserData(data, '0.3.0'), SyntaxError, '损坏数据必须中止安装，不能当成空数据');
assert.equal(fs.readFileSync(path.join(data, 'state.json'), 'utf8'), '{broken');
console.log('✓ 手动下载安装、取消安装、保存失败、校验失败、安装顺序、登录数据与课程备份通过');
