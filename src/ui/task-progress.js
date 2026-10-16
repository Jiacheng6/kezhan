const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = value => Math.min(1, Math.max(0, value));
const clock = value => {
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
};

export function taskProgressModel(status = {}) {
  const p = status.progress || {}, stats = status.runStats || {}, current = stats.current || {};
  const running = !!status.running, scanning = !!status.reconRunning;
  const type = p.taskType || current.type;
  const phase = p.phase || current.phase;
  const questionIndex = p.questionIndex ?? current.questionIndex;
  const questionTotal = p.questionTotal ?? current.questionTotal;
  const currentTime = p.currentTime ?? current.currentTime;
  const duration = p.duration ?? current.duration;
  let fraction = finite(p.percent) ? clamp(p.percent) : finite(current.progress) ? clamp(current.progress) : null;
  let kind = type === 'video' ? '播放进度' : ['doc', 'read'].includes(type) ? '阅读进度' : '当前任务';
  let detail = '';
  if (type === 'work' && finite(questionIndex) && questionTotal > 0) {
    const answered = Math.max(0, Math.min(questionTotal, questionIndex + (phase === 'done' ? 1 : 0)));
    fraction = answered / questionTotal; kind = '答题进度'; detail = `已处理 ${answered} / ${questionTotal} 题`;
  } else if (finite(currentTime) && duration > 0) detail = `${clock(currentTime)} / ${clock(duration)}`;
  if (scanning) { fraction = null; kind = '课程扫描'; }
  const verifying = phase === 'verifying';
  const label = scanning ? '正在读取课程' : !running ? '已停止' : verifying ? '核对平台状态' : phase === 'quiz' ? '处理视频弹题' : phase === 'asking' ? '正在读取 AI 回答' : fraction === null ? '正在准备任务' : '任务进行中';
  const rate = p.playbackRate ?? current.playbackRate;
  const hint = p.playbackPhase || current.playbackPhase || (verifying ? '以平台确认结果为准' : !running ? '保留当前进度，可继续学习' : fraction === null ? '页面就绪后显示实际进度' : '');
  return { visible: running || scanning || !!p.current || !!stats.current, running: running || scanning, verifying, fraction,
    percent: fraction === null ? '—' : (fraction * 100).toFixed(1), kind, label,
    title: scanning ? '正在整理课程与章节任务' : p.current || [current.courseName, current.secNo, current.name].filter(Boolean).join(' · ') || '等待当前任务页面就绪',
    detail: [detail, type === 'video' && rate ? `实际 ${rate}×` : '', hint].filter(Boolean).join(' · ') };
}

export function renderTaskProgress(root, status) {
  if (!root) return;
  if (!root.dataset.mounted) {
    root.classList.add('task-progress'); root.dataset.mounted = 'true';
    root.innerHTML = `<div class="tp-caption"><span class="tp-state"><i aria-hidden="true"></i><span data-tp="label"></span></span><span data-tp="kind"></span></div>
      <div class="tp-reading"><p data-tp="title"></p><span class="tp-percent"><strong data-tp="percent"></strong><small>%</small></span></div>
      <div class="tp-track" data-tp="track" role="progressbar" aria-label="当前任务进度" aria-valuemin="0" aria-valuemax="100"><div class="tp-fill" data-tp="fill"></div></div>
      <div class="tp-foot"><span data-tp="detail"></span><button class="tp-view" data-open-web="task">查看任务网页 <span aria-hidden="true">↗</span></button></div>`;
  }
  const model = taskProgressModel(status);
  root.hidden = !model.visible;
  root.dataset.running = String(model.running); root.dataset.verifying = String(model.verifying);
  root.dataset.indeterminate = String(model.fraction === null);
  const part = key => root.querySelector(`[data-tp="${key}"]`);
  for (const key of ['label', 'kind', 'title', 'percent', 'detail']) part(key).textContent = model[key];
  part('title').title = model.title;
  part('fill').style.width = model.fraction === null ? '28%' : `${model.fraction * 100}%`;
  if (model.fraction === null) part('track').removeAttribute('aria-valuenow');
  else part('track').setAttribute('aria-valuenow', String(Number(model.percent)));
  part('track').setAttribute('aria-valuetext', `${model.kind} ${model.fraction === null ? '等待进度' : model.percent + '%'}，${model.label}`);
}
