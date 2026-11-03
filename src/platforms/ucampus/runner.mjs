/**
 * U校园 AI 版：学习节点执行器。
 *
 * 关键事实（2026-11-01 真机确认）：
 *   · 播放器的目录树来自它自己的接口 `guidance/getList`，每条带
 *     `taskId`（节点 id）与 `taskUrl`（hash 路径：unit/…/taskId）。
 *     这个接口要私有认证头，外部复刻会 401；但**用 Playwright 监听页面响应**
 *     就能直接拿到（页面自己带着认证去请求）。
 *   · 导航 = 把 `location.hash` 设成 `#/<courseId>/courseware/<taskUrl>`。
 *     实测改 hash 会让播放器加载对应内容，不需要点目录（点击定位太脆弱）。
 *   · 验收 = 重新读教程的 finishPointNum，涨了才算完成（progressDelta）。
 *
 * 所以执行器不伪造任何进度：真实加载节点 → 真实播放/停留 → 平台自己上报 → 读回确认。
 */
import { log } from '../../logbus.mjs';
import { throwIfStopped, interruptibleSleep } from '../../control.mjs';
import { loadSettings } from '../../config.mjs';
import { classifyNodeOutcome, progressDelta } from './policy.mjs';
import { readTutorialProgress } from './scan.mjs';

const PLAYER_HOST = 'https://ucontent.unipus.cn';
const treeCache = new Map();

/** 打开（或复用）某教程的播放器页面 */
async function ensurePlayer(context, { instanceId, continueUrl }) {
  const pages = context.pages().filter((p) => !p.isClosed() && p.url().startsWith(PLAYER_HOST));
  const hit = pages.find((p) => instanceId && p.url().includes(instanceId));
  if (hit) return hit;
  const page = pages[0] || (await context.newPage());
  if (continueUrl) {
    await page.goto(continueUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } else if (instanceId) {
    await page.goto(`${PLAYER_HOST}/_explorationpc_default/pc.html#/${instanceId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await page.waitForTimeout(3000);
  return page;
}

/**
 * 读播放器的目录树：监听它自己的 guidance/getList 响应。
 * 结果按教程缓存，避免每个节点都重载一次页面。
 */
export async function readPlayerTree(page, { shouldStop = () => false } = {}) {
  const captured = [];
  const onResponse = (res) => {
    if (!/guidance\/getList/.test(res.url())) return;
    res
      .json()
      .then((body) => captured.push(body))
      .catch(() => {});
  };
  page.on('response', onResponse);
  try {
    throwIfStopped(shouldStop);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 20 && !captured.length; i += 1) {
      throwIfStopped(shouldStop);
      await interruptibleSleep(500, shouldStop);
    }
  } finally {
    page.off('response', onResponse);
  }
  const data = captured.find((b) => Array.isArray(b?.data))?.data || [];
  return data
    .filter((item) => item && item.taskId && item.taskUrl)
    .map((item) => ({ taskId: String(item.taskId), taskUrl: String(item.taskUrl), unit: String(item.unit || '') }));
}

/**
 * 完成"自评类"节点（Review & check）。
 *
 * 真机结论（2026-11-01）：
 *   · 表格每行是一条 "I can ..."，第 2 列是 Got it 方框（`span.anticon-border`）；
 *   · 必须用**真实鼠标事件**点单元格中心——DOM 的 `.click()` 不触发 React 的提交；
 *   · 一次点击会 POST `/course/api/v3/newExploration/submit`，body 里的
 *     `groupId` 就是节点 id，证明平台按节点记账；
 *   · 点完之后 `finishPointNum` 会从 1 变 2（已实测）。
 *
 * @returns {Promise<{kind:string, clicked:number}>}
 */
async function completeSelfAssessment(page, { shouldStop = () => false } = {}) {
  const total = await page.evaluate(() => document.querySelectorAll('table .anticon-border').length);
  if (!total) return { kind: 'none', clicked: 0 };
  log(`   自评类节点：${total} 条待勾选`, 'info');
  let clicked = 0;
  for (let round = 0; round < 20; round += 1) {
    throwIfStopped(shouldStop);
    const box = await page.evaluate(() => {
      const table = document.querySelector('table');
      if (!table) return '';
      const row = [...table.querySelectorAll('tbody tr')].slice(1).find((tr) => tr.querySelector('td .anticon-border'));
      if (!row) return '';
      const td = row.querySelectorAll('td')[1];
      if (!td) return '';
      const r = td.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    });
    if (!box) break;
    const { x, y } = JSON.parse(box);
    await page.mouse.move(x, y);
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.mouse.up();
    clicked += 1;
    await page.waitForTimeout(1200);
  }
  log(`   自评：已勾选 ${clicked} 条`, 'ok');
  return { kind: 'self-assessment', clicked };
}

/** 让当前节点产生学习行为：先试交互类（自评/练习），再试视频/音频，最后按阅读处理 */
async function studyCurrentNode(page, { shouldStop = () => false, onProgress = () => {} } = {}) {
  const settings = loadSettings();
  const speed = Math.min(2, Math.max(1, Number(settings?.playbackSpeed) || 1));
  await page.waitForTimeout(1500);

  // 1) 自评类：表格里的 Got it 方框
  const assessment = await completeSelfAssessment(page, { shouldStop });
  if (assessment.clicked) return { kind: assessment.kind };

  // 2) 视频 / 音频
  const media = await page.evaluate(() => {
    const pick = document.querySelector('video') || document.querySelector('audio');
    if (!pick) return null;
    return {
      kind: document.querySelector('video') ? 'video' : 'audio',
      duration: Number.isFinite(pick.duration) ? pick.duration : 0,
    };
  });

  if (!media) {
    const dwellMs = Math.max(5000, Number(settings?.ucampusDwellMs) || 12000);
    log(`   阅读类节点，停留 ${Math.round(dwellMs / 1000)} 秒`, 'info');
    await page.evaluate(() => {
      const scroller = document.scrollingElement || document.body;
      scroller.scrollTop = scroller.scrollHeight;
    });
    const started = Date.now();
    while (Date.now() - started < dwellMs) {
      throwIfStopped(shouldStop);
      await interruptibleSleep(500, shouldStop);
    }
    return { kind: 'reading' };
  }

  log(`   ${media.kind === 'video' ? '视频' : '音频'}节点，时长 ${Math.round(media.duration)} 秒，按 ${speed}× 播放`, 'info');
  await page.evaluate((rate) => {
    const pick = document.querySelector('video') || document.querySelector('audio');
    if (!pick) return;
    pick.muted = true;
    pick.playbackRate = rate;
    pick.play().catch(() => {});
  }, speed);

  const limitMs = Math.max(60000, ((media.duration || 600) * 1000) / speed + 60000);
  const started = Date.now();
  for (;;) {
    throwIfStopped(shouldStop);
    const st = await page.evaluate(() => {
      const pick = document.querySelector('video') || document.querySelector('audio');
      if (!pick) return { ended: true, t: 0, d: 0 };
      return { ended: pick.ended, t: pick.currentTime || 0, d: Number.isFinite(pick.duration) ? pick.duration : 0 };
    });
    onProgress({ phase: 'play', detail: `${Math.round(st.t)}/${Math.round(st.d)} 秒` });
    if (st.ended || (st.d && st.t / st.d >= 0.995)) break;
    if (Date.now() - started > limitMs) {
      log('   播放超时，停止等待（不谎报完成）', 'warn');
      break;
    }
    await interruptibleSleep(1000, shouldStop);
  }
  return { kind: media.kind };
}

/**
 * 执行一个学习节点。
 * @param {{task:object, context:Function, shouldStop?:Function, onProgress?:Function, continueUrl?:string}} args
 */
export async function runUcampusStudyNode({ task, context, shouldStop = () => false, onProgress = () => {}, continueUrl = '' }) {
  const nodeId = String(task.platformTaskKey || '');
  const courseResourceId = String(task.courseResourceId || '');
  if (!nodeId || !courseResourceId) return { ok: false, phase: 'failed', error: '任务缺少节点或教程标识' };

  const before = await readTutorialProgress({ context, courseResourceId, shouldStop });
  if (!before) return { ok: false, phase: 'failed', error: '读不到该教程的进度，可能登录已失效' };
  if (Number(before.finishPointNum) >= Number(before.totalPointNum)) {
    return { ok: true, phase: 'already-finished' };
  }

  const page = await ensurePlayer(context(), {
    instanceId: String(task.courseInstanceId || ''),
    continueUrl,
  });
  await ensureDirectoryOpen(page);

  // 目录条目没有 id，只能"点一下看它请求哪个节点"来确定位置（实测改 hash 不会加载内容）
  let index = indexCache.get(courseResourceId)?.get(nodeId);
  if (index === undefined) {
    index = await resolveNodeIndex(page, nodeId, { shouldStop, onProgress });
    if (index < 0) {
      return { ok: false, phase: 'needs-human', error: `目录里定位不到节点 ${nodeId}，请在播放器里核对` };
    }
    if (!indexCache.has(courseResourceId)) indexCache.set(courseResourceId, new Map());
    indexCache.get(courseResourceId).set(nodeId, index);
  }

  onProgress({ phase: 'open', detail: nodeId });
  await page.evaluate((idx) => {
    const list = [...document.querySelectorAll('span.pc-menu-node-name')];
    const el = list[idx];
    if (el) el.click();
  }, index);
  await page.waitForTimeout(4000);

  await studyCurrentNode(page, { shouldStop, onProgress });

  const after = await readTutorialProgress({ context, courseResourceId, shouldStop });
  const delta = progressDelta(before, after);
  log(
    `   平台进度：${before.finishPointNum}/${before.totalPointNum} → ${after?.finishPointNum}/${after?.totalPointNum}（${delta}）`,
    delta === 'advanced' ? 'ok' : 'warn',
  );
  const outcome = classifyNodeOutcome({ delta, stopped: shouldStop() });
  return { ...outcome, delta, before: before.finishPointNum, after: after?.finishPointNum, loaded: hits.length > 0 };
}

export function resetUcampusCaches() {
  treeCache.clear();
}

/** 打开播放器左侧「目录」面板（折叠时条目不可见） */
export async function ensureDirectoryOpen(page) {
  const opened = await page.evaluate(() => {
    const tab = [...document.querySelectorAll('div,span,button,a,li')].find(
      (el) => (el.innerText || '').trim() === '目录' && el.getClientRects().length,
    );
    if (tab) {
      tab.click();
      return true;
    }
    return false;
  });
  if (opened) await page.waitForTimeout(1500);
  return opened;
}

const indexCache = new Map();

/**
 * 找出必修节点在目录里的条目下标。
 * 目录条目（span.pc-menu-node-name）不带 id，只能"点一下看它请求了哪个节点 id"
 * —— 播放器会请求 .../<nodeId>/<openId>/default，这是自校验的信号。
 */
export async function resolveNodeIndex(page, nodeId, { shouldStop = () => false, onProgress = () => {} } = {}) {
  const entries = await page.evaluate(() =>
    [...document.querySelectorAll('span.pc-menu-node-name')].map((el, index) => ({ index, text: (el.innerText || '').trim() })),
  );
  if (!entries.length) return -1;
  onProgress({ phase: 'map', detail: `目录 ${entries.length} 条` });
  const hits = [];
  const onRequest = (req) => {
    const url = req.url();
    if (!/\/course\/api\//.test(url)) return;
    for (const seg of url.split('?')[0].split('/')) if (/^[0-9a-f]{12,22}$/i.test(seg)) hits.push(seg);
  };
  page.on('request', onRequest);
  try {
    for (const entry of entries) {
      throwIfStopped(shouldStop);
      hits.length = 0;
      await page.evaluate((idx) => {
        const list = [...document.querySelectorAll('span.pc-menu-node-name')];
        const el = list[idx];
        if (el) el.click();
      }, entry.index);
      await page.waitForTimeout(900);
      if (hits.includes(nodeId)) {
        log(`   定位到节点 ${nodeId} → 目录第 ${entry.index + 1} 条（${entry.text}）`, 'ok');
        return entry.index;
      }
    }
  } finally {
    page.off('request', onRequest);
  }
  return -1;
}