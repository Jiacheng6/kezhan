// Shared by the UI and service: a run is bound to explicit task identities,
// never to the course currently in focus or to whatever was saved later.
export function selectedRunTasks(courses = []) {
  return courses.filter(c => !c.empty && c.enabled !== false).flatMap(c =>
    (c.tasks || []).filter(t => t.willHandle === true && !t.excluded && t.policyHandle !== false)
      .map(t => ({ ...t, courseId:t.courseId || c.courseId, clazzId:t.clazzId || c.clazzId, courseName:c.name })));
}
export function runScopeRequest(courses) {
  const tasks = selectedRunTasks(courses);
  const identities = tasks.map(t => [t.key,t.courseId,t.clazzId,t.knowledgeId,t.type,t.name].map(v => String(v ?? '')))
    .sort((a,b) => a[0].localeCompare(b[0]));
  return { taskKeys:tasks.map(t => t.key), selection:JSON.stringify(identities) };
}
export function assertRunScope(courses, request) {
  if (!request || !Array.isArray(request.taskKeys) || !request.taskKeys.length || request.taskKeys.length > 30000
    || request.taskKeys.some(key => typeof key !== 'string') || new Set(request.taskKeys).size !== request.taskKeys.length
    || typeof request.selection !== 'string') throw Error('本次任务范围缺失或无效，已取消执行。请在选课页核对后重新开始。');
  const expected = runScopeRequest(courses);
  const keys = new Set(request.taskKeys);
  if (expected.taskKeys.length !== keys.size || !expected.taskKeys.every(key => keys.has(key)) || expected.selection !== request.selection) {
    throw Error('界面选择与已保存范围不一致，已取消执行；不会扩大到其他任务。请重新读取清单并核对。');
  }
  return selectedRunTasks(courses);
}
export function selectOnlyTask(courses, key) {
  const owner = courses.find(c => !c.empty && (c.tasks || []).some(t => t.key === key && t.policyHandle !== false));
  if (!owner) throw Error('该任务不可选择，请重新读取清单。');
  for (const c of courses) {
    c.enabled = c === owner;
    for (const t of c.tasks || []) {
      t.excluded = t.key !== key;
      t.willHandle = c.enabled && t.policyHandle !== false && !t.excluded;
    }
  }
}
export function clearRunSelection(courses) {
  for (const c of courses) {
    c.enabled = false;
    for (const t of c.tasks || []) { t.excluded = true; t.willHandle = false; }
  }
}
export function selectCourseTasks(course, selected) {
  course.enabled = !!selected;
  for (const t of course.tasks || []) {
    t.excluded = !selected || t.policyHandle === false;
    t.willHandle = !!selected && t.policyHandle !== false;
  }
}
