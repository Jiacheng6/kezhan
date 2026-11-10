/**
 * 入口：编排全流程
 *   拉起/接管 Edge → 起控制台 → 打开学习通 → 探测登录态 → 等指令
 *
 * 常驻不退出：控制台的按钮通过 HTTP 调到这里注册的 hooks。
 */
import { spawn } from 'node:child_process';
import { ensureDirs, loadSettings, PATHS, TARGETS, DEBUG_PORT, DEFAULT_SETTINGS, PERSON_ID } from './config.mjs';
import { describeSettings, normalizeSettings, diffFromDefault, getByPath, toSparseSettings, READONLY_SPEC } from './settings.mjs';
import { log, patchStatus, getStatus, notifyUser } from './logbus.mjs';
import { ensureEdge, connect, contextOf, getPage, bringToFront, findPage, waitForPage, waitForAnyPage, stopOwnedEdge } from './browser/launch.mjs';
import { waitForPagesSettled, cleanupPages, closeTrackedPages, isSamePageUrl, newTaskPage, releasePage } from './browser/pages.mjs';
import { gotoChaoxingHome } from './browser/login.mjs';
import { listCourses, reconAll, saveReconReport, writeTaskReport } from './chaoxing/recon.mjs';
import { autoConfigurePersonId } from './chaoxing/identity.mjs';
import { buildChecklist, loadSelection, invalidateReconCache } from './chaoxing/checklist.mjs';
import { batchRunner, buildRunTasks } from './batch.mjs';
import { assertRunScope } from './ui/run-scope.js';
import { loadState, resetState, statePath, setTaskStatus, listReviewItems, markReviewItem, healStaleRunning, reconcile, mutateState, repairCompletedReviewRecords } from './state.mjs';
import { listKeptPages, registerKeptPage, editKeptEssayReviewAnswer, findStandaloneWork } from './chaoxing/quizrun.mjs';
import { frameWorkIdentity } from './chaoxing/submission-state.mjs';
import { getWorkMeta } from './chaoxing/quiz.mjs';
import { reopenReviewWork, submitPendingReviews, withReviewLock, syncSubmittedReviews } from './chaoxing/review-recovery.mjs';
import {reconcileReviewResults,reconcileOneReview} from './review-reconcile.mjs';
import {reviewOperationBlock} from './review-policy.mjs';
import { updateReviewAnswer } from './state.mjs';
import { startServer } from './server.mjs';
import { embedded, embeddedRequest } from './browser/embedded.mjs';
import { getOnboarding } from './onboarding.mjs';
import { startWindowControl, setBrowserVisible, isBrowserVisible, stopWindowControl } from './browser/window-control.mjs';
import { ownerState, startOwnerMonitor } from './browser/owner-lifecycle.mjs';
import {selectedProvider, ensureProviderPage} from './ai/providers.mjs';
import {aiResumeStatus,continueAI,onAIResumeChange} from './ai/resume.mjs';
import {apiStatus, askApiImage} from './ai/api.mjs';
import {askImage, readAnswer, checkLogin} from './ai/ai.mjs';
import {parseAnswer} from './ai/parse.mjs';
import { PlatformRuns, planPlatformRun } from './platforms/runs.mjs';
import { scanZhihuishuCourses } from './platforms/zhihuishu/scan.mjs';
import { scanUcampusCourses, ensureUcampusPage } from './platforms/ucampus/scan.mjs';
import { readStudentCourses } from './platforms/ucampus/api.mjs';
import {ensureWelearnPage,scanWelearnCourses} from './platforms/welearn/scan.mjs';
import {runWelearnSelectedTask} from './platforms/welearn/dispatch.mjs';
import { runUcampusStudyNode, ensurePlayer as ensureUcampusPlayer } from './platforms/ucampus/runner.mjs';
import {confirmedUcampusOutcome} from './platforms/ucampus/policy.mjs';
import { runUcampusQuizTab, openUnitTest, openQuizTab, openUcampusRequiredItem, openVocabularyLearning, clickByText, dismissUcampusDialog, requireUcampusReady } from './platforms/ucampus/quiz.mjs';
import { runUcampusTextQuiz } from './platforms/ucampus/textquiz.mjs';
import { runUcampusCloze } from './platforms/ucampus/cloze.mjs';
import { runUcampusVocab } from './platforms/ucampus/vocab.mjs';
import { runZhihuishuVideo } from './platforms/zhihuishu/runner.mjs';
import { runZhihuishuQuiz, restoreZhihuishuReview, submitZhihuishuReview, editZhihuishuReview, syncZhihuishuReviews } from './platforms/zhihuishu/quiz-task.mjs';
import { platformOf,platformInfo,platformEnabled,enabledCourses,enabledPlatformIds,assertPlatformChange } from './ui/platforms.js';
import { onAIQueueChange } from './ai/queue.mjs';
onAIQueueChange(aiQueue => patchStatus({ aiQueue }));
const extraRuns = new PlatformRuns({ execute: args => {
    // 按平台分派：U校园 按题型走不同执行器（学习/自评/选择题/填空/翻译/单词卡），其余沿用智慧树实现
    if (args.platform === 'ucampus' || platformOf(args.task) === 'ucampus') return runUcampusTask(args);
    if (args.platform === 'welearn') return runWelearnSelectedTask(args);
    return args.task.type === 'work' ? runZhihuishuQuiz(args) : runZhihuishuVideo(args);
  }, changed: sessions => patchStatus({ platformRuns: sessions }),
  onRestart:({task,result,error})=>log(`【平台任务】当前任务暂停，保留进度并重启一次（1/1）：${task.name||''} · ${result?.error||error?.message||'页面暂未恢复'}`,'warn') });
const startingPlatforms = new Set();
const retryingReviews = new Set();
const zhsScan = { running: false, stop: false };
const ucampusScan = { running: false, stop: false };
const welearnScan={running:false,stop:false};
// 同一时间只允许一个 U校园 测验任务在跑（真机踩过：两次任务交错作答）
let ucampusQuizBusy = false;
/** 批量执行用：按题型把 U校园 的一个必修节点分派到对应执行器 */
async function runUcampusTask(args) {
  const task=args.task||{};
  setTaskStatus(task.key,{status:'running',platform:'ucampus'});
  try{
    const result=confirmedUcampusOutcome(await executeUcampusTask(args));
    if(result?.nativeReceipt?.accepted)mutateState(s=>{s.ucampusSubmissions||={};s.ucampusSubmissions[task.key]={at:new Date().toISOString(),accepted:true,workUrl:result.workUrl,questions:result.nativeReceipt.answerCount,credited:result.credited===true};});
    setTaskStatus(task.key,{status:result?.ok?'done':result?.phase==='stopped'?'pending':'manual',platform:'ucampus',
      progress:result?.ok?1:undefined,note:result?.ok?'U校园平台已确认完成':result?.error||'任务已停止，保留进度'});
    return result;
  }catch(error){
    setTaskStatus(task.key,{status:error.code==='STOPPED'?'pending':'manual',platform:'ucampus',note:error.message});throw error;
  }
}
async function executeUcampusTask(args) {
  const task = args.task || {};
  const kind = String(task.type || 'study');
  const unit = Number(task.unitIndex || 0);
  const stop = args.shouldStop || (() => shuttingDown);

  // 学习节点 / 自评：沿用原来的执行器（真实鼠标勾选）
  if (kind === 'review' || kind === 'study') return runUcampusStudyNode(args);

  let page;
  if (kind === 'vocab-cards' || kind === 'video-quiz') {
    const entered = await openUcampusRequiredItem(ctx(), kind === 'vocab-cards' ? 'Vocabulary' : 'Quiz', {unit,courseResourceId:String(task.courseResourceId||'')});
    if(!entered.ok)return {ok:false,phase:'needs-human',error:entered.note};
    page=entered.page;
  } else page = await ensureUcampusPlayer(ctx(), {instanceId:String(task.courseInstanceId||''),continueUrl:task.studyUrl||'',courseResourceId:String(task.courseResourceId||''),shouldStop:stop});
  if (!/^https:\/\/ucontent\.unipus\.(cn|com)\//.test(page.url())) return { ok:false,phase:'needs-human',error:'U校园播放器未成功打开，请核对课程登录与续学入口' };
  await requireUcampusReady(page);

  if (kind === 'vocab-cards') {
    const r = await runUcampusVocab({ page, apply: true, shouldStop: stop, readProgress, onProgress:args.onProgress, dwellMs:1200,onBeforeVerify:()=>openUnitTest(page,unit) });
    return r;
  }

  // 其余类型都要 AI；统一构造 ask（豆包/千问走网页，api 走接口）
  const provider = selectedProvider(loadSettings());
  const aiPage = provider?.id === 'api' ? null : await ensureProviderPage(ctx(), provider);
  if (provider?.id !== 'api') {
    const login = await checkLogin(aiPage).catch(() => ({ loggedIn: false }));
    if (!login?.loggedIn) return { ok: false, phase: 'blocked-ai', error: `${provider.label}未登录，先登录再跑测验` };
  }
  const ask = async ({ imagePath, prompt, question }) => {
    if (provider?.id === 'api') {
      const r = await askApiImage({ imagePath, prompt, shouldStop: stop });
      if (!r?.ok) return { ok: false, letters: [], confidence: 'none', error: r?.error };
      const parsed = parseAnswer(r.answer, question || { qtype: 'single' });
      return { ok: true, answer: r.answer, letters: parsed.letters || [], confidence: parsed.confidence || 'low' };
    }
    const r = await askImage({ page: aiPage, imagePath, prompt, shouldStop: stop, freshChat: false });
    if (!r?.ok) return { ok: false, letters: [], confidence: 'none', error: r?.error };
    const parsed = parseAnswer(r.answer, question || { qtype: 'single' });
    return { ok: true, answer: r.answer, letters: parsed.letters || [], confidence: parsed.confidence || 'low' };
  };
  async function readProgress() {
    const uai = (await ensureUcampusPage(ctx(), { create: false })) || (await ensureUcampusPage(ctx()));
    const list = await readStudentCourses(uai, { shouldStop: stop });
    for (const course of list) {
      for (const tutorial of course.courseResourceList || []) {
        if (String(tutorial.id) === String(task.courseResourceId)) return tutorial;
      }
    }
    return null;
  };


  if (kind === 'video-quiz') {
    return runUcampusQuizTab({ page, tab: null, limit: 99, apply: true, ask, shouldStop: stop, readProgress, onProgress:args.onProgress });
  }
  if (kind === 'unit-cloze') {
    const opened = await openUnitTest(page, unit);
    if (!opened.ok) return { ok: false, phase: 'needs-human', error: opened.note };
    const tabOk = await clickByText(page, 'Banked cloze', { selector: '[class*="pc-header-task"], [class*="pc-task"]' });
    if (!tabOk) return { ok: false, phase: 'needs-human', error: '找不到 Banked cloze 标签' };
    await page.waitForTimeout(3000);
    await dismissUcampusDialog(page);
    return runUcampusCloze({ page, ask, apply: true, shouldStop: stop, readProgress, onProgress:args.onProgress });
  }
  const tabName = kind === 'unit-vocab' ? 'Vocabulary' : kind === 'unit-reading' ? 'Reading' : kind === 'unit-translation' ? 'Translation' : '';
  const opened = await openUnitTest(page, unit);
  if (!opened.ok) return { ok: false, phase: 'needs-human', error: opened.note };
  if (kind === 'unit-translation') {
    const tabbed = await openQuizTab(page, tabName);
    if (!tabbed) return { ok: false, phase: 'needs-human', error: `找不到标签「${tabName}」` };
    return runUcampusTextQuiz({ page, ask, apply: true, limit: 99, shouldStop: stop, readProgress, onProgress:args.onProgress });
  }
  const tabbed = await openQuizTab(page, tabName);
  if (!tabbed) return { ok: false, phase: 'needs-human', error: `找不到标签「${tabName}」` };
  return runUcampusQuizTab({ page, tab: null, limit: 99, apply: true, ask, shouldStop: stop, readProgress, onProgress:args.onProgress });
}

function startUcampusTasks(tasks) {
  const plan = planPlatformRun(tasks, loadState().taskPoints);
  if (plan.skipped) log(`【U校园】保留并跳过 ${plan.skipped} 个已完成节点，本次待完成 ${plan.tasks.length} 个`, 'info');
  if (!plan.tasks.length) return { started: false, platform: 'ucampus', count: 0, skipped: plan.skipped, message: '所选节点均已完成，无需重复执行' };
  const result = extraRuns.start('ucampus', plan.tasks, ctx());
  log(`【U校园】开始 ${plan.tasks.length} 个必修节点；以平台 finishPointNum 增长为验收标准`, 'info');
  void extraRuns.wait('ucampus').then((session) => {
    if (session.error) {
      const attention = session.phase === 'needs-human';
      log(`【U校园】${attention ? '已暂停，需要处理' : '任务中断'}：` + session.error, attention ? 'warn' : 'error');
      notifyUser(attention ? 'ucampus-attention' : 'batch-error', { key: `ucampus:${Date.now()}`, detail: 'U校园：' + session.error });
    } else {
      notifyUser(session.phase === 'stopped' ? 'batch-stopped' : 'batch-complete', {
        key: `ucampus:${Date.now()}`,
        detail: `U校园：完成 ${session.done}/${session.total} 个节点`,
      });
    }
  });
  return { ...result, skipped: plan.skipped, selected: plan.selected };
}

function startWelearnTasks(tasks){
  const plan=planPlatformRun(tasks,loadState().taskPoints);
  if(!plan.tasks.length)return {started:false,platform:'welearn',count:0,skipped:plan.skipped,message:'所选 WeLearn 小节均已完成'};
  const result=extraRuns.start('welearn',plan.tasks,ctx());
  log(`【WeLearn】开始 ${plan.tasks.length} 个小节；真实课件运行，按平台原小节完成状态核对`,'info');
  void extraRuns.wait('welearn').then(session=>{
    if(session.error){log('【WeLearn】已暂停：'+session.error,'warn');notifyUser('welearn-attention',{key:'welearn:'+Date.now(),detail:session.error});}
    else notifyUser(session.phase==='stopped'?'batch-stopped':'batch-complete',{key:'welearn:'+Date.now(),detail:`WeLearn：平台确认 ${session.done}/${session.total} 个小节`});
  });
  return {...result,skipped:plan.skipped,selected:plan.selected};
}
function startZhihuishuTasks(tasks) {
  const plan=planPlatformRun(tasks,loadState().taskPoints);
  if(plan.skipped)log(`【智慧树】保留并跳过 ${plan.skipped} 个已完成任务，本次待完成 ${plan.tasks.length} 个`, 'info');
  if(!plan.tasks.length)return {started:false,platform:'zhihuishu',count:0,skipped:plan.skipped,message:'所选任务均已完成，无需重复执行'};
  const result = extraRuns.start('zhihuishu', plan.tasks, ctx());
  log(`【智慧树】开始 ${plan.tasks.length} 个任务；学习通队列独立运行，AI逐题排队`, 'info');
  void extraRuns.wait('zhihuishu').then(session => {
    if (session.error) {
      const attention=session.phase==='needs-human';
      log(`【智慧树】${attention?'已暂停，需要处理':'任务中断'}：`+session.error,attention?'warn':'error');
      notifyUser(attention?'zhihuishu-attention':'batch-error',{key:`zhihuishu:${Date.now()}`,detail:'智慧树：'+session.error});
    }
    else notifyUser(session.phase === 'stopped' ? 'batch-stopped' : session.review ? 'batch-review' : 'batch-complete', { key: `zhihuishu:${Date.now()}`, detail: `智慧树：完成 ${session.done}/${session.total} 个任务，待审 ${session.review||0} 份` });
  });
  return {...result,skipped:plan.skipped,selected:plan.selected};
}
onAIResumeChange(wait=>{patchStatus({aiWaiting:wait});if(wait.waiting)notifyUser('ai-verification',{provider:wait.provider,key:wait.provider+'-verification',detail:`${wait.label}需要人工验证；完成后点击“验证已完成，继续本题”。`});});

/*
 * ⚠ 不要在这里把 PERSON_ID 抄成常量。
 *
 * 账号 ID 是**运行时才自动识别**的（登录后从页面里认出来，见 chaoxing/identity.mjs）。
 * 早期写成 `const RUN_PERSON_ID = PERSON_ID` —— 那是"导入那一刻的快照"，
 * 自动识别发生在这之后，于是跑任务时用的还是空字符串（换了别人用就必踩）。
 * 现在一律在使用处直接读 `PERSON_ID`（ESM 实时绑定，拿到的永远是最新值）。
 */

/** 读取请求体 JSON（hook 里需要原始 body 时用） */
function readJson(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(new Error(`JSON 解析失败: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

const runtime = {
  browser: null,
  context: null,
  coursePage: null,
  qianwenPage: null,
  service: null,
  getStatus,
};

/** 侦察运行态 */
const recon = { running: false, stopRequested: false };

/** 便捷取 context（hooks 里用） */
function ctx() {
  return runtime.context;
}
function requirePlatform(id){if(!platformEnabled(loadSettings(),id))throw Error(`${platformInfo(id).name}已关闭，请在“学习平台”设置中开启`);}

function openInDefaultBrowser(url) {
  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* 打不开就算了，日志里已经打印了地址 */
  }
}

/**
 * 等"会话恢复"把页面找回来。
 * Edge 带 --restore-last-session 启动时，标签页是异步恢复的，
 * 刚连上 CDP 那一刻可能只有 about:blank，所以要给它一点时间。
 */
async function waitForRestoredPage(context, urlPart, timeoutMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (context.pages().some((p) => p.url().includes(urlPart))) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function boot() {
  ensureDirs();
  const repairedReviews = repairCompletedReviewRecords();
  if (repairedReviews.videoPages || repairedReviews.quizzes) log(`待审记录对账：移除 ${repairedReviews.videoPages} 条已完成视频弹窗记录，同步 ${repairedReviews.quizzes} 份已提交测验摘要`, 'info');
  const settings = loadSettings();
  if (embedded) await embeddedRequest('audio-muted', { muted: settings.muted !== false });
  // account 一并带上：local.json 已配置时，控制台一打开就能看到账号 ID
  patchStatus({ settings, phase: 'P4', bootError: null, account: accountStatus(), browserMode: embedded ? 'embedded' : 'external' });

  log('学习通自动刷课助手 启动中…', 'info');
  log(`工作目录: ${PATHS.root}`, 'dim');

  // 先起界面服务：Edge 不存在或启动失败时也能显示诊断和重试入口。
  runtime.service = await startServer(buildHooks());
  const { url, port } = runtime.service;
  log(`控制台已就绪: ${url}`, 'ok');
  process.parentPort?.postMessage({ type: 'server-ready', url });
  if (process.env.KEBO_SMOKE_TEST === '1') {
    patchStatus({ ready: true, bootError: '离线打包自检：未启动浏览器、未连接账号' });
    return runtime;
  }

  // 1) 拉起 / 接管 Edge
  let edgeInfo;
  try {
    edgeInfo = await ensureEdge((m, lv) => log(m, lv));
  } catch (err) {
    patchStatus({ bootError: err.message });
    log(err.message, 'error');
    return null;
  }

  // 2) CDP 接管
  let browser;
  try {
    browser = await connect();
  } catch (err) {
    patchStatus({ bootError: `CDP 接管失败: ${err.message}` });
    log(`CDP 接管失败: ${err.message}`, 'error');
    return null;
  }

  runtime.browser = browser;
  const context = await contextOf(browser);
  runtime.context = context;
  if (embedded) runtime.coursePage = context.pages()[0] || null;
  browser.on('disconnected', () => {
    if (shuttingDown) return;
    batchRunner.requestStop();
    extraRuns.stopAll();
    patchStatus({ ready: false, edge: { connected: false }, bootError: '网页连接已中断，请在软件中重启服务。已保存的进度仍然保留。' });
  });
  await startWindowControl(browser);
  patchStatus({ browserVisible: !embedded });

  patchStatus({
    edge: {
      connected: true,
      launched: edgeInfo.launched,
      version: edgeInfo.version?.Browser || 'unknown',
    },
  });
  log(`已连接${embedded ? '内置网页' : 'Edge'}，当前标签页 ${context.pages().length} 个`, 'ok');

  /*
   * 等标签页"稳定"再往下走。
   *
   * Edge 带 `--restore-last-session`：上一轮的标签页是**异步恢复**的。
   * 不等就会出岔子 —— 恢复还没完成时判断"有没有现成的控制台/千问页"，
   * 会得出"没有" → 再新建一个 → 恢复完成后就变成**重复标签页**（用户实测反馈）。
   */
  const settled = embedded ? { pages: context.pages().length } : await waitForPagesSettled(context, { quietMs: 1500, maxMs: 10000 });
  if (settled.pages !== context.pages().length) {
    log(`标签页恢复到 ${context.pages().length} 个`, 'debug');
  }

  /*
   * 4) 清场：关掉上一轮残留的刷课/测验页、about:blank，并去掉重复的控制台/千问页。
   *    白名单 = state.json 里 keptPages 记录的"等你手动作答/确认提交"的页面。
   */
  try {
    const keptUrls = Object.values(loadState().keptPages || {})
      .map((k) => k.url)
      .filter(Boolean);
    const cr = await cleanupPages(context, {
      keepUrls: keptUrls,
      log: (m, lv) => log(m, lv || 'dim'),
    });
    if (cr.closed.length) {
      log(`启动清场：关掉 ${cr.closed.length} 个残留页面`, 'ok');
      for (const c of cr.closed.slice(0, 8)) log(`    × ${c.reason} → ${c.url}`, 'dim');
      if (cr.closed.length > 8) log(`    …还有 ${cr.closed.length - 8} 个`, 'dim');
    } else {
      log('启动清场：没有需要关闭的残留页面', 'dim');
    }
    if (keptUrls.length) {
      const opened=context.pages().filter(page=>!page.isClosed()&&keptUrls.some(url=>isSamePageUrl(url,page.url()))).length;
      log(`    （保留 ${keptUrls.length} 条待审定位记录，当前打开 ${opened} 页，其余可恢复）`, 'dim');
    }

    /*
     * 关闭页面后仍保留定位与草稿，待用户恢复；不能把恢复入口一起删掉。
     */
    try {
      const live = context.pages().filter((p) => !p.isClosed()).map((p) => p.url());
      const closed=Object.values(loadState().keptPages||{}).filter(record=>record.url&&!live.some(url=>isSamePageUrl(url,record.url))).length;
      if (closed) log(`    ${closed} 个待审作业页已关闭，定位和答案已保留，可在待审答案中恢复`, 'dim');
    } catch {
      /* 清理失败不影响启动 */
    }
  } catch (err) {
    log(`启动清场失败（不影响使用）：${err.message}`, 'warn');
  }

  /*
   * 4) 学习通页面（复用或新建）
   *
   * 必须**先等**：Edge 的启动 URL 要先经过 about:blank 才提交，
   * `--restore-last-session` 恢复的标签页也是异步出现的。
   * 不等就会"以为没有 → 新建一个"，于是同一个页面开两个（实测冷启动后出现两个）。
   */
  let coursePage = platformEnabled(settings,'chaoxing') ? (embedded ? findPage(context, 'chaoxing.com') : await waitForPage(context, 'chaoxing.com', 7000)) : null;
  if (!coursePage&&platformEnabled(settings,'chaoxing')) {
    coursePage = (embedded && context.pages().find(page => page.url() === 'about:blank')) || await context.newPage();
    await coursePage.goto(TARGETS.chaoxingHome, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    log('新开学习通标签页', 'dim');
  }
  runtime.coursePage = coursePage;

  // 4.5) 千问标签页（P4 答题通道）—— 复用已有的，没有就开一个待用户登录
  let qianwenPage = null;
  try { qianwenPage = await ensureProviderPage(context, selectedProvider(loadSettings()), { create: enabledPlatformIds(loadSettings()).some(id=>id!=='welearn')&&!!getOnboarding().completedAt&&getOnboarding().aiWanted!==false }); }
  catch (err) { log(`打开${selectedProvider(loadSettings()).label}失败（不影响其他任务）：${err.message}`, 'warn'); }
  runtime.qianwenPage = qianwenPage;

  /* 千问登录态先探一次（界面顶栏"答题通道"那颗灯），失败不阻塞启动 */
  await refreshQianwenStatus().catch(() => {});

  // 5) 打开控制台：优先在受控 Edge 里开（能和你并排看）
  let consoleOpenedInEdge = false;
  let consolePage = null;
  if (process.env.KEBO_DESKTOP !== '1') try {
    // 同样先等一等：恢复会话可能已经带回了控制台标签页
    consolePage = await waitForPage(context, `127.0.0.1:${port}`, 5000);
    if (!consolePage) {
      consolePage = await getPage(context, `127.0.0.1:${port}`, { create: true, navigate: url });
    }
    if (consolePage && consolePage.url().includes(`127.0.0.1:${port}`)) {
      consoleOpenedInEdge = true;
    }
  } catch {
    /* 忽略 */
  }
  if (process.env.KEBO_DESKTOP !== '1' && !consoleOpenedInEdge) openInDefaultBrowser(url);

  /*
   * 5.5) 再清一次场：把"恢复会话 + 我们新建"这轮竞态里可能多出来的重复页收掉。
   *
   * 走到这里时所有需要的页面都已就位，所以把**正在用的三个页面**显式保护起来
   * （课程页/千问页/控制台）—— 去重逻辑再怎么写错也不会把正在用的页面关掉。
   */
  try {
    const dup = await cleanupPages(context, {
      keepUrls: Object.values(loadState().keptPages || {})
        .map((k) => k.url)
        .filter(Boolean),
      protectedPages: [coursePage, qianwenPage, consolePage],
      log: (m, lv) => log(m, lv || 'dim'),
    });
    if (dup.closed.length) {
      log(`去重：关掉 ${dup.closed.length} 个重复/残留页面`, 'ok');
      for (const c of dup.closed.slice(0, 6)) log(`    × ${c.reason} → ${c.url}`, 'dim');
    }
  } catch {
    /* 忽略 */
  }

  // 6) 进学习通 + 探测登录态
  if(coursePage)await bringToFront(coursePage);

  // 启动自愈：把上次崩溃遗留在 running 的任务点重置为 pending
  try {
    const healed = healStaleRunning();
    if (healed.fixed) log(`已重置 ${healed.fixed} 个上次中断的任务点（回到待处理）`, 'warn');
  } catch (err) {
    log(`重置中断状态失败（可忽略）：${err.message}`, 'debug');
  }

  /*
   * 启动对账：把"本地记录未完成、但学习通已是绿点"的任务点标为已完成。
   *
   * 必要性：本地 state.json 可能落后于学习通（例如用户自己看过、
   * 或上一次运行完成但状态没来得及写）。不对账就会重复去刷已完成的内容 ——
   * 既浪费时间，也增加被判定异常的风险。
   */
  try {
    const cl = buildChecklist();
    if (cl) {
      const tasks = buildRunTasks(cl);
      const r = reconcile(tasks);
      if (r.fixed) log(`对账：${r.fixed} 个任务点在学习通上已显示完成 → 标记为完成，本次跳过`, 'ok');
    }
  } catch (err) {
    log(`启动对账失败（可忽略）：${err.message}`, 'debug');
  }

  await refreshLogin();

  /*
   * 千问登录态定期刷新（60 秒一次）。
   * 用户可能中途去登录千问，界面那颗"答题通道"灯要能自己变绿，
   * 而不是重启服务才更新。只读一次 DOM，开销可忽略。
   */
  setInterval(() => {
    refreshQianwenStatus().catch(() => {});
  }, 60000).unref?.();

  patchStatus({ ready: true });
  log('——— P4 就绪（刷课 + 测验答题）———', 'ok');
  if (platformEnabled(loadSettings(),'chaoxing')&&!getStatus().login.loggedIn) {
    log('尚未登录学习通，请在学习通网页中扫码或使用账号登录。', 'warn');
    log('登录完成后，点控制台里的「重新检测登录」即可。', 'warn');
  } else {
    const s = loadState();
    const doneCount = Object.values(s.taskPoints || {}).filter((t) => t.status === 'done').length;
    log(`运行记录：已有 ${doneCount} 个任务点标记完成（断点续跑会自动跳过它们）`, 'info');
  }
  return runtime;
}

async function refreshLogin() {
  if(!platformEnabled(loadSettings(),'chaoxing')){const result={loggedIn:false,reason:'学习通已关闭'};patchStatus({login:result});return result;}
  const previouslyLoggedIn = !!getStatus().login?.loggedIn;
  const page = runtime.coursePage;
  if (!page) return { loggedIn: false, reason: '学习通页面不存在' };
  try {
    const result = await gotoChaoxingHome(page);
    patchStatus({ login: result });
    if (result.loggedIn) {
      log(`登录态正常（${result.title || result.url}）`, 'ok');
      /*
       * 登录成功后顺手自动识别账号 ID。
       * 这是"交给别人用"的关键一环：使用者不需要知道 cpi 是什么、
       * 更不用去地址栏里找 —— 登录完程序自己认，并写进 local.json。
       */
      if (!PERSON_ID) {
        const got = await autoConfigurePersonId({ context: runtime.context, page }).catch(() => ({ ok: false }));
        patchStatus({ account: accountStatus(got.ok ? got.from : null) });
      } else {
        patchStatus({ account: accountStatus() });
      }
    } else {
      log(`登录态异常：${result.reason}`, 'warn');
      if (previouslyLoggedIn || batchRunner.running || recon.running) notifyUser('login-required');
    }
    return result;
  } catch (err) {
    log(`登录探测失败: ${err.message}`, 'error');
    return { loggedIn: false, reason: err.message };
  }
}

/**
 * 账号 ID 的状态（给控制台显示用）。
 *
 * 为什么要显示：这个功能的价值就是"你不用管它"，但如果界面上什么都看不到，
 * 使用者反而会怀疑"到底配上了没"。所以把 ID 和它的来源如实打出来
 * （source='auto' 表示本次自动识别，'local.json' 表示读的已有配置）。
 */
function accountStatus(autoFrom = null) {
  if (!PERSON_ID) return { personId: null, source: null, detail: null };
  return {
    personId: PERSON_ID,
    source: autoFrom ? 'auto' : 'local.json',
    detail: autoFrom || null,
  };
}

/**
 * 重新认领"保持打开"的页面。
 *
 * 页面句柄只存在进程内存里，服务重启后就认不出还开在 Edge 里的页面
 * （实测：重启后「待审队列」显示 closed=true，明明标签页还在）。
 * 这里按 URL 把活着的标签页重新登记回来。
 */
let reviewSyncJob=null,reviewSyncStarted=0;
async function beginReviewSync({force=false}={}){
 if(reviewSyncJob)return {started:false,running:true};
 if(!force&&Date.now()-reviewSyncStarted<30000)return {started:false,running:false,cooldown:true};
 if(!ctx()||!getStatus().ready)throw Error('内置网页尚未就绪');
 reviewSyncStarted=Date.now();patchStatus({reviewSync:{running:true,index:0,total:0,synced:0}});
 reviewSyncJob=reconcileReviewResults(ctx(),{personId:PERSON_ID,shouldStop:()=>shuttingDown,onProgress:progress=>patchStatus({reviewSync:progress})})
  .then(result=>{patchStatus({reviewSync:result,reviewCount:listReviewItems().length});log(`待审平台核对完成：已归档 ${result.synced} 组，其余 ${result.total-result.synced} 组保留`,'info');return result;})
  .catch(error=>{patchStatus({reviewSync:{running:false,error:error.message}});log('待审平台核对未完成，草稿保留：'+error.message,'warn');})
  .finally(()=>{reviewSyncJob=null;});
 return {started:true,running:true};
}
function assertReviewScopeIdle(scope){
 const error=reviewScopeBlock(scope);
 if(error)throw Error(error);
}
function reviewScopeBlock(scope){return reviewOperationBlock(scope,{chaoxingRunning:batchRunner.running,zhihuishuRunning:!!extraRuns.snapshot().zhihuishu?.running,chaoxingScanning:recon.running,zhihuishuScanning:zhsScan.running,syncRunning:!!reviewSyncJob});}
async function readoptKeptPages() {
  const ctxNow = ctx();
  if (!ctxNow) return 0;
  let n = 0;
  const live = ctxNow.pages();
  for (const rec of listKeptPages()) {
    if(rec.key.startsWith('zhihuishu:'))continue;
    if (rec.submittable || !rec.url) continue;
    const hit = live.find((p) => isSamePageUrl(p.url(), rec.url));
    if (hit) {
      registerKeptPage(rec.key, hit, rec.info || {});
      log(`重新认领保留页面：${rec.info?.secNo || ''} ${rec.info?.name || rec.key}`, 'info');
      n += 1;
    }
  }
  return n;
}

/**
 * 重新探测千问登录态并推到界面（顶栏"答题通道"灯）。
 * 失败一律按"未登录"处理，绝不因此打断主流程。
 */
async function refreshQianwenStatus({create=false}={}) {
  const provider=selectedProvider(loadSettings());
  if(provider.id==='api'){
    const status=await apiStatus().catch(()=>({configured:false}));runtime.qianwenPage=null;
    patchStatus({ai:{provider:'api',label:'API',loggedIn:status.configured,url:null},qianwen:{loggedIn:status.configured,url:null}});
    return {loggedIn:status.configured};
  }
  const sequence=runtime.aiProbeSequence=(runtime.aiProbeSequence||0)+1;
  const current=()=>runtime.aiProbeSequence===sequence&&selectedProvider(loadSettings()).id===provider.id;
  const publish=(loggedIn,url=null)=>{if(current())patchStatus({ai:{provider:provider.id,label:provider.label,loggedIn,url},qianwen:{loggedIn,url}});};
  publish(false);
  let p;
  try { p=runtime.context?await ensureProviderPage(runtime.context,provider,{create}):null; }
  catch(error){if(current())runtime.qianwenPage=null;publish(false);throw error;}
  if(!current())return {loggedIn:false,stale:true};
  runtime.qianwenPage=p;
  if (!p) {
    publish(false);
    return { loggedIn: false };
  }
  try {
    const { checkLogin } = await import('./ai/ai.mjs');
    const l = await checkLogin(p);
    publish(!!l.loggedIn, p.url().slice(0,80));
    return { loggedIn: !!l.loggedIn };
  } catch {
    publish(false,p.url().slice(0,80));
    return { loggedIn: false };
  }
}

function buildHooks() {
  return {
    aiResumeStatus:async()=>aiResumeStatus(),
    continueAI:async()=>continueAI(),
    editReviewAnswer: async (body) => {
      const item = listReviewItems().find((it) => it.id === body.id);
      if (!item) return null;
      if(platformOf(item)==='zhihuishu'){
        if(getStatus().platforms?.zhihuishu?.running)throw Error('请先停止智慧树任务再修改答案');
        return withReviewLock(item.taskKey,()=>editZhihuishuReview(ctx(),item,body.letters));
      }
      if(item.qtype==='discussion'){
        if(batchRunner.running||recon.running)throw new Error('请先停止当前任务，再修改讨论草稿');
        return withReviewLock(item.taskKey,async()=>(await import('./chaoxing/discussion.mjs')).saveDiscussionDraft(body.id,body.textAnswer));
      }
      if (item.qtype !== 'essay') {
        if (Object.hasOwn(body, 'textAnswer')) throw new Error('此题不是简答题');
        if(batchRunner.running||recon.running)throw new Error('请先停止当前任务，再修改答案');
        return withReviewLock(item.taskKey,async()=>{
          const saved=updateReviewAnswer(body.id,body.letters||[]);
            try{const prepared=await reopenReviewWork(ctx(),item.taskKey,{personId:PERSON_ID});if(prepared.alreadySubmitted)return {id:body.id,alreadySubmitted:true};}
          catch(error){throw new Error(`答案已保存，但未能填入作业页：${error.message}`);}
          return listReviewItems().find(it=>it.id===saved.id);
        });
      }
      if (batchRunner.running) throw new Error('请先停止当前任务，再修改简答草稿');
      await readoptKeptPages();
      return withReviewLock(item.taskKey,()=>editKeptEssayReviewAnswer(body.id, body.textAnswer,{
        ensurePage:key=>reopenReviewWork(ctx(),key,{personId:PERSON_ID,restoreAnswers:false}),
      }));
    },
    discardReviewItem: async ({id}={}) => {
      const item=listReviewItems().find(item=>item.id===id);
      if(!item)return null;
      return withReviewLock(item.taskKey,()=>markReviewItem(id,{status:'discarded'}));
    },
    // —— 浏览器 / 登录 ——
    refreshLogin: async () => refreshLogin(),

    /** 重新探测千问登录态（界面「答题通道」灯） */
    checkQianwen: async () => refreshQianwenStatus({create:true}),
    openAI: async () => {
      if(selectedProvider(loadSettings()).id==='api')return {provider:'api',api:true};
      await refreshQianwenStatus({create:true});
      if(runtime.qianwenPage)await bringToFront(runtime.qianwenPage);
      if(process.env.KEBO_DESKTOP==='1'){await setBrowserVisible(true);patchStatus({browserVisible:true});}
      return {provider:selectedProvider(loadSettings()).id};
    },

    // —— 设置（设置页可编辑） ——
    getSettings: async () => ({
      rows: describeSettings(loadSettings()),
      readonly: READONLY_SPEC.map((r) => ({ ...r, value: getByPath(loadSettings(), r.path) })),
      changed: diffFromDefault(loadSettings()),
    }),

    /**
     * 保存设置。校验后写进 state.json 的 settings 段。
     * 生效时机：`loadSettings()` 每次都读盘，所以**下一个任务点/下一道题**就用新值，
     * 不需要重启服务。
     */
    saveSettings: async (patch = {}) => {
      const before = loadSettings();
      const r = normalizeSettings(patch, before);
      assertPlatformChange(before,r.settings,{...getStatus(),platformRuns:extraRuns.snapshot(),startingPlatforms:[...startingPlatforms]});
      const providerChanged=selectedProvider(r.settings).id!==selectedProvider(before).id;
      if(providerChanged&&(getStatus().running||getStatus().aiQueue?.active))throw new Error('请先停止各平台任务，再切换 AI 答题通道');
      if (r.rejected.length) {
        log(`设置未保存：无法识别的项 ${r.rejected.join('、')}`, 'error');
        return { ok: false, error: `无法识别的设置项：${r.rejected.join('、')}`, ...r };
      }
      /*
       * 只写"与默认值不同"的项（稀疏存盘）。
       * 写整份会把今天的默认值钉死在 state.json 里，以后改默认值用户永远不生效。
       */
      const sparse = toSparseSettings(r.settings, DEFAULT_SETTINGS);
      mutateState((s) => {
        s.settings = sparse;
        if(s.onboarding&&Object.keys(patch).some(key=>key.startsWith('platforms.')))s.onboarding.platforms=enabledPlatformIds(r.settings);
      });
      const after = loadSettings();
      if (embedded) await embeddedRequest('audio-muted', { muted: after.muted !== false });
      const changedKeys = Object.keys(r.applied).filter(
        (k) => JSON.stringify(getByPath(before, k)) !== JSON.stringify(getByPath(after, k)),
      );
      const changed = diffFromDefault(after);
      patchStatus({ settings: after });
      log(
        changedKeys.length
          ? `设置已保存：${changedKeys.map((k) => `${k}=${JSON.stringify(getByPath(after, k))}`).join(' · ')}`
          : '设置已保存（与原来一致，没有变化）',
        changedKeys.length ? 'ok' : 'info',
      );
      if (r.errors.length) for (const e of r.errors) log(`    ! ${e}`, 'warn');
      if(providerChanged)await refreshQianwenStatus({create:true}).catch(error=>log(`设置已保存，答题网页尚未就绪：${error.message}`,'warn'));
      return { ok: true, applied: r.applied, errors: r.errors, changed };
    },

    /** 恢复出厂设置（会清掉 state.json 里的 settings 段） */
    resetSettings: async () => {
      if(batchRunner.running||Object.values(extraRuns.snapshot()).some(s=>s.running)||recon.running||zhsScan.running||ucampusScan.running||welearnScan.running)throw new Error('请先停止当前任务或扫描，再恢复设置');
      mutateState((s) => {
        s.settings = {};
      });
      const settings = loadSettings();
      if (embedded) await embeddedRequest('audio-muted', { muted: settings.muted !== false });
      patchStatus({ settings });
      await refreshQianwenStatus({create:true}).catch(()=>{});
      log('设置已恢复为默认值', 'ok');
      return { ok: true };
    },

    /**
     * 一键清理：关掉所有刷课/测验临时页 + 空白页 + 重复的控制台/千问页。
     * 白名单（state.keptPages）和"正在跑的任务页"不会被关。
     */
    cleanupPages: async () => {
      const keptUrls = Object.values(loadState().keptPages || {})
        .map((k) => k.url)
        .filter(Boolean);
      const before = ctx()?.pages().length ?? 0;
      const r = await cleanupPages(ctx(), {
        keepUrls: keptUrls,
        preserveBusy: true,
        log: (m, lv) => log(m, lv || 'dim'),
      });
      log(`一键清理：关闭 ${r.closed.length} 个页面，当前剩 ${r.kept.length} 个`, 'ok');
      for (const c of r.closed.slice(0, 10)) log(`    × ${c.reason} → ${c.url}`, 'dim');
      if (keptUrls.length) log(`    （保留了 ${keptUrls.length} 个等你手动作业的页面）`, 'dim');
      return { before, after: r.kept.length, closed: r.closed.length, details: r.closed.slice(0, 30) };
    },

    openChaoxing: async () => {
      requirePlatform('chaoxing');
      if (process.env.KEBO_DESKTOP === '1') await setBrowserVisible(true);
      const page = runtime.coursePage && !runtime.coursePage.isClosed() ? runtime.coursePage : (await runtime.context.newPage());
      runtime.coursePage = page;
      if (!page.url().includes('chaoxing.com')) await page.goto(TARGETS.chaoxingHome, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await bringToFront(page);
      log(`已在${embedded ? '软件内' : '受控浏览器中'}打开学习通首页`, 'info');
      return { ok: true };
    },
    readZhihuishu: async () => {
      requirePlatform('zhihuishu');
      if (!ctx()) throw Error('内置网页尚未就绪');
      if (zhsScan.running) throw Error('智慧树正在扫描');
      if (extraRuns.snapshot().zhihuishu?.running) throw Error('请先停止智慧树任务再读取课程');
      zhsScan.running = true; zhsScan.stop = false;
      try {
        const result = await scanZhihuishuCourses(ctx(), { shouldStop: () => zhsScan.stop || shuttingDown,
          onProgress: progress => patchStatus({ zhihuishuScan: { running: true, ...progress } }) });
        log(`【智慧树】扫描完成：${result.courses} 门课程、${result.videos} 个视频`, 'ok'); return result;
      } catch(error){notifyUser('batch-error',{key:'zhihuishu-scan',detail:error.message});throw error;}
      finally { zhsScan.running = false; patchStatus({ zhihuishuScan: { running: false } }); }
    },

    /** 在软件内打开 U校园 站点（让用户在受控浏览器里登录） */
    openUcampus: async () => {
      requirePlatform('ucampus');
      const page = await ensureUcampusPage(ctx());
      if (!page) throw Error('打不开 U校园 页面');
      await bringToFront(page);
      log('已在受控浏览器中打开 U校园，请在其中登录后再扫描', 'info');
      return { ok: true, url: 'https://uai.unipus.cn/portal' };
    },
    openWelearn:async()=>{requirePlatform('welearn');const page=await ensureWelearnPage(ctx());await bringToFront(page);return {ok:true};},
    readWelearn:async()=>{
      requirePlatform('welearn');
      if(!ctx())throw Error('内置网页尚未就绪');
      if(welearnScan.running||extraRuns.snapshot().welearn?.running)throw Error('请先停止 WeLearn 任务或等待扫描完成');
      welearnScan.running=true;welearnScan.stop=false;
      try{const result=await scanWelearnCourses(ctx(),{shouldStop:()=>welearnScan.stop||shuttingDown,onProgress:progress=>patchStatus({welearnScan:{running:true,...progress}})});
        log(`【WeLearn】扫描完成：${result.courses} 门课程、${result.nodes} 个小节`,'ok');notifyUser('scan-complete',{key:'welearn-scan'});return result;
      }catch(error){notifyUser(error.code==='STOPPED'?'scan-stopped':'scan-failed',{key:'welearn-scan',detail:error.message});throw error;}
      finally{welearnScan.running=false;patchStatus({welearnScan:{running:false}});}
    },

    /**
     * 读取 U校园 AI 版课程与必修节点（只读扫描）。
     * 与智慧树扫描分开跑，互不影响；扫描结果写进平台清单。
     */
    readUcampus: async () => {
      requirePlatform('ucampus');
      if (!ctx()) throw Error('网页尚未就绪');
      if (ucampusScan.running) throw Error('U校园正在扫描');
      if (extraRuns.snapshot().ucampus?.running) throw Error('请先停止 U校园 任务再读取课程');
      ucampusScan.running = true; ucampusScan.stop = false;
      try {
        const result = await scanUcampusCourses({
          context: () => ctx(),
          shouldStop: () => ucampusScan.stop || shuttingDown,
          onProgress: (progress) => patchStatus({ ucampusScan: { running: true, ...progress } }),
        });
        const nodes = result.courses.reduce((n, c) => n + c.taskPoints.length, 0);
        log(`【U校园】扫描完成：${result.courses.length} 门课程、${nodes} 个必修节点`, 'ok');
        return { courses: result.courses.length, nodes, detail: result };
      } catch (error) {
        notifyUser('batch-error', { key: 'ucampus-scan', detail: error.message });
        throw error;
      } finally {
        ucampusScan.running = false;
        patchStatus({ ucampusScan: { running: false } });
      }
    },

    /**
     * 执行 U校园 单个学习节点（用于验证与手动补跑；批量走 extraRuns）。
     * 走界面真实播放，完成后以平台 finishPointNum 是否增长作为验收。
     */
    runUcampusNode: async (req) => {
      if (!ctx()) throw Error('网页尚未就绪');
      const body = await readJson(req);
      const nodeId = String(body.nodeId || '');
      const courseResourceId = String(body.courseResourceId || '');
      if (!nodeId || !courseResourceId) throw Error('缺少 nodeId 或 courseResourceId');
      const result = await runUcampusStudyNode({
        task: { platformTaskKey: nodeId, courseResourceId, courseInstanceId: String(body.courseInstanceId || ''), name: body.name || nodeId },
        context: () => ctx(),
        shouldStop: () => shuttingDown,
        continueUrl: String(body.continueUrl || ''),
        onProgress: (progress) => patchStatus({ ucampusRun: { running: true, ...progress } }),
      });
      patchStatus({ ucampusRun: { running: false } });
      return result;
    },

    /**
     * U校园 测验节点：读题 → 问 AI →（全部高可靠时）点选并提交。
     * 默认 apply=false：只算不点，返回每题的答案与可靠性，供人工核对。
     */
    runUcampusQuiz: async (req) => {
      if (!ctx()) throw Error('网页尚未就绪');
      const body = await readJson(req);
      const provider = selectedProvider(loadSettings());
      const aiPage = provider?.id === 'api' ? null : await ensureProviderPage(ctx(), provider);
      const playerPage = (await ensureUcampusPage(ctx(), { create: false })) || (await ensureUcampusPage(ctx()));
      const page = ctx().pages().find((p) => !p.isClosed() && p.url().startsWith('https://ucontent.unipus.cn'));
      if (!page) throw Error('没有打开播放器页，请先在 U校园 教程里点「继续学习」');
      void playerPage;
      // 前置检查：通道没登录就直接说清楚，不要每题白等 30 秒节流后才发现
      if (provider?.id !== 'api') {
        const login = await checkLogin(aiPage).catch(() => ({ loggedIn: false }));
        if (!login?.loggedIn) throw Error(`${provider.label}未登录，请先在受控浏览器里登录后再答题`);
      }
      // 指定单元时，先在播放器里打开该单元的 Unit test 节点
      if (ucampusQuizBusy) throw Error('已有 U校园 测验任务在跑，请等它结束（同一页面并发作答会错乱）');
      ucampusQuizBusy = true;
      try {
      if (body.unit && !body.required) {
        const opened = await openUnitTest(page, Number(body.unit));
        if (!opened.ok) throw Error(opened.note || '打不开该单元的 Unit test');
      }
      /*
       * 视频区的必修（Vocabulary / Quiz）不在播放器目录里，
       * 只能从 uai 教程页的必修清单点进去，会新开一个播放器标签页。
       */
      let quizPage = page;
      // 视频区必修（Vocabulary / Quiz）：目录 → Reading the text → Vocabulary learning → 子标签
      if (body.vocab) {
        const opened = await openVocabularyLearning(page, {
          unitOccurrence: Number(body.unitOccurrence ?? (Number(body.unit || 1) - 1) * 2),
          subTab: String(body.sub || 'Quiz'),
        });
        if (!opened.ok) throw Error(opened.note || '打不开 Vocabulary learning');
      }
      if (body.required) {
        const opened = await openUcampusRequiredItem(ctx(), String(body.required), { occurrence: Number(body.occurrence || 0), unit: body.unit ? Number(body.unit) : null });
        if (!opened.ok) throw Error(opened.note || `打不开必修项「${body.required}」`);
        quizPage = opened.page;
      }
      const ask = async ({ imagePath, prompt, question }) => {
        if (provider?.id === 'api') {
          const apiResult = await askApiImage({ imagePath, prompt, shouldStop: () => shuttingDown });
          if (!apiResult?.ok) return { ok: false, letters: [], confidence: 'none', error: apiResult?.error };
          const parsed = parseAnswer(apiResult.answer, question || { qtype: 'single' });
          return { ok: true, answer: apiResult.answer, letters: parsed.letters || [], confidence: parsed.confidence || 'low' };
        }
        const webResult = await askImage({ page: aiPage, imagePath, prompt, shouldStop: () => shuttingDown, freshChat: body.freshChat === true });
        if (!webResult?.ok) return { ok: false, letters: [], confidence: 'none', error: webResult?.error };
        let answer = String(webResult.answer || '');
        let parsed = parseAnswer(answer, question || { qtype: 'single' });
        /*
         * 真机踩到：千问把「深度思考已完成」和真正的答案放在**不同的块**里，
         * readAnswer 只取最后一张卡，于是常常只读到思考摘要、解析不出字母。
         * 这里改为把最后几张卡的文字拼起来解析，并从拿到回答后持续读 20 秒，
         * 直到解析出字母或内容不再增长（不重复提问，省节流）。
         */
        const readCards = async () => {
          try {
            const raw = await aiPage.evaluate(() => {
              const cards = [...document.querySelectorAll('.chat-answers-card-wrap')];
              const texts = cards.map((c) => (c.innerText || '').trim()).filter(Boolean);
              return JSON.stringify({ recent: texts.slice(-3) });
            });
            return String((JSON.parse(raw).recent || []).join('\n'));
          } catch {
            return '';
          }
        };
        let lastSeen = answer;
        for (let i = 0; i < 14 && !(parsed.letters || []).length; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const combined = await readCards();
          if (combined && combined !== lastSeen) {
            lastSeen = combined;
            answer = combined;
            parsed = parseAnswer(answer, question || { qtype: 'single' });
            continue;
          }
          if (!combined) {
            const state = await readAnswer(aiPage).catch(() => null);
            const next = String(state?.text || '');
            if (next && next !== answer) {
              answer = next;
              parsed = parseAnswer(answer, question || { qtype: 'single' });
            }
          }
        }
        return { ok: true, answer, letters: parsed.letters || [], confidence: parsed.confidence || 'low' };
      };
      return runUcampusQuizTab({
        page: quizPage,
        tab: body.tab ? String(body.tab) : body.required || body.vocab ? null : 'Vocabulary',
        limit: Number(body.limit || 99),
        apply: body.apply === true,
        ask,
        shouldStop: () => shuttingDown,
        // 验收回调：读平台口径的"已学任务"，涨了才算这个节点完成
        readProgress: async () => {
          const list = await readStudentCourses(playerPage || page, { shouldStop: () => shuttingDown });
          for (const course of list) {
            for (const tutorial of course.courseResourceList || []) {
              if (String(tutorial.id) === String(body.courseResourceId || '20001230493')) return tutorial;
            }
          }
          return null;
        },
      });
      } finally {
        ucampusQuizBusy = false;
      }
    },

    /**
     * U校园 文本作答（简答 / 翻译）：读题干 → AI 生成答案 → 填写 → 提交 → 验收。
     * 默认 apply=false，只返回每题答案与可用性。
     */
    runUcampusTextQuiz: async (req) => {
      if (!ctx()) throw Error('网页尚未就绪');
      const body = await readJson(req);
      if (ucampusQuizBusy) throw Error('已有 U校园 测验任务在跑，请等它结束');
      ucampusQuizBusy = true;
      try {
        const provider = selectedProvider(loadSettings());
        const aiPage = provider?.id === 'api' ? null : await ensureProviderPage(ctx(), provider);
        const page = ctx().pages().find((p) => !p.isClosed() && p.url().startsWith('https://ucontent.unipus.cn'));
        if (!page) throw Error('没有打开播放器页，请先在 U校园 教程里点「继续学习」');
        const playerPage = (await ensureUcampusPage(ctx(), { create: false })) || (await ensureUcampusPage(ctx()));

        if (provider?.id !== 'api') {
          const login = await checkLogin(aiPage).catch(() => ({ loggedIn: false }));
          if (!login?.loggedIn) throw Error(`${provider.label}未登录，请先在受控浏览器里登录后再答题`);
        }
        // 指定"单元 + 标签"时，先打开该单元的 Unit test，再切到指定标签
        if (body.unit && body.tab) {
          const opened = await openUnitTest(page, Number(body.unit));
          if (!opened.ok) throw Error(opened.note || '打不开该单元的 Unit test');
          const tabbed = await openQuizTab(page, String(body.tab));
          if (!tabbed) throw Error(`播放器里找不到标签「${body.tab}」`);
        }
        // 指定目录条目时先打开它
        if (body.nodeIndex !== undefined && body.nodeIndex !== null) {
          await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
          await page.evaluate((i) => {
            const tab = [...document.querySelectorAll('div,span,button,a,li')].find((el) => (el.innerText || '').trim() === '目录' && el.getClientRects().length);
            if (tab) tab.click();
            const list = [...document.querySelectorAll('span.pc-menu-node-name')];
            if (list[i]) list[i].click();
          }, Number(body.nodeIndex));
          await page.waitForTimeout(5000);
        }

        const ask = async ({ imagePath, prompt }) => {
          if (provider?.id === 'api') {
            const apiResult = await askApiImage({ imagePath, prompt, shouldStop: () => shuttingDown });
            if (!apiResult?.ok) return { ok: false, answer: '', error: apiResult?.error };
            return { ok: true, answer: apiResult.answer };
          }
          const webResult = await askImage({ page: aiPage, imagePath, prompt, shouldStop: () => shuttingDown, freshChat: false });
          if (!webResult?.ok) return { ok: false, answer: '', error: webResult?.error };
          return { ok: true, answer: webResult.answer };
        };

        return await runUcampusTextQuiz({
          page,
          ask,
          apply: body.apply === true,
          limit: Number(body.limit || 99),
          shouldStop: () => shuttingDown,
          readProgress: async () => {
            const list = await readStudentCourses(playerPage || page, { shouldStop: () => shuttingDown });
            for (const course of list) {
              for (const tutorial of course.courseResourceList || []) {
                if (String(tutorial.id) === String(body.courseResourceId || '20001230493')) return tutorial;
              }
            }
            return null;
          },
        });
      } finally {
        ucampusQuizBusy = false;
      }
    },

    /**
     * U校园 Banked cloze（选词填空）：读文章 → AI 选词 → fill → 提交 → 验收。
     */
    runUcampusCloze: async (req) => {
      if (!ctx()) throw Error('网页尚未就绪');
      const body = await readJson(req);
      if (ucampusQuizBusy) throw Error('已有 U校园 测验任务在跑，请等它结束');
      ucampusQuizBusy = true;
      try {
        const provider = selectedProvider(loadSettings());
        const aiPage = provider?.id === 'api' ? null : await ensureProviderPage(ctx(), provider);
        const page = ctx().pages().find((p) => !p.isClosed() && p.url().startsWith('https://ucontent.unipus.cn'));
        if (!page) throw Error('没有打开播放器页');
        const playerPage = (await ensureUcampusPage(ctx(), { create: false })) || (await ensureUcampusPage(ctx()));
        if (provider?.id !== 'api') {
          const login = await checkLogin(aiPage).catch(() => ({ loggedIn: false }));
          if (!login?.loggedIn) throw Error(`${provider.label}未登录，请先登录`);
        }
        // 打开该单元的 Unit test → Banked cloze 表头
        if (body.unit) {
          const opened = await openUnitTest(page, Number(body.unit));
          if (!opened.ok) throw Error(opened.note || '打不开该单元的 Unit test');
          const tabOk = await clickByText(page, 'Banked cloze', { selector: '[class*="pc-header-task"], [class*="pc-task"]' });
          if (!tabOk) throw Error('没找到「Banked cloze」表头');
          await page.waitForTimeout(3000);
          await dismissUcampusDialog(page);
        }

        const ask = async ({ imagePath, prompt }) => {
          if (provider?.id === 'api') {
            const r = await askApiImage({ imagePath, prompt, shouldStop: () => shuttingDown });
            return { ok: !!r?.ok, answer: r?.answer || '', error: r?.error };
          }
          const r = await askImage({ page: aiPage, imagePath, prompt, shouldStop: () => shuttingDown, freshChat: false });
          return { ok: !!r?.ok, answer: r?.answer || '', error: r?.error };
        };

        return await runUcampusCloze({
          page,
          ask,
          apply: body.apply === true,
          shouldStop: () => shuttingDown,
          readProgress: async () => {
            const list = await readStudentCourses(playerPage || page, { shouldStop: () => shuttingDown });
            for (const course of list) {
              for (const tutorial of course.courseResourceList || []) {
                if (String(tutorial.id) === String(body.courseResourceId || '20001230493')) return tutorial;
              }
            }
            return null;
          },
        });
      } finally {
        ucampusQuizBusy = false;
      }
    },

    /**
     * U校园 Vocabulary（单词卡片）：一路点「下一个」把 53 张走完，平台按完成度记账。
     */
    runUcampusVocab: async (req) => {
      if (!ctx()) throw Error('网页尚未就绪');
      const body = await readJson(req);
      if (ucampusQuizBusy) throw Error('已有 U校园 测验任务在跑，请等它结束');
      ucampusQuizBusy = true;
      try {
        const page = ctx().pages().find((p) => !p.isClosed() && p.url().startsWith('https://ucontent.unipus.cn'));
        if (!page) throw Error('没有打开播放器页');
        const playerPage = (await ensureUcampusPage(ctx(), { create: false })) || (await ensureUcampusPage(ctx()));

        if (body.unit) {
          const opened = await openVocabularyLearning(page, {
            unitOccurrence: Number(body.unitOccurrence ?? (Number(body.unit) - 1) * 2),
            subTab: 'Vocabulary',
          });
          if (!opened.ok) throw Error(opened.note || '打不开 Vocabulary learning');
        }

        return await runUcampusVocab({
          page,
          apply: body.apply === true,
          shouldStop: () => shuttingDown,
          readProgress: async () => {
            const list = await readStudentCourses(playerPage || page, { shouldStop: () => shuttingDown });
            for (const course of list) {
              for (const tutorial of course.courseResourceList || []) {
                if (String(tutorial.id) === String(body.courseResourceId || '20001230493')) return tutorial;
              }
            }
            return null;
          },
        });
      } finally {
        ucampusQuizBusy = false;
      }
    },

    focusEdge: async () => {
      if (process.env.KEBO_DESKTOP === '1') await setBrowserVisible(true);
      const page = runtime.coursePage || runtime.context.pages()[0];
      if (page) await bringToFront(page);
      return { ok: true };
    },

    showBrowser: async () => {
      const result = await setBrowserVisible(true);
      patchStatus({ browserVisible: isBrowserVisible() });
      return result;
    },
    hideBrowser: async () => {
      const result = await setBrowserVisible(false);
      patchStatus({ browserVisible: isBrowserVisible() });
      return result;
    },

    // —— 侦察（P1） ——
    startRecon: async () => {
      requirePlatform('chaoxing');
      if (batchRunner.running) throw new Error('请先停止当前任务，再读取课程清单');
      if (!runtime.context || !getStatus().ready) throw new Error('浏览器尚未就绪');
      if (recon.running) {
        log('侦察已在进行中', 'warn');
        return { running: true };
      }
      recon.running = true;
      recon.stopRequested = false;
      patchStatus({ reconRunning: true, reconProgress: null });
      log('=== 开始侦察（只读：不播视频、不答题、不提交）===', 'info');

      (async () => {
        let entryPage,keepEntry=false;
        try {
          // Use our own fresh entry, never a user-owned course/quiz tab whose
          // current view may no longer contain the personal-space course list.
          entryPage=await newTaskPage(ctx(),'recon-entry');
          const login=await gotoChaoxingHome(entryPage);
          if(!login.loggedIn)throw Error('学习通扫描入口需要登录，请在保留的软件内页面登录后重试');
          const courses = await listCourses(entryPage,{shouldStop:()=>recon.stopRequested||shuttingDown});
          const results = await reconAll(ctx(), courses, {
            deep: true,
            maxSections: 300,
            shouldStop: () => recon.stopRequested || shuttingDown,
            onProgress: (p) =>
              patchStatus({ reconProgress: { index: p.index + 1, total: p.total, course: p.course.name, section:p.section??null, sections:p.sections??null } }),
          });
          const file = saveReconReport({ at: new Date().toISOString(), courses: results });
          log(`侦察完成，报告已存: ${file}`, 'ok');

          /*
           * 关键一步：把侦察结果**同时**写成执行清单报告。
           * 早期只写 logs/recon-*.json，而清单读的是 data/probe-out/task-report.json，
           * 于是"侦察完了清单还是老的" —— 用户点「读取清单」看到的永远是旧数据。
           */
          const wr = writeTaskReport(results);
          invalidateReconCache();
          log(`执行清单已同步（${wr.courses} 门课 · ${wr.total} 个任务点），到「课程树」点「读取清单」即可`, 'ok');
          notifyUser('scan-complete', {key:`scan:${Date.now()}`});
        } catch (err) {
          keepEntry=err.code!=='STOPPED';
          log(err.code === 'STOPPED' ? '已停止读取课程，原有清单保留' : `侦察失败: ${err.message}`, err.code === 'STOPPED' ? 'info' : 'error');
          notifyUser(err.code === 'STOPPED' ? 'scan-stopped' : 'scan-failed', {key:`scan:${Date.now()}`,detail:err.code === 'STOPPED' ? '' : err.message});
        } finally {
          if(entryPage){releasePage(entryPage);if(!keepEntry)await entryPage.close().catch(()=>{});}
          recon.running = false;
          patchStatus({ reconRunning: false, reconProgress: null });
        }
      })();

      return { started: true };
    },

    reconStatus: async () => ({ running: recon.running, progress: getStatus().reconProgress }),

    loadChecklist: async () => {
      const cl = buildChecklist();
      if (!cl) {
        log('还没有侦察数据，请先「开始侦察课程」', 'warn');
        return { ok: false, error: 'no-recon-data' };
      }
      log(
        `清单已加载：${cl.summary.totalCourses} 门课 · ${cl.summary.totalTasks} 个任务点 · 将处理 ${cl.summary.handleable}`,
        'ok',
      );
      return { courses: cl.summary.totalCourses, tasks: cl.summary.totalTasks };
    },

    saveSelection: async () => {
      const sel = loadSelection();
      const excluded = (sel.excluded || []).length;
      const orderEntries = Object.values(sel.taskOrder || {}).filter((v) => Array.isArray(v) && v.length).length;
      const disabledCourses = Object.values(sel.courses || {}).filter((c) => c.enabled === false).length;
      log(
        `选择已保存：${orderEntries} 个小节有自定义顺序 · ${excluded} 个任务点被排除 · ${disabledCourses} 门课被停用`,
        'ok',
      );
      return { orderEntries, excluded, disabledCourses };
    },

    startStandaloneWork: async () => {
      if (recon.running || batchRunner.running || startingPlatforms.has('chaoxing')) throw Error('请先停止当前学习通任务');
      if (!runtime.context || !getStatus().ready || !PERSON_ID) throw Error('请先登录学习通并检测登录状态');
      startingPlatforms.add('chaoxing');
      try {
        const page = await findStandaloneWork(ctx(), { personId: PERSON_ID });
        if (!page) throw Error('请在学习通课程的「作业」列表打开一份未提交的独立作业，仅保留一份独立作业打开');
        const identity = await frameWorkIdentity(page.mainFrame());
        if (!identity.workid || !identity.workanswerid) throw Error('无法核对当前作业与作答身份');
        const meta = await getWorkMeta(page.mainFrame());
        if (!meta.questionTotal || !meta.submitBtn?.visible) throw Error('作业尚未加载或当前页面不可作答');
        const key = `chaoxing:standalone:${identity.workid}:${identity.workanswerid}`;
        const task = { key, type:'work', name:meta.title || '独立作业', standalone:true, workIdentity:identity, willHandle:true };
        void batchRunner.start({ctx:ctx(),tasks:[task],command:{personId:PERSON_ID},qianwenPage:runtime.qianwenPage,
          onUpdate:({running,stopRequested,stats})=>patchStatus({running,runStats:stats,progress:{done:stats.done,total:1,current:stats.current?.name||task.name,taskType:'work',questionIndex:stats.current?.questionIndex??null,questionTotal:stats.current?.questionTotal??null,answerSource:stats.current?.answerSource,stopping:stopRequested,phase:stats.current?.phase??null}})
        }).catch(error=>log(`独立作业失败：${error.message}`,'error')).finally(()=>patchStatus({running:false,reviewCount:listReviewItems().length}));
        return {started:true,count:1};
      } finally { startingPlatforms.delete('chaoxing'); }
    },

    // —— 执行（P2 / P3） ——
    startRun: async (req) => {
      if (recon.running) throw new Error('正在读取课程清单，请等待完成或先停止');
      if (!runtime.context || !getStatus().ready) throw new Error('浏览器尚未就绪');
      const cl = buildChecklist();
      if (!cl) {
        log('没有任务点清单，请先侦察', 'error');
        return { ok: false, error: 'no-checklist' };
      }
      const request = await readJson(req, 2 * 1024 * 1024);
      if (request.platform && !['chaoxing', 'zhihuishu', 'ucampus','welearn'].includes(request.platform)) throw Error('此平台暂未接入执行');
      if(request.platform)requirePlatform(request.platform);
      const available=enabledCourses(cl.courses,loadSettings());
      const selected = assertRunScope(request.platform ? available.filter(c => platformOf(c) === request.platform) : available, request);
      const zhsTasks = selected.filter(t => platformOf(t) === 'zhihuishu');
      const uaiTasks = selected.filter(t => platformOf(t) === 'ucampus');
      const welearnTasks=selected.filter(t=>platformOf(t)==='welearn');
      const tasks = selected.filter(t => platformOf(t) === 'chaoxing');
      if (tasks.length + zhsTasks.length + uaiTasks.length + welearnTasks.length !== selected.length) throw Error('选择中包含尚未接入执行的平台');
      const startExtras=()=>[...(zhsTasks.length?[startZhihuishuTasks(zhsTasks)]:[]),...(uaiTasks.length?[startUcampusTasks(uaiTasks)]:[]),...(welearnTasks.length?[startWelearnTasks(welearnTasks)]:[])];
      const starting = [...new Set(selected.map(platformOf))];
      if (starting.some(id => startingPlatforms.has(id))) throw Error('此平台正在启动，请稍候');
      if (zhsTasks.length && extraRuns.snapshot().zhihuishu?.running) throw Error('智慧树已在运行，请使用独立停止按钮');
      if (zhsTasks.length && zhsScan.running) throw Error('请等待智慧树扫描完成');
      if (uaiTasks.length && extraRuns.snapshot().ucampus?.running) throw Error('U校园已在运行，请使用独立停止按钮');
      if (uaiTasks.length && ucampusScan.running) throw Error('请等待 U校园 扫描完成');
      if(welearnTasks.length&&(extraRuns.snapshot().welearn?.running||welearnScan.running))throw Error('请先停止 WeLearn 任务或等待扫描完成');
      if (tasks.length && batchRunner.running) throw Error('学习通已在运行，请使用独立停止按钮');
      starting.forEach(id => startingPlatforms.add(id));
      try {
      if (!tasks.length) {
        const runs=startExtras();if(!runs.length)throw Error('没有可执行任务');
        return {started:runs.some(r=>r.started),count:runs.reduce((n,r)=>n+(r.count||0),0),platforms:runs};
      }

      /*
       * 开跑前确保有账号 ID：正常情况启动/登录时就自动识别过；
       * 这里再兜一次（例如刚登录完还没点「重新检测登录」）。
       * 真的识别不到才拦下 —— 并说清原因，而不是拼个残缺 URL 报一堆看不懂的错。
       */
      if (!PERSON_ID) {
        const got = await autoConfigurePersonId({ context: ctx(), page: runtime.coursePage }).catch(() => ({ ok: false }));
        patchStatus({ account: accountStatus(got.ok ? got.from : null) });
        if (!got.ok) {
          notifyUser('login-required');
          log('识别不到账号 ID，无法执行任务点', 'error');
          log('  原因通常是：还没有登录学习通。登录后点「重新检测登录」，程序会自动识别并写入 local.json', 'warn');
          return { ok: false, error: 'no-person-id' };
        }
      }
      const runnable = tasks.filter((t) => t.willHandle);
      if (!runnable.length) {
        if(zhsTasks.length||uaiTasks.length||welearnTasks.length){const runs=startExtras();return {started:runs.some(r=>r.started),count:runs.reduce((n,r)=>n+(r.count||0),0),platforms:runs};}
        log('没有可执行的任务点（可能全部已完成或被排除）', 'warn');
        return { ok: false, error: 'nothing-to-run' };
      }

      const byType = {};
      for (const t of runnable) byType[t.type] = (byType[t.type] || 0) + 1;

      // 明确播报"这次要刷哪些课"，避免用户以为只刷某一门却被全量刷了
      const enabledCourses = cl.courses.filter((c) => platformOf(c) === 'chaoxing' && !c.empty && c.enabled !== false);
      const courseNames = enabledCourses.map((c) => c.name);
      patchStatus({
        running: true,
        progress: { done: 0, total: runnable.length, current: null },
        runScope: {
          courses: courseNames,
          tasks: runnable.length,
          byType,
        },
      });

      log('=== 开始执行刷课 ===', 'info');
      // 开跑前刷新一次千问登录态：没登录的话答题会全线失败，界面要看得见
      if (runnable.some(task => task.type !== 'work') || loadSettings().answerBank?.source === 'ai') await refreshQianwenStatus({create:true}).catch(() => {});
      if (enabledCourses.length === 12) {
        log(`⚠ 本次会刷全部 ${enabledCourses.length} 门课（共 ${runnable.length} 个任务点）`, 'warn');
        log('   如果你只想刷某几门课：到「课程树」取消勾选不要的课程 → 点「保存选择」→ 再开始', 'warn');
      } else {
        log(`本次范围：${enabledCourses.length} 门课，共 ${runnable.length} 个任务点`, 'info');
      }
      for (const c of enabledCourses) {
        const n = c.tasks.filter((t) => t.willHandle).length;
        log(`    · ${c.name}  (${n} 个)`, 'info');
      }
      log(`类型分布 ${JSON.stringify(byType)}`, 'info');
      startExtras();

      (async () => {
        try {
          await batchRunner.start({
            ctx: ctx(),
            tasks,
            command: { personId: PERSON_ID },
            qianwenPage: runtime.qianwenPage,
            onUpdate: (snap) => {
              const st = snap.stats;
              patchStatus({
                running: snap.running,
                progress: {
                  done: st.done,
                  total: st.total,
                  current: st.current
                    ? `${st.current.courseName || ''} ${st.current.secNo || ''} ${st.current.name || ''}`.trim()
                    : null,
                  percent: st.current?.progress ?? null,
                  resumes: st.current?.resumes ?? null,
                  playbackRate: st.current?.playbackRate ?? null,
                  playbackPhase: st.current?.playbackPhase ?? null,
                  currentTime: st.current?.currentTime ?? null,
                  duration: st.current?.duration ?? null,
                  questionIndex: st.current?.questionIndex ?? null,
                  questionTotal: st.current?.questionTotal ?? null,
                  answerSource: st.current?.answerSource,
                  stopping: snap.stopRequested,
                  taskType: st.current?.type ?? null,
                  phase: st.current?.phase ?? null,
                },
                runStats: st,
              });
            },
          });
        } catch (err) {
          log(`执行异常: ${err.message}`, 'error');
          notifyUser('batch-error', {key:`batch-error:${Date.now()}`,detail:err.message});
        } finally {
          patchStatus({ running: false });
          const s = loadState();
          const done = Object.values(s.taskPoints || {}).filter((t) => t.status === 'done').length;
          log(`运行记录：已标记完成 ${done} 个任务点（存于 state.json）`, 'info');
        }
      })();

      return { started: true, count: runnable.length };
      } finally { starting.forEach(id => startingPlatforms.delete(id)); }
    },

    stopRun: async (req) => {
      const { platform } = req ? await readJson(req, 4096) : {};
      if (platform && !['chaoxing', 'zhihuishu','ucampus','welearn'].includes(platform)) throw Error('平台标识无效');
      for(const [id,scan]of [['zhihuishu',zhsScan],['ucampus',ucampusScan],['welearn',welearnScan]])if(!platform||platform===id){extraRuns.stop(id);scan.stop=true;}
      if (platform && platform!=='chaoxing') return { stopping: true, platform };
      if (recon.running) {
        recon.stopRequested = true;
        log('收到停止请求，当前页面读取结束后停止；原有课程清单保留', 'warn');
      }
      return batchRunner.requestStop();
    },

    runStatus: async () => ({ ...batchRunner.snapshot(), platforms: getStatus().platforms }),

    /** 查看断点续跑状态 */
    stateInfo: async () => {
      const s = loadState();
      const counts = {};
      for (const t of Object.values(s.taskPoints || {})) {
        counts[t.status] = (counts[t.status] || 0) + 1;
      }
      return {
        file: statePath(),
        total: Object.keys(s.taskPoints || {}).length,
        byStatus: counts,
        handbook: (s.handbook || []).length,
        updatedAt: s.updatedAt,
      };
    },

    /** 清空运行记录（慎用：会重刷已完成的） */
    resetState: async () => {
      if (getStatus().running) {
        log('执行中不能重置状态', 'error');
        return { ok: false, error: 'running' };
      }
      resetState();
      log('运行记录已清空（下次会重新刷，包括已完成的）', 'warn');
      return { ok: true };
    },

    openConsole: async () => ({ url: getStatus().consoleUrl }),

    /**
     * 列出为人工确认而保持打开的作业页。
     *
     * ⚠ 重启后自愈：页面句柄只存在进程内存里，服务一重启就"认不出"那些
     * 还开在 Edge 里的页面（实测：重启后「待审队列」显示 closed=true，
     * 明明标签页还在）。这里按 URL 把活着的标签页**重新认领**回来，
     * 于是重启也能照常提交，用户不必手动去点。
     */
    listKeptPages: async () => {
      await readoptKeptPages();
      if(!batchRunner.running&&!recon.running)await syncSubmittedReviews();
      if(!extraRuns.snapshot().zhihuishu?.running)await syncZhihuishuReviews(ctx());
      return listKeptPages();
    },
    syncReviews: opts=>beginReviewSync(opts),

    openReview: async ({taskKey}={}) => {
      assertReviewScopeIdle({taskKey});
      if(taskKey?.startsWith('zhihuishu:'))return withReviewLock(taskKey,async()=>{
        if(getStatus().platforms?.zhihuishu?.running)throw Error('请先停止智慧树任务再恢复草稿');
        const {page,...result}=await restoreZhihuishuReview(ctx(),taskKey);await bringToFront(page);if(embedded)await setBrowserVisible(true);return result;
      });
      if(batchRunner.running||recon.running)throw new Error('请先停止当前任务，再恢复待审作业');
      return withReviewLock(taskKey,async()=>{
        await readoptKeptPages();
        const {page,...result}=await reopenReviewWork(ctx(),taskKey,{personId:PERSON_ID});
        await bringToFront(page);
        if(process.env.KEBO_DESKTOP==='1'){await setBrowserVisible(true);patchStatus({browserVisible:true});}
        return result;
      });
    },

    retryReview: async req => {
      const {taskKey}=await readJson(req,4096);
      if(typeof taskKey!=='string'||!taskKey||taskKey.length>1000)throw Error('待审任务标识无效');
      if(getStatus().running||recon.running||zhsScan.running||retryingReviews.size)throw Error('请先停止正在运行或扫描的任务，再继续待审作业');
      if(!runtime.context||!getStatus().ready)throw Error('内置网页尚未就绪');
      const items=listReviewItems().filter(i=>i.taskKey===taskKey);
      if(!items.length||items.some(i=>i.qtype==='discussion'))throw Error('此记录不是可继续的测验草稿');
      const standalone=loadState().keptPages?.[taskKey]?.info?.task;
      const task=standalone?.standalone ? {...standalone,key:taskKey} : buildChecklist()?.courses.flatMap(c=>c.tasks||[]).find(t=>t.key===taskKey);
      if(!task||task.type!=='work')throw Error('课程清单中找不到这份作业，请先读取清单；已有答案保留');
      if(loadState().taskPoints?.[taskKey]?.status==='done')throw Error('平台已确认完成，未重复作答');
      retryingReviews.add(taskKey);
      try{
        if(platformOf(task)==='zhihuishu')return startZhihuishuTasks([{...task,reviewRetry:true}]);
        if(!PERSON_ID)throw Error('请先登录学习通并重新检测登录');
        if (loadSettings().answerBank?.source === 'ai') await refreshQianwenStatus({create:true});
        // A retry is restricted to one stored task and always stops for review.
        // It never changes the user's course selection or submits an assignment.
        void batchRunner.start({ctx:ctx(),tasks:[{...task,willHandle:true,reviewRetry:true}],command:{personId:PERSON_ID},qianwenPage:runtime.qianwenPage,
          onUpdate:({running,stopRequested,stats})=>patchStatus({running,runStats:stats,progress:{done:stats.done,total:1,current:stats.current?.name||task.name,taskType:'work',questionIndex:stats.current?.questionIndex??null,questionTotal:stats.current?.questionTotal??null,answerSource:stats.current?.answerSource,stopping:stopRequested,phase:stats.current?.phase??null}})
        }).catch(error=>{log(`继续作业失败：${error.message}`,'error');notifyUser('batch-error',{key:taskKey+':retry',detail:error.message});}).finally(()=>patchStatus({running:false,reviewCount:listReviewItems().length}));
        return {started:true,count:1};
      }finally{retryingReviews.delete(taskKey);}
    },

    /**
     * 提交待审答案。
     *
     * 支持两种范围：
     *   { taskKey }  只提交这一组（一个作业）
     *   { all: true } 提交所有"保持打开"的作业页
     */
    submitReviews: async (opts = {}) => {
      const cxBlocked=reviewScopeBlock({taskKey:'chaoxing:review'}),zhsBlocked=reviewScopeBlock({taskKey:'zhihuishu:review'});
      if(opts.all){if(cxBlocked&&zhsBlocked)throw Error(cxBlocked+'；'+zhsBlocked);}else assertReviewScopeIdle(opts);
      // 先做一次"重新认领"，确保重启后仍能提交（保持打开的页面还在 Edge 里）
      await readoptKeptPages();
      let result;
      try {
        if(opts.taskKey?.startsWith('zhihuishu:')){
          await reconcileOneReview(ctx(),opts.taskKey,{personId:PERSON_ID});
          result=await withReviewLock(opts.taskKey,()=>submitZhihuishuReview(ctx(),opts.taskKey));
        }
        else {
          if(opts.all&&cxBlocked){const keys=[...new Set(listReviewItems().filter(i=>!i.taskKey.startsWith('zhihuishu:')).map(i=>i.taskKey))];result={submitted:0,failed:keys.length,details:keys.map(key=>({key,ok:false,error:cxBlocked}))};}
          else result=await submitPendingReviews(ctx(),opts,{personId:PERSON_ID});
          result.details||=[];
          if(opts.all)for(const key of new Set(listReviewItems().filter(i=>platformOf(i)==='zhihuishu').map(i=>i.taskKey))){
            const zhs=zhsBlocked?{submitted:0,failed:1,details:[{key,ok:false,error:zhsBlocked}]}:await (async()=>{await reconcileOneReview(ctx(),key,{personId:PERSON_ID});return withReviewLock(key,()=>submitZhihuishuReview(ctx(),key));})().catch(error=>({submitted:0,failed:1,details:[{key,ok:false,error:error.message}]}));
            result.submitted+=zhs.submitted;result.failed+=zhs.failed;result.details.push(...zhs.details);
          }
        }
      }
      catch(error) { notifyUser('submit-failed',{key:`submit-failed:${Date.now()}`,detail:error.message}); throw error; }
      for(const item of result.details||[])log(item.ok?'待审作业已确认提交':`待审提交未完成：${item.error}`,item.ok?'ok':'error');
      if(result.failed)notifyUser('submit-failed',{key:`submit-failed:${Date.now()}`,detail:`本次已确认 ${result.submitted||0} 组，未成功 ${result.failed} 组；失败的作业仍在待审中。`});
      else if(result.submitted)notifyUser('submit-success',{key:`submit:${Date.now()}`,detail:`本次已确认 ${result.submitted} 组答案。`});
      patchStatus({ reviewCount: listReviewItems().length });
      return result;
    },

    info: async () => ({
      root: PATHS.root,
      edgeProfile: embedded ? PATHS.browserProfile : PATHS.edgeProfile,
      debugPort: DEBUG_PORT,
      node: process.version,
      consoleUrl: getStatus().consoleUrl,
      pid: process.pid,
    }),
  };
}

/* ---------------- 启动 & 兜底 ---------------- */

process.on('unhandledRejection', (err) => {
  const m = String(err?.message || err);
  // 学习通原生 alert 在 CDP 下会与 Playwright 内部处理竞态，属已知无害噪声
  if (/No dialog is showing|handleJavaScriptDialog/i.test(m)) return;
  log(`未处理的 Promise 拒绝: ${m}`, 'error');
});
process.on('uncaughtException', (err) => {
  log(`未捕获异常: ${err?.message || err}`, 'error');
});

/*
 * 退出时收摊（用户反馈的"页面堆积"有一大半是这里漏的）：
 * Ctrl+C / 托盘退出 / 被 kill 之前，把**本进程开的**刷课页关掉，
 * 只保留"等你手动作答/确认提交"的白名单页面。
 *
 * 为什么要抢在退出前做：进程直接死掉的话，当前任务页会永远挂在 Edge 里，
 * 下一轮启动又多一个残留（叠加起来就是"堆积成灾"）。
 */
let shuttingDown = false;
let ownerMonitor = null;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  recon.stopRequested = true;
  batchRunner.requestStop();
  extraRuns.stopAll();
  zhsScan.stop = true;
  ucampusScan.stop=true;welearnScan.stop=true;
  const stopDeadline = Date.now() + 6000;
  while ((batchRunner.running || Object.values(extraRuns.snapshot()).some(s=>s.running)) && Date.now() < stopDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  log(`收到 ${signal}，正在收摊（关闭刷课临时页，保留待人工页面）…`, 'warn');
  try {
    const keptUrls = Object.values(loadState().keptPages || {})
      .map((k) => k.url)
      .filter(Boolean);
    const closed = await closeTrackedPages({ keepUrls: keptUrls });
    if (closed.length) {
      log(`已关闭 ${closed.length} 个临时页面`, 'ok');
      for (const u of closed.slice(0, 8)) log(`    × ${u}`, 'dim');
    } else {
      log('没有需要关闭的临时页面', 'dim');
    }
    if (keptUrls.length) log(`保留了 ${keptUrls.length} 个待人工页面（不会丢答案）`, 'dim');
  } catch (err) {
    log(`收摊时出错（忽略）：${err.message}`, 'warn');
  }
  // Windows 强杀进程不触发 SIGTERM，桌面端通过消息请求有序退出。
  stopWindowControl();
  ownerMonitor?.stop();
  if (runtime.browser && process.env.KEBO_DESKTOP === '1' && !embedded) {
    try {
      const session = await runtime.browser.newBrowserCDPSession();
      await session.send('Browser.close');
    } catch { /* Browser.close 后连接断开是正常现象 */ }
  }
  // Browser.close 后留时间给 Edge 写入登录会话，避免立即强杀打断落盘。
  if (process.env.KEBO_DESKTOP === '1' && !embedded) await stopOwnedEdge({ graceMs: 3000 });
  if (runtime.service) {
    for (const client of runtime.service.wss.clients) client.terminate();
    runtime.service.wss.close();
    runtime.service.server.close();
    runtime.service.server.closeAllConnections();
  }
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
if (process.parentPort) {
  ownerMonitor = startOwnerMonitor(process.env.KEBO_OWNER_PID);
  let lastHeartbeat = Date.now();
  let lastOwnerState = 'alive';
  process.parentPort.on('message', ({ data }) => {
    if (data?.type === 'heartbeat') lastHeartbeat = Date.now();
    if (data?.type === 'shutdown') gracefulShutdown('桌面退出');
  });
  setInterval(() => {
    const state = ownerState({ ownerPid: process.env.KEBO_OWNER_PID, lastHeartbeat, probe: ownerMonitor.probe });
    if (state === 'gone') return gracefulShutdown('已确认桌面主进程退出');
    if (state === 'unresponsive' && state !== lastOwnerState) {
      log('桌面心跳暂时超时，但主进程仍在；后台继续运行', 'warn');
    }
    if (state === 'alive' && lastOwnerState === 'unresponsive') log('桌面心跳已恢复', 'info');
    lastOwnerState = state;
  }, 3000).unref();
}

boot()
  .then((rt) => {
    if (!rt) {
      log('启动未完成。修复上述错误后重新运行「启动.bat」。', 'error');
      log('（本进程保持存活，便于你在控制台/终端查看日志）', 'dim');
    }
  })
  .catch((err) => {
    log(`启动异常: ${err?.stack || err}`, 'error');
    patchStatus({ bootError: err.message, ready: false });
    process.parentPort?.postMessage({ type: 'fatal', message: err.message });
  });
