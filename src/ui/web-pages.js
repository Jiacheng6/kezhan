// Pure presentation helpers. Only the desktop's owned pages are offered.
export const taskRoles = new Set(['task', 'video', 'quiz', 'doc']);
export function pageKind(tab) {
  if (taskRoles.has(tab.role)) return tab.busy ? '正在进行的任务' : '学习任务';
  if (tab.role === 'review') return '待审答案';
  if (tab.role?.startsWith('recon') || ['view-status', 'verify-point'].includes(tab.role)) return '课程检查';
  let host = ''; try { host = new URL(tab.url).hostname; } catch {}
  if (/(^|\.)(qianwen\.com|tongyi\.aliyun\.com|doubao\.com|deepseek\.com)$/.test(host)) return 'AI 网页';
  if (/(^|\.)(chaoxing\.com|xueyinonline\.com)$/.test(host)) return '学习通';
  return tab.url === 'about:blank' ? '正在准备' : '网页';
}
export function currentTaskPage(tabs) {
  return tabs.findLast(tab => tab.busy && taskRoles.has(tab.role)) || null;
}
export function sortedPages(tabs) {
  const score = tab => tab.busy && taskRoles.has(tab.role) ? 0 : pageKind(tab) === 'AI 网页' ? 2 : pageKind(tab) === '课程检查' ? 4 : 3;
  return tabs.map((tab, index) => ({ tab, index })).sort((a, b) => score(a.tab) - score(b.tab) || a.index - b.index).map(item => item.tab);
}
