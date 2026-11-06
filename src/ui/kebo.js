import { workspace } from './app.js';
import { platformOf, platformInfo, PLATFORMS } from './platforms.js';
import { runScopeRequest, pendingRunTasks } from './run-scope.js';
import { confirmBankUse } from './bank-guide.js';
import { activeTaskPlatforms, renderProgressTrack, renderTaskProgress, platformTaskStatus, totalProgressModel } from './task-progress.js';
const message = document.querySelector('#platformMessage');
// One place to open and scan every platform. Existing action handlers stay intact.
message.setAttribute('role', 'status');
const platformActions = document.querySelector('.platform-web-actions');
const manager = document.createElement('details'); manager.className = 'platform-manager';
manager.innerHTML = '<summary>管理平台</summary><div class="platform-manager-content"><div class="platform-group" data-platform="chaoxing"><span class="group-label">学习通</span><button data-action="openChaoxing">打开网页</button><button data-action="startRecon">扫描课程</button></div></div>';
const managerContent = manager.querySelector('.platform-manager-content');
for (const group of [...platformActions.children]) managerContent.append(group);
platformActions.append(manager);
for (const button of managerContent.querySelectorAll('button')) {
  if (button.id.startsWith('open')) button.textContent = '打开网页';
}
managerContent.addEventListener('click', event => {
  const action = event.target.closest('button[data-action]');
  if (action) [...document.querySelectorAll(`[data-action="${action.dataset.action}"]`)].find(button => !manager.contains(button))?.click();
});
// Native details semantics, predictable dismissal, and focus restoration.
const menus = [...document.querySelectorAll('.platform-manager,.theme-menu,.connection-menu')];
for (const menu of menus) menu.addEventListener('toggle', () => {
  if (menu.open) for (const other of menus) if (other !== menu) other.open = false;
});
document.addEventListener('click', event => {
  for (const menu of menus) if (menu.open && !menu.contains(event.target)) menu.open = false;
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  for (const menu of menus) if (menu.open) { menu.open = false; menu.querySelector('summary').focus(); event.preventDefault(); }
});
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
      const pendingTasks = pendingRunTasks(courses);
      if (!pendingTasks.length) throw Error('所选任务均已完成，无需重复执行');
      if (id === 'chaoxing' && pendingTasks.some(task => task.type === 'work') &&
          !await confirmBankUse(model.status?.settings?.answerBank)) return;
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
  const current = model.platformFilter || 'all';
  const key = JSON.stringify([courses.map(c => [c.courseId, pendingRunTasks([c]).length]), status.platforms, status.progress, status.runStats, status.running, status.aiQueue, status.zhihuishuScan, status.ready, current, [...pending]]);
  if (!force && signature === key) return; signature = key;
  const focused = document.activeElement?.dataset.platformControl;
  const filterSignature = JSON.stringify([current, ids.map(id => [id, courses.filter(c => platformOf(c) === id).length])]);
  if (filters.dataset.signature !== filterSignature) {
  filters.dataset.signature = filterSignature;
  filters.replaceChildren(...['all', ...ids].map(id => {
    const count = courses.filter(c => id === 'all' || platformOf(c) === id).length;
    const b = button(`${id === 'all' ? '全部平台' : platformInfo(id).name} ${count}`, () => {
      workspace.setPlatformFilter(id);
      message.textContent = id === 'all' ? '' : '这里只筛选课程展示，其他平台已勾选的任务仍然保留。';
    });
    b.setAttribute('aria-pressed', String(current === id)); b.dataset.platformControl = 'filter:' + id; return b;
  }));
  }
  let summary = sessions.querySelector('.platform-total');
  if (!summary) {
    summary = document.createElement('div'); summary.className = 'platform-total';
    summary.innerHTML = '<div class="platform-total-caption"><strong>本批总进度</strong><b data-total-percent></b></div><div class="tp-track" role="progressbar" aria-label="全部平台任务总进度" aria-valuemin="0" aria-valuemax="100"><div class="tp-fill"></div></div><div class="platform-total-foot"><span data-total-count></span><small data-total-detail></small></div>';
  }
  const overall = totalProgressModel(status), percent = +(overall.fraction * 100).toFixed(1);
  const count = overall.total ? `完成 ${overall.done} / ${overall.total} 项` : '开始学习后统计';
  summary.querySelector('[data-total-percent]').textContent = overall.total ? `${percent}%` : '—';
  summary.querySelector('[data-total-count]').textContent = count;
  renderProgressTrack(summary.querySelector('[role=progressbar]'), overall.total ? overall.fraction : null, count, overall.running);
  summary.querySelector('[data-total-detail]').textContent = overall.review ? `待审 ${overall.review} 份` : !overall.total ? '' : overall.running ? '进行中' : overall.done === overall.total ? '已完成' : '进度已保存';
  const active = activeTaskPlatforms(status);
  const cards = ids.map(id => {
    const info = platformInfo(id);
    const run = status.platforms?.[id] || (id === 'chaoxing' ? { ...status.progress, running: status.running } : {});
    const ownCourses = courses.filter(c => platformOf(c) === id), selected = pendingRunTasks(ownCourses).length;
    let article = [...sessions.querySelectorAll('.platform-session')].find(node => node.dataset.platform === id);
    if (!article) {
      article = document.createElement('article'); article.className = 'platform-session'; article.dataset.platform = id;
      article.innerHTML = '<strong class="platform-title"></strong><small class="platform-state"></small><div class="tp-track platform-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="tp-fill"></div></div><button class="platform-action"></button><div class="platform-task-progress" hidden></div>';
    }
    const title = article.querySelector('.platform-title'); title.textContent = info.name;
    const state = article.querySelector('.platform-state'); state.textContent = run.error || (run.stopping ? '正在停止…' : run.running ? (run.total ? `本批完成 ${run.done || 0} / ${run.total} 项` : '正在准备任务') : run.phase === 'awaiting-review' ? `待你核对 · ${run.review||0} 份测验未提交` : run.phase === 'completed' ? `本批已完成 ${run.done} / ${run.total} 项` : `${ownCourses.length} 门课程 · 已选 ${selected} 项`);
    state.title = state.textContent;
    const progress = article.querySelector('.platform-track');
    progress.setAttribute('aria-label', `${info.name}本批进度`); progress.hidden = !run.total;
    renderProgressTrack(progress, run.total ? (run.done || 0) / run.total : null, `完成 ${run.done || 0} / ${run.total || 0} 项`, run.running && !run.stopping);
    const action = article.querySelector('.platform-action'); action.textContent = run.running ? '停止此平台' : '开始此平台'; action.onclick = () => control(id, run.running);
    const queued=(status.aiQueue?.pending||[]).filter(item=>item.platform===id).length;
    if(queued)state.textContent=`等待共用 AI · 排队 ${queued} 题 · `+state.textContent;
    if(id==='zhihuishu'&&status.zhihuishuScan?.running){state.textContent=`正在扫描课程 ${(status.zhihuishuScan.index??0)+1}/${status.zhihuishuScan.total||'—'}`;action.textContent='停止扫描';action.onclick=()=>control(id,true);}
    action.dataset.platformControl = 'run:' + id; action.disabled = pending.has(id) || (!run.running && !(id==='zhihuishu'&&status.zhihuishuScan?.running) && (!status.ready || !selected || !PLATFORMS[id]));
    renderTaskProgress(article.querySelector('.platform-task-progress'), active.length > 1 && active.includes(id) ? platformTaskStatus(status, id) : {});
    return article;
  });
  if (sessions.firstElementChild !== summary || cards.some((card, index) => sessions.children[index + 1] !== card)) sessions.replaceChildren(summary, ...cards);
  if (focused) document.querySelector(`[data-platform-control="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}
workspace.subscribe(next => { model = next; render(); });
/*
 * U校园：先在软件内打开站点登录，再扫描课程与必修节点。
 * 扫描只读：不进入学习、不上报进度。
 */
document.querySelector('#openUcampus')?.addEventListener('click', async () => {
  try {
    await post('openUcampus');
    message.textContent = '在软件内登录 U校园 后，点击“扫描 U校园 课程”。播放器要求单独登录时，点课程里的“继续学习”完成一次单点登录。';
  } catch (error) {
    message.textContent = error.message;
  }
});
document.querySelector('#readUcampus')?.addEventListener('click', async (event) => {
  const b = event.currentTarget;
  b.disabled = true;
  try {
    const result = await post('readUcampus');
    await workspace.reload();
    message.textContent = `已汇入 ${result.courses} 门 U校园 课程、${result.nodes} 个必修节点。执行时以平台“已学任务”增长为验收标准。`;
  } catch (error) {
    message.textContent = error.message;
  } finally {
    b.disabled = false;
  }
});

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
