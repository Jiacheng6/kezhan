/**
 * 实机验证「设置」页真的可用（在真控制台页面上改值 → 保存 → 校验落盘 → 复原）。
 *
 * 覆盖：
 *   · GET /api/settings 能拿到可编辑项
 *   · 设置页渲染出控件（不是只读文本）
 *   · 改一个值 → 保存 → state.json 真的变了
 *   · 越界值被夹紧并明确告知
 *   · 未知键被拒绝
 *   · 收尾恢复默认，不留改动给用户
 *
 * 用法: node tools/test/verify-ui-settings.mjs
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { DEBUG_PORT } from '../../src/config.mjs';

const b = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const ctx = b.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('127.0.0.1:8787'));
if (!page) {
  console.error('找不到控制台页（先启动服务）');
  process.exit(1);
}

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
};

const api = async (path, init) => (await fetch(`http://127.0.0.1:8787${path}`, init)).json();
const readStateSettings = () => JSON.parse(readFileSync('state.json', 'utf8')).settings || {};

console.log('=== 接口 ===');
const got = await api('/api/settings');
ok('GET /api/settings 可用', got.ok === true);
ok('返回可编辑项', (got.result?.rows || []).length > 10, `${(got.result?.rows || []).length} 项`);
ok('返回只读安全边界项', (got.result?.readonly || []).length > 0, `${(got.result?.readonly || []).length} 项`);

console.log('\n=== 页面渲染 ===');
await page.evaluate(() => document.querySelector('.tab[data-tab="settings"]')?.click());
await page.waitForTimeout(200);
await page.evaluate(() => document.querySelector('#reloadSettings')?.click());
await page.waitForTimeout(1500);
const dom = await page.evaluate(() => ({
  rows: document.querySelectorAll('#bankStrategyRows .setrow, #settingsDrafts .setrow, #settingsAI .setrow, #settingsForm .setrow').length,
  advRows: document.querySelectorAll('#settingsAdvanced .setrow').length,
  inputs: document.querySelectorAll('#panel-settings [data-setting]').length,
  selects: document.querySelectorAll('#panel-settings select[data-setting]').length,
  checkboxes: document.querySelectorAll('input[type=checkbox][data-setting]').length,
  readonly: document.querySelectorAll('#settingsReadonly dt').length,
  dirtyPill: document.getElementById('settingsDirty')?.textContent.trim(),
}));
ok('普通设置有控件行', dom.rows >= 8, `${dom.rows} 行`);
ok('高级设置折叠区有控件行', dom.advRows >= 5, `${dom.advRows} 行`);
ok('控件总数与项数一致', dom.inputs >= dom.rows + dom.advRows, `${dom.inputs} 个控件`);
ok('有下拉框（提交模式）', dom.selects >= 1, `${dom.selects} 个`);
ok('有开关（静音等）', dom.checkboxes >= 2, `${dom.checkboxes} 个`);
ok('只读安全边界有展示', dom.readonly >= 4, `${dom.readonly} 项`);
ok('状态徽章显示保存状态', /未修改|已改/.test(dom.dirtyPill || ''), dom.dirtyPill);

console.log('\n=== 改值 → 保存 → 落盘 ===');
const before = readStateSettings();
console.log('  改前 state.settings =', JSON.stringify(before));
await page.evaluate(() => {
  const inp = document.querySelector('[data-setting="maxRetries"]');
  inp.value = '4';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(300);
const dirtyNow = await page.evaluate(() => document.getElementById('settingsDirty')?.textContent.trim());
ok('改动后徽章提示未保存', /未保存/.test(dirtyNow || ''), dirtyNow);

await page.evaluate(() => document.querySelector('#saveSettings')?.click());
await page.waitForTimeout(2000);
const afterSave = readStateSettings();
ok('state.json 里 maxRetries=4', afterSave.maxRetries === 4, JSON.stringify(afterSave));
const pill2 = await page.evaluate(() => document.getElementById('settingsDirty')?.textContent.trim());
ok('保存后徽章恢复（不再提示未保存）', !/未保存/.test(pill2 || ''), pill2);

console.log('\n=== 越界值被夹紧 ===');
const clamped = await api('/api/settings', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ patch: { 'ai.minIntervalMs': 0 } }),
});
ok('提交 0 秒被夹到下限', readStateSettings().ai?.minIntervalMs === 5000, JSON.stringify(readStateSettings().ai));
ok('并且返回了提示', (clamped.result?.errors || []).length > 0, (clamped.result?.errors || [])[0] || '');

console.log('\n=== 未知键被拒绝 ===');
const rejected = await api('/api/settings', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ patch: { 乱写的键: 1 } }),
});
ok('未知键保存被拒', rejected.ok === false, JSON.stringify(rejected.result?.rejected || rejected.error));

console.log('\n=== 收尾：恢复默认，不留改动 ===');
await page.evaluate(() => document.querySelector('#reloadSettings')?.click());
await page.waitForTimeout(800);
const resetRes = await api('/api/action/resetSettings', { method: 'POST' });
await page.waitForTimeout(1200);
const finalSettings = readStateSettings();
ok('恢复默认成功', resetRes.ok === true);
ok('state.json 的 settings 已清空', Object.keys(finalSettings).length === 0, JSON.stringify(finalSettings));

await b.close().catch(() => {});
console.log('\n' + '='.repeat(50));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
