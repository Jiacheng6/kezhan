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

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  status: null,
  logs: [],
  autoScroll: true,
  filter: '',
};

/* ---------------- 标签页 ---------------- */
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    const name = btn.dataset.tab;
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
  });
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
  state.status = s;

  // 顶栏
  const edgeOk = !!s.edge?.connected;
  setPill($('#pillEdge'), edgeOk ? 'Edge 已接管' : 'Edge 未连接', edgeOk ? 'ok' : 'bad');
  const loggedIn = !!s.login?.loggedIn;
  setPill($('#pillLogin'), loggedIn ? '已登录' : '未登录', loggedIn ? 'ok' : 'warn');
  /*
   * 这两颗灯以前是「只侦察模式」（读 settings.reconOnly）——
   * 但那个开关**从来只影响这颗灯**，不影响任何行为：脚本一直在真刷课、真答题。
   * 结果界面上永远挂着一颗"只侦察模式"，用户以为它不会动手。
   * 现在改成两颗**说真话**的灯：提交模式 + 答题通道。
   */
  const submitAuto = s.settings?.submitMode === 'auto';
  setPill(
    $('#pillRecon'),
    submitAuto ? '提交：自动（仅高可靠）' : '提交：人工确认',
    submitAuto ? 'ok' : 'warn',
  );
  const qOk = !!s.qianwen?.loggedIn;
  setPill($('#pillQuiz'), qOk ? '答题通道：千问就绪' : '答题通道：未登录千问', qOk ? 'ok' : 'warn');

  $('#phaseLine').textContent = s.running ? '任务运行中 · 隐藏窗口后继续运行' : '选择课程后开始 · 进度自动保存';

  // 概览：浏览器
  $('#kEdgeState').textContent = edgeOk ? (s.edge.launched ? '本次启动并接管' : '接管已有实例') : '未连接';
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
  $('#kCurrent').textContent = p.current || '空闲';
  $('#kRunning').textContent = s.running ? '运行中' : '未运行';

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
  renderRunBar(s);

  // 待审队列计数
  $('#reviewCount').textContent = s.reviewCount ?? 0;
}

/** 执行中/停止状态条 */
function renderRunBar(s) {
  const bar = $('#runBar');
  const p = s.progress || {};
  const st = s.runStats;
  const running = !!s.running || !!s.reconRunning;

  /*
   * 按钮可用性必须无条件更新 —— 之前放在"状态条显示"的早退之后，
   * 结果空闲时「开始」按钮保持 HTML 里的 disabled，"停止"反而可用，正好反了。
   */
  $$('[data-action="startRun"]').forEach((runBtn) => {
    runBtn.disabled = running || !s.ready || !s.edge?.connected || !!s.reconRunning;
    runBtn.textContent = s.reconRunning ? '正在读取课程…' : running ? '执行中…' : '▶ 开始执行刷课';
  });
  $$('[data-action="stopRun"]').forEach((stopBtn) => { stopBtn.disabled = !running; });
  $$('[data-action="startRecon"]').forEach((btn) => { btn.disabled = running || !s.ready || !s.edge?.connected || !!s.reconRunning; });

  if (!bar) return;

  // 有进度或有统计才显示状态条
  const show = running || (st && (st.done || st.failed));
  bar.classList.toggle('hidden', !show);
  if (!show) return;

  const total = p.total || st?.total || 0;
  const done = st?.done ?? p.done ?? 0;
  const failed = st?.failed ?? 0;
  const cur = p.current || '';

  $('#runLabel').textContent = running ? '▶ 执行中' : '已停止';
  $('#runProg').textContent = p.percent != null ? `${(p.percent * 100).toFixed(1)}%` : '';
  $('#runFill').style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;

  const parts = [`完成 ${done}/${total}`];
  if (failed) parts.push(`失败 ${failed}`);
  if (st?.handbook) parts.push(`待人工 ${st.handbook}`);
  if (st?.resumes) parts.push(`纠偏 ${st.resumes}`);
  $('#runSub').innerHTML =
    `${parts.join(' · ')}` + (cur ? `<br><span class="muted">当前：${escapeHtml(cur)}</span>` : '');
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
  div.querySelector('.msg').textContent = entry.message;
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

  /*
   * 「开始执行」前强制对齐选择。
   *
   * 用户实际踩过的坑：在课程树里勾了要刷的课，忘了点「保存选择」，
   * 于是执行用的是**上一次保存的**范围（甚至只有一门别的课），
   * 看起来就是"我选的课它不刷，只刷另一门"。
   * 这里不再靠用户记性：只要有未保存改动，先自动保存再开始。
   */
  if (name === 'startRun' && tree.data && tree.dirty) {
    try {
      const r = await saveSelection();
      if (r && r.ok) {
        appendLog({ t: Date.now(), level: 'ok', message: '开始前已自动保存课程选择（界面有未保存的改动）' });
      } else {
        appendLog({
          t: Date.now(),
          level: 'error',
          message: `课程选择自动保存失败，已中止执行：${r?.error || '未知错误'}（请手动点「保存选择」）`,
        });
        return;
      }
    } catch (err) {
      appendLog({ t: Date.now(), level: 'error', message: `课程选择自动保存异常，已中止执行：${err.message}` });
      return;
    }
  }

  if (btn) {
    btn.classList.add('busy');
    btn.dataset.old = label;
    btn.textContent = '执行中…';
  }
  try {
    const res = await fetch(`/api/action/${name}`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) {
      appendLog({ t: Date.now(), level: 'error', message: `动作 ${name} 失败：${body.error || res.status}` });
    }
  } catch (err) {
    appendLog({ t: Date.now(), level: 'error', message: `动作 ${name} 请求失败：${err.message}` });
  } finally {
    if (btn) {
      btn.classList.remove('busy');
      btn.textContent = btn.dataset.old || label;
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
          const r = await fetch('/api/review/submit', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ all: true }),
          }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
          if (r.ok) {
            appendLog({
              t: Date.now(),
              level: 'ok',
              message: `已提交 ${r.result?.submitted || 0} 组答案${r.result?.failed ? `，${r.result.failed} 组失败` : ''}`,
            });
          } else {
            appendLog({ t: Date.now(), level: 'error', message: `提交失败：${r.error}` });
          }
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

    await runAction(name, btn);
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
};

// 暴露到 window，便于在浏览器控制台里排查（不影响正常使用）
window.__console = {
  tree,
  loadChecklist,
  renderTree,
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
    return;
  }
  tree.data = body.result;
  tree.dirty = false;
  $('#treeSource').textContent = '已加载';
  renderTree();
}

function renderTree() {
  const body = $('#treeBody');
  const summary = $('#treeSummary');
  if (!tree.data) return;

  const s = tree.data.summary;
  const typeParts = Object.entries(s.byType || {}).map(([k, v]) => `${k} ${v}`);
  summary.innerHTML =
    `共 <b>${s.totalCourses}</b> 门课 · 任务点 <b>${s.totalTasks}</b> 个 · ` +
    (typeParts.length ? `<span class="muted">类型分布：${typeParts.join(' · ')}</span>` : '');

  const q = tree.query || '';
  body.innerHTML = '';
  let shown = 0;
  for (const c of tree.data.courses) {
    if (!courseVisible(c, q)) continue;
    shown += 1;
    body.appendChild(renderCourse(c, q));
  }
  if (!shown) {
    body.appendChild(el('p', 'placeholder', q ? `没有匹配「${q}」的课程或任务点。` : '清单里没有可显示的课程。'));
  }

  renderWillSummary();
  renderPreview();

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
    box.innerHTML = `<b class="warn">本次将刷 0 个任务点</b> <span class="muted">（没有任何课程/任务点被选中）</span>`;
  } else {
    // 类型范围没全勾时明确提示，免得"为什么只有视频"
    const sc = scopeOf();
    const off = Object.entries(sc)
      .filter(([, v]) => !v)
      .map(([k]) => ({ video: '视频', work: '测验', doc: '文档', other: '其它' })[k]);
    box.innerHTML =
      `本次将刷 <b>${s.courses}</b> 门课 · <b>${s.tasks}</b> 个任务点` +
      (parts.length ? ` <span class="muted">（${parts.join(' · ')}）</span>` : '') +
      (off.length ? ` <span class="warn">（类型范围不含：${off.join('、')}）</span>` : '');
  }
  const dirty = $('#treeDirty');
  if (dirty) dirty.classList.toggle('hidden', !tree.dirty);
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
        btn.textContent = tree.previewOpen ? '收起预览' : '预览将刷清单';
        renderPreview();
      } else if (act === 'expandAll' || act === 'collapseAll') {
        const all = $$('#treeBody .treecourse');
        for (const w of all) {
          const open = act === 'expandAll';
          w.classList.toggle('open', open);
          const caret = w.querySelector('.caret');
          if (caret) caret.textContent = open ? '▾' : '▸';
        }
      }
    });
  }
}

function renderCourse(c, q = '') {
  const wrap = el('div', 'treecourse');
  const head = el('div', 'treehead');

  const caret = el('span', 'caret', '▸');
  head.appendChild(caret);

  if (!c.empty) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
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
  if (c.empty) {
    meta.appendChild(el('span', 'chip skip', '无章节内容'));
  } else {
    const counts = c.counts || {};
    for (const [k, v] of Object.entries(counts)) {
      const chip = el('span', `chip ${['video', 'work', 'doc'].includes(k) ? k : 'skip'}`, `${k} ${v}`);
      meta.appendChild(chip);
    }
    const will = c.tasks.filter((t) => t.willHandle).length;
    meta.appendChild(el('span', 'chip', `将处理 ${will}/${c.tasks.length}`));
  }
  head.appendChild(meta);

  // 课程头：停用/启用、只刷这门课、只留前 N 个
  if (!c.empty) {
    const only = el('button', 'ghost onlybtn', '只刷这门课');
    only.title = '禁用其它课程并保存选择（执行时就只会刷这一门）';
    only.addEventListener('click', async (e) => {
      e.stopPropagation();
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
    head.appendChild(only);

    const firstN = el('button', 'ghost onlybtn', '只留前 N 个');
    firstN.title = '只保留这门课最前面的 N 个任务点（其余排除），适合"先刷一小段试试"';
    firstN.addEventListener('click', (e) => {
      e.stopPropagation();
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
    head.appendChild(firstN);
  }

  head.addEventListener('click', () => {
    wrap.classList.toggle('open');
    caret.textContent = wrap.classList.contains('open') ? '▾' : '▸';
    if (wrap.classList.contains('open')) tree.expanded.add(c.courseId);
    else tree.expanded.delete(c.courseId);
  });

  // 搜索时自动展开命中的课程，省得还要手点
  if (q && courseNameMatches(c, q)) wrap.classList.add('open');
  if (tree.expanded.has(c.courseId)) {
    wrap.classList.add('open');
    caret.textContent = '▾';
  }

  wrap.appendChild(head);

  if (!c.empty) {
    const bodyEl = el('div', 'treebody');
    const courseNameHit = courseNameMatches(c, q);

    /*
     * 按"章"分组（节号第一段相同 = 同一章，如 2.1/2.9 同属第 2 章）。
     * 章级复选框一键勾选/取消整章 —— 用户要的"按章节批量选"。
     */
    const groups = new Map();
    for (const sec of c.sections || []) {
      const ch = String(sec.secNo || '').split('.')[0] || '?';
      if (!groups.has(ch)) groups.set(ch, []);
      groups.get(ch).push(sec);
    }

    for (const [ch, secs] of groups) {
      const chTasks = tasksOf(c, { chapterNo: ch });
      if (q && !courseNameHit && !chTasks.some((t) => matchesQuery(c.name, t, q))) {
        // 该章在搜索结果里没有命中的任务点 → 整章不显示
        continue;
      }

      const chHead = el('div', 'chaphead');
      const chCb = document.createElement('input');
      chCb.type = 'checkbox';
      const chState = selectionState(chTasks);
      chCb.checked = chState.state === 'all';
      chCb.indeterminate = chState.state === 'partial';
      chCb.title = `第 ${ch} 章：一键勾选/取消本章全部 ${chState.total} 个任务点`;
      chCb.addEventListener('click', (e) => e.stopPropagation());
      chCb.addEventListener('change', () => {
        batchSelectBookChapter(c, ch, chCb.checked ? 'select' : 'deselect');
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
      bodyEl.appendChild(chHead);

      for (const sec of secs) {
        const blk = el('div', 'sectionblk');
        const sh = el('div', 'sechead');

        const secCb = document.createElement('input');
        secCb.type = 'checkbox';
        const st = chapterState(c, sec);
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
        sh.appendChild(el('span', 'chip', `${sec.taskCount} 个任务点`));
        blk.appendChild(sh);

        const all = (c.tasks || []).filter((t) => t.knowledgeId === sec.knowledgeId);
        const tasks = q && !courseNameHit ? all.filter((t) => matchesQuery(c.name, t, q)) : all;
        for (let i = 0; i < tasks.length; i += 1) {
          blk.appendChild(renderTaskRow(c, all, all.indexOf(tasks[i])));
        }
        bodyEl.appendChild(blk);
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
  cb.checked = !t.excluded;
  cb.title = t.excluded ? '已排除，点击恢复' : '取消勾选即排除';
  cb.addEventListener('change', () => {
    t.excluded = !cb.checked;
    t.willHandle = course.enabled !== false && t.policyHandle !== false && !t.excluded;
    tree.dirty = true;
    renderTree();
  });
  row.appendChild(cb);

  const typeChip = el('span', `chip ${['video', 'work', 'doc'].includes(t.type) ? t.type : 'skip'}`, t.type);
  row.appendChild(typeChip);

  const nm = el('span', 'tname', t.name || t.sectionName || '(无名称)');
  nm.title = `${t.name || ''}\n${t.policy || ''}`;
  row.appendChild(nm);

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

async function saveSelection() {
  if (!tree.data) return { ok: false, error: '没有可保存的清单' };
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
  const res = await fetch('/api/selection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ courseOrder, courses, taskOrder, excluded }),
  });
  // 调试辅助：记录实际发出的多元素条目（便于排查"界面顺序没保存上"）
  const multi = Object.entries(taskOrder).filter(([, v]) => v.length >= 2).length;
  console.debug(`[saveSelection] 发送: 课程 ${courseOrder.length} · 小节 ${Object.keys(taskOrder).length} · 多任务点小节 ${multi} · 排除 ${excluded.length}`);
  const body = await res.json();
  if (body.ok) {
    tree.dirty = false;
    appendLog({ t: Date.now(), level: 'ok', message: `已保存选择：排除 ${excluded.length} 个任务点` });
  }
  return body;
}

// 切到课程树标签时自动加载
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'courses' && !tree.data) loadChecklist();
  });
});

/* ---------------- 待审队列 ---------------- */

async function loadReview() {
  const res = await fetch('/api/review');
  const body = await res.json();
  if (!body.ok) {
    $('#reviewSummary').textContent = body.error || '读取待审队列失败';
    $('#reviewSource').textContent = '出错';
    return;
  }
  renderReview(body.result);
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
  sum.innerHTML =
    `共 <b>${s.total || 0}</b> 题 · 待确认 <b>${s.pending || 0}</b> · 已填入 <b>${s.filled || 0}</b> · ` +
    `已提交 <b>${s.submitted || 0}</b> · 已丢弃 <b>${s.discarded || 0}</b>` +
    (kept.length
      ? `<br><span class="muted">保持打开的作业页 ${kept.length} 个（可点「提交全部」）</span>`
      : '<br><span class="muted">当前没有保持打开的作业页 —— 若已手动关闭，答案需你在页面上手工重填</span>');

  const items = data.items || [];
  bodyEl.innerHTML = '';
  if (!items.length) {
    bodyEl.innerHTML = '<p class="placeholder">队列为空。</p>';
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
    head.appendChild(el('span', 'gname', `${list[0].course || ''} · ${list[0].secNo || ''} ${list[0].sectionName || ''}`));
    head.appendChild(el('span', 'gmeta', `${list.length} 题`));
    if (k) {
      head.appendChild(el('span', 'chip', '作业页已打开'));
      const btn = el('button', 'primary', '✔ 提交这一组');
      btn.addEventListener('click', async () => {
        btn.classList.add('busy');
        btn.textContent = '提交中…';
        const r = await fetch('/api/review/submit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ taskKey }),
        }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
        if (r.ok) {
          appendLog({ t: Date.now(), level: 'ok', message: `已提交 ${list[0].secNo} 的答案` });
          await loadReview();
        } else {
          appendLog({ t: Date.now(), level: 'error', message: `提交失败：${r.error}` });
          btn.classList.remove('busy');
          btn.textContent = '✔ 提交这一组';
        }
      });
      head.appendChild(btn);
    } else {
      head.appendChild(el('span', 'chip skip', '作业页已关闭'));
    }
    g.appendChild(head);

    const bodyInner = el('div', 'rgbody');
    for (const it of list) bodyInner.appendChild(renderQCard(it, taskKey));
    g.appendChild(bodyInner);
    bodyEl.appendChild(g);
  }
}

function renderQCard(it, taskKey) {
  const card = el('div', 'qcard');
  const isEssay = it.qtype === 'essay';

  const head = el('div', 'qhead');
  head.appendChild(el('span', 'qno', `第 ${it.questionIndex} 题`));
  head.appendChild(el('span', 'chip', it.qtypeRaw || it.qtype));
  const conf = el('span', `badge ${it.confidence}`, it.confidenceLabel || it.confidence);
  head.appendChild(conf);
  if (it.editedByHuman) head.appendChild(el('span', 'chip', '人工改过'));
  head.appendChild(el('span', 'chip', it.autoFilled ? '已自动填入' : it.filled?.verified ? '已人工填入' : '未填入'));
  if (isEssay) head.appendChild(el('span', 'chip', '简答需人工核对'));
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
  bodyEl.appendChild(shot);

  // 右：AI 答案 + 解析 + 编辑
  const info = el('div', 'qinfo');

  const r1 = el('div', 'row');
  r1.appendChild(el('span', 'lbl', isEssay ? '简答草稿' : 'AI 解析出的答案'));
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
  info.appendChild(r3);

  const r4 = el('div', 'row');
  r4.appendChild(el('span', 'lbl', '千问原始回答'));
  const ai = el('div', 'ai-text', (it.aiAnswer || it.aiError || '(无)').slice(0, 1500));
  r4.appendChild(ai);
  info.appendChild(r4);

  // 人工改答案
  const edit = el('div', 'qedit');
  const inp = document.createElement(isEssay ? 'textarea' : 'input');
  if (isEssay) { inp.rows = 6; inp.maxLength = 10000; } else inp.type = 'text';
  inp.value = isEssay ? it.textAnswer || '' : (it.letters || []).map((l) => String(l).toUpperCase()).join('');
  inp.placeholder = isEssay ? '填写简答正文，支持分段' : '如 AB';
  inp.title = isEssay ? '保存并填入将替换该题页面上的草稿；不会提交作业' : '人工修改答案（选择题填字母，判断题填 T/F 或 对/错）';
  const save = el('button', null, isEssay ? '保存并填入' : '改答案');
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
        ? `简答正文已保存并填入（${v.length} 字符），请核对后提交` : `简答填写失败：${r.error}` });
      if (r.ok) await loadReview();
      return;
    }
    const letters = v
      .split('')
      .filter((c) => /[A-Ha-h]/.test(c))
      .map((c) => c.toUpperCase());
    const finalLetters = letters.length
      ? letters
      : /^(t|true|对|正确)$/i.test(v)
        ? ['true']
        : /^(f|false|错|错误)$/i.test(v)
          ? ['false']
          : [];
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
      appendLog({ t: Date.now(), level: 'ok', message: `已改为 ${finalLetters.join('')}（提交时以你为准）` });
      await loadReview();
    } else {
      appendLog({ t: Date.now(), level: 'error', message: `改答案失败：${r.error}` });
    }
  });
  const discard = el('button', 'ghost', '丢弃这题');
  discard.addEventListener('click', async () => {
    await fetch('/api/review/discard', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: it.id }),
    }).catch(() => {});
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
  connectWS();
  appendLog({ t: Date.now(), level: 'info', message: '控制台已连接。' });
})();
