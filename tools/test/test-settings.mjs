/**
 * 设置校验的离线测试（不需要浏览器）。
 *
 * 设置能改之后，最重要的不是"能存进去"，而是**不能存进危险值**：
 *   · 未知键必须被拒绝（界面写错键名不能静默成功）
 *   · 数值必须夹在允许范围内（比如"问千问间隔"填 0 会把账号送进风控）
 *   · 界面按"分钟/秒"提交，内部按毫秒存 —— 单位换算不能错
 *   · 类型不符要报错而不是写进去
 *
 * 用法: node tools/test/test-settings.mjs
 */
import {
  normalizeSettings,
  describeSettings,
  diffFromDefault,
  getByPath,
  setByPath,
  toSparseSettings,
  deleteByPath,
} from '../../src/settings.mjs';
import { DEFAULT_SETTINGS } from '../../src/config.mjs';

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

console.log('=== 路径读写 ===');
{
  const o = {};
  setByPath(o, 'ai.minIntervalMs', 123);
  ok('按点号路径写嵌套值', o.ai && o.ai.minIntervalMs === 123);
  ok('按点号路径读嵌套值', getByPath({ ai: { x: 7 } }, 'ai.x') === 7);
  ok('读不存在的路径返回 undefined', getByPath({}, 'a.b.c') === undefined);
  const d = { ai: { x: 1, y: 2 }, z: 3 };
  deleteByPath(d, 'ai.x');
  ok('删除嵌套键保留兄弟键', d.ai.x === undefined && d.ai.y === 2);
  deleteByPath(d, 'ai.y');
  ok('删空后回收空对象', d.ai === undefined && d.z === 3);
}

console.log('\n=== 正常保存 ===');
{
  const r = normalizeSettings({ submitMode: 'auto', muted: false, maxRetries: 5 }, DEFAULT_SETTINGS);
  ok('没有错误', r.ok && r.errors.length === 0, JSON.stringify(r.errors));
  ok('submitMode 写入', r.settings.submitMode === 'auto');
  ok('muted 写入', r.settings.muted === false);
  ok('maxRetries 写入', r.settings.maxRetries === 5);
  ok('其它键保持默认', r.settings.progressThreshold === DEFAULT_SETTINGS.progressThreshold);
}

console.log('\n=== 未知键必须被拒绝 ===');
{
  const r = normalizeSettings({ 不存在的键: 1, submitMode: 'auto' }, DEFAULT_SETTINGS);
  ok('返回 ok=false', r.ok === false);
  ok('未知键进 rejected', r.rejected.includes('不存在的键'));
  ok('已知键仍然写入', r.settings.submitMode === 'auto');
}

console.log('\n=== 单位换算（界面填分钟，内部存毫秒）===');
{
  const r = normalizeSettings({ greenDotPatientMs: 5 }, DEFAULT_SETTINGS); // 5 分钟
  ok('5 分钟 → 300000 毫秒', r.settings.greenDotPatientMs === 300000, String(r.settings.greenDotPatientMs));
  const r2 = normalizeSettings({ 'ai.minIntervalMs': 90 }, DEFAULT_SETTINGS); // 90 秒
  ok('90 秒 → 90000 毫秒', getByPath(r2.settings, 'ai.minIntervalMs') === 90000, String(getByPath(r2.settings, 'ai.minIntervalMs')));
  const r3 = normalizeSettings({ greenDotPatientMs: 2.5 }, DEFAULT_SETTINGS);
  ok('支持 0.5 分钟粒度 → 150000', r3.settings.greenDotPatientMs === 150000, String(r3.settings.greenDotPatientMs));
}

console.log('\n=== 越界夹紧（关键：不能把危险值存进去）===');
{
  const r = normalizeSettings({ 'ai.minIntervalMs': 0 }, DEFAULT_SETTINGS);
  const v = getByPath(r.settings, 'ai.minIntervalMs');
  ok('问千问间隔填 0 → 夹到下限 5 秒', v === 5000, String(v));
  ok('并且明确告知被夹紧', r.errors.some((e) => /超出范围/.test(e)), r.errors[0] || '');

  const r2 = normalizeSettings({ maxRetries: 999 }, DEFAULT_SETTINGS);
  ok('重试次数 999 → 夹到 10', r2.settings.maxRetries === 10);

  const r3 = normalizeSettings({ greenDotPatientMs: 9999 }, DEFAULT_SETTINGS);
  ok('绿点等待 9999 分钟 → 夹到上限 30 分钟', r3.settings.greenDotPatientMs === 1800000, String(r3.settings.greenDotPatientMs));

  const r4 = normalizeSettings({ greenDotPatientMs: -5 }, DEFAULT_SETTINGS);
  ok('负数也夹紧（-5 分钟 → 下限 1 分钟）', r4.settings.greenDotPatientMs === 60000, String(r4.settings.greenDotPatientMs));
}

console.log('\n=== 类型错误要报错 ===');
{
  const r = normalizeSettings({ muted: 'yes' }, DEFAULT_SETTINGS);
  ok('bool 收到字符串 → 报错且不写', r.errors.some((e) => /开关值/.test(e)) && r.settings.muted === DEFAULT_SETTINGS.muted);
  const r2 = normalizeSettings({ maxRetries: 'abc' }, DEFAULT_SETTINGS);
  ok('数字收到非数字 → 报错', r2.errors.some((e) => /不是有效数字/.test(e)));
  const r3 = normalizeSettings({ submitMode: '乱填' }, DEFAULT_SETTINGS);
  ok('select 收到非法值 → 报错', r3.errors.some((e) => /只能是/.test(e)));
}

console.log('\n=== 文本类 ===');
{
  const r = normalizeSettings({ quizPrompt: '请只回答字母' }, DEFAULT_SETTINGS);
  ok('提问词可改', r.settings.quizPrompt === '请只回答字母');
  const long = 'x'.repeat(5000);
  const r2 = normalizeSettings({ quizPrompt: long }, DEFAULT_SETTINGS);
  ok('超长文本被拒', r2.errors.some((e) => /过长/.test(e)));
}

console.log('\n=== 描述与差异（界面用）===');
{
  const rows = describeSettings(DEFAULT_SETTINGS);
  ok('描述表非空', rows.length > 10, `${rows.length} 项`);
  ok('每项都有 label/kind/path', rows.every((r) => r.label && r.kind && r.path));
  const g = rows.find((r) => r.path === 'greenDotPatientMs');
  ok('毫秒项按分钟展示', g && g.value === 6 && g.unit === '分钟', JSON.stringify(g && { v: g.value, u: g.unit }));
  ok('默认值标记正确', rows.every((r) => r.isDefault === true));

  const changed = diffFromDefault({ ...DEFAULT_SETTINGS, submitMode: 'auto', maxRetries: 7 });
  ok('能列出被改过的项', changed.length === 2, JSON.stringify(changed.map((c) => c.path)));
}

console.log('\n=== 稀疏存盘（只写与默认不同的项）===');
{
  const merged = normalizeSettings({ maxRetries: 4, submitMode: 'auto' }, DEFAULT_SETTINGS).settings;
  const sparse = toSparseSettings(merged, DEFAULT_SETTINGS);
  ok('只留被改过的键', Object.keys(sparse).length === 2, JSON.stringify(sparse));
  ok('值正确', sparse.maxRetries === 4 && sparse.submitMode === 'auto');
  const back = normalizeSettings({ maxRetries: 4, submitMode: 'auto' }, DEFAULT_SETTINGS).settings;
  ok('默认值不会被写进文件', sparse.progressThreshold === undefined && back.progressThreshold === DEFAULT_SETTINGS.progressThreshold);
  const none = toSparseSettings(DEFAULT_SETTINGS, DEFAULT_SETTINGS);
  ok('全默认 → 空对象', Object.keys(none).length === 0);
}

console.log('\n=== 不改动传入对象 ===');
{
  const base = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  const snapshot = JSON.stringify(base);
  normalizeSettings({ maxRetries: 9, submitMode: 'auto' }, base);
  ok('base 未被就地修改', JSON.stringify(base) === snapshot);
}

console.log('\n' + '='.repeat(50));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
