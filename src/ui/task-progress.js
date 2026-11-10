import {animateProgress} from './linear-progress.js';
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
 if(status.reconRunning||status.zhihuishuScan?.running||status.ucampusScan?.running||status.welearnScan?.running)return '正在扫描';
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
  const courseware=String(phase||'').startsWith('courseware-');
  if(courseware)kind='WeLearn 接口任务';
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
  const hint = scanning?'只读扫描，原有进度保留':completed?'以平台任务点完成标记为准':(type==='work'&&p.detail)||p.playbackPhase || current.playbackPhase || (verifying ? '以平台确认结果为准' : !running ? '保留当前进度，可继续学习' : fraction === null ? '页面就绪后显示实际进度' : '');
  const coursewareLabel=phase==='courseware-read'?'读取课件内置答案':phase==='courseware-wait'?'等待并保持会话':phase==='courseware-submit'?'提交答题与学时数据':null;
  const awaitingSubmitted=!running&&status.outcomePhase==='awaiting-review'&&p.submissionAccepted===true;
  return { visible: running || scanning || !!p.current || !!stats.current, running: running || scanning, moving, verifying, fraction, particleRate, usingBank,
    percent: fraction === null ? '—' : (fraction * 100).toFixed(1), kind, label:awaitingSubmitted?'已提交 · 待平台确认':running&&coursewareLabel?coursewareLabel:label,
    title: scanning ? scan.course||'正在整理课程与章节任务' : p.current || [current.courseName, current.secNo, current.name].filter(Boolean).join(' · ') || '等待当前任务页面就绪',
    detail: [detail, !scanning&&type === 'video' && rate ? `实际 ${rate}×` : '', hint].filter(Boolean).join(' · ') };
}

export function taskProgressForecast(status={}){
  const model=taskProgressModel(status),p=status.progress||{},current=status.runStats?.current||{},phase=p.phase||current.phase||'';
  const running=!!status.running&&!status.stopping&&!status.runStats?.paused&&!(p.paused??current.paused)&&!p.stopping&&!(p.resuming??current.resuming);
  const count=p.questionTotal??current.questionTotal,type=p.taskType||current.type;
  let measured=model.fraction??0,rate=0,ceiling=measured,estimated=false;
  if(running){
    if(type==='video'&&Number(p.duration??current.duration)>0){rate=Number(p.playbackRate??current.playbackRate)||1;rate/=Number(p.duration??current.duration);ceiling=Math.min(.99,measured+rate*10);}
    else if(phase==='courseware-wait'&&p.duration>0){rate=1/p.duration;ceiling=.95;estimated=true;}
    else if(type==='work'&&count>0){
      measured=Math.min(.95,measured);const fast=(p.answerSource??current.answerSource)==='bank';
      rate=1/((fast?2:50)*count);ceiling=Math.min(.95,measured+.85/count);estimated=true;
      if(['verifying','submitting','filling'].includes(phase)){rate=.0006;ceiling=.985;}
    }else{rate=1/180;ceiling=.9;estimated=true;}
  }
  return {key:p.taskKey||current.key||model.title,measured,rate,ceiling,running,estimated,complete:status.completed===true};
}

export function batchProgressForecast(status={},id){
  const ids=id?[id]:Object.keys(status.platforms||{});
  if(!id&&!status.platforms?.chaoxing)ids.push('chaoxing');
  let total=0,done=0,partial=0,ceiling=0,rate=0,running=false;
  for(const platform of ids){
    const run=status.platforms?.[platform]||(platform==='chaoxing'?{...status.progress,running:status.running}:{}),n=Number(run.total)||0,d=Math.min(n,Number(run.done)||0);
    total+=n;done+=d;
    if(n>d&&run.running){const f=taskProgressForecast(platformTaskStatus(status,platform));partial+=Math.min(.985,f.measured);ceiling+=Math.min(.985,f.ceiling);rate+=f.running?f.rate:0;running||=f.running;}
  }
  const batchKey=ids.map(platform=>`${platform}:${status.platforms?.[platform]?.startedAt||(platform==='chaoxing'?status.runStats?.startedAt:0)||status.startedAt||0}`).join('|');
  return {key:`batch:${batchKey}:${total}`,measured:total?(done+partial)/total:0,ceiling:total?(done+ceiling)/total:0,rate:total?rate/total:0,running,estimated:running,complete:total>0&&done===total};
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
  root.dataset.indeterminate = String(!!status.reconRunning&&model.fraction === null);
  const part = key => root.querySelector(`[data-tp="${key}"]`);
  const title = part('title');
  root.dataset.reset = String(title.textContent !== model.title || part('kind').textContent !== model.kind);
  for (const key of ['label', 'kind', 'title', 'percent', 'detail']) {
    const element = part(key);
    if (element.textContent !== model[key]) element.textContent = model[key];
  }
  title.title = model.title;
  const forecast=taskProgressForecast(status);
  renderProgressTrack(part('track'), model.fraction, `${model.kind}，${model.label}`, model.moving, model.particleRate, model.usingBank,
    {...forecast,onDisplay:(value,estimated)=>{part('percent').textContent=(value*100).toFixed(1);part('percent').title=estimated?'按当前步骤耗时预估；完成以平台确认为准':'跟随实际进度平滑显示';}});
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

export function renderProgressTrack(track, fraction, label, active = false, particleRate = 1, showEmptyParticles = false, forecast) {
  const transform = `scaleX(${fraction === null ? 0 : clamp(fraction)})`;
  const fill = track.querySelector('.tp-fill');
  if(forecast){const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches||document.documentElement.classList.contains('reduce-motion');animateProgress(track,{...forecast,reduced});}
  else if (fill.style.transform !== transform) fill.style.transform = transform;
  const shown=forecast?Number(track.getAttribute('aria-valuenow'))/100:fraction;
  const particleFraction=forecast&&active?Math.max(shown,forecast.ceiling):shown;
  const particles = showEmptyParticles && particleFraction === 0 ? 'empty' : particleFraction > 0 && particleFraction < 1 ? 'fill' : '';
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
  if(!forecast){if (fraction === null) track.removeAttribute('aria-valuenow');
  else track.setAttribute('aria-valuenow', String(Number((clamp(fraction) * 100).toFixed(1))));}
  track.setAttribute('aria-valuetext', label);
}
