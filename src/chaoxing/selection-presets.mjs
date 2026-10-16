import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PATHS, PERSON_ID } from '../config.mjs';
import { validatePlan } from '../ui/selection-plan.js';

export function readSelectionDocument() {
  try {
    const value = JSON.parse(fs.readFileSync(PATHS.selection, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw Error('选课文件无法读取，请先备份并检查数据，未覆盖原文件');
  }
}
export function writeSelectionDocument(value) {
  fs.mkdirSync(path.dirname(PATHS.selection), { recursive: true });
  const temp = PATHS.selection + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, PATHS.selection);
}
export function listSelectionPresets() {
  return (readSelectionDocument().presets || []).filter(p => p.owner === PERSON_ID).map(({owner, ...preset}) => preset);
}
export function changeSelectionPreset({ action, id, name, plan }) {
  const doc = readSelectionDocument();
  const presets = doc.presets || [];
  if (!Array.isArray(presets)) throw Error('选课方案数据格式不正确');
  const index = presets.findIndex(p => p.id === id && p.owner === PERSON_ID);
  if (!['create', 'replace', 'rename', 'delete'].includes(action)) throw Error('不支持的方案操作');
  if (action !== 'create' && index < 0) throw Error('方案不存在或不属于当前账号');
  if (action !== 'delete') {
    name = typeof name === 'string' ? name.trim() : '';
    if (!name || name.length > 40) throw Error('方案名称需为 1 至 40 个字');
    if (presets.some(p => p.owner === PERSON_ID && p.id !== (action === 'create' ? null : id) && p.name === name)) throw Error('已有同名方案，请换个名称或覆盖原方案');
  }
  if (action === 'create' || action === 'replace') validatePlan(plan);
  if (action === 'create') {
    if (presets.filter(p => p.owner === PERSON_ID).length >= 20) throw Error('最多保存 20 套方案，请先删除不需要的方案');
    id = randomUUID(); presets.push({ id, name, plan, owner: PERSON_ID, updatedAt: new Date().toISOString() });
  } else if (action === 'delete') presets.splice(index, 1);
  else Object.assign(presets[index], { name, updatedAt: new Date().toISOString(), ...(action === 'replace' ? { plan } : {}) });
  writeSelectionDocument({ ...doc, presets });
  return { id, presets: listSelectionPresets() };
}
