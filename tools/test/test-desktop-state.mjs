import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, PATHS, DATA_ROOT, DEFAULT_SETTINGS, loadSettings } from '../../src/config.mjs';
import { mutateState, loadState, invalidateCache } from '../../src/state.mjs';
import { reconAll } from '../../src/chaoxing/recon.mjs';

assert.ok(process.env.XXT_DATA_DIR, '请通过 npm test 在隔离数据目录运行');
assert.notEqual(ROOT, DATA_ROOT);
for (const key of ['local', 'selection', 'state', 'logs', 'answers', 'edgeProfile', 'taskReport']) {
  assert.ok(PATHS[key].startsWith(DATA_ROOT + path.sep), `${key} 必须写入数据目录`);
}
assert.equal(PATHS.ui, path.join(ROOT, 'src', 'ui'));
mutateState((s) => { s.settings = { ai: { askRetries: 1 } }; s.taskPoints.sample = { status: 'done' }; });
const settings = loadSettings();
assert.equal(settings.ai.askRetries, 1);
assert.equal(settings.ai.minIntervalMs, DEFAULT_SETTINGS.ai.minIntervalMs);
settings.ai.minIntervalMs = -100;
assert.notEqual(DEFAULT_SETTINGS.ai.minIntervalMs, -100);
assert.equal(loadState().taskPoints.sample.status, 'done');

const original = fs.readFileSync(PATHS.state);
try {
  fs.writeFileSync(PATHS.state, '{broken');
  invalidateCache();
  assert.throws(() => mutateState((s) => { s.settings = {}; }), /无法读取进度文件/);
  assert.equal(fs.readFileSync(PATHS.state, 'utf8'), '{broken', '损坏数据不能静默覆盖');
  fs.writeFileSync(PATHS.state, original);
  fs.chmodSync(PATHS.state, 0o444);
  invalidateCache();
  assert.throws(() => mutateState((s) => { s.taskPoints.lost = {}; }), /进度保存失败/);
} finally {
  fs.chmodSync(PATHS.state, 0o666);
  fs.writeFileSync(PATHS.state, original);
  invalidateCache();
}
assert.equal(loadState().taskPoints.lost, undefined);
await assert.rejects(() => reconAll(null, [{ name: '测试' }], { shouldStop: () => true }), { code: 'STOPPED' });
console.log('✓ 隔离数据目录、稀疏设置合并、文件损坏保护、写入失败传播通过');
