// 任务点完成状态与勾选范围分别计算，小节未完成不代表其中的视频未完成。
export function taskCompletion(task, progress = null) {
  if (task.finished === true || progress?.status === 'done') {
    return { state: 'done', label: '已完成', finished: true,
      source: task.finished === true ? 'platform' : 'local' };
  }
  const labels = { running: '未完成 · 执行中', manual: '未完成 · 待人工',
    failed: '未完成 · 执行失败', skipped: '未完成 · 已跳过' };
  const status = progress?.status;
  return { state: labels[status] ? status : task.finished === false ? 'pending' : 'unknown',
    label: labels[status] || (task.finished === false ? '未完成' : '待确认'),
    finished: false, source: status ? 'local' : 'platform' };
}

export function completionOf(task) {
  return task.completion || taskCompletion(task);
}

export function completionCounts(tasks) {
  const total = (tasks || []).length;
  const done = (tasks || []).filter((t) => completionOf(t).finished).length;
  return { total, done, remaining: total - done };
}

// 刷新时只更新状态，不覆盖用户尚未保存的勾选、排序或课程开关。
export function mergeTaskCompletion(current, fresh) {
  const byKey = new Map((fresh.courses || []).flatMap((c) => c.tasks || []).map((t) => [t.key, t]));
  let changed = false;
  for (const course of current.courses || []) for (const task of course.tasks || []) {
    const next = byKey.get(task.key);
    if (!next) continue;
    const completion = completionOf(next);
    if (JSON.stringify(completionOf(task)) !== JSON.stringify(completion)) {
      task.completion = completion;
      changed = true;
    }
  }
  return changed;
}
