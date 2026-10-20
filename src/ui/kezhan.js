import { workspace } from './app.js';
import { platformOf, platformInfo, PLATFORMS } from './platforms.js';
import { runScopeRequest } from './run-scope.js';
const message = document.querySelector('#platformMessage');
const filters = document.querySelector('#platformFilters'), sessions = document.querySelector('#platformSessions');
let model = workspace.snapshot(), signature = '', pending = new Set();
async function post(name, body = {}) {
  const response = await fetch('/api/action/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!result.ok || result.result?.ok === false) throw Error(result.error || result.result?.error || '操作未完成');
  return result.result;
}
function button(text, click) { const b = document.createElement('button'); b.textContent = text; b.onclick = click; return b; }
async function control(id, stop) {
  pending.add(id); render(true);
  try {
    if (stop) await post('stopRun', { platform: id });
    else {
      const courses = model.checklist?.courses.filter(c => platformOf(c) === id) || [];
      const scope = runScopeRequest(courses);
      if (!scope.taskKeys.length) throw Error('请先勾选这个平台的任务');
      const saved = await workspace.save(); if (!saved?.ok) throw Error('选课范围保存失败');
      await post('startRun', { ...scope, platform: id });
    }
    message.textContent = stop ? `${platformInfo(id).name}正在停止，其他平台继续运行。` : `${platformInfo(id).name}已启动；可同时启动其他平台。`;
  } catch (error) { message.textContent = error.message; }
  finally { pending.delete(id); render(true); }
}
function render(force = false) {
  const courses = model.checklist?.courses || [], status = model.status || {};
  const ids = [...new Set([...Object.keys(PLATFORMS), ...courses.map(platformOf)])];
  document.body.dataset.multiPlatform = String(new Set(courses.map(platformOf)).size > 1);
  document.body.dataset.multiRunning = String(Object.values(status.platforms || {}).filter(run => run.running).length > 1);
  const current = model.platformFilter || 'all';
  const key = JSON.stringify([courses.map(c => [c.courseId, c.tasks?.filter(t => t.willHandle).length]), status.platforms, status.aiQueue, status.zhihuishuScan, status.ready, current, [...pending]]);
  if (!force && signature === key) return; signature = key;
  const focused = document.activeElement?.dataset.platformControl;
  filters.replaceChildren(...['all', ...ids].map(id => {
    const count = courses.filter(c => id === 'all' || platformOf(c) === id).length;
    const b = button(`${id === 'all' ? '全部平台' : platformInfo(id).name} ${count}`, () => {
      workspace.setPlatformFilter(id);
      message.textContent = id === 'all' ? '' : '这里只筛选课程展示，其他平台已勾选的任务仍然保留。';
    });
    b.setAttribute('aria-pressed', String(current === id)); b.dataset.platformControl = 'filter:' + id; return b;
  }));
  sessions.replaceChildren(...ids.map(id => {
    const info = platformInfo(id), run = status.platforms?.[id] || { running: id === 'chaoxing' && status.running };
    const ownCourses = courses.filter(c => platformOf(c) === id), selected = runScopeRequest(ownCourses).taskKeys.length;
    const article = document.createElement('article'); article.className = 'platform-session'; article.dataset.platform = id;
    const title = document.createElement('strong'); title.textContent = info.name;
    const state = document.createElement('small'); state.textContent = run.error || (run.stopping ? '正在停止…' : run.running ? `学习中 · ${run.done || 0}/${run.total || 0} · ` + (run.current || '准备任务') : run.phase === 'awaiting-review' ? `待你核对 · ${run.review||0} 份测验未提交` : run.phase === 'completed' ? `本批已完成 ${run.done}/${run.total}` : `${ownCourses.length} 门课程 · 已选 ${selected} 项`);
    const progress = document.createElement('progress'); progress.max = run.total || 1; progress.value = run.done || 0;
    progress.setAttribute('aria-label', `${info.name}本批完成 ${run.done || 0}/${run.total || 0}`); progress.hidden = !run.total;
    const action = button(run.running ? '停止此平台' : '开始此平台', () => control(id, run.running));
    const queued=(status.aiQueue?.pending||[]).filter(item=>item.platform===id).length;
    if(queued)state.textContent=`等待共用 AI · 排队 ${queued} 题 · `+state.textContent;
    if(id==='zhihuishu'&&status.zhihuishuScan?.running){state.textContent=`正在扫描课程 ${(status.zhihuishuScan.index??0)+1}/${status.zhihuishuScan.total||'—'}`;action.textContent='停止扫描';action.onclick=()=>control(id,true);}
    action.dataset.platformControl = 'run:' + id; action.disabled = pending.has(id) || (!run.running && !(id==='zhihuishu'&&status.zhihuishuScan?.running) && (!status.ready || !selected || !PLATFORMS[id]));
    article.append(title, state, progress, action); return article;
  }));
  if (focused) document.querySelector(`[data-platform-control="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}
workspace.subscribe(next => { model = next; render(); });
document.querySelector('#openZhihuishu').onclick = async () => {
  try {
    if (!window.desktopApp?.webCommand) throw Error('请在桌面软件中打开智慧树');
    await window.desktopApp.webCommand({ action: 'open-zhihuishu' });
    message.textContent = '在软件内登录智慧树后，点击“扫描智慧树课程”，自动逐课读取目录。';
  } catch (error) { message.textContent = error.message; }
};
document.querySelector('#readZhihuishu').onclick = async event => {
  const b = event.currentTarget; b.disabled = true;
  try { const result = await post('readZhihuishu'); await workspace.reload(); message.textContent = `已汇入 ${result.courses} 门智慧树课程、${result.videos} 个视频。${result.unrecognized ? '部分课程需先进入课程页面才能识别。' : ''}`; }
  catch (error) { message.textContent = error.message; } finally { b.disabled = false; }
};
