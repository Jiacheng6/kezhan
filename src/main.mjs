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
import { waitForPagesSettled, cleanupPages, closeTrackedPages, isSamePageUrl } from './browser/pages.mjs';
import { gotoChaoxingHome } from './browser/login.mjs';
import { listCourses, reconAll, saveReconReport, writeTaskReport } from './chaoxing/recon.mjs';
import { autoConfigurePersonId } from './chaoxing/identity.mjs';
import { buildChecklist, loadSelection, invalidateReconCache } from './chaoxing/checklist.mjs';
import { batchRunner, buildRunTasks } from './batch.mjs';
import { assertRunScope } from './ui/run-scope.js';
import { loadState, resetState, statePath, setTaskStatus, listReviewItems, markReviewItem, healStaleRunning, reconcile, mutateState } from './state.mjs';
import { listKeptPages, registerKeptPage, editKeptEssayReviewAnswer } from './chaoxing/quizrun.mjs';
import { reopenReviewWork, submitPendingReviews, withReviewLock, syncSubmittedReviews } from './chaoxing/review-recovery.mjs';
import { updateReviewAnswer } from './state.mjs';
import { startServer } from './server.mjs';
import { embedded } from './browser/embedded.mjs';
import { getOnboarding } from './onboarding.mjs';
import { startWindowControl, setBrowserVisible, isBrowserVisible, stopWindowControl } from './browser/window-control.mjs';
import { ownerState, startOwnerMonitor } from './browser/owner-lifecycle.mjs';
import {selectedProvider, ensureProviderPage} from './ai/providers.mjs';
import {aiResumeStatus,continueAI,onAIResumeChange} from './ai/resume.mjs';
import {apiStatus} from './ai/api.mjs';
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
  const settings = loadSettings();
  // account 一并带上：local.json 已配置时，控制台一打开就能看到账号 ID
  patchStatus({ settings, phase: 'P4', bootError: null, account: accountStatus(), browserMode: embedded ? 'embedded' : 'external' });

  log('学习通自动刷课助手 启动中…', 'info');
  log(`工作目录: ${PATHS.root}`, 'dim');

  // 先起界面服务：Edge 不存在或启动失败时也能显示诊断和重试入口。
  runtime.service = await startServer(buildHooks());
  const { url, port } = runtime.service;
  log(`控制台已就绪: ${url}`, 'ok');
  process.parentPort?.postMessage({ type: 'server-ready', url });
  if (process.env.XXT_SMOKE_TEST === '1') {
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
  let coursePage = embedded ? findPage(context, 'chaoxing.com') : await waitForPage(context, 'chaoxing.com', 7000);
  if (!coursePage) {
    coursePage = (embedded && context.pages().find(page => page.url() === 'about:blank')) || await context.newPage();
    await coursePage.goto(TARGETS.chaoxingHome, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    log('新开学习通标签页', 'dim');
  }
  runtime.coursePage = coursePage;

  // 4.5) 千问标签页（P4 答题通道）—— 复用已有的，没有就开一个待用户登录
  let qianwenPage = null;
  try { qianwenPage = await ensureProviderPage(context, selectedProvider(loadSettings()), { create: !!getOnboarding().completedAt }); }
  catch (err) { log(`打开${selectedProvider(loadSettings()).label}失败（不影响其他任务）：${err.message}`, 'warn'); }
  runtime.qianwenPage = qianwenPage;

  /* 千问登录态先探一次（界面顶栏"答题通道"那颗灯），失败不阻塞启动 */
  await refreshQianwenStatus().catch(() => {});

  // 5) 打开控制台：优先在受控 Edge 里开（能和你并排看）
  let consoleOpenedInEdge = false;
  let consolePage = null;
  if (process.env.XXT_DESKTOP !== '1') try {
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
  if (process.env.XXT_DESKTOP !== '1' && !consoleOpenedInEdge) openInDefaultBrowser(url);

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
  await bringToFront(coursePage);

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
  if (!getStatus().login.loggedIn) {
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
async function readoptKeptPages() {
  const ctxNow = ctx();
  if (!ctxNow) return 0;
  let n = 0;
  const live = ctxNow.pages();
  for (const rec of listKeptPages()) {
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
      if(process.env.XXT_DESKTOP==='1'){await setBrowserVisible(true);patchStatus({browserVisible:true});}
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
      const providerChanged=selectedProvider(r.settings).id!==selectedProvider(before).id;
      if(providerChanged&&batchRunner.running)throw new Error('请先停止当前任务，再切换 AI 网页版通道');
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
      });
      const after = loadSettings();
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
      if(batchRunner.running)throw new Error('请先停止当前任务，再恢复设置');
      mutateState((s) => {
        s.settings = {};
      });
      patchStatus({ settings: loadSettings() });
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
      if (process.env.XXT_DESKTOP === '1') await setBrowserVisible(true);
      const page = runtime.coursePage && !runtime.coursePage.isClosed() ? runtime.coursePage : (await runtime.context.newPage());
      runtime.coursePage = page;
      if (!page.url().includes('chaoxing.com')) await page.goto(TARGETS.chaoxingHome, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await bringToFront(page);
      log(`已在${embedded ? '软件内' : '受控浏览器中'}打开学习通首页`, 'info');
      return { ok: true };
    },

    focusEdge: async () => {
      if (process.env.XXT_DESKTOP === '1') await setBrowserVisible(true);
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
        try {
          const courses = await listCourses(runtime.coursePage);
          const results = await reconAll(ctx(), courses, {
            deep: true,
            maxSections: 300,
            shouldStop: () => recon.stopRequested || shuttingDown,
            onProgress: (p) =>
              patchStatus({ reconProgress: { index: p.index + 1, total: p.total, course: p.course.name } }),
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
          log(err.code === 'STOPPED' ? '已停止读取课程，原有清单保留' : `侦察失败: ${err.message}`, err.code === 'STOPPED' ? 'info' : 'error');
          notifyUser(err.code === 'STOPPED' ? 'scan-stopped' : 'scan-failed', {key:`scan:${Date.now()}`,detail:err.code === 'STOPPED' ? '' : err.message});
        } finally {
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

    // —— 执行（P2 / P3） ——
    startRun: async (req) => {
      if (recon.running) throw new Error('正在读取课程清单，请等待完成或先停止');
      if (!runtime.context || !getStatus().ready) throw new Error('浏览器尚未就绪');
      if (batchRunner.running) {
        log('执行已在进行中', 'warn');
        return { running: true };
      }
      const cl = buildChecklist();
      if (!cl) {
        log('没有任务点清单，请先侦察', 'error');
        return { ok: false, error: 'no-checklist' };
      }
      const tasks = assertRunScope(cl.courses, await readJson(req, 2 * 1024 * 1024));

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
        log('没有可执行的任务点（可能全部已完成或被排除）', 'warn');
        return { ok: false, error: 'nothing-to-run' };
      }

      const byType = {};
      for (const t of runnable) byType[t.type] = (byType[t.type] || 0) + 1;

      // 明确播报"这次要刷哪些课"，避免用户以为只刷某一门却被全量刷了
      const enabledCourses = cl.courses.filter((c) => !c.empty && c.enabled !== false);
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
      await refreshQianwenStatus({create:true}).catch(() => {});
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
    },

    stopRun: async () => {
      if (recon.running) {
        recon.stopRequested = true;
        log('收到停止请求，当前页面读取结束后停止；原有课程清单保留', 'warn');
      }
      return batchRunner.requestStop();
    },

    runStatus: async () => batchRunner.snapshot(),

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
      if (batchRunner.running) {
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
      return listKeptPages();
    },

    openReview: async ({taskKey}={}) => {
      if(batchRunner.running||recon.running)throw new Error('请先停止当前任务，再恢复待审作业');
      return withReviewLock(taskKey,async()=>{
        await readoptKeptPages();
        const {page,...result}=await reopenReviewWork(ctx(),taskKey,{personId:PERSON_ID});
        await bringToFront(page);
        if(process.env.XXT_DESKTOP==='1'){await setBrowserVisible(true);patchStatus({browserVisible:true});}
        return result;
      });
    },

    /**
     * 提交待审答案。
     *
     * 支持两种范围：
     *   { taskKey }  只提交这一组（一个作业）
     *   { all: true } 提交所有"保持打开"的作业页
     */
    submitReviews: async (opts = {}) => {
      if(batchRunner.running||recon.running)throw new Error('请先停止当前任务，再提交待审作业');
      // 先做一次"重新认领"，确保重启后仍能提交（保持打开的页面还在 Edge 里）
      await readoptKeptPages();
      let result;
      try { result=await submitPendingReviews(ctx(),opts,{personId:PERSON_ID}); }
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
  const stopDeadline = Date.now() + 6000;
  while (batchRunner.running && Date.now() < stopDeadline) {
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
  if (runtime.browser && process.env.XXT_DESKTOP === '1' && !embedded) {
    try {
      const session = await runtime.browser.newBrowserCDPSession();
      await session.send('Browser.close');
    } catch { /* Browser.close 后连接断开是正常现象 */ }
  }
  // Browser.close 后留时间给 Edge 写入登录会话，避免立即强杀打断落盘。
  if (process.env.XXT_DESKTOP === '1' && !embedded) await stopOwnedEdge({ graceMs: 3000 });
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
  ownerMonitor = startOwnerMonitor(process.env.XXT_OWNER_PID);
  let lastHeartbeat = Date.now();
  let lastOwnerState = 'alive';
  process.parentPort.on('message', ({ data }) => {
    if (data?.type === 'heartbeat') lastHeartbeat = Date.now();
    if (data?.type === 'shutdown') gracefulShutdown('桌面退出');
  });
  setInterval(() => {
    const state = ownerState({ ownerPid: process.env.XXT_OWNER_PID, lastHeartbeat, probe: ownerMonitor.probe });
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
