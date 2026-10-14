import fs from 'node:fs';
import path from 'node:path';

// 值来自被忽略的本机报告，不将真实名称写进公共源码或检查日志。
export function collectLearningTerms(value) {
  const terms = new Set();
  const add = (text) => {
    if (typeof text !== 'string') return;
    text = text.trim();
    if (text.length < 5 || text.length > 120 || /^(?:[\d._-]+\.(?:mp4|mp3|pdf|pptx?)|示例|测试|fixture)/i.test(text)) return;
    terms.add(text);
  };
  const visit = (item, context = '') => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) { item.forEach((child) => visit(child, context)); return; }
    if (/courses|sections|tasks|taskPoints|items/.test(context)) add(item.name);
    for (const field of ['courseName', 'sectionName', 'schoolName', 'studentName']) add(item[field]);
    for (const [key, child] of Object.entries(item)) if (child && typeof child === 'object') visit(child, key === 'taskPoints' ? 'taskPoints' : /taskPoints/.test(context) ? 'taskPoints' : key);
  };
  visit(value);
  return [...terms];
}

export function loadLearningTerms(root, extraRoots = []) {
  const terms = new Set();
  const roots = new Set([root, ...extraRoots].filter(Boolean).map((p) => path.resolve(p)));
  for (const base of roots) {
    for (const relative of ['state.json', 'data/probe-out/task-report.json', '.privacy-blocklist.local.json']) {
      const file = path.join(base, relative);
      if (!fs.existsSync(file)) continue;
      const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, ''));
      if (relative === '.privacy-blocklist.local.json') {
        for (const term of value.terms || []) if (typeof term === 'string' && term.length >= 2) terms.add(term);
      } else for (const term of collectLearningTerms(value)) terms.add(term);
    }
  }
  return [...terms];
}

export function containsLearningTerms(text, terms) {
  return terms.some((term) => text.includes(term));
}
