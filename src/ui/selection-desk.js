import { capturePlan, applyPlan, QUICK_RULES, planRule, applyRule } from './selection-plan.js';
import { recalc, willSummary, matchesQuery, courseVisible } from './selection.js';
import { completionOf, courseCompletion, sectionCompletion } from './task-status.js';

const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const types = { video: '视频', work: '测验', doc: '文档', read: '阅读' };

export function createSelectionDesk({ root, snapshot, change, save, navigate, action }) {
  root.innerHTML = `
    <div class="sd-layout">
      <aside class="sd-courses" aria-label="选择课程">
        <div class="sd-column-title"><b><span>课程</span></b><span id="deskCourseCount"></span></div>
        <input id="deskCourseSearch" type="search" placeholder="搜索课程…" aria-label="筛选课程" />
        <button id="deskScan" class="text-button" hidden>扫描课程 →</button>
        <p class="sd-micro">勾选课程，查看并调整任务。</p>
        <div id="deskCourses" class="sd-course-list"></div>
        <button id="deskLegacy" class="text-button sd-legacy-link">树状视图 ↗</button>
      </aside>
      <section class="sd-tasks" aria-label="章节与任务">
        <div class="sd-column-title"><b><span>章节与任务</span></b><span id="deskCourseState"></span></div>
        <div class="sd-active-course"><h3 id="deskCourseTitle">还没有课程清单</h3><p id="deskCourseMeta"></p></div>
        <details class="sd-rules" id="deskQuickRules"><summary>快捷选择 <span>按类型或章节批量选择</span></summary>
          <div id="deskRules" class="sd-rule-buttons"></div>
          <div class="sd-rule-options"><label>作用范围<select id="deskRuleScope"><option value="current">当前课程</option><option value="enabled">已勾选的课程</option><option value="all">全部课程</option></select></label>
          <div id="deskRange" hidden><label>起始节号<input id="deskFrom" placeholder="1.1" aria-label="规则起始节号" /></label><label>结束节号<input id="deskTo" placeholder="2.3" aria-label="规则结束节号" /></label></div></div>
          <p id="deskRuleDescription" class="sd-micro"></p>
          <div class="sd-rule-preview"><p id="deskRulePreview" role="status"></p><button id="deskApplyRule">应用规则</button></div>
        </details>
        <div class="sd-task-filter"><input id="deskTaskSearch" type="search" placeholder="查找章节或任务…" aria-label="筛选章节与任务" /><select id="deskTaskStatus" aria-label="任务完成状态"><option value="pending">待完成</option><option value="all">全部状态</option><option value="done">已完成</option></select></div>
        <div id="deskTasks" class="sd-task-list"></div>
      </section>
      <aside class="sd-selection" aria-label="本次已选范围与方案">
        <div class="sd-column-title"><b><span>本次学习</span></b><span id="deskRunState">尚未开始</span></div>
        <div class="sd-total"><strong id="deskTotal">0</strong><span>个任务 <small id="deskTotalCourses"></small></span></div>
        <p id="deskPendingCounts" class="sd-micro"></p>
        <details class="sd-selected-details"><summary>查看已选范围</summary><p id="deskTypeCounts" class="sd-micro"></p><div id="deskSelected" class="sd-selected-list"></div></details>
        <div id="deskProgress"></div><div id="deskRunActions" class="sd-run-actions"></div>
        <div id="deskConnection" class="sd-connection" hidden><p id="deskConnectionMessage"></p><button id="deskConnect" class="text-button">连接与登录 →</button></div>
        <div class="sd-save"><span id="deskDirty" role="status">与已保存选择一致</span><div><button id="deskSave" class="text-button">保存选择</button><button id="deskUndo" class="text-button" disabled>撤销修改</button></div></div>
        <p id="deskFeedback" class="sd-feedback" role="status" aria-live="polite"></p>
        <details class="sd-presets" id="deskPresetsPanel"><summary class="sd-preset-heading">选课方案 <span id="deskPresetCount">0 / 20</span></summary>
        <section aria-label="我的选课方案">
          <p class="sd-micro">保存当前范围，下次直接载入再微调。</p>
          <div class="sd-preset-picker"><select id="deskPreset" aria-label="选择已保存方案"><option value="">选择已存方案…</option></select><button id="deskLoadPreset">载入</button></div>
          <label class="sd-plan-name">方案名称<input id="deskPresetName" maxlength="40" placeholder="例如：本周只看视频" /></label>
          <div class="sd-preset-actions"><button id="deskCreatePreset">另存为新方案</button><details id="deskManage"><summary>管理方案 ⌄</summary><div><button id="deskReplacePreset">覆盖范围</button><button id="deskRenamePreset">仅改名</button><button id="deskDeletePreset" class="sd-danger">删除方案</button></div></details></div>
        </section></details>
      </aside>
    </div>
    <dialog id="deskConfirm" class="sd-confirm"><form method="dialog"><h3 id="deskConfirmTitle"></h3><p id="deskConfirmText"></p><div class="actions"><button value="cancel" autofocus>取消</button><button value="yes" class="primary">确认</button></div></form></dialog>`;
  const $ = id => root.querySelector('#' + id);
  // Move the original buttons with their existing listeners; there remains one
  // start/stop path with the same save-before-start and backend guards.
  $('deskRunActions').append(...document.querySelectorAll('#panel-courses > .page-heading [data-action]'));
  $('deskProgress').append(document.getElementById('runBar'));
  const runActions = $('deskRunActions'), runProgress = $('deskProgress');
  $('deskConnect').onclick = () => navigate('overview');
  $('deskScan').onclick = async () => {
    if (!guard()) return;
    const result = await action('startRecon', $('deskScan'));
    if (result?.ok === false) feedback(result.error || '未能开始扫描，请检查连接。', true);
  };
  let active = '', rule = 'unfinished', previous = null, presets = [], presetBusy = false, locked = false, account, loaded = false, requestId = 0, completedOpen = false;
  const data = () => snapshot().checklist?.courses || [];
  const busy = () => !!snapshot().status?.running || !!snapshot().status?.reconRunning;
  const feedback = (message, error = false) => { $('deskFeedback').textContent = message; $('deskFeedback').classList.toggle('error', error); };
  document.addEventListener('workspace-action-result', ({ detail }) => {
    if (!['startRun', 'stopRun'].includes(detail.name)) return;
    if (detail.result?.ok === false) feedback(detail.result.error || '操作未完成，请重试。', true);
    else if (detail.result?.ok) feedback('');
  });
  function guard() { if (busy()) { feedback('请先停止任务或等待扫描结束，再调整选课范围。', true); return false; } return true; }
  function edit(action, message) {
    if (!guard()) return;
    const before = capturePlan(data());
    try { action(); previous = before; change(); if (message) feedback(message); }
    catch (error) { feedback(error.message, true); }
  }
  function button(text, action, cls = '') {
    const b = node('button', cls, text); b.type = 'button'; b.onclick = action; return b;
  }
  function checkbox(label, checked, action, key, disabled = false) {
    const input = node('input'); input.type = 'checkbox'; input.checked = checked;
    input.setAttribute('aria-label', label); input.dataset.sdFocus = key; input.disabled = disabled || busy();
    input.onchange = () => { if (!guard()) { input.checked = !input.checked; return; } action(input.checked); }; return input;
  }
  function keepPosition(element, draw) {
    const scroll = element.scrollTop, focus = element.contains(document.activeElement) ? document.activeElement.dataset.sdFocus : null;
    draw(); element.scrollTop = scroll;
    if (focus) [...element.querySelectorAll('[data-sd-focus]')].find(e => e.dataset.sdFocus === focus)?.focus({ preventScroll: true });
  }
  function focusCourse(id) {
    active = id; $('deskCourseSearch').value = ''; $('deskTaskSearch').value = ''; $('deskTasks').scrollTop = 0; render();
  }
  function drawCourses() {
    const courses = data(), q = $('deskCourseSearch').value;
    $('deskCourseCount').textContent = `${courses.length} 门`;
    keepPosition($('deskCourses'), () => {
      $('deskCourses').replaceChildren();
      for (const done of [false, true]) {
        const group = courses.filter(c => courseCompletion(c).finished === done && courseVisible(c, q));
        if (!group.length) continue;
        let container = $('deskCourses');
        if (done) {
          const details = node('details', 'sd-completed-courses'); details.open = completedOpen || !!q;
          details.append(node('summary', null, `已完成 · ${group.length} 门`));
          container.append(details); container = details;
          details.ontoggle = () => { if (!q) completedOpen = details.open; };
        } else container.append(node('p', 'sd-group-label', `待完成 / 待确认 · ${group.length}`));
        for (const c of group) {
          const row = node('div', 'sd-course' + (active === c.courseId ? ' active' : ''));
          row.dataset.sdCourseId = c.courseId;
          row.append(checkbox(`纳入课程 ${c.name}`, c.enabled !== false, checked => edit(() => { c.enabled = checked; recalc(c); }), 'course:' + c.courseId, c.empty));
          const title = button('', () => focusCourse(c.courseId), 'sd-course-name');
          title.dataset.sdFocus = 'focus:' + c.courseId; title.setAttribute('aria-pressed', String(active === c.courseId));
          const completion = courseCompletion(c), finished = c.tasks.filter(t => completionOf(t).finished).length;
          title.append(node('b', null, c.name), node('small', null, c.tasks.length ? `完成 ${finished}/${c.tasks.length} 项 · 已选 ${c.tasks.filter(t => t.willHandle).length}` : completion.finished ? '已完成' : completion.label));
          if (c.tasks.length || completion.finished) {
            const progress = node('progress', 'sd-course-progress'); progress.max = c.tasks.length || 1; progress.value = c.tasks.length ? finished : 1;
            progress.setAttribute('aria-label', `${c.name}：${c.tasks.length ? `已读取任务完成 ${finished}/${c.tasks.length}` : '已完成'}`); title.append(progress);
          }
          row.append(title); container.append(row);
        }
      }
      if (!$('deskCourses').children.length) $('deskCourses').append(node('p', 'sd-empty', courses.length ? '没有匹配的课程。' : '首次使用请先扫描课程。'));
    });
  }
  function drawTasks() {
    const c = data().find(c => c.courseId === active), q = $('deskTaskSearch').value, mode = $('deskTaskStatus').value;
    $('deskCourseTitle').textContent = c?.name || '还没有课程清单';
    $('deskCourseMeta').textContent = c ? `${c.sections.length} 个小节 · ${c.tasks.length} 个已读取任务${c.enabled === false ? ' · 当前未纳入学习范围' : ''}` : '扫描课程后，即可在这里选择章节与任务。';
    $('deskCourseState').textContent = c ? courseCompletion(c).label : '';
    keepPosition($('deskTasks'), () => {
      const list = $('deskTasks'); list.replaceChildren(); if (!c) return;
      const sections = [...c.sections];
      for (const t of c.tasks) if (!sections.some(s => s.knowledgeId === t.knowledgeId)) sections.push({ knowledgeId: t.knowledgeId, secNo: t.secNo, name: t.sectionName });
      for (const sec of sections) {
        const all = c.tasks.filter(t => t.knowledgeId === sec.knowledgeId), progress = sectionCompletion(c, sec);
        const tasks = all.filter(t => (mode === 'all' || completionOf(t).finished === (mode === 'done')) && matchesQuery(c.name, t, q));
        if (!tasks.length && (all.length || mode !== 'all' && progress.finished !== (mode === 'done') || q && !`${sec.secNo} ${sec.name}`.includes(q))) continue;
        const block = node('section', 'sd-section'), head = node('div', 'sd-section-heading');
        const eligible = tasks.filter(t => t.policyHandle !== false), selected = eligible.filter(t => c.enabled !== false && !t.excluded).length;
        const toggle = checkbox(`选择小节 ${sec.secNo} ${sec.name}`, eligible.length > 0 && selected === eligible.length,
          checked => edit(() => { if (checked) c.enabled = true; for (const t of eligible) t.excluded = !checked; recalc(c); }), 'section:' + c.courseId + ':' + sec.knowledgeId, !eligible.length);
        toggle.indeterminate = selected > 0 && selected < eligible.length;
        head.append(toggle, node('span', 'sd-section-no', sec.secNo || '—'), node('b', null, sec.name || '未命名小节'), node('small', null, progress.finished ? '已完成' : progress.total ? `${progress.done}/${progress.total} 已完成` : progress.label));
        block.append(head);
        if (!tasks.length) block.append(node('p', 'sd-coverage', progress.finished ? '平台已标记完成，未重复读取任务详情。' : progress.label));
        for (const t of tasks) {
          const row = node('label', 'sd-task' + (t.willHandle ? ' selected' : '')); row.dataset.taskKey = t.key;
          const completion = completionOf(t);
          row.append(checkbox(`选择任务 ${t.name || t.sectionName}`, c.enabled !== false && !t.excluded && t.policyHandle !== false,
            checked => edit(() => { if (checked) c.enabled = true; t.excluded = !checked; recalc(c); }), 'task:' + t.key, t.policyHandle === false),
            node('span', 'sd-task-type', types[t.type] || t.typeName || '其他'), node('span', 'sd-task-name', t.name || t.sectionName || '未命名任务'),
            node('span', 'sd-task-status' + (completion.finished ? ' done' : ''), t.policyHandle === false ? '需人工处理' : completion.label));
          block.append(row);
        }
        list.append(block);
      }
      if (!list.children.length) list.append(node('p', 'sd-empty', mode === 'pending' ? '当前没有匹配的待完成任务，可切换「全部状态」查看。' : '没有匹配的章节或任务。'));
    });
  }
  function drawSummary() {
    const courses = data(), summary = willSummary(courses);
    $('deskTotal').textContent = summary.tasks; $('deskTotalCourses').textContent = `${summary.courses} 门课`;
    $('deskTypeCounts').textContent = Object.entries(summary.byType).filter(([, n]) => n).map(([type, n]) => `${types[type] || '其他'} ${n}`).join(' · ') || '从左侧选课程，在中间勾选任务。';
    const pending = courses.flatMap(c => c.tasks).filter(t => t.willHandle && !completionOf(t).finished).length;
    $('deskPendingCounts').textContent = summary.tasks ? `${pending} 个待完成${summary.tasks > pending ? ' · 已完成的会跳过' : ''}` : '勾选左侧课程，再选择需要学习的任务。';
    drawSession();
    $('deskSelected').replaceChildren(...summary.list.map(c => {
      const row = node('div', 'sd-selected-course'), title = button('', () => focusCourse(c.courseId));
      title.append(node('span', null, c.name), node('small', null, `${c.tasks} 项 ↗`));
      const remove = button('×', () => edit(() => { const course = courses.find(x => x.courseId === c.courseId); course.enabled = false; recalc(course); }));
      remove.setAttribute('aria-label', '移除课程 ' + c.name); remove.disabled = busy(); row.append(title, remove); return row;
    }));
    $('deskDirty').textContent = snapshot().dirty ? '范围已修改，开始时会自动保存' : '开始时会使用当前选课范围';
    $('deskDirty').classList.toggle('dirty', !!snapshot().dirty);
    $('deskUndo').disabled = !previous || busy(); $('deskSave').disabled = busy() || !snapshot().checklist;
  }
  function drawSession() {
    const status = snapshot().status || {};
    $('deskRunState').textContent = status.reconRunning ? '正在扫描' : status.running ? '进行中' : status.runStats ? '已停止' : '尚未开始';
    const connected = status.ready && status.edge?.connected && status.login?.loggedIn;
    $('deskConnection').hidden = !!connected || !!status.running || !!status.reconRunning;
    $('deskConnectionMessage').textContent = !status.ready ? '正在准备服务…' : !status.edge?.connected ? '浏览器尚未连接' : '开始前请先登录学习通';
    $('deskScan').hidden = data().length > 0;
    $('deskScan').disabled = !connected || busy();
  }
  function previewRule() {
    const courses = data(), scope = $('deskRuleScope').value;
    const ids = courses.filter(c => scope === 'all' || (scope === 'current' ? c.courseId === active : c.enabled !== false)).map(c => c.courseId);
    return planRule(courses, rule, ids, { from: $('deskFrom').value.trim(), to: $('deskTo').value.trim() });
  }
  function drawRule() {
    $('deskRange').hidden = rule !== 'range';
    $('deskRuleDescription').textContent = QUICK_RULES.find(r => r.id === rule).description;
    for (const b of $('deskRules').children) b.setAttribute('aria-pressed', String(b.dataset.rule === rule));
    try {
      const preview = previewRule();
      $('deskRulePreview').textContent = preview.courses ? `将替换 ${preview.courses} 门课的范围：保留 ${preview.selected} 项，取消 ${preview.removed} 项。其他课程不变。` : '请先选择课程范围。';
      $('deskApplyRule').disabled = busy() || !preview.courses;
    } catch (error) { $('deskRulePreview').textContent = error.message; $('deskApplyRule').disabled = true; }
  }
  function drawPresets() {
    const chosen = $('deskPreset').value;
    $('deskPreset').replaceChildren(node('option', null, '选择已存方案…')); $('deskPreset').firstChild.value = '';
    for (const preset of presets) { const option = node('option', null, preset.name); option.value = preset.id; $('deskPreset').append(option); }
    $('deskPreset').value = presets.some(p => p.id === chosen) ? chosen : '';
    $('deskPresetCount').textContent = `${presets.length} / 20`; lockControls();
  }
  function lockControls() {
    const disabled = busy() || presetBusy || !snapshot().checklist;
    for (const id of ['deskCreatePreset', 'deskPresetName']) $(id).disabled = disabled || !loaded;
    for (const id of ['deskLoadPreset', 'deskReplacePreset', 'deskRenamePreset', 'deskDeletePreset']) $(id).disabled = disabled || !loaded || !$('deskPreset').value;
    $('deskPreset').disabled = presetBusy || !loaded;
  }
  async function loadPresets() {
    const request = ++requestId;
    loaded = false; lockControls();
    try { const body = await (await fetch('/api/selection/presets')).json(); if (request !== requestId) return; if (!body.ok) throw Error(body.error); presets = body.result; loaded = true; drawPresets(); }
    catch (error) { feedback('方案读取失败：' + error.message + '。重新进入选课页可重试。', true); }
  }
  async function confirm(title, text) {
    if (!guard()) return false;
    $('deskConfirmTitle').textContent = title; $('deskConfirmText').textContent = text;
    const dialog = $('deskConfirm'); dialog.returnValue = ''; dialog.showModal();
    return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes' && guard()), { once: true }));
  }
  async function mutatePreset(action) {
    if (!guard() || presetBusy || !loaded) return;
    const selected = presets.find(p => p.id === $('deskPreset').value);
    const name = $('deskPresetName').value.trim();
    if (action !== 'delete' && !name) { feedback('请先填写方案名称。', true); $('deskPresetName').focus(); return; }
    if (action !== 'create' && !selected) return;
    if (action === 'delete' && !await confirm('删除选课方案？', `将删除「${selected.name}」，当前勾选范围不会改变。`)) return;
    if (action === 'replace' && !await confirm('覆盖方案范围？', `用当前勾选范围替换「${selected.name}」。`)) return;
    presetBusy = true; lockControls();
    try {
      const body = await (await fetch('/api/selection/presets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, id: selected?.id, name, ...(action === 'create' || action === 'replace' ? { plan: capturePlan(data()) } : {}) }) })).json();
      if (!body.ok) throw Error(body.error);
      presets = body.result.presets; drawPresets(); $('deskPreset').value = action === 'delete' ? '' : body.result.id;
      if (action === 'delete') $('deskPresetName').value = '';
      feedback(action === 'delete' ? '方案已删除，当前选课范围未改变。' : '方案已保存到本机；载入方案后可继续微调。');
    } catch (error) { feedback('方案保存失败：' + error.message, true); }
    finally { presetBusy = false; $('deskManage').open = false; lockControls(); }
  }
  $('deskRules').append(...QUICK_RULES.map(r => { const b = button(r.name, () => { rule = r.id; drawRule(); }); b.dataset.rule = r.id; return b; }));
  $('deskApplyRule').onclick = () => { try { const preview = previewRule(); edit(() => applyRule(data(), preview), `已应用「${QUICK_RULES.find(r => r.id === rule).name}」：${preview.courses} 门课、${preview.selected} 个任务。可撤销或继续微调，保存后生效。`); } catch (error) { feedback(error.message, true); } };
  for (const id of ['deskRuleScope', 'deskFrom', 'deskTo']) $(id).addEventListener('input', drawRule);
  $('deskCourseSearch').oninput = drawCourses;
  $('deskTaskSearch').oninput = drawTasks; $('deskTaskStatus').onchange = drawTasks;
  $('deskUndo').onclick = () => { if (!guard() || !previous) return; const before = previous; previous = null; applyPlan(data(), before); change(); feedback('已撤销上一次范围修改。'); };
  $('deskSave').onclick = async () => {
    if (!guard()) return; $('deskSave').disabled = true;
    try { const result = await save(); if (!result?.ok) throw Error(result?.error || '保存失败'); render(); feedback('选择已保存，点击「开始学习」才会执行。'); }
    catch (error) { feedback('选择保存失败：' + error.message, true); }
    finally { $('deskSave').disabled = busy() || !snapshot().checklist; }
  };
  $('deskPreset').onchange = () => { $('deskPresetName').value = presets.find(p => p.id === $('deskPreset').value)?.name || ''; lockControls(); };
  $('deskLoadPreset').onclick = () => {
    const preset = presets.find(p => p.id === $('deskPreset').value); if (!preset || !guard()) return;
    edit(() => {
      const result = applyPlan(data(), preset.plan);
      feedback(`已载入「${preset.name}」：匹配 ${result.matched} 项${result.missing ? `，${result.missing} 个原选任务已缺失或变化` : ''}${result.added ? `，${result.added} 个新增或变化任务未自动勾选` : ''}。请核对后保存；可撤销。`);
    });
  };
  for (const [id, action] of [['deskCreatePreset', 'create'], ['deskReplacePreset', 'replace'], ['deskRenamePreset', 'rename'], ['deskDeletePreset', 'delete']]) $(id).onclick = () => mutatePreset(action);
  const legacy = document.getElementById('legacyCourseTree');
  const legacySession = node('div'); legacySession.id = 'legacySession'; document.getElementById('deskReturn').after(legacySession);
  function setView(view, focus = false) {
    const treeView = view === 'tree';
    if (treeView) legacySession.append(runProgress, runActions);
    else $('deskConnection').before(runProgress, runActions);
    root.hidden = treeView; legacy.hidden = !treeView;
    document.getElementById('viewColumns')?.setAttribute('aria-pressed', String(!treeView));
    document.getElementById('viewTree')?.setAttribute('aria-pressed', String(treeView));
    try { localStorage.setItem('xxt-course-view', treeView ? 'tree' : 'columns'); } catch {}
    if (!treeView) render();
    if (focus) (treeView ? document.getElementById('deskReturn') : $('deskLegacy')).focus();
  }
  $('deskLegacy').onclick = () => setView('tree', true);
  document.getElementById('deskReturn').onclick = () => setView('columns', true);
  document.getElementById('viewColumns')?.addEventListener('click', () => setView('columns'));
  document.getElementById('viewTree')?.addEventListener('click', () => setView('tree'));
  function render() {
    const courses = data(); root.classList.toggle('sd-no-courses', !courses.length);
    if (!courses.some(c => c.courseId === active)) active = courses.find(c => c.enabled !== false && !courseCompletion(c).finished)?.courseId || courses[0]?.courseId || '';
    drawCourses(); drawTasks(); drawSummary(); drawRule(); lockControls();
  }
  render();
  try { setView(localStorage.getItem('xxt-course-view')); } catch {}
  return { render, focusCourse, updateStatus() {
    const nextAccount = snapshot().status?.account?.personId || '';
    if (account !== nextAccount) { account = nextAccount; presets = []; $('deskPresetName').value = ''; loadPresets(); }
    if (locked !== busy()) { locked = busy(); render(); }
    else drawSession();
  }, refreshPresets: loadPresets };
}
