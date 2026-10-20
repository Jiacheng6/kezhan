/**
 * 页面台账（① about:blank / ② 页面堆积 的根治模块）。
 *
 * 背景（用户实测反馈）：
 *   ① 每次启动都多一个 about:blank：`launch.mjs` 拉起 Edge 时启动 URL 写死
 *      `about:blank`，而且没有任何代码去关它。
 *   ② 页面堆积成灾，四类都堆：about:blank、<kbd>cards</kbd> 章节/视频页、
 *      work 测验页、以及控制台/千问的**重复**标签页。
 *      叠加原因：
 *        - Edge 带 `--restore-last-session`，恢复上一轮标签页需要时间，
 *          而代码只对学习通页等了 4 秒，控制台/千问没等 → 恢复慢一点就被
 *          当成"没有"，再新建一个 → 重复；
 *        - 被打断 / 异常退出时，当前任务页走不到关闭逻辑就留下了；
 *        - 每轮启动不清理上一轮残留。
 *
 * 这个模块负责：登记本进程开的页、启动时清场、退出时收摊、提供一键清理。
 * 原则：**绝不关掉"等你手动作答/确认提交"的页面**（白名单来自 state.keptPages）。
 */
import { TARGETS } from '../config.mjs';
import { embedded, embeddedRequest, targetOf } from './embedded.mjs';

/** 本进程创建的页面台账 */
const registry = new Map(); // page -> { kind, busy, createdAt }

/** 刷课类页面的 URL 特征（这些是"临时页"，跑完就该没了） */
const TASK_PAGE_RE = /mooc-ans\/knowledge\/cards|mooc-ans\/work\/|doHomeWorkNew|ananas\/modules\//i;

export function isTaskPageUrl(url) {
  return TASK_PAGE_RE.test(String(url || ''));
}

export function isBlankUrl(url) {
  const u = String(url || '');
  return u === 'about:blank' || u === '' || u === 'about:newtab';
}

/**
 * "垃圾页"：空白页 + Edge 自带的新标签页 / 首次运行页。
 *
 * 实测：把启动 URL 从 about:blank 换成学习通首页后，空白页没了，
 * 但 Edge 自己还会带出一个「新建标签页」（`ntp.msn.cn/edge/ntp?...`）——
 * 用户视角它同样是"无关网页"，所以一并清理。
 */
export function isJunkUrl(url) {
  const u = String(url || '');
  if (isBlankUrl(u)) return true;
  return (
    /ntp\.msn\.cn\/edge\/ntp/i.test(u) ||
    /^edge:\/\/(newtab|default-browser|welcome|first-run)/i.test(u) ||
    /^microsoft-edge:\/\//i.test(u) ||
    /\/edge\/ntp\?/i.test(u)
  );
}

/** 新建一个"任务页"并登记（替代裸用 ctx.newPage()） */
export async function newTaskPage(ctx, kind = 'task') {
  const page = await ctx.newPage();
  registry.set(page, { kind, busy: true, createdAt: Date.now() });
  if (embedded) await targetOf(page).then(targetId => embeddedRequest('annotate', { targetId, role: kind, busy: true })).catch(() => {});
  return page;
}

/** 页面用完（已关或即将关）→ 从台账移除 */
export function releasePage(page) {
  registry.delete(page);
  if (embedded && !page.isClosed()) void targetOf(page).then(targetId => embeddedRequest('annotate', { targetId, busy: false })).catch(() => {});
}

/** 标记页面是否正忙（忙的页面在"一键清理"时也会被跳过） */
export function setPageBusy(page, busy) {
  const e = registry.get(page);
  if (e) e.busy = !!busy;
  if (embedded && !page.isClosed()) void targetOf(page).then(targetId => embeddedRequest('annotate', { targetId, busy: !!busy })).catch(() => {});
}

export function markSavedReviewPage(page) {
  const record=registry.get(page);if(record){record.kind='review';record.busy=false;}
  if(embedded&&!page.isClosed())void targetOf(page).then(targetId=>embeddedRequest('annotate',{targetId,role:'review',busy:false})).catch(()=>{});
}

export function trackedPages() {
  return [...registry.entries()]
    .filter(([p]) => !p.isClosed())
    .map(([p, v]) => ({ url: p.url(), ...v }));
}

/**
 * 等页面数量稳定下来。
 *
 * 目的：Edge `--restore-last-session` 恢复标签页是异步的，恢复没完成就判断
 * "有没有现成的控制台/千问页"，会得出"没有"→ 再新建 → 重复页。
 */
export async function waitForPagesSettled(context, { quietMs = 1500, maxMs = 10000 } = {}) {
  const t0 = Date.now();
  let last = -1;
  let stableSince = Date.now();
  for (;;) {
    const n = context.pages().length;
    if (n !== last) {
      last = n;
      stableSince = Date.now();
    }
    if (Date.now() - stableSince >= quietMs) return { pages: n, waitedMs: Date.now() - t0 };
    if (Date.now() - t0 >= maxMs) return { pages: n, waitedMs: Date.now() - t0, timeout: true };
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * 页面的"身份"：origin + path + 关键查询参数。
 *
 * 为什么不能简单用前缀比较：`...cards?clazzid=1&knowledgeid=AAA` 和
 * `...cards?clazzid=1&knowledgeid=BBB` 前 60 个字符完全一样 ——
 * 宽松的前缀匹配会把"另一个小节的页面"误判成白名单页面（测试实测踩到）。
 * 这里只认真实身份参数，既精确又能容忍无关参数/顺序差异。
 */
const IDENTITY_KEYS = ['knowledgeid', 'clazzid', 'courseid', 'workid', 'workanswerid', 'num', 'cpi', 'jobid'];

export function pageIdentity(u) {
  const s = String(u || '');
  try {
    const url = new URL(s);
    if(url.hostname==='onlineexamh5new.zhihuishu.com'&&url.hash.startsWith('#/webExamList/dohomework/'))return `${url.origin}${url.pathname}${url.hash.split('?')[0]}`;
    const parts = [];
    for (const k of IDENTITY_KEYS) {
      const v = url.searchParams.get(k);
      if (v != null) parts.push(`${k}=${v}`);
    }
    parts.sort();
    return `${url.origin}${url.pathname}${parts.length ? '?' + parts.join('&') : ''}`;
  } catch {
    return s;
  }
}

/** 两个 URL 是不是"同一个页面"（给白名单与重启认领用） */
export function isSamePageUrl(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y) return false;
  if (x === y) return true;
  return pageIdentity(x) === pageIdentity(y);
}

/** URL 是否在白名单里 */
function inKeepList(url, keepUrls) {
  return keepUrls.some((k) => isSamePageUrl(url, k));
}

/**
 * 清场：关掉残留的刷课页 / 空白页，并去掉重复的控制台、千问页。
 *
 * @param {object} opts
 * @param {string[]} opts.keepUrls 白名单（待人工提交的页面 URL）
 * @param {boolean} opts.preserveBusy 跳过"正忙"的页面（一键清理时用）
 * @param {(msg:string, level?:string)=>void} opts.log
 * @returns {Promise<{closed:Array<{url:string,reason:string}>, kept:string[], skipped:number}>}
 */
export async function cleanupPages(
  context,
  {
    keepUrls = [],
    protectedPages = [],
    preserveBusy = true,
    closeJunk = true,
    closeTaskPages = true,
    dedupe = true,
    log = () => {},
  } = {},
) {
  const closed = [];
  const pages = context.pages().filter((p) => !p.isClosed());
  const busy = (p) => preserveBusy && registry.get(p)?.busy;
  /** 正在被程序使用的页面（如 runtime.coursePage / qianwenPage / 控制台）——绝不动 */
  const protectedSet = new Set(protectedPages.filter(Boolean));
  const isProtected = (p) => protectedSet.has(p) || busy(p);

  const closePage = async (p, reason) => {
    if (p.isClosed()) return false;
    try {
      await p.close();
      registry.delete(p);
      closed.push({ url: p.url().slice(0, 120), reason });
      return true;
    } catch {
      return false;
    }
  };

  // 1) 残留刷课页 / 垃圾页
  /*
   * 先算"要关哪些"，再动手 —— 并且**保证至少留下一个页面**。
   * Chromium 关掉最后一个标签页会连浏览器一起退出（CDP 断掉、启动直接失败），
   * 所以不能"先全关、再补一个"（补是来得及的，但中间那一瞬浏览器可能已经退了）。
   */
  const closable = [];
  for (const p of pages) {
    const url = p.url();
    if (isProtected(p)) continue; // 正在用的页面 / 正忙的任务页
    if (inKeepList(url, keepUrls)) continue;
    if (closeJunk && isJunkUrl(url)) {
      closable.push({ p, reason: isBlankUrl(url) ? 'about:blank 空白页' : '浏览器自带的新标签页/推广页' });
      continue;
    }
    if (closeTaskPages && isTaskPageUrl(url)) {
      closable.push({ p, reason: '上一轮残留的刷课/测验页' });
    }
  }
  if (closable.length >= pages.length && closable.length) {
    // 至少留一个：优先留"非垃圾"的那个
    const junkIdx = closable.findIndex((c) => isJunkUrl(c.p.url()));
    const keepIdx = junkIdx >= 0 ? junkIdx : closable.length - 1;
    const [kept] = closable.splice(keepIdx, 1);
    log(`  （避免关掉最后一个标签页，保留：${kept.p.url()}）`, 'warn');
  }
  for (const { p, reason } of closable) await closePage(p, reason);

  // 只剩一个垃圾页的话，顺手把它导航到学习通首页（别让用户对着空白页）
  const aliveNow = context.pages().filter((p) => !p.isClosed());
  if (aliveNow.length === 1 && isJunkUrl(aliveNow[0].url())) {
    await aliveNow[0].goto(TARGETS.chaoxingHome, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  }

  // 2) 控制台 / 千问 去重（各只留一个）
  if (dedupe) {
    const groups = [
      { name: '控制台', test: (u) => /127\.0\.0\.1:\d+/.test(u) },
      { name: '千问', test: (u) => /(qianwen\.com|tongyi\.com)/i.test(u) },
      /*
       * 学习通的"工具页"也要去重：个人空间首页、登录页**各自**去重。
       *
       * 冷启动时"启动 URL"和"恢复的会话"很容易各带出一个；未登录时
       * i.chaoxing.com 还会 302 到 passport2 登录页 —— 于是页面上就是
       * **两个一模一样的登录页**（实测出现）。
       *
       * ⚠ 必须分成两组：登录页和已登录的个人空间页是**两个不同的有用页面**
       * （程序要用个人空间页拿课程列表），合成一组会把其中一个关掉。
       */
      { name: '学习通登录页', test: (u) => /passport2?\.chaoxing\.com\/login/i.test(u) },
      { name: '学习通个人空间页', test: (u) => /i\.chaoxing\.com\/base/i.test(u) },
    ];
    for (const g of groups) {
      const hits = context.pages().filter((p) => !p.isClosed() && g.test(p.url()));
      // 优先留"正在被程序使用"的那个，其次白名单，最后第一个
      const keep = hits.find((p) => protectedSet.has(p)) || hits.find((p) => inKeepList(p.url(), keepUrls)) || hits[0];
      for (const p of hits) {
        if (p === keep || isProtected(p)) continue;
        await closePage(p, `重复的${g.name}标签页`);
      }
    }
  }

  /*
   * 兜底：万一还是变成 0 个页面，补一个（正常不该走到这里）。
   */
  const alive = context.pages().filter((p) => !p.isClosed());
  if (!alive.length) {
    log('  （页面被关光了，补一个学习通首页）', 'warn');
    try {
      const p = await context.newPage();
      await p.goto(TARGETS.chaoxingHome, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    } catch {
      /* 补不上也不影响 */
    }
  }

  const kept = context
    .pages()
    .filter((p) => !p.isClosed())
    .map((p) => p.url().slice(0, 120));
  return { closed, kept, skipped: pages.length - closed.length };
}

/**
 * 退出时收摊：关掉本进程开的、且不在白名单里的页面。
 * 目的：Ctrl+C / 托盘退出后不留下"半死不活的刷课页"。
 */
export async function closeTrackedPages({ keepUrls = [] } = {}) {
  const closed = [];
  for (const [p] of [...registry.entries()]) {
    if (p.isClosed()) {
      registry.delete(p);
      continue;
    }
    if (inKeepList(p.url(), keepUrls)) continue;
    try {
      await p.close();
      closed.push(p.url().slice(0, 120));
    } catch {
      /* 忽略 */
    }
    registry.delete(p);
  }
  return closed;
}
