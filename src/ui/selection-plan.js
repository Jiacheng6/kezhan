// Shared, deterministic selection rules and named-plan snapshots. No execution.
import { completionOf } from './task-status.js';
import { recalc, typeGroup, inSecRange } from './selection.js';

export const QUICK_RULES = [
  { id: 'unfinished', name: '全部未完成', description: '保留未完成的视频、测验与阅读任务。' },
  { id: 'video', name: '只看视频', description: '只选未完成的视频，取消范围内的其他任务。' },
  { id: 'work', name: '只做测验', description: '只选未完成的章节测验，答案仍需按原设置核对。' },
  { id: 'doc', name: '只读文档', description: '只选未完成的文档与阅读任务。' },
  { id: 'from-next', name: '从下个未完成小节起', description: '从首个未完成任务所在小节起，选择后续未完成任务。' },
  { id: 'range', name: '指定章节范围', description: '只选指定节号区间内的未完成任务，包含起止小节。' },
];

const identity = task => JSON.stringify([task.knowledgeId, task.type, task.name || '', task.cardNum ?? null]);
export function capturePlan(courses) {
  return { courses: courses.filter(c => !c.empty).map(c => ({ courseId: c.courseId, clazzId: c.clazzId || '',
    enabled: c.enabled !== false, tasks: (c.tasks || []).map(t => ({ key: t.key, identity: identity(t), selected: t.policyHandle !== false && !t.excluded })) })) };
}

export function validatePlan(plan) {
  if (!plan || !Array.isArray(plan.courses) || plan.courses.length > 500) throw Error('选课方案格式不正确');
  const ids = new Set(); let total = 0;
  for (const c of plan.courses) {
    if (!c || typeof c.courseId !== 'string' || c.courseId.length > 200 || !c.courseId || ids.has(c.courseId)
      || typeof c.clazzId !== 'string' || c.clazzId.length > 200 || typeof c.enabled !== 'boolean' || !Array.isArray(c.tasks)) throw Error('方案课程信息不正确');
    ids.add(c.courseId); const keys = new Set();
    for (const t of c.tasks) {
      if (++total > 20000 || !t || typeof t.key !== 'string' || !t.key || t.key.length > 500 || keys.has(t.key)
        || typeof t.identity !== 'string' || t.identity.length > 2000 || typeof t.selected !== 'boolean') throw Error('方案任务信息不正确');
      keys.add(t.key);
    }
  }
  return plan;
}

export function applyPlan(courses, plan) {
  validatePlan(plan);
  let matched = 0, missing = 0, added = 0;
  const saved = new Map(plan.courses.map(c => [c.courseId, c]));
  for (const c of courses) {
    const prev = saved.get(c.courseId);
    const same = prev && prev.clazzId === (c.clazzId || '');
    c.enabled = !!same && prev.enabled;
    const tasks = new Map((same ? prev.tasks : []).map(t => [t.key, t]));
    const found = new Set();
    for (const t of c.tasks || []) {
      const old = tasks.get(t.key), matches = old?.identity === identity(t);
      t.excluded = !matches || !old.selected || t.policyHandle === false;
      if (matches) { found.add(t.key); if (prev.enabled && old.selected && t.policyHandle !== false) matched++; }
      else if (t.policyHandle !== false) added++;
    }
    if (same) {
      missing += prev.enabled ? prev.tasks.filter(t => t.selected && !found.has(t.key)).length : 0;
      const order = new Map(prev.tasks.map((t, index) => [t.key, index]));
      c.tasks.sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity));
    }
    recalc(c);
  }
  for (const prev of plan.courses) if (prev.enabled && !courses.some(c => c.courseId === prev.courseId && (c.clazzId || '') === prev.clazzId)) missing += prev.tasks.filter(t => t.selected).length;
  const order = new Map(plan.courses.map((c, index) => [c.courseId, index]));
  courses.sort((a, b) => (order.get(a.courseId) ?? Infinity) - (order.get(b.courseId) ?? Infinity));
  return { matched, missing, added };
}

export function planRule(courses, ruleId, courseIds, { from = '', to = '' } = {}) {
  if (!QUICK_RULES.some(rule => rule.id === ruleId)) throw Error('请选择一个快捷规则');
  if (ruleId === 'range' && (!from && !to || [from, to].some(v => v && !/^\d+(?:\.\d+)?$/.test(v)))) throw Error('请填写有效节号，例如 1.1 至 2.3');
  const scope = new Set(courseIds); const changes = []; let selected = 0, removed = 0;
  for (const c of courses.filter(c => !c.empty && scope.has(c.courseId))) {
    const next = (c.tasks || []).find(t => t.policyHandle !== false && !completionOf(t).finished);
    let reached = ruleId !== 'from-next';
    const chosen = new Set();
    for (const t of c.tasks || []) {
      if (next && t.knowledgeId === next.knowledgeId) reached = true;
      const pick = t.policyHandle !== false && !completionOf(t).finished
        && (ruleId === 'unfinished' || ruleId === 'from-next' && reached
          || ruleId === 'range' && inSecRange(t.secNo, from, to) || typeGroup(t.type) === ruleId);
      if (pick) { chosen.add(t.key); selected++; }
      else if (t.willHandle) removed++;
    }
    changes.push({ courseId: c.courseId, keys: [...chosen] });
  }
  return { changes, selected, removed, courses: changes.length };
}

export function applyRule(courses, preview) {
  for (const change of preview.changes) {
    const c = courses.find(c => c.courseId === change.courseId); if (!c) continue;
    const keys = new Set(change.keys);
    c.enabled = keys.size > 0;
    for (const t of c.tasks || []) t.excluded = !keys.has(t.key);
    recalc(c);
  }
}
