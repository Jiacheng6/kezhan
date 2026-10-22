/* 学习通刷课控制台 —— 前端逻辑（原生 JS + ES module，无构建） */

/*
 * 选择算术全部放在 selection.js（纯函数，可在 Node 里单测：
 * tools/test/test-selection.mjs）。这里只负责"渲染 + 接线"。
 * 注意：index.html 里这个脚本必须以 type="module" 引入，否则 import 不生效。
 */
import {
  batchSelect,
  batchSelectBookChapter,
  batchSelectChapter,
  chapterState,
  selectionState,
  tasksOf,
  keepFirstN,
  willSummary,
  willList,
  courseVisible,
  courseNameMatches,
  matchesQuery,
  recalc,
} from './selection.js';
import { completionOf, completionCounts, courseCompletion, sectionCompletion, mergeTaskCompletion } from './task-status.js';
import { changePanel, expandCourse, preserveTreeFocus } from './motion.js';
import { createSelectionDesk } from './selection-desk.js';
import { renderTaskProgress } from './task-progress.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

import { runScopeRequest, pendingRunTasks } from './run-scope.js';

const state = {
  status: null,
  logs: [],
  autoScroll: true,
  filter: '',
};
import { platformOf, platformBadge } from './platforms.js';
const workspaceListeners = new Set();
let platformFilter = 'all';
let checklistLoading = true;
const workspaceSnapshot = () => ({ status: state.status, checklist: tree.data, dirty: tree.dirty, loading: checklistLoading, platformFilter });
function emitWorkspace() {
  for (const callback of workspaceListeners) {
    try { callback(workspaceSnapshot()); } catch (error) { console.warn('首页更新失败', error); }
  }
}
// Both home views use the same selection, status and action implementation.
export const workspace = Object.freeze({
  snapshot: workspaceSnapshot,
  subscribe(callback) { workspaceListeners.add(callback); callback(workspaceSnapshot()); return () => workspaceListeners.delete(callback); },
  navigate: switchTab,
  action: runAction,
  reload: loadChecklist,
  setPlatformFilter(id) {
    platformFilter = id; renderTree(); selectionDesk.render(); emitWorkspace();
  },
  save: saveSelection,
  refresh: refreshTreeProgress,
  selectCourse(courseId, enabled) {
    const course = tree.data?.courses.find(c => c.courseId === courseId);
    if (!course || state.status?.running || state.status?.reconRunning) return;
    course.enabled = enabled; recalc(course); tree.dirty = true; renderTree();
  },
  selectTask(courseId, key, selected) {
    const course = tree.data?.courses.find(c => c.courseId === courseId);
    const task = course?.tasks.find(t => t.key === key);
    if (!task || task.policyHandle === false || state.status?.running || state.status?.reconRunning) return;
    if (selected) course.enabled = true;
    task.excluded = !selected; recalc(course); tree.dirty = true; renderTree();
  },
  onlyUnfinished(courseId) {
    if (!tree.data?.courses.some(course => course.courseId === courseId) || state.status?.running || state.status?.reconRunning) return;
    for (const course of tree.data.courses) {
      course.enabled = course.courseId === courseId;
      if (course.enabled) for (const task of course.tasks) task.excluded = completionOf(task).finished;
      recalc(course);
    }
    tree.dirty = true; renderTree();
  },
  openCourse(courseId) {
    selectionDesk.focusCourse(courseId);
    if(courseCompletion(tree.data?.courses.find(c=>c.courseId===courseId)||{}).finished)tree.completedOpen=true;
    tree.expanded.add(courseId); tree.query = ''; $('#treeSearch').value = '';
    switchTab('courses'); if (tree.data) renderTree();
  },
});
const compactLayout = matchMedia('(max-width:1100px)');
let readinessLayoutState = '';
compactLayout.addEventListener('change', () => { if (state.status) renderReadinessLayout(state.status); });

// 原生展开菜单可用键盘操作；点击外部或 Escape 时收起。
const menuSelector = '.connection-menu[open], .inline-menu[open], .course-info[open], .selection-tools[open], .course-actions[open], .desktop-more[open], .workspace-utilities[open]';
document.addEventListener('click', (event) => {
  for (const menu of $$(menuSelector)) if (!menu.contains(event.target)) menu.open = false;
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  for (const menu of $$(menuSelector)) {
    if (menu.contains(document.activeElement)) menu.querySelector('summary')?.focus();
    menu.open = false;
  }
});

/* ---------------- 标签页 ---------------- */
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const previous = $('.panel.active');
    $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.tab').forEach((b) => {
      if (b === btn) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    const name = btn.dataset.tab;
    document.body.dataset.panel = name;
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
    changePanel(previous, document.getElementById('panel-' + name));
    $('#pageTitle').textContent = ({ overview: '学习工作台', courses: '选课与学习', review: '待审答案', logs: '运行记录', settings: '偏好设置' })[name] || '学习空间';
  });
});

$$('[data-navigate]').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.navigate));
});

function switchTab(name) {
  const btn = $(`.tab[data-tab="${name}"]`);
  if (btn) btn.click();
}

/* ---------------- 渲染：状态 ---------------- */
function setPill(el, text, kind) {
  el.textContent = text;
  el.className = `pill${kind ? ` ${kind}` : ''}`;
}

function setCheck(id, pass, text) {
  const li = $(`#${id}`);
  if (!li) return;
  li.classList.remove('pass', 'fail', 'wait');
  li.classList.add(pass === true ? 'pass' : pass === false ? 'fail' : 'wait');
  const st = li.querySelector('.st');
  if (st) st.textContent = text;
}

function renderStatus(s) {
  const reconJustFinished = state.status?.reconRunning && !s.reconRunning;
  state.status = s;

  // 顶栏
  const edgeOk = !!s.edge?.connected;
  setPill($('#pillEdge'), edgeOk ? '网页引擎已连接' : '网页引擎未连接', edgeOk ? 'ok' : 'bad');
  const loggedIn = !!s.login?.loggedIn;
  setPill($('#pillLogin'), loggedIn ? '已登录' : '未登录', loggedIn ? 'ok' : 'warn');
  /*
   * 这两颗灯以前是「只侦察模式」（读 settings.reconOnly）——
   * 但那个开关**从来只影响这颗灯**，不影响任何行为：脚本一直在真刷课、真答题。
   * 结果界面上永远挂着一颗"只侦察模式"，用户以为它不会动手。
   * 现在改成两颗**说真话**的灯：提交模式 + 答题通道。
   */
  const playbackNote = $('#overviewPlayback');
  if (playbackNote) playbackNote.textContent = `优先 ${s.settings?.playbackSpeed || 1}× · ${s.settings?.videoCompletionMode === 'check90' ? '90% 先核对，未完成继续' : '播到片尾后核对'}`;
  const submitAuto = s.settings?.submitMode === 'auto';
  setPill(
    $('#pillRecon'),
    submitAuto ? '提交：自动（仅高可靠）' : '提交：人工确认',
    submitAuto ? 'ok' : 'warn',
  );
  const qOk = !!s.qianwen?.loggedIn;
  const aiLabel=s.ai?.label||({doubao:'豆包',deepseek:'DeepSeek'}[s.settings?.ai?.provider]||'千问');
  setPill($('#pillQuiz'), qOk ? `答题通道：${aiLabel}就绪` : `答题通道：未登录${aiLabel}`, qOk ? 'ok' : 'warn');
  const channelTitle=$('#readyQianwen b');if(channelTitle)channelTitle.textContent=`${aiLabel}答题通道`;

  $('#phaseLine').textContent = s.running ? '任务运行中 · 隐藏窗口后继续运行' : '选择课程后开始 · 进度自动保存';

  // 概览：浏览器
  $('#kEdgeState').textContent = edgeOk ? '已连接，可在后台运行' : '等待连接';
  $('#kEdgeVersion').textContent = s.edge?.version || '—';
  $('#kDebugPort').textContent = s.debugPort || '—';
  $('#kProfile').textContent = s.edgeProfile || '—';

  // 概览：登录
  $('#kLoginState').textContent = loggedIn ? '已登录' : '未登录';
  $('#kLoginReason').textContent = s.login?.reason || '—';
  $('#kLoginTitle').textContent = s.login?.title || s.login?.url || '—';

  // 概览：账号 ID（自动识别结果 —— 让使用者能确认"不用手填"是真的生效了）
  const acc = s.account || {};
  $('#kPersonId').textContent = acc.personId
    ? `${acc.personId}（${acc.source === 'auto' ? `自动识别：${acc.detail || '已写入 local.json'}` : '读自 local.json'}）`
    : '未识别 —— 登录后会自动识别并写入 local.json';

  // 概览：任务
  const p = s.progress || {};
  $('#kDone').textContent = p.done ?? 0;
  $('#kTotal').textContent = p.total ?? 0;
  $('#kCurrent').textContent = [p.current || '空闲', p.playbackRate ? `实际 ${p.playbackRate}×` : '', p.playbackPhase || ''].filter(Boolean).join(' · ');
  $('#kRunning').textContent = s.running ? '运行中' : '未运行';
  $('#overviewReviewCount').textContent = s.reviewCount ?? 0;
  $('#overviewQianwen').textContent = qOk ? '已登录，答题通道就绪' : `使用答题功能前请登录${aiLabel}`;
  for (const [id, ready] of [['readyBrowser', edgeOk], ['readyLogin', loggedIn], ['readyQianwen', qOk]]) {
    $(`#${id}`).classList.toggle('ready', ready);
  }
  renderReadinessLayout(s);
  const activity = $('#overviewActivity');
  const paused = !s.running && s.runStats?.paused;
  activity.textContent = paused ? '已暂停 · 待处理' : s.reconRunning ? '正在扫描' : s.running ? '学习进行中' : !loggedIn ? '等待登录' : '已就绪';
  activity.classList.toggle('running', !!s.running || !!s.reconRunning);
  $('#overviewHeadline').textContent = paused ? '任务尚未完成，需要你处理' : s.reconRunning ? '正在整理课程清单' : s.running ? '学习任务运行中' : !loggedIn ? '先登录学习通' : '准备开始学习';
  $('#overviewSubtitle').textContent = s.reconRunning ? s.reconProgress?.total ? `正在扫描第 ${s.reconProgress.index}/${s.reconProgress.total} 门课程${s.reconProgress.sections?` · 小节 ${s.reconProgress.section}/${s.reconProgress.sections}`:''}，原有进度保留。` : '正在读取课程与章节任务，原有进度会保留。' : s.running ? '你可以返回工作台，任务会继续运行。' : !loggedIn ? '在软件内打开学习通登录，再检测登录状态。' : '选择课程与任务范围，再开始这一次学习。';
  if (paused) $('#overviewSubtitle').textContent = s.runStats.pauseReason || '请查看通知与待审答案，处理后重新开始。';
  const sessionPercent = p.total ? Math.min(100, ((p.done || 0) / p.total) * 100) : 0;
  $('#overviewProgressFill').style.width = `${sessionPercent}%`;
  $('#overviewSessionProgress').classList.toggle('hidden', !p.total && !s.running);
  $('#overviewSessionDetails').classList.toggle('hidden', !p.total && !s.running);
  $('#overviewProgressTitle').textContent = s.running ? '本次已完成' : '最近一次运行';
  renderOverviewSelection();

  // 概览：本次运行范围（避免"以为只刷一门，其实刷了全部"）
  const sc = s.runScope;
  const scopeEl = $('#kScope');
  if (scopeEl) {
    if (!sc) scopeEl.textContent = '—';
    else {
      const types = Object.entries(sc.byType || {})
        .map(([k, v]) => `${k} ${v}`)
        .join(' · ');
      scopeEl.textContent = `${(sc.courses || []).length} 门课 · ${sc.tasks || 0} 个任务点${types ? '（' + types + '）' : ''}`;
      scopeEl.title = (sc.courses || []).join('\n');
    }
  }

  // 概览：环境
  $('#kRoot').textContent = s.root || '—';
  $('#kNode').textContent = s.node || '—';
  $('#kPid').textContent = s.pid || '—';

  // 验收清单
  setCheck('ck-edge', edgeOk ? true : null, edgeOk ? '通过' : '等待');
  setCheck('ck-cdp', edgeOk ? true : null, edgeOk ? '通过' : '等待');
  setCheck('ck-console', true, '通过');
  setCheck(
    'ck-login',
    loggedIn ? true : false,
    loggedIn ? '通过' : s.login?.reason || '需要登录',
  );

  // 启动错误横幅
  const banner = $('#bootError');
  if (s.bootError) {
    banner.textContent = `启动遇到问题：\n${s.bootError}`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  // 设置页
  renderSettings(s);

  // 执行状态条
  renderTaskProgress($('#overviewTaskProgress'), s);
  renderTaskProgress($('#runTaskProgress'), s);
  renderRunBar(s);

  // 待审队列计数
  $('#reviewCount').textContent = s.reviewCount ?? 0;
  if (!tree.data) renderOverviewCourses();
  if (reconJustFinished && !tree.dirty) loadChecklist().catch(() => {});
  selectionDesk.updateStatus();
  emitWorkspace();
}

function renderReadinessLayout(s) {
  const ready = !!s.edge?.connected && !!s.login?.loggedIn && !!s.qianwen?.loggedIn;
  const key = `${compactLayout.matches}:${ready}`;
  if (key !== readinessLayoutState) {
    $('#readinessDetails').open = !compactLayout.matches || !ready;
    readinessLayoutState = key;
  }
  $('.overview-rail').classList.toggle('all-ready', ready);
  $('#readinessTitle').textContent = compactLayout.matches && ready ? '连接已就绪' : '连接与登录';
  $('#readinessIndex').textContent = compactLayout.matches && ready ? '3 项已就绪 · 展开查看' : '01—03';
}

/** 执行中/停止状态条 */
function renderRunBar(s) {
  const bar = $('#runBar');
  const p = s.progress || {};
  const st = s.runStats;
  const running = !!s.running || !!s.reconRunning;
  const hasSelectedTasks = !!tree.data && willSummary(tree.data.courses).tasks > 0;

  /*
   * 按钮可用性必须无条件更新 —— 之前放在"状态条显示"的早退之后，
   * 结果空闲时「开始」按钮保持 HTML 里的 disabled，"停止"反而可用，正好反了。
   */
  $$('[data-action="startRun"]').forEach((runBtn) => {
    runBtn.disabled = running || !s.ready || !s.edge?.connected || !s.login?.loggedIn || !hasSelectedTasks;
    const count = tree.data ? pendingRunTasks(tree.data.courses).length : 0;
    if(!count)runBtn.disabled=true;
    runBtn.textContent = s.reconRunning ? '正在扫描课程…' : running ? '学习进行中…' : `开始学习（${count} 项）↗`;
  });
  $$('[data-action="stopRun"]').forEach((stopBtn) => { stopBtn.disabled = !running; });
  $$('[data-action="startRecon"]').forEach((btn) => { btn.disabled = running || !s.ready || !s.edge?.connected || !s.login?.loggedIn; });

  if (!bar) return;

  // 有进度或有统计才显示状态条
  const show = running || (st && (st.done || st.failed || st.review || st.handbook || st.paused));
  bar.classList.toggle('hidden', !show);
  if (!show) return;

  const total = p.total || st?.total || 0;
  const done = st?.done ?? p.done ?? 0;
  const failed = st?.failed ?? 0;
  const cur = p.current || '';

  $('#runLabel').textContent = st?.paused ? '已暂停，待处理' : running ? '本次已完成' : '运行已停止';
  $('#runProg').textContent = `${done} / ${total}`;
  $('#runFill').style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;

  const parts = [`完成 ${done}/${total}`];
  if (p.playbackRate) parts.push(`实际 ${p.playbackRate}×`);
  if (p.playbackPhase) parts.push(p.playbackPhase);
  if (failed) parts.push(`失败 ${failed}`);
  if (st?.review) parts.push(`待审 ${st.review}`);
  if (st?.handbook) parts.push(`待人工 ${st.handbook}`);
  if (st?.resumes) parts.push(`纠偏 ${st.resumes}`);
  $('#runSub').innerHTML =
    `${parts.join(' · ')}` + (cur && $('#runTaskProgress').hidden ? `<br><span class="muted">当前：${escapeHtml(cur)}</span>` : '');
}

/* ---------------- 设置（可编辑，落盘 state.json） ---------------- */

/** 设置表单的本地状态：改动先攒在这里，点保存才落盘 */
const settingsForm = { rows: [], readonly: [], changed: [], dirty: false };

async function loadSettingsForm() {
  const box = $('#settingsForm');
  const adv = $('#settingsAdvanced');
  if (!box) return;
  try {
    const r = await fetch('/api/settings').then((x) => x.json());
    if (!r.ok) throw new Error(r.error || '读取失败');
    settingsForm.rows = r.result.rows || [];
    settingsForm.readonly = r.result.readonly || [];
    settingsForm.changed = r.result.changed || [];
    settingsForm.dirty = false;
    renderSettingsForm();
  } catch (err) {
    box.innerHTML = `<p class="placeholder">读取设置失败：${escapeHtml(err.message)}</p>`;
  }
}

function renderSettingsForm() {
  const box = $('#settingsForm');
  const adv = $('#settingsAdvanced');
  if (!box) return;
  box.innerHTML = '';
  if (adv) adv.innerHTML = '';

  for (const row of settingsForm.rows) {
    const host = row.advanced && adv ? adv : box;
    host.appendChild(renderSettingRow(row));
  }

  // 只读项
  const ro = $('#settingsReadonly');
  if (ro) {
    ro.innerHTML = settingsForm.readonly
      .map((r) => {
        let v = r.value;
        if (typeof v === 'number' && /Ms$/.test(r.path)) v = `${Math.round(v / 1000)} 秒`;
        return `<dt>${escapeHtml(r.label)}</dt><dd class="mono">${escapeHtml(String(v))}` +
          (r.hint ? ` <span class="muted">${escapeHtml(r.hint)}</span>` : '') +
          `</dd>`;
      })
      .join('');
  }

  const pill = $('#settingsDirty');
  if (pill) {
    const n = settingsForm.changed.length;
    pill.textContent = settingsForm.dirty ? '有未保存改动' : n ? `已改 ${n} 项` : '默认值';
    pill.className = `pill${settingsForm.dirty ? ' warn' : n ? '' : ''}`;
  }
}

/** 一行设置：按 kind 渲染对应控件。控件用 data-setting 标识，避免动态 id 干扰检查工具 */
function renderSettingRow(row) {
  const wrap = el('div', 'setrow');
  const left = el('div', 'setlabel');
  left.appendChild(el('span', 'setname', row.label));
  if (row.help) left.appendChild(el('span', 'sethelp', row.help));
  if (!row.isDefault) left.appendChild(el('span', 'chip', '非默认'));
  wrap.appendChild(left);

  const right = el('div', 'setctl');
  let input;

  if (row.kind === 'bool') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!row.value;
    input.dataset.setting = row.path;
    input.addEventListener('change', () => markDirty(row.path, input.checked));
  } else if (row.kind === 'select') {
    input = document.createElement('select');
    input.dataset.setting = row.path;
    for (const [value, label] of row.options || []) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      if (String(row.value) === String(value)) opt.selected = true;
      input.appendChild(opt);
    }
    input.addEventListener('change', () => markDirty(row.path, input.value));
  } else if (row.kind === 'textarea') {
    input = document.createElement('textarea');
    input.rows = 3;
    input.dataset.setting = row.path;
    input.value = row.value ?? '';
    input.addEventListener('input', () => markDirty(row.path, input.value));
  } else if (row.kind === 'int' || row.kind === 'number') {
    input = document.createElement('input');
    input.type = 'number';
    input.dataset.setting = row.path;
    if (row.min != null) input.min = row.min;
    if (row.max != null) input.max = row.max;
    if (row.step != null) input.step = row.step;
    input.value = row.value ?? '';
    input.addEventListener('input', () => markDirty(row.path, input.value));
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.dataset.setting = row.path;
    input.value = row.value ?? '';
    input.addEventListener('input', () => markDirty(row.path, input.value));
  }

  input.className = 'setinput';
  input.setAttribute('aria-label',row.label);
  right.appendChild(input);
  if (row.unit) right.appendChild(el('span', 'setunit', row.unit));
  if (row.kind === 'int' || row.kind === 'number') {
    if (row.min != null || row.max != null) {
      right.appendChild(
        el('span', 'setrange', `允许 ${row.min ?? '-∞'} ~ ${row.max ?? '+∞'}${row.unit || ''}`),
      );
    }
  }
  wrap.appendChild(right);
  return wrap;
}

/** 记录改动（数字按"界面单位"暂存，保存时服务端会换算回内部单位） */
function markDirty(path, rawValue) {
  settingsForm.dirty = true;
  settingsForm.pending = settingsForm.pending || {};
  settingsForm.pending[path] = rawValue;
  const pill = $('#settingsDirty');
  if (pill) {
    pill.textContent = `有未保存改动（${Object.keys(settingsForm.pending).length} 项）`;
    pill.className = 'pill warn';
  }
}

async function saveSettingsForm() {
  const patch = settingsForm.pending || {};
  if (!Object.keys(patch).length) {
    appendLog({ t: Date.now(), level: 'info', message: '设置没有改动，无需保存' });
    return { ok: true, noop: true };
  }
  const btn = $('#saveSettings');
  if (btn) {
    btn.classList.add('busy');
    btn.textContent = '保存中…';
  }
  try {
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch }),
    }).then((x) => x.json());
    if (!r.ok) {
      appendLog({ t: Date.now(), level: 'error', message: `设置保存失败：${r.error || '未知错误'}` });
      return r;
    }
    const res = r.result || {};
    for (const e of res.errors || []) {
      appendLog({ t: Date.now(), level: 'warn', message: `设置已夹紧：${e}` });
    }
    appendLog({
      t: Date.now(),
      level: 'ok',
      message: `设置已保存（${Object.keys(res.applied || {}).length} 项）${(res.errors || []).length ? '，部分值被夹紧到允许范围' : ''}`,
    });
    settingsForm.pending = {};
    await loadSettingsForm();
    await refreshTreeProgress();
    return r;
  } finally {
    if (btn) {
      btn.classList.remove('busy');
      btn.textContent = '保存设置';
    }
  }
}

function renderSettings(s) {
  // 设置页现在是可编辑表单：只有在还没加载过时才拉一次
  if (!settingsForm.rows.length) {
    loadSettingsForm();
  } else if (s && s.settings) {
    // 状态推送里带了最新设置（比如别的标签页改过）→ 没本地改动就跟着刷新
    if (!settingsForm.dirty) {
      const changed = JSON.stringify(s.settings) !== JSON.stringify(settingsForm.lastSeen || null);
      if (changed) {
        settingsForm.lastSeen = s.settings;
        loadSettingsForm();
      }
    }
  }
}

/* ---------------- 渲染：日志 ---------------- */
function logLine(entry) {
  const div = document.createElement('div');
  div.className = `logline ${entry.level}`;
  const t = new Date(entry.t).toLocaleTimeString('zh-CN', { hour12: false });
  div.innerHTML = `<span class="ts">${t}</span><span class="msg"></span>`;
  div.querySelector('.msg').textContent = (entry.platform ? `【${entry.platform === 'zhihuishu' ? '智慧树' : '学习通'}】` : '') + entry.message;
  div.dataset.raw = entry.message.toLowerCase();
  return div;
}

function matchesFilter(div) {
  if (!state.filter) return true;
  return div.dataset.raw.includes(state.filter);
}

function appendLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > 2000) state.logs.shift();
  const view = $('#logView');
  const div = logLine(entry);
  if (!matchesFilter(div)) div.style.display = 'none';
  view.appendChild(div);
  while (view.childElementCount > 2000) view.removeChild(view.firstChild);
  if (state.autoScroll) view.scrollTop = view.scrollHeight;
}

function renderAllLogs() {
  const view = $('#logView');
  view.innerHTML = '';
  for (const entry of state.logs) {
    const div = logLine(entry);
    if (!matchesFilter(div)) div.style.display = 'none';
    view.appendChild(div);
  }
  if (state.autoScroll) view.scrollTop = view.scrollHeight;
}

$('#autoScroll').addEventListener('change', (e) => {
  state.autoScroll = e.target.checked;
  if (state.autoScroll) $('#logView').scrollTop = $('#logView').scrollHeight;
});
$('#logFilter').addEventListener('input', (e) => {
  state.filter = e.target.value.trim().toLowerCase();
  $$('#logView .logline').forEach((d) => {
    d.style.display = matchesFilter(d) ? '' : 'none';
  });
});
$('#clearLogs').addEventListener('click', () => {
  state.logs = [];
  $('#logView').innerHTML = '';
});

/* ---------------- 动作 ---------------- */
async function runAction(name, btn) {
  const label = btn ? btn.textContent : name;
  let runRequest = null;

  /*
   * 「开始执行」前强制对齐选择。
   *
   * 用户实际踩过的坑：在课程树里勾了要刷的课，忘了点「保存选择」，
   * 于是执行用的是**上一次保存的**范围（甚至只有一门别的课），
   * 看起来就是"我选的课它不刷，只刷另一门"。
   * 这里不再靠用户记性：只要有未保存改动，先自动保存再开始。
   */
  if (name === 'startRun') {
    if (!tree.data) return {ok:false,error:'请先读取清单并选择任务'};
    runRequest = runScopeRequest(tree.data.courses);
    if (!runRequest.taskKeys.length) return {ok:false,error:'请先选择至少一个任务'};
    if(!pendingRunTasks(tree.data.courses).length)return {ok:false,error:'所选任务均已完成，无需重复执行'};
    try {
      const r = await saveSelection();
      if (r && r.ok) {
        if (tree.dirty || runScopeRequest(tree.data.courses).selection !== runRequest.selection) {
          throw Error('保存期间选课范围发生变化，已取消开始，请核对任务数量后重试');
        }
        appendLog({ t: Date.now(), level: 'ok', message: `本次明确选择 ${runRequest.taskKeys.length} 项任务，已保存并核对范围` });
      } else {
        appendLog({
          t: Date.now(),
          level: 'error',
          message: `课程选择自动保存失败，已中止执行：${r?.error || '未知错误'}（请手动点「保存选择」）`,
        });
        return { ok: false, error: r?.error || '课程选择保存失败' };
      }
    } catch (err) {
      appendLog({ t: Date.now(), level: 'error', message: `课程选择自动保存异常，已中止执行：${err.message}` });
      return { ok: false, error: err.message };
    }
  }

  if (btn) {
    btn.classList.add('busy');
    btn.dataset.old = label;
    btn.textContent = '执行中…';
  }
  try {
    const res = await fetch(`/api/action/${name}`, { method: 'POST', ...(runRequest ? {
      headers:{'content-type':'application/json'},body:JSON.stringify(runRequest),
    } : {}) });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) {
      appendLog({ t: Date.now(), level: 'error', message: `动作 ${name} 失败：${body.error || res.status}` });
    }
    return body;
  } catch (err) {
    appendLog({ t: Date.now(), level: 'error', message: `动作 ${name} 请求失败：${err.message}` });
    return { ok: false, error: err.message };
  } finally {
    if (btn) {
      btn.classList.remove('busy');
      btn.textContent = btn.dataset.old || label;
      if (state.status && ['startRun', 'stopRun', 'startRecon'].includes(name)) renderRunBar(state.status);
    }
  }
}

$$('[data-action]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const name = btn.dataset.action;

    // 下面这几个是"前端动作"：需要读当前界面状态或从专属接口拉数据，
    // 不能让它们走 /api/action/ 转发路线，否则点了按钮什么也不会发生。
    if (name === 'saveSelection' || name === 'loadChecklist' || name === 'loadReview' || name === 'submitAllReviews') {
      const old = btn.textContent;
      btn.classList.add('busy');
      btn.textContent = '处理中…';
      try {
        if (name === 'saveSelection') {
          const r = await saveSelection();
          if (!r || r.ok === false) {
            appendLog({ t: Date.now(), level: 'error', message: `保存失败：${r?.error || '未知错误'}` });
          }
        } else if (name === 'loadChecklist') {
          await loadChecklist();
        } else if (name === 'loadReview') {
          await loadReview();
        } else if (name === 'submitAllReviews') {
          await submitReviewedAnswers({all:true});
          await loadReview();
        }
      } catch (err) {
        appendLog({ t: Date.now(), level: 'error', message: `${name} 异常：${err.message}` });
      } finally {
        btn.classList.remove('busy');
        btn.textContent = old;
      }
      return;
    }

    const result = await runAction(name, btn);
    document.dispatchEvent(new CustomEvent('workspace-action-result', { detail: { name, result } }));
  });
});

/* ---------------- WebSocket ---------------- */
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'status') renderStatus(msg.data);
    else if (msg.type === 'log') appendLog(msg.data);
    else if (msg.type === 'logs') {
      state.logs = msg.data || [];
      renderAllLogs();
    }
  };

  ws.onclose = () => {
    appendLog({ t: Date.now(), level: 'warn', message: '与后台的连接断开，3 秒后重连…' });
    setTimeout(connectWS, 3000);
  };
  ws.onerror = () => ws.close();
}

/* ---------------- 课程树 / 任务点清单 ---------------- */

const tree = {
  data: null, // { courses, summary }
  dirty: false,
  query: '', // 搜索词
  expanded: new Set(), // 展开的课程 courseId
  previewOpen: false,
  completedOpen: false,
  completedSectionsOpen: new Map(),
};
const selectionDesk = createSelectionDesk({ root: $('#selectionDesk'), snapshot: workspaceSnapshot,
  change() { tree.dirty = true; renderTree(); }, save: saveSelection, navigate: switchTab, action: runAction,openDiscussionSettings });

async function openDiscussionSettings(){
  switchTab('settings');await loadSettingsForm();
  const input=document.querySelector('[data-setting="discussionDrafts"]');input?.scrollIntoView({block:'center'});input?.focus();
}

// 暴露到 window，便于在浏览器控制台里排查（不影响正常使用）
window.__console = {
  tree,
  loadChecklist,
  renderTree,
  refreshTreeProgress,
  saveSelection,
  // 选择算术也挂上：排查"点了没反应"这类问题时可以直接在控制台里调
  selection: { willSummary, willList, batchSelect, batchSelectBookChapter, batchSelectChapter, keepFirstN, recalc },
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function loadChecklist() {
  checklistLoading = true;
  try {
  const res = await fetch('/api/checklist');
  const body = await res.json();
  if (!body.ok) {
    $('#treeSummary').textContent = body.error || '读取清单失败';
    $('#treeSource').textContent = '未加载';
    return;
  }
  if (!body.result) {
    $('#treeSummary').textContent = '还没有侦察数据。点「重新侦察」抓取。';
    $('#treeSource').textContent = '无数据';
    renderOverviewCourses();
    return;
  }
  tree.data = body.result;
  tree.dirty = false;
  $('#treeSource').textContent = '已加载';
  renderTree();
  } finally { checklistLoading = false; emitWorkspace(); }
}

let progressRefreshing = false;
async function refreshTreeProgress() {
  if (!tree.data || progressRefreshing) return;
  progressRefreshing = true;
  try {
    const body = await (await fetch('/api/checklist')).json();
    if (body.ok && body.result && mergeTaskCompletion(tree.data, body.result)) renderTree();
  } catch { /* 后台恢复连接后继续刷新，不改变当前选择。 */ }
  finally { progressRefreshing = false; }
}

setInterval(() => {
  const library = document.getElementById('libraryHome');
  if ($('#panel-review')?.classList.contains('active')&&!state.status?.running)void loadReview({passive:true}).catch(()=>{});
  if ($('#panel-courses').classList.contains('active') || (library && !library.hidden)) refreshTreeProgress();
}, 5000);

function renderOverviewSelection() {
  const selection = willSummary(tree.data?.courses || []);
  const s = state.status || {};
  const names = selection.list.map((c) => c.name);
  const hasCourses = (tree.data?.courses || []).some((c) => !c.empty);
  const primary = $('#overviewStart');
  primary.dataset.action = hasCourses ? 'startRun' : 'startRecon';
  if (!hasCourses) primary.textContent = s.reconRunning ? '正在扫描课程…' : '扫描课程 ↗';
  $('#overviewSelectedNames').textContent = names.join(' / ');
  $('#overviewSelectedNames').title = names.join('、');
  if (s.login?.loggedIn && !s.running && !s.reconRunning && !s.runStats?.paused) {
    $('#overviewSubtitle').textContent = selection.tasks
      ? `已选 ${selection.courses} 门课 · ${selection.tasks} 个任务，已完成的内容会自动跳过。`
      : hasCourses ? '课程清单已保留，可在课程树中查看待完成与已完成内容。' : '先扫描课程，再选择这次要学习的范围。';
  }
}

function renderOverviewCourses() {
  renderOverviewSelection();
  const courses = tree.data?.courses || [];
  const progress = completionCounts(courses.flatMap((c) => c.tasks || []));
  $('#overviewTaskCount').textContent = progress.total;
  $('#overviewDoneCount').textContent = progress.done;
  const box = $('#overviewCourses');
  box.innerHTML = '';
  const visible = courses.filter((c) => !c.empty && (platformFilter === 'all' || platformOf(c) === platformFilter));
  if (!visible.length) {
    box.appendChild(el('p', 'placeholder', '还没有课程清单。首次使用先扫描课程，之后会自动读取。'));
    const scan = el('button', 'text-button', '扫描课程 →');
    scan.addEventListener('click', () => runAction('startRecon', scan));
    scan.disabled = !state.status?.ready || !state.status?.edge?.connected;
    box.appendChild(scan);
    return;
  }
  visible.forEach((course, index) => {
    const progress = completionCounts(course.tasks);
    const row = el('button', 'ledger-row');
    row.appendChild(el('span', 'ledger-number', String(index + 1).padStart(2, '0')));
    const name = el('span', 'ledger-name');
    name.appendChild(el('b', null, course.name));
    name.appendChild(platformBadge(course));
    name.appendChild(el('small', null, `${course.sections.length} 个小节 · 清单内 ${progress.total} 个任务`));
    row.appendChild(name);
    const completion=courseCompletion(course);
    row.appendChild(el('span', 'ledger-remaining', completion.finished?'已完成':progress.remaining?`${progress.remaining} 项待完成`:completion.label));
    row.appendChild(el('span', 'ledger-arrow', '↗'));
    row.addEventListener('click', () => {
      if(completion.finished)tree.completedOpen=true;
      tree.expanded.add(course.courseId);
      tree.query = '';
      $('#treeSearch').value = '';
      selectionDesk.focusCourse(course.courseId);
      switchTab('courses');
      renderTree();
    });
    box.appendChild(row);
  });
}

const courseViews = new WeakMap();
const completionGroups=new Map();
function syncChildren(parent,nodes){
  const retained=new Set(nodes);
  for(const child of [...parent.children])if(!retained.has(child))child.remove();
  nodes.forEach((node,index)=>{if(parent.children[index]!==node)parent.insertBefore(node,parent.children[index]||null);});
}
function completionGroup(id,label,count,matching,query){
  if(!completionGroups.has(id)){
    const node=el('section','course-completion-group');node.dataset.completionGroup=id;
    const heading=el('button','completion-group-heading');heading.type='button';
    const content=el('div','completion-group-content');content.id=`course-group-${id}`;
    heading.setAttribute('aria-controls',content.id);
    if(id==='completed')heading.onclick=()=>{tree.completedOpen=!tree.completedOpen;renderTree();};
    else heading.disabled=true;
    node.append(heading,content);completionGroups.set(id,{node,heading,content});
  }
  const group=completionGroups.get(id),open=id==='pending'||tree.completedOpen||!!query;
  group.heading.textContent=`${id==='completed'?(open?'▾ ':'▸ '):''}${label} ${count} 门${query?` · 匹配 ${matching} 门`:''}`;
  group.heading.setAttribute('aria-expanded',String(open));group.content.hidden=!open;
  return group;
}
function renderTree() {
  const body = $('#treeBody');
  const summary = $('#treeSummary');
  if (!tree.data) return;
  renderOverviewCourses();

  const s = tree.data.summary;
  const progress = completionCounts(tree.data.courses.flatMap((c) => c.tasks || []));
  const completedCount=tree.data.courses.filter(course=>courseCompletion(course).finished).length;
  summary.innerHTML =
    `共 <b>${s.totalCourses}</b> 门课 · 已完成 <b>${completedCount}</b> 门 · 待完成 <b>${s.totalCourses-completedCount}</b> 门 · 已读取任务点 <b>${s.totalTasks}</b> 个 · ` +
    `已完成 <b>${progress.done}</b> · 未完成 <b>${progress.remaining}</b>`;

  const q = tree.query || '';
  preserveTreeFocus(body, () => {
  const grouped={pending:[],completed:[]};
  for (const c of tree.data.courses) {
    if (platformFilter !== 'all' && platformOf(c) !== platformFilter) continue;
    if (!courseVisible(c, q)) continue;
    const signature = JSON.stringify([q, c, tree.expanded.has(c.courseId),tree.completedSectionsOpen.get(c.courseId)]);
    let cached = courseViews.get(c);
    if (!cached || cached.signature !== signature) {
      cached = { signature, node: renderCourse(c, q) };
      courseViews.set(c, cached);
    }
    grouped[courseCompletion(c).finished?'completed':'pending'].push(cached.node);
  }
  const nodes=[];
  for(const [id,label,total]of [['pending','待完成',tree.data.courses.length-completedCount],['completed','已完成',completedCount]]){
    const group=completionGroup(id,label,total,grouped[id].length,q);
    syncChildren(group.content,grouped[id].length?grouped[id]:[el('p','placeholder',q?'本组没有匹配的课程。':id==='completed'?'暂无已完成课程。':'暂无待完成课程。')]);
    nodes.push(group.node);
  }
  syncChildren(body,nodes);
  });

  renderWillSummary();
  renderPreview();
  if (state.status) renderRunBar(state.status);

  // 待人工清单
  const hb = s.handbook || [];
  const card = $('#handbookCard');
  if (hb.length) {
    card.style.display = '';
    const rows = hb
      .map(
        (h) =>
          `<tr><td>${escapeHtml(h.course)}</td><td class="mono">${escapeHtml(h.secNo || '')}</td>` +
          `<td>${escapeHtml(h.typeName || h.type)}</td><td>${escapeHtml(h.name || h.sectionName || '')}</td>` +
          `<td>${escapeHtml(h.reason || '')}</td></tr>`,
      )
      .join('');
    $('#handbookBody').innerHTML =
      `<table class="hbtable"><thead><tr><th>课程</th><th>小节</th><th>类型</th><th>名称</th><th>原因</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`;
  } else {
    card.style.display = 'none';
  }
}

/** 类型范围勾选框的当前状态（工具条与汇总条共用） */
function scopeOf() {
  return {
    video: $('#scopeVideo')?.checked !== false,
    work: $('#scopeWork')?.checked !== false,
    doc: $('#scopeDoc')?.checked !== false,
    other: $('#scopeDoc')?.checked !== false,
  };
}

/** 常驻汇总条：本次到底会刷什么（用户最想要的"看得见"） */
function renderWillSummary() {
  renderOverviewSelection();
  if (state.status) renderRunBar(state.status);
  const box = $('#treeWillSummary');
  if (!box || !tree.data) return;
  const s = willSummary(tree.data.courses);
  const by = s.byType;
  const parts = [];
  if (by.video) parts.push(`视频 ${by.video}`);
  if (by.work) parts.push(`测验 ${by.work}`);
  if (by.doc) parts.push(`文档 ${by.doc}`);
  if (by.other) parts.push(`其它 ${by.other}`);

  if (!s.tasks) {
    box.innerHTML = `<b class="warn">尚未选择任务</b> <span class="muted">勾选需要学习的课程或任务</span>`;
  } else {
    // 类型范围没全勾时明确提示，免得"为什么只有视频"
    const sc = scopeOf();
    const off = Object.entries(sc)
      .filter(([, v]) => !v)
      .map(([k]) => ({ video: '视频', work: '测验', doc: '文档', other: '其它' })[k]);
    box.innerHTML =
      `已选 <b>${s.courses}</b> 门课 · <b>${s.tasks}</b> 个任务` +
      (parts.length ? ` <span class="muted">（${parts.join(' · ')}）</span>` : '') +
      (off.length ? ` <span class="warn">（类型范围不含：${off.join('、')}）</span>` : '');
  }
  const dirty = $('#treeDirty');
  if (dirty) dirty.classList.toggle('hidden', !tree.dirty);
  selectionDesk.render();
  emitWorkspace();
}

/** 预览：逐条列出将被执行的任务点 */
function renderPreview() {
  const box = $('#treePreview');
  if (!box) return;
  if (!tree.previewOpen || !tree.data) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const list = willList(tree.data.courses);
  const rows = list
    .slice(0, 300)
    .map(
      (t) =>
        `<tr><td>${escapeHtml(t.course)}</td><td class="mono">${escapeHtml(t.secNo || '')}</td>` +
        `<td>${escapeHtml(t.type)}</td><td>${escapeHtml(t.sectionName || '')}</td>` +
        `<td>${escapeHtml(t.name || '')}</td></tr>`,
    )
    .join('');
  box.classList.remove('hidden');
  box.innerHTML =
    `<div class="tphead">将执行 <b>${list.length}</b> 个任务点` +
    (list.length > 300 ? `（下表只显示前 300 条）` : '') +
    `</div>` +
    `<table class="hbtable"><thead><tr><th>课程</th><th>小节</th><th>类型</th><th>小节名</th><th>任务点</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`;
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/** 课程树工具条：全选/反选/按类型/节号区间/搜索/预览/展开收起 */
function bindTreeTools() {
  const onlyVisible = () => !!$('#onlyVisible')?.checked;
  const rangeOf = () => ({
    from: ($('#secFrom')?.value || '').trim(),
    to: ($('#secTo')?.value || '').trim(),
  });
  const afterChange = (msg) => {
    tree.dirty = true;
    renderTree();
    if (msg) appendLog({ t: Date.now(), level: 'info', message: msg });
  };

  const search = $('#treeSearch');
  if (search) {
    search.addEventListener('input', () => {
      tree.query = search.value.trim();
      renderTree();
    });
  }

  for (const btn of $$('[data-tree]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = btn.dataset.tree;
      if (!tree.data) {
        appendLog({ t: Date.now(), level: 'warn', message: '还没有清单，先「读取清单」或「重新侦察」' });
        return;
      }
      const q = onlyVisible() ? tree.query : '';
      const scope = scopeOf();
      const { from, to } = rangeOf();
      /*
       * ⚠ 节号区间**只对"区间按钮"生效**，不参与全选/反选/按类型。
       *
       * 实测踩坑：区间输入框填过值以后不会自动清空，而早期实现把 from/to
       * 传给了所有批量操作 —— 于是"全选"被悄悄限制成"只选 1.1~1.2"，
       * 表现就是"点了全选没反应"。区间这类**有状态的筛选条件**必须和
       * 无状态的一键操作分开，否则用户根本猜不到为什么没生效。
       */
      const rangeOpts = { scope, query: q, from, to };
      const plainOpts = { scope, query: q };

      if (act === 'select' || act === 'deselect' || act === 'invert') {
        const r = batchSelect(tree.data.courses, act, plainOpts);
        afterChange(
          act === 'select'
            ? `已勾选 ${r.changed} 个任务点`
            : act === 'deselect'
              ? `已取消 ${r.changed} 个任务点`
              : `反选完成，变动 ${r.changed} 个任务点`,
        );
      } else if (act === 'unfinished') {
        const r = batchSelect(tree.data.courses, 'select', { ...plainOpts, finishedOnly: true });
        afterChange(`已勾选 ${r.changed} 个「未完成」任务点（已完成的保持原样）`);
      } else if (act === 'scopeSelect' || act === 'scopeDeselect') {
        const action = act === 'scopeSelect' ? 'select' : 'deselect';
        const r = batchSelect(tree.data.courses, action, plainOpts);
        afterChange(`按类型范围${action === 'select' ? '勾选' : '取消'}了 ${r.changed} 个任务点`);
      } else if (act === 'rangeSelect' || act === 'rangeDeselect') {
        if (!from && !to) {
          appendLog({ t: Date.now(), level: 'warn', message: '先在「节号区间」里填起点/终点，例如 2.1 ~ 2.9' });
          return;
        }
        const action = act === 'rangeSelect' ? 'select' : 'deselect';
        const r = batchSelect(tree.data.courses, action, rangeOpts);
        afterChange(`节号 ${from || '*'} ~ ${to || '*'}：${action === 'select' ? '勾选' : '取消'} ${r.changed} 个`);
      } else if (act === 'clearRange') {
        const f = $('#secFrom');
        const t2 = $('#secTo');
        if (f) f.value = '';
        if (t2) t2.value = '';
        appendLog({ t: Date.now(), level: 'info', message: '已清空节号区间（一键操作本来就不受区间影响）' });
      } else if (act === 'preview') {
        tree.previewOpen = !tree.previewOpen;
        btn.textContent = tree.previewOpen ? '收起预览' : '预览任务';
        renderPreview();
      } else if (act === 'expandAll' || act === 'collapseAll') {
        tree.completedOpen=act==='expandAll';
        for(const course of tree.data.courses)tree.completedSectionsOpen.set(course.courseId,act==='expandAll');
        const all = $$('#treeBody .treecourse');
        for (const w of all) {
          const open = act === 'expandAll';
          if (open) tree.expanded.add(w.dataset.courseId); else tree.expanded.delete(w.dataset.courseId);
          expandCourse(w, open);
          const caret = w.querySelector('.caret');
          if (caret) { caret.textContent = open ? '▾' : '▸'; caret.setAttribute('aria-expanded', String(open)); }
        }
        renderTree();
      }
    });
  }
}

function renderCourse(c, q = '') {
  const wrap = el('div', 'treecourse');
  wrap.dataset.courseId = c.courseId;
  const head = el('div', 'treehead');

  const caret = el('button', 'caret', '▸');
  caret.dataset.motionKey = c.courseId + ':caret';
  caret.setAttribute('aria-label', `展开或收起${c.name}`);
  head.appendChild(caret);

  if (!c.empty) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.motionKey = c.courseId + ':enabled';
    cb.checked = c.enabled !== false;
    cb.title = '是否处理这门课';
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      c.enabled = cb.checked;
      tree.dirty = true;
      // 重算 willHandle
      for (const t of c.tasks) t.willHandle = c.enabled && t.policyHandle !== false && !t.excluded;
      renderTree();
    });
    head.appendChild(cb);
  }

  head.appendChild(el('span', 'cname', c.name));

  const meta = el('span', 'cmeta');
  meta.appendChild(platformBadge(c));
  if (c.empty) {
    meta.appendChild(el('span', 'chip skip', '无章节内容'));
  } else {
    const counts = c.counts || {};
    for (const [k, v] of Object.entries(counts)) {
      const chip = el('span', 'type-count', `${({video:'视频',work:'测验',doc:'文档',read:'阅读'})[k] || '其他'} ${v}`);
      meta.appendChild(chip);
    }
    const progress = completionCounts(c.tasks);
    const completion=courseCompletion(c);
    meta.appendChild(el('span',`chip ${completion.finished?'task-done':''}`,completion.label));
    if(progress.total)meta.appendChild(el('span', 'chip', `已读取任务 ${progress.done}/${progress.total}`));
    if(completion.totalSections)meta.appendChild(el('span','chip',`小节 ${completion.completedSections}/${completion.totalSections}`));
    const will = c.tasks.filter((t) => t.willHandle).length;
    meta.appendChild(el('span', 'chip', `已选 ${will}/${c.tasks.length}`));
  }
  head.appendChild(meta);

  // 课程头：停用/启用、只刷这门课、只留前 N 个
  if (!c.empty) {
    const menu = el('details', 'course-actions');
    const menuToggle = el('summary', null, '课程操作 ···');
    const menuBody = el('div');
    menu.appendChild(menuToggle);
    menu.appendChild(menuBody);
    menu.addEventListener('click', (event) => event.stopPropagation());
    const only = el('button', 'ghost onlybtn', '只刷这门课');
    only.title = '禁用其它课程并保存选择（执行时就只会刷这一门）';
    only.addEventListener('click', async (e) => {
      e.stopPropagation();
      menu.open = false;
      for (const x of tree.data.courses) {
        if (x.empty) continue;
        x.enabled = x.courseId === c.courseId;
        recalc(x);
      }
      appendLog({ t: Date.now(), level: 'info', message: `已限定只刷《${c.name}》，正在保存…` });
      const r = await saveSelection();
      if (r && r.ok) {
        appendLog({ t: Date.now(), level: 'ok', message: `已保存：现在只会刷《${c.name}》` });
      }
      renderTree();
    });
    menuBody.appendChild(only);

    const firstN = el('button', 'ghost onlybtn', '只留前 N 个');
    firstN.title = '只保留这门课最前面的 N 个任务点（其余排除），适合"先刷一小段试试"';
    firstN.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.open = false;
      const ans = window.prompt(`《${c.name}》\n只保留最前面的几个任务点？（其余会被排除）`, '5');
      if (ans == null) return;
      const n = Number(ans);
      if (!Number.isFinite(n) || n < 0) {
        appendLog({ t: Date.now(), level: 'warn', message: `「${ans}」不是有效数字，已忽略` });
        return;
      }
      const r = keepFirstN(c, n);
      tree.dirty = true;
      appendLog({ t: Date.now(), level: 'ok', message: `《${c.name}》已只留前 ${r.kept} 个任务点（共 ${r.total} 个）` });
      renderTree();
    });
    menuBody.appendChild(firstN);
    head.appendChild(menu);
  }

  const toggleCourse = () => {
    expandCourse(wrap, !wrap.classList.contains('open'));
    caret.textContent = wrap.classList.contains('open') ? '▾' : '▸';
    caret.setAttribute('aria-expanded', String(wrap.classList.contains('open')));
    if (wrap.classList.contains('open')) tree.expanded.add(c.courseId);
    else tree.expanded.delete(c.courseId);
  };
  head.addEventListener('click', toggleCourse);
  caret.addEventListener('click', (event) => { event.stopPropagation(); toggleCourse(); });

  // 搜索时自动展开命中的课程，省得还要手点
  if (q) wrap.classList.add('open');
  if (tree.expanded.has(c.courseId)) {
    wrap.classList.add('open');
    caret.textContent = '▾';
  }
  caret.setAttribute('aria-expanded', String(wrap.classList.contains('open')));

  wrap.appendChild(head);

  if (!c.empty) {
    const bodyEl = el('div', 'treebody');
    const courseNameHit = courseNameMatches(c, q);

    /*
     * 按"章"分组（节号第一段相同 = 同一章，如 2.1/2.9 同属第 2 章）。
     * 章级复选框一键勾选/取消整章 —— 用户要的"按章节批量选"。
     */
    const pendingSections=(c.sections||[]).filter(sec=>!sectionCompletion(c,sec).finished);
    const doneSections=(c.sections||[]).filter(sec=>sectionCompletion(c,sec).finished);
    for(const [finished,sections]of [[false,pendingSections],[true,doneSections]]){
      if(!sections.length)continue;
      const group=el('section','section-completion-group');
      group.dataset.sectionCompletion=finished?'completed':'pending';
      const title=el('button','section-group-heading');title.type='button';
      title.dataset.motionKey=c.courseId+':section-group:'+(finished?'completed':'pending');
      const open=!finished||!!q||(tree.completedSectionsOpen.get(c.courseId)??!pendingSections.length);
      title.textContent=`${finished?(open?'▾ ':'▸ '):''}${finished?'已完成小节':'待完成小节'} ${sections.length}`;
      title.setAttribute('aria-expanded',String(open));
      if(finished)title.onclick=()=>{tree.completedSectionsOpen.set(c.courseId,!open);renderTree();};
      else title.disabled=true;
      const content=el('div','section-group-content');content.hidden=!open;
      group.append(title,content);bodyEl.appendChild(group);
    const groups = new Map();
    for (const sec of sections) {
      const ch = String(sec.secNo || '').split('.')[0] || '?';
      if (!groups.has(ch)) groups.set(ch, []);
      groups.get(ch).push(sec);
    }

    for (const [ch, secs] of groups) {
      const sectionIds=new Set(secs.map(sec=>sec.knowledgeId));
      const chTasks = (c.tasks||[]).filter(task=>sectionIds.has(task.knowledgeId));
      if (q && !courseNameHit && !chTasks.some((t) => matchesQuery(c.name, t, q))&&!secs.some(sec=>[sec.secNo,sec.name].some(value=>String(value||'').toLowerCase().includes(q.toLowerCase())))) {
        // 该章在搜索结果里没有命中的任务点 → 整章不显示
        continue;
      }

      const chHead = el('div', 'chaphead');
      const chCb = document.createElement('input');
      chCb.type = 'checkbox';
      chCb.dataset.motionKey = c.courseId + ':chapter:' + (finished?'completed:':'pending:') + ch;
      const chState = selectionState(chTasks);
      chCb.checked = chState.state === 'all';
      chCb.indeterminate = chState.state === 'partial';
      chCb.disabled=chState.total===0;
      chCb.title = `第 ${ch} 章：一键勾选/取消本章全部 ${chState.total} 个任务点`;
      chCb.addEventListener('click', (e) => e.stopPropagation());
      chCb.addEventListener('change', () => {
        for(const sec of secs)batchSelectChapter(c,sec,chCb.checked ? 'select' : 'deselect');
        tree.dirty = true;
        appendLog({
          t: Date.now(),
          level: 'info',
          message: `第 ${ch} 章：${chCb.checked ? '已勾选' : '已取消'} ${chState.total} 个任务点`,
        });
        renderTree();
      });
      chHead.appendChild(chCb);
      chHead.appendChild(el('span', 'chapname', `第 ${ch} 章`));
      chHead.appendChild(el('span', 'chip', `${chTasks.filter((t) => t.policyHandle !== false).length} 个任务点`));
      content.appendChild(chHead);

      for (const sec of secs) {
        const blk = el('div', 'sectionblk');
        const sh = el('div', 'sechead');

        const secCb = document.createElement('input');
        secCb.type = 'checkbox';
        secCb.dataset.motionKey = c.courseId + ':section:' + sec.knowledgeId;
        const st = chapterState(c, sec);
        secCb.disabled=st.total===0;
        secCb.checked = st.state === 'all';
        secCb.indeterminate = st.state === 'partial';
        secCb.title = `整节勾选/取消（${sec.secNo}，共 ${st.total} 个任务点）`;
        secCb.addEventListener('click', (e) => e.stopPropagation());
        secCb.addEventListener('change', () => {
          batchSelectChapter(c, sec, secCb.checked ? 'select' : 'deselect');
          tree.dirty = true;
          renderTree();
        });
        sh.appendChild(secCb);

        sh.appendChild(el('span', 'sno', sec.secNo || ''));
        sh.appendChild(el('span', null, sec.name || ''));
        const all = (c.tasks || []).filter((t) => t.knowledgeId === sec.knowledgeId);
        const progress = sectionCompletion(c,sec);
        sh.appendChild(el('span', `chip ${progress.finished ? 'task-done' : ''}`,
          progress.total?`${!progress.finished&&!progress.remaining?progress.label+' · 已读取任务 ': '已完成 '}${progress.done}/${progress.total}`:progress.label));
        blk.appendChild(sh);
        if(!all.length)blk.appendChild(el('p','section-coverage-note',sec.done?'平台已标记此小节完成，未重复读取任务详情。':progress.label));

        const tasks = q && !courseNameHit ? all.filter((t) => matchesQuery(c.name, t, q)) : all;
        for (let i = 0; i < tasks.length; i += 1) {
          blk.appendChild(renderTaskRow(c, all, all.indexOf(tasks[i])));
        }
        content.appendChild(blk);
      }
    }
    }
    wrap.appendChild(bodyEl);
  }
  return wrap;
}

function renderTaskRow(course, tasks, index) {
  const t = tasks[index];
  const row = el('div', `tprow${t.willHandle ? '' : ' willnot'}`);

  // 排序按钮（用户要的"自己选顺序"）
  const ord = el('div', 'ordbtns');
  const up = el('button', null, '↑');
  const down = el('button', null, '↓');
  up.disabled = index === 0;
  down.disabled = index === tasks.length - 1;
  up.title = '上移（优先处理）';
  down.title = '下移';
  up.addEventListener('click', (e) => {
    e.stopPropagation();
    moveTask(course, tasks, index, -1);
  });
  down.addEventListener('click', (e) => {
    e.stopPropagation();
    moveTask(course, tasks, index, 1);
  });
  ord.appendChild(up);
  ord.appendChild(down);
  row.appendChild(ord);

  // 勾选（排除）
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.dataset.motionKey = t.key + ':selected';
  cb.checked = !t.excluded && t.policyHandle !== false;
  cb.title = t.excluded ? '已排除，点击恢复' : '取消勾选即排除';
  cb.addEventListener('change', () => {
    t.excluded = !cb.checked;
    t.willHandle = course.enabled !== false && t.policyHandle !== false && !t.excluded;
    tree.dirty = true;
    renderTree();
  });
  row.appendChild(cb);
  if(t.blockedReason){cb.disabled=true;cb.title=t.blockedReason;const enable=el('button','text-button','开启讨论草稿 →');enable.addEventListener('click',openDiscussionSettings);row.appendChild(enable);}

  const typeChip = el('span', `chip ${['video', 'work', 'doc'].includes(t.type) ? t.type : 'skip'}`, t.typeName || ({ video: '视频', work: '测验', doc: '文档' })[t.type] || t.type);
  row.appendChild(typeChip);

  const nm = el('span', 'tname', t.name || t.sectionName || '(无名称)');
  nm.title = `${t.name || ''}\n${t.policy || ''}`;
  row.appendChild(nm);
  const completion = completionOf(t);
  const statusChip = el('span', `chip task-status task-${completion.state}`, completion.label);
  statusChip.title = completion.finished
    ? completion.source === 'local' ? '依据本机已保存的完成记录' : '依据最近一次读取的平台任务点状态'
    : '任务点状态独立计算；平台上的外部变化需重新侦察。';
  row.appendChild(statusChip);

  if (!t.willHandle && !t.excluded) row.appendChild(el('span', 'why', '跳过'));
  if (t.excluded) row.appendChild(el('span', 'why', '已排除'));
  if (t.sizeText) row.appendChild(el('span', 'tsize', t.sizeText));

  return row;
}

function moveTask(course, tasks, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= tasks.length) return;
  const arr = tasks.slice();
  [arr[index], arr[target]] = [arr[target], arr[index]];
  // 写回 course.tasks 的对应位置
  const keys = new Set(tasks.map((t) => t.key));
  let cursor = 0;
  course.tasks = course.tasks.map((t) => (keys.has(t.key) ? arr[cursor++] : t));
  tree.dirty = true;
  renderTree();
}

function selectionPayload() {
  const courses = {};
  const taskOrder = {};
  const excluded = [];
  const courseOrder = tree.data.courses.map((c) => c.courseId);

  for (const c of tree.data.courses) {
    if (c.empty) continue;
    courses[c.courseId] = { enabled: c.enabled !== false };
    for (const t of c.tasks) {
      if (!taskOrder[t.knowledgeId]) taskOrder[t.knowledgeId] = [];
      // 用服务端给的 uid（小节内序号派生的稳定标识），
      // 不要自己拼 jobid/idx —— 很多任务点 jobid 为 null 会撞车。
      taskOrder[t.knowledgeId].push(t.uid || `t${taskOrder[t.knowledgeId].length}`);
      if (t.excluded) excluded.push(t.key);
    }
  }
  return { courseOrder, courses, taskOrder, excluded };
}
async function saveSelection() {
  if (!tree.data) return { ok: false, error: '没有可保存的清单' };
  const payload = selectionPayload();
  const {courseOrder,taskOrder,excluded}=payload;
  const res = await fetch('/api/selection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  // 调试辅助：记录实际发出的多元素条目（便于排查"界面顺序没保存上"）
  const multi = Object.entries(taskOrder).filter(([, v]) => v.length >= 2).length;
  console.debug(`[saveSelection] 发送: 课程 ${courseOrder.length} · 小节 ${Object.keys(taskOrder).length} · 多任务点小节 ${multi} · 排除 ${excluded.length}`);
  const body = await res.json();
  if (body.ok) {
    tree.dirty = JSON.stringify(selectionPayload()) !== JSON.stringify(payload);
    renderWillSummary();
    appendLog({ t: Date.now(), level: 'ok', message: `已保存选择：排除 ${excluded.length} 个任务点` });
  }
  return body;
}

// 切到课程树标签时自动加载
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'courses') {
      selectionDesk.refreshPresets();
      if (!tree.data) loadChecklist();
      else refreshTreeProgress();
    }
  });
});

/* ---------------- 待审队列 ---------------- */

let reviewReadSequence=0,reviewReadCount=0;
function hasReviewEdits(){return !!document.activeElement?.closest('.qedit')||[...document.querySelectorAll('.qedit input,.qedit textarea')].some(e=>e.value!==e.dataset.savedValue);}
async function loadReview({passive=false}={}) {
  if(passive&&reviewReadCount)return;
  const ticket=++reviewReadSequence;reviewReadCount++;
  try{
  const res = await fetch('/api/review');
  const body = await res.json();
  if(ticket!==reviewReadSequence||(passive&&hasReviewEdits()))return;
  if (!body.ok) {
    $('#reviewSummary').textContent = body.error || '读取待审队列失败';
    $('#reviewSource').textContent = '出错';
    return;
  }
  renderReview(body.result);
  }finally{reviewReadCount--;}
}

const reviewFeedback=new Map();
const reviewConfirmationReady=new Set();
async function restoreReviewedAnswers(taskKey) {
  const response=await fetch('/api/review/open',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskKey})})
    .then(result=>result.json()).catch(error=>({ok:false,error:error.message}));
  const result=response.result;
  if(response.ok&&result.pendingConfirmation)reviewConfirmationReady.add(taskKey);else reviewConfirmationReady.delete(taskKey);
  const message=response.ok?
    result.alreadySubmitted?(result.discussion?'平台已显示本人讨论回复，待审记录已同步':'平台显示该作业已提交，可刷新确认状态'):result.pendingConfirmation?'作业页仍有提交确认框，请核对后继续确认；已保存答案保留':result.discussion?'讨论草稿已填入网页，请核对后确认发布':`${result.pendingRecovered?'已重新核对平台草稿':'作业页已打开'}，恢复 ${result.restored||0} 题${result.ready?'，请核对后提交':`；${Array.isArray(result.missing)?'第 '+result.missing.join('、')+' 题':result.missing+' 题'}仍需填写`}`:
    `恢复失败：${response.error}`;
  reviewFeedback.set(taskKey,message);
  appendLog({t:Date.now(),level:response.ok?'ok':'error',message});
  return response;
}
async function submitReviewedAnswers(scope) {
  // An uncertain request can survive a restart after its modal disappears.
  // Read current state rather than trusting a stale button label. A recovery
  // click only restores; the user must click again after reviewing the result.
  const current=await fetch('/api/review').then(result=>result.json()).catch(error=>({ok:false,error:error.message}));
  if(!current.ok){appendLog({t:Date.now(),level:'error',message:`未能核对待审状态，未提交：${current.error||'请刷新后重试'}`});return;}
  const active=new Set((current.result?.items||[]).map(item=>item.taskKey));
  const targets=(current.result?.keptPages||[]).filter(record=>active.has(record.key)&&(scope.all?record.info?.type!=='discussion':record.key===scope.taskKey));
  const pending=targets.filter(record=>record.info?.submissionPending&&!reviewConfirmationReady.has(record.key));
  if(pending.length){
    for(const record of pending)await restoreReviewedAnswers(record.key);
    appendLog({t:Date.now(),level:'info',message:'已先核对需要恢复的作业，本次未执行提交；请核对答案后再次点击提交。'});
    await loadReview();return;
  }
  for(const record of targets)reviewConfirmationReady.delete(record.key);
  const response=await fetch('/api/review/submit',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(scope),
  }).then(result=>result.json()).catch(error=>({ok:false,error:error.message}));
  const submitted=response.result?.submitted||0,failed=response.result?.failed||0;
  for(const item of response.result?.details||[]){if(item.ok)reviewFeedback.delete(item.key);else reviewFeedback.set(item.key,item.error||'未确认提交成功');}
  if(submitted)appendLog({t:Date.now(),level:failed?'warn':'ok',message:`已确认提交 ${submitted} 组答案${failed?`，${failed} 组未成功`:''}`});
  if(!response.ok||failed||!submitted){
    const detail=response.error||response.result?.note||(response.result?.details||[]).filter(item=>!item.ok).map(item=>item.error).join('；')||'未确认提交成功';
    appendLog({t:Date.now(),level:'error',message:`提交未完成：${detail}`});
    if(scope.taskKey)reviewFeedback.set(scope.taskKey,detail);
  }
  await loadReview();
}

function renderReview(data) {
  const bodyEl = $('#reviewBody');
  const sum = $('#reviewSummary');
  if (!data) {
    sum.textContent = '尚无待审题目。';
    $('#reviewSource').textContent = '空';
    bodyEl.innerHTML = '';
    return;
  }

  $('#reviewSource').textContent = '已加载';
  const s = data.stats || {};
  const kept = data.keptPages || [];
  const openWorkPages = kept.filter(record => record.info?.type !== 'video-quiz' && !record.closed && record.submittable).length;
  const videoPageCount = kept.filter(record => record.info?.type === 'video-quiz').length;
  sum.innerHTML =
    `待处理 <b>${(data.items || []).length}</b> 题 · 待确认 <b>${s.pending || 0}</b> · 已填入 <b>${s.filled || 0}</b>` +
    `<br><span class="muted">历史记录：已提交 ${s.submitted || 0} 题 · 已丢弃 ${s.discarded || 0} 题</span>` +
    `<br><span class="muted">待审页面已打开 ${openWorkPages} 个，可恢复已保存的答案；保留的视频弹窗记录 ${videoPageCount} 条（需在学习通页面手动作答）。${(data.items||[]).some(item=>item.qtype==='discussion')?'讨论请逐条核对并点击“确认发布讨论”，不会随顶部批量按钮一起发布。':''}</span>`;

  const items = data.items || [];
  bodyEl.innerHTML = '';
  if (!items.length) {
    const videoPages = kept.filter(record => record.info?.type === 'video-quiz');
    if (!videoPages.length) {
      bodyEl.innerHTML = '<p class="placeholder">待审答案队列为空。</p>';
      return;
    }
    bodyEl.appendChild(el('p', 'placeholder', '待审答案队列为空。视频弹窗题不会进入此队列；请切换到保留的学习通页面，在视频弹窗中手动作答。'));
    const list = el('div', 'review-kept-pages');
    for (const record of videoPages) {
      const info = record.info || {};
      const row = el('article', 'reviewgroup');
      const title = [info.course, info.secNo, info.sectionName || info.name].filter(Boolean).join(' · ') || '视频弹窗题';
      row.appendChild(el('strong', null, title));
      row.appendChild(el('p', 'muted', record.closed ? '弹窗页当前已关闭；请重新进入该视频任务。' : '弹窗页仍保持打开；请在学习通页面中手动作答。'));
      if (info.reason) row.appendChild(el('p', 'muted', info.reason));
      const viewPages = $('#viewWebPages');
      if (!record.closed && viewPages && !viewPages.hidden) {
        const open = el('button', 'ghost', '查看保留的学习通页面');
        open.addEventListener('click', () => viewPages.click());
        row.appendChild(open);
      }
      list.appendChild(row);
    }
    bodyEl.appendChild(list);
    return;
  }

  // 按任务点分组
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.taskKey)) groups.set(it.taskKey, []);
    groups.get(it.taskKey).push(it);
  }

  const keptMap = new Map(kept.map((k) => [k.key, k]));

  for (const [taskKey, list] of groups) {
    const g = el('div', 'reviewgroup');
    const head = el('div', 'rghead');
    const k = keptMap.get(taskKey);
    const discussion=list[0].qtype==='discussion';
    head.appendChild(platformBadge(list[0]));
    head.appendChild(el('span', 'gname', `${list[0].course || ''} · ${list[0].secNo || ''} ${list[0].sectionName || ''}`));
    head.appendChild(el('span', 'gmeta', `${list.length} ${discussion?'条':'题'}`));
    {
      const opened=!!k&&!k.closed&&k.submittable;
      head.appendChild(el('span',`chip ${opened?'':'skip'}`,discussion?(opened?'讨论页已打开':'讨论页已关闭，可恢复'):(opened?'作业页已打开':'作业页已关闭，可恢复')));
      const needsRecovery=!discussion&&!!k?.info?.submissionPending&&!reviewConfirmationReady.has(taskKey);
      const open=el('button','ghost',opened?'打开并核对':'重新打开并恢复');
      open.addEventListener('click',async()=>{
        open.disabled=true;open.textContent='正在恢复…';
        await restoreReviewedAnswers(taskKey);
        await loadReview();
      });
      head.appendChild(open);
      if(!discussion&&list.some(item=>!item.autoFilled||item.aiError)){
        const retry=el('button','ghost','只重试未完成题目');
        retry.disabled=!!state.status?.running;
        retry.addEventListener('click',async()=>{
          if(hasReviewEdits()){reviewFeedback.set(taskKey,'请先保存正在编辑的答案，再继续未完成题目');await loadReview();return;}
          retry.disabled=true;retry.textContent='正在继续…';
          try{
            const response=await fetch('/api/action/retryReview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskKey})}).then(r=>r.json());
            const started=response.ok&&response.result?.started;
            reviewFeedback.set(taskKey,started?'已继续此作业：保留并恢复已保存答案，只向 AI 询问未完成题目；完成后仍需核对提交':response.error||response.result?.reason||'未能继续，草稿已保留');
          }catch(error){reviewFeedback.set(taskKey,'继续失败：'+error.message);}finally{await loadReview();}
        });
        head.appendChild(retry);
      }
      const buttonLabel=discussion?(k?.info?.submissionPending?'核对发布结果':'确认发布讨论'):needsRecovery?'恢复并核对':reviewConfirmationReady.has(taskKey)?'继续确认提交':opened?'✔ 提交这一组':'恢复后提交这一组';
      const btn = el('button', 'primary', buttonLabel);
      btn.addEventListener('click', async () => {
        btn.disabled=true;
        btn.classList.add('busy');
        btn.textContent = needsRecovery?'正在恢复…':'提交中…';
        try{await submitReviewedAnswers({taskKey});}
        finally{btn.disabled=false;btn.classList.remove('busy');btn.textContent=buttonLabel;}
      });
      head.appendChild(btn);
    }
    g.appendChild(head);
    if(reviewFeedback.has(taskKey)){const feedback=el('p','review-feedback',reviewFeedback.get(taskKey));feedback.setAttribute('role','status');g.appendChild(feedback);}

    const bodyInner = el('div', 'rgbody');
    for (const it of list) bodyInner.appendChild(renderQCard(it, taskKey));
    g.appendChild(bodyInner);
    bodyEl.appendChild(g);
  }
}

function renderQCard(it, taskKey) {
  const card = el('div', 'qcard');
  if (!it.imagePath) card.classList.add('no-shot');
  const isDiscussion=it.qtype==='discussion';
  const isEssay = it.qtype === 'essay'||isDiscussion;

  const head = el('div', 'qhead');
  head.appendChild(el('span', 'qno', isDiscussion?'讨论':`第 ${it.questionIndex} 题`));
  head.appendChild(el('span', 'chip', it.qtypeRaw || it.qtype));
  const conf = el('span', `badge ${it.confidence}`, it.confidenceLabel || it.confidence);
  if(!isDiscussion)head.appendChild(conf);
  if (it.editedByHuman) head.appendChild(el('span', 'chip', '人工改过'));
  head.appendChild(el('span', 'chip', isDiscussion?(it.filled?.verified?'已填入讨论页':'待发布草稿'):it.autoFilled ? '已自动填入' : it.filled?.verified ? '已人工填入' : '未填入'));
  if (isEssay) head.appendChild(el('span', 'chip', isDiscussion?'讨论需逐条确认发布':'简答需人工核对'));
  head.appendChild(el('span', 'chip', it.status === 'submitted' ? '已提交' : '待确认'));
  card.appendChild(head);

  const bodyEl = el('div', 'qbody');

  // 左：题目截图
  const shot = el('div', 'qshot');
  if (it.imagePath) {
    // 通过服务端把本地图片吐出来（浏览器无法直接访问 file:// 任意路径）
    const img = document.createElement('img');
    img.src = `/api/answer-image?p=${encodeURIComponent(it.imagePath)}`;
    img.alt = '题目截图';
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      shot.innerHTML = '<div class="nolink">截图加载失败<br>(文件可能已被清理)</div>';
    });
    shot.appendChild(img);
  } else {
    shot.innerHTML = '<div class="nolink">无截图</div>';
  }
  if(!isDiscussion||it.imagePath)bodyEl.appendChild(shot);

  // 右：AI 答案 + 解析 + 编辑
  const info = el('div', 'qinfo');
  if(isDiscussion){const topic=el('div','row');topic.appendChild(el('span','lbl','讨论题目'));topic.appendChild(el('div','ai-text',it.archive?.stemTextRaw||it.sectionName||''));info.appendChild(topic);}

  const r1 = el('div', 'row');
  r1.appendChild(el('span', 'lbl', isDiscussion?'讨论草稿':isEssay ? '简答草稿' : 'AI 解析出的答案'));
  r1.appendChild(el(isEssay ? 'div' : 'span', isEssay ? 'ai-text' : null,
    isEssay ? it.textAnswer || '(无可用正文)' : (it.letters || []).join('') || '(无)'));
  info.appendChild(r1);

  const r2 = el('div', 'row');
  r2.appendChild(el('span', 'lbl', '选项'));
  const opts = el('div', 'optlist');
  const ansSet = new Set((it.letters || []).map(String));
  for (const o of it.options || []) {
    const isAns = ansSet.has(String(o.letter));
    opts.appendChild(el('span', `optitem${isAns ? ' answer' : ''}`, `${o.letter}. ${o.text}`));
  }
  r2.appendChild(opts);
  if (!isEssay) info.appendChild(r2);

  const r3 = el('div', 'row');
  r3.appendChild(el('span', 'lbl', '判定依据'));
  r3.appendChild(el('span', `reason${it.validation?.safe ? ' ok' : ''}`, it.parseReason || ''));
  if (it.validation && !it.validation.safe && it.validation.errors?.length) {
    r3.appendChild(el('span', 'reason', `　${isEssay ? '提交提示' : '拦截'}：${it.validation.errors.join('；')}`));
  }
  if (it.fillError) r3.appendChild(el('span', 'reason', `　填写失败：${it.fillError}`));
  if(!isDiscussion)info.appendChild(r3);

  const r4 = el('div', 'row');
  r4.appendChild(el('span', 'lbl', isDiscussion?'草稿来源':'AI 原始回答'));
  const ai = el('div', 'ai-text', (isDiscussion?(it.discussion?.source==='popular-copy'?`已有评论原文：近似回答出现 ${it.discussion.matches} 次；已读取 ${it.discussion.scanned} 条${it.discussion.complete?'，已读完':'，未读完全部评论'}`:'所选 AI 生成，待你核对'):(it.aiAnswer || it.aiError || '(无)')).slice(0, 1500));
  r4.appendChild(ai);
  info.appendChild(r4);

  // 人工改答案
  const edit = el('div', 'qedit');
  const inp = document.createElement(isEssay ? 'textarea' : 'input');
  if (isEssay) { inp.rows = 6; inp.maxLength = isDiscussion?1500:10000; } else inp.type = 'text';
  inp.value = isEssay ? it.textAnswer || '' : (it.letters || []).map((l) => String(l).toUpperCase()).join('');
  inp.dataset.savedValue=inp.value;
  inp.placeholder = isDiscussion?'填写简短讨论回答':isEssay ? '填写简答正文，支持分段' : '如 AB';
  inp.title = isDiscussion?'仅保存本地讨论草稿；核对后点击该组的确认发布讨论才会发表':isEssay ? '保存并填入将替换该题页面上的草稿；不会提交作业' : '人工修改答案（选择题填字母，判断题填 T/F 或 对/错）';
  const save = el('button', null, isDiscussion?'保存讨论草稿':'保存并填入');
  save.addEventListener('click', async () => {
    const v = inp.value.trim();
    if (isEssay) {
      if (!v) { appendLog({ t: Date.now(), level: 'warn', message: '请先填写简答正文' }); return; }
      save.disabled = true;
      const r = await fetch('/api/review/edit', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: it.id, textAnswer: v }),
      }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
      save.disabled = false;
      appendLog({ t: Date.now(), level: r.ok ? 'ok' : 'error', message: r.ok
        ? (r.result?.alreadySubmitted?'平台已提交，待审记录已同步清除':isDiscussion?'讨论草稿已保存，尚未发布':`简答正文已保存并填入（${v.length} 字符），请核对后提交`) : `正文保存失败：${r.error}` });
      if (r.ok) await loadReview();
      return;
    }
    const letters = v
      .split('')
      .filter((c) => /[A-Ha-h]/.test(c))
      .map((c) => c.toUpperCase());
    const finalLetters = /^(t|true|对|正确)$/i.test(v)
        ? ['true']
        : /^(f|false|错|错误)$/i.test(v)
          ? ['false']
          : letters;
    if (!finalLetters.length) {
      appendLog({ t: Date.now(), level: 'warn', message: `无法解析输入「${v}」` });
      return;
    }
    const r = await fetch('/api/review/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: it.id, letters: finalLetters }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
    if (r.ok) {
      appendLog({ t: Date.now(), level: 'ok', message: r.result?.alreadySubmitted?'平台已提交，待审记录已同步清除':`已保存并填入 ${finalLetters.join('')}，请核对后提交` });
      await loadReview();
    } else {
      appendLog({ t: Date.now(), level: 'error', message: `改答案失败：${r.error}` });
    }
  });
  const discard = el('button', 'ghost', '丢弃这题');
  discard.addEventListener('click', async () => {
    const response=await fetch('/api/review/discard', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: it.id }),
    }).then(result=>result.json()).catch(error=>({ok:false,error:error.message}));
    if(!response.ok)reviewFeedback.set(taskKey,response.error||'丢弃失败，请稍后重试');
    await loadReview();
  });
  edit.appendChild(inp);
  edit.appendChild(save);
  edit.appendChild(discard);
  info.appendChild(edit);

  bodyEl.appendChild(info);
  card.appendChild(bodyEl);
  return card;
}

// 切到待审队列时自动加载
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'review') loadReview();
  });
});

/** 设置页按钮 */
function bindSettingsTools() {
  $('#saveSettings')?.addEventListener('click', () => saveSettingsForm());
  $('#reloadSettings')?.addEventListener('click', () => loadSettingsForm());
  $('#resetSettings')?.addEventListener('click', async () => {
    const ok = window.confirm('恢复默认设置？\n会清掉 state.json 里的 settings 段（课程选择、进度不受影响）。');
    if (!ok) return;
    const r = await fetch('/api/action/resetSettings', { method: 'POST' }).then((x) => x.json());
    if (r.ok) {
      appendLog({ t: Date.now(), level: 'ok', message: '设置已恢复默认' });
      settingsForm.pending = {};
      settingsForm.rows = [];
      await loadSettingsForm();
    } else {
      appendLog({ t: Date.now(), level: 'error', message: `恢复默认失败：${r.error || '未知错误'}` });
    }
  });
  // 切到设置标签页时刷新一次（可能别的窗口改过）
  $$('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'settings') loadSettingsForm();
    });
  });
}

/* ---------------- 初始化 ---------------- */
(async function init() {
  try {
    const res = await fetch('/api/status');
    renderStatus(await res.json());
  } catch {
    /* 交给 WS */
  }
  bindTreeTools();
  bindSettingsTools();
  // 使用本机已有报告，无需连接课程平台、无需重新侦察。
  await loadChecklist().catch(() => { $('#treeSummary').textContent = '已有清单读取失败，可点击「读取清单」重试。'; });
  connectWS();
  appendLog({ t: Date.now(), level: 'info', message: '控制台已连接。' });
})();
