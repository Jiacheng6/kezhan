const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = value => Math.min(1, Math.max(0, value));
const clock = value => {
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
};

// Never use the aggregated current task as the other platform's progress.
export function platformTaskStatus(status = {}, id) {
  const run = status.platforms?.[id] || {};
  const legacy = id === 'chaoxing' && !status.platforms?.chaoxing;
  const progress = { ...(legacy ? status.progress : run.progress), current: run.current || (legacy ? status.progress?.current : run.progress?.current) };
  if (id === 'zhihuishu' && progress.taskType === 'work') {
    const stage = progress.phase;
    if (finite(progress.questionIndex)) progress.questionIndex = Math.max(0, progress.questionIndex - 1);
    if (stage === 'save-next') progress.phase = 'done';
    if (stage === 'ask-ai') progress.phase = 'asking';
    if (stage === 'filled-all') { progress.questionIndex = Math.max(0, (progress.questionTotal || 1) - 1); progress.phase = 'done'; }
  }
  return { running: legacy ? status.running : run.running, stopping: run.stopping, progress,
    completed:run.phase==='completed'&&run.total>0&&run.done===run.total,
    outcomePhase:run.phase,
    runStats: id === 'chaoxing' ? status.runStats : null };
}

export function totalProgressModel(status = {}) {
  const runs = Object.entries(status.platforms || {}).map(([id, run]) =>
    id === 'chaoxing' ? { ...run, review: run.review ?? status.runStats?.review } : run);
  if (!status.platforms?.chaoxing) runs.push({ ...status.progress, review: status.runStats?.review, running: status.running });
  const count = value => finite(value) ? Math.max(0, Math.floor(value)) : 0;
  const total = runs.reduce((n, run) => n + count(run.total), 0);
  const done = runs.reduce((n, run) => n + Math.min(count(run.done), count(run.total)), 0);
  const review = runs.reduce((n, run) => n + count(run.review), 0);
  return { total, done, review, running: runs.some(run => run.running && !run.stopping), fraction: total ? done / total : 0 };
}

export function activeTaskPlatforms(status = {}) {
  const ids = Object.keys(status.platforms || {}).filter(id => status.platforms[id].running);
  if (status.running && !status.platforms?.chaoxing) ids.unshift('chaoxing');
  return ids;
}

export function mainTaskStatus(status, active = activeTaskPlatforms(status)) {
  if (status.reconRunning) return status;
  if (active.length > 1) return {};
  if (active.length === 1) return platformTaskStatus(status, active[0]);
  return status;
}

export function runSummaryLabel(status={}){
 const runs=Object.values(status.platforms||{}).filter(run=>run.running||run.total>0||run.error);
 if(status.reconRunning||status.zhihuishuScan?.running)return '正在扫描';
 if(status.running||runs.some(run=>run.running))return '进行中';
 if(status.runStats?.paused||runs.some(run=>['needs-human','failed'].includes(run.phase)||run.error))return '已暂停 · 待处理';
 if(runs.some(run=>run.phase==='awaiting-review'||run.review>0))return '待你核对';
 if(runs.length&&runs.every(run=>run.phase==='completed'&&run.done===run.total))return '已完成';
 return status.runStats||runs.length?'已停止':'尚未开始';
}

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
  const completed=status.completed===true&&!running&&!scanning;
  if(completed){fraction=1;kind='任务完成进度';if(type==='video'&&detail)detail='播放记录 '+detail;}
  const scan=status.reconProgress||{};
  if (scanning) { fraction = null; kind = '课程扫描';detail=scan.total?`课程 ${scan.index}/${scan.total}${scan.sections?` · 小节 ${scan.section}/${scan.sections}`:''}`:''; }
  const verifying = phase === 'verifying';
  const stopping = status.stopping || p.stopping;
  const resuming = p.resuming ?? current.resuming;
  const videoPaused = type === 'video' && (p.paused ?? current.paused) === true;
  const moving = scanning || (running && !stopping && !resuming && !stats.paused && !verifying && !videoPaused && phase !== 'quiz');
  const usingBank = !scanning && type === 'work' && (p.answerSource ?? current.answerSource) === 'bank';
  const rate = p.playbackRate ?? current.playbackRate;
  const fastParticles = usingBank || (!scanning && type === 'video' && Number(rate) === 2);
  const particleRate = fastParticles ? 1.65 : 1;
  const label = completed?'平台已确认完成':scanning ? '正在读取课程' : stats.paused ? '已暂停 · 需要处理' : !running ? status.outcomePhase==='awaiting-review'?'待你核对 · 尚未提交':['needs-human','failed'].includes(status.outcomePhase)?'需要处理后继续':'已停止' : stopping ? '正在停止' : resuming ? '正在恢复任务' : verifying ? '核对平台状态' : phase === 'quiz' ? '处理视频弹题' : videoPaused ? '播放已暂停' : phase === 'bank-lookup' ? '正在查询题库' : usingBank ? '正在回填题库答案' : phase === 'asking' ? '正在读取 AI 回答' : fraction === null ? '正在准备任务' : '任务进行中';
  const hint = scanning?'只读扫描，原有进度保留':completed?'以平台任务点完成标记为准':p.playbackPhase || current.playbackPhase || (verifying ? '以平台确认结果为准' : !running ? '保留当前进度，可继续学习' : fraction === null ? '页面就绪后显示实际进度' : '');
  return { visible: running || scanning || !!p.current || !!stats.current, running: running || scanning, moving, verifying, fraction, particleRate, usingBank,
    percent: fraction === null ? '—' : (fraction * 100).toFixed(1), kind, label,
    title: scanning ? scan.course||'正在整理课程与章节任务' : p.current || [current.courseName, current.secNo, current.name].filter(Boolean).join(' · ') || '等待当前任务页面就绪',
    detail: [detail, !scanning&&type === 'video' && rate ? `实际 ${rate}×` : '', hint].filter(Boolean).join(' · ') };
}

export function renderTaskProgress(root, status) {
  if (!root) return;
  if (!root.dataset.mounted) {
    root.classList.add('task-progress'); root.dataset.mounted = 'true';
    root.innerHTML = `<div class="tp-caption"><span class="tp-state"><i aria-hidden="true"></i><span data-tp="label"></span></span><span data-tp="kind"></span></div>
      <div class="tp-reading"><p data-tp="title"></p><span class="tp-percent"><strong data-tp="percent"></strong><small>%</small></span></div>
      <div class="tp-track" data-tp="track" role="progressbar" aria-label="当前任务进度" aria-valuemin="0" aria-valuemax="100"><div class="tp-fill"></div><div class="tp-sweep" aria-hidden="true"></div></div>
      <div class="tp-foot"><span data-tp="detail"></span><button class="tp-view" data-open-web="task">查看任务网页 <span aria-hidden="true">↗</span></button></div>`;
  }
  const model = taskProgressModel(status);
  root.hidden = !model.visible;
  root.dataset.running = String(model.running); root.dataset.verifying = String(model.verifying);
  root.dataset.moving = String(model.moving);
  root.dataset.indeterminate = String(model.fraction === null);
  const part = key => root.querySelector(`[data-tp="${key}"]`);
  const title = part('title');
  root.dataset.reset = String(title.textContent !== model.title || part('kind').textContent !== model.kind);
  for (const key of ['label', 'kind', 'title', 'percent', 'detail']) {
    const element = part(key);
    if (element.textContent !== model[key]) element.textContent = model[key];
  }
  title.title = model.title;
  renderProgressTrack(part('track'), model.fraction, `${model.kind} ${model.fraction === null ? '等待进度' : model.percent + '%'}，${model.label}`, model.moving, model.particleRate, model.usingBank);
}

function syncParticleAnimation(track, animation) {
  if (animation.animationName !== 'particle-flow') return;
  const rate = Number(track.dataset.particleRate);
  if (animation.playbackRate !== rate) {
    // Updating the playback rate keeps the animation at the same position.
    animation.updatePlaybackRate(rate);
  }
  if (track.dataset.active === 'true') {
    if (animation.playState === 'paused') animation.play();
  } else if (animation.playState !== 'paused') animation.pause();
}

export function renderProgressTrack(track, fraction, label, active = false, particleRate = 1, showEmptyParticles = false) {
  const transform = `scaleX(${fraction === null ? 0 : clamp(fraction)})`;
  const fill = track.querySelector('.tp-fill');
  if (fill.style.transform !== transform) fill.style.transform = transform;
  const particles = showEmptyParticles && fraction === 0 ? 'empty' : fraction > 0 && fraction < 1 ? 'fill' : '';
  const moving = String(active && !!particles);
  const rate = String(particleRate);
  if (track.dataset.particles !== particles || track.dataset.active !== moving || track.dataset.particleRate !== rate) {
    if (!track.dataset.particleRate) {
      // Covers new CSS animations after the page or particle style becomes visible.
      track.addEventListener('animationstart', event => {
        if (event.animationName === 'particle-flow') {
          for (const animation of event.target.getAnimations({ subtree: true })) syncParticleAnimation(track, animation);
        }
      });
    }
    track.dataset.particles = particles;
    track.dataset.active = moving;
    track.dataset.particleRate = rate;
    if (particles) for (const animation of track.getAnimations({ subtree: true })) syncParticleAnimation(track, animation);
  }
  if (fraction === null) track.removeAttribute('aria-valuenow');
  else track.setAttribute('aria-valuenow', String(Number((clamp(fraction) * 100).toFixed(1))));
  track.setAttribute('aria-valuetext', label);
}
