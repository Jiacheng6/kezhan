/**
 * 自动识别学习通账号 ID（personId / cpi）。
 *
 * 为什么要它：personId 是"构造任务点链接"必需的参数（`...&cpi=<personId>`），
 * 但它**不是账号密码**，也不该要求使用者手动去地址栏里找 —— 交给别人用时
 * 手填配置是最容易卡住的一步。
 *
 * 识别来源（按可信度排序，本项目都在真实会话里实测过）：
 *
 *   ① 课程列表接口（最可靠，纯 HTTP）
 *      POST https://mooc2-ans.chaoxing.com/mooc2-ans/visit/courselistdata
 *      表单 courseType=1&courseFolderId=0&…（见 COURSE_LIST_FORM）
 *      返回的 HTML 里每张卡片都带 `info="<clazzId>_<personId>"`
 *      实测：31 KB、12 张卡片全部一致；用浏览器会话的 cookie 发请求，
 *      **不用点页面、不用导航**，登录着就能拿到。
 *
 *   ② 课程列表卡片 DOM
 *      `.course.learnCourse input.curPersonId`（侦察时本来就在用）
 *      或卡片属性 `info="<clazzId>_<personId>"`
 *
 *   ③ 已打开页面的 URL / frame URL 里的 `cpi=`
 *
 *   ④ 页面 HTML 里的 JSON（`"personId":"…"` / `cpi=…`）—— 最弱，兜底
 *
 *   ⑤ 交互兜底：以上全落空时，在个人空间页点「全部课程」把课程列表拉起来，
 *      再按 ② 读。实测个人空间首页（i.chaoxing.com/base）**自身不含任何
 *      personId**，课程列表要点开才加载 —— 所以这一步不能省。
 *
 * 识别到之后**写进 local.json**（该文件已被 .gitignore 忽略），下次启动直接用，
 * 不再需要任何手工配置。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, setPersonId, PERSON_ID } from '../config.mjs';
import { log } from '../logbus.mjs';

/** 学习通 ID 都是这种纯数字串（personId/clazzId 均是）；太短的当噪声丢掉 */
const ID_RE = /^\d{5,}$/;

/** 课程列表接口（实测：带会话 cookie 的 POST，返回带 info 属性的卡片 HTML） */
export const COURSE_LIST_API = 'https://mooc2-ans.chaoxing.com/mooc2-ans/visit/courselistdata';

/**
 * 接口表单参数（从真实请求抓包得到）。
 * 任何一项缺失都可能退化成"空列表"，所以照抄，别精简。
 */
export const COURSE_LIST_FORM = Object.freeze({
  courseType: '1',
  courseFolderId: '0',
  query: '',
  pageHeader: '-1',
  single: '0',
  superstarClass: '0',
  isFirefly: '0',
  fid: '',
  from: '',
});

/** 各来源的可信度权重（决定投票结果，见 discoverPersonId） */
const SOURCE_WEIGHT = {
  课程列表接口: 3,
  课程列表卡片: 3,
  '课程列表 info 属性': 3,
  页面URL: 2,
  'frame URL': 2,
  页面内容: 1,
};

/** 从一段 URL 里取 cpi 参数 */
export function cpiFromUrl(url) {
  const m = String(url || '').match(/[?&]cpi=(\d{5,})/);
  return m ? m[1] : null;
}

/** 从 HTML 文本里取 personId / cpi（尽量宽松，但只认明确带键名的） */
export function cpiFromHtml(html) {
  const s = String(html || '');
  const m =
    s.match(/["'](?:personId|personid|cpi)["']\s*[:=]\s*["']?(\d{5,})/i) ||
    s.match(/[?&]cpi=(\d{5,})/);
  return m ? m[1] : null;
}

/**
 * 从课程列表 HTML 里抽出所有 personId（一门课一个，正常应全部相同）。
 *
 * 卡片形如 `<div class="course clearfix learnCourse stu_1234567" info="1234567_87654321">`，
 * 因此取 `info="<clazzId>_<personId>"` 的下划线后半段（示例里的数字是编的）。
 *
 * @returns {string[]} 出现的 personId 列表（可能有重复，交给投票去重）
 */
export function personIdsFromCourseListHtml(html) {
  const s = String(html || '');
  const ids = [];
  for (const m of s.matchAll(/info="\d{5,}_(\d{5,})"/g)) ids.push(m[1]);
  // 有些返回片段是带 input 的表单式结构
  for (const m of s.matchAll(/curPersonId["'][^>]*value=["'](\d{5,})/gi)) ids.push(m[1]);
  return ids.filter((x) => ID_RE.test(x));
}

/**
 * 纯 HTTP 识别：用浏览器会话的 cookie 调课程列表接口。
 *
 * 失败（未登录 / 接口改版 / 网络不通）一律返回空数组，交给后面的来源兜底 ——
 * 这里绝不能抛异常把整个启动流程带崩。
 *
 * @param {object} opts
 * @param {import('playwright-core').BrowserContext} [opts.context] 用它的 request（共享 cookie）
 * @param {object} [opts.request] 也可以直接传一个 APIRequestContext
 * @returns {Promise<string[]>}
 */
export async function fetchPersonIds({ context, request } = {}) {
  const req = request || context?.request;
  if (!req || typeof req.post !== 'function') return [];
  try {
    const res = await req.post(COURSE_LIST_API, {
      form: { ...COURSE_LIST_FORM },
      timeout: 20000,
      maxRedirects: 5,
    });
    if (!res.ok()) {
      log(`账号 ID 接口返回 HTTP ${res.status()}（改用页面识别）`, 'debug');
      return [];
    }
    const html = await res.text();
    const ids = personIdsFromCourseListHtml(html);
    if (!ids.length) log('账号 ID 接口没返回课程卡片（可能未登录，改用页面识别）', 'debug');
    return ids;
  } catch (err) {
    log(`账号 ID 接口调用失败：${err.message}（改用页面识别）`, 'debug');
    return [];
  }
}

/** 从单个 frame 的 DOM 读课程卡片里的 personId（evaluate 回调须自包含，不能引用 Node 侧变量） */
async function cardFromFrame(frame) {
  return frame
    .evaluate(() => {
      const card = document.querySelector('.course.learnCourse');
      if (!card) return null;
      const v = card.querySelector('input.curPersonId')?.value;
      if (v && /^\d{5,}$/.test(String(v).trim())) return { id: String(v).trim(), from: '课程列表卡片' };
      const info = String(card.getAttribute('info') || '');
      const parts = info.split('_');
      if (parts[1] && /^\d{5,}$/.test(parts[1].trim())) {
        return { id: parts[1].trim(), from: '课程列表 info 属性' };
      }
      return null;
    })
    .catch(() => null);
}

/** 被动扫描：已打开页面/iframe 里是否已经有课程卡片 */
async function cardsFromOpenPages(context) {
  const out = [];
  if (!context) return out;
  for (const p of context.pages()) {
    for (const f of p.frames()) {
      const hit = await cardFromFrame(f);
      if (hit && ID_RE.test(hit.id)) out.push(hit);
    }
  }
  return out;
}

/** 在个人空间页里等课程列表 iframe 出现（列表要点「全部课程」才会加载） */
async function findCourseFrame(page, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (const f of page.frames()) {
      // 列表在 mooc2-ans 域下；其余 frame（课表等）不用看
      if (!f.url().includes('mooc2-ans.chaoxing.com')) continue;
      const n = await f
        .evaluate(() => document.querySelectorAll('.course.learnCourse').length)
        .catch(() => 0);
      if (n > 0) return f;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/**
 * 交互兜底：点「全部课程」把课程列表拉起来再读。
 * 与 recon.listCourses 是同一套动作（同一份实测结论：列表在 iframe 里，
 * 首屏不加载）。
 */
async function cardsViaCourseListTab(page, timeoutMs) {
  if (!page || typeof page.locator !== 'function') return null;
  let frame = await findCourseFrame(page, 2000);
  if (!frame) {
    await page
      .locator('.label-item', { hasText: '全部课程' })
      .first()
      .click({ timeout: 10000 })
      .catch(() => {});
    frame = await findCourseFrame(page, timeoutMs);
  }
  if (!frame) return null;
  return cardFromFrame(frame);
}

/**
 * 在浏览器里找 personId：按来源可信度加权投票。
 *
 * @param {object} opts
 * @param {import('playwright-core').BrowserContext} [opts.context]
 * @param {import('playwright-core').Page} [opts.page] 个人空间页（交互兜底用）
 * @param {object} [opts.request] 可注入的 APIRequestContext（测试用）
 * @param {boolean} [opts.allowUiFallback=true] 是否允许点「全部课程」
 * @returns {Promise<{id:string, from:string, score:number, votes:number, total:number}|null>}
 */
export async function discoverPersonId({ context, page, request, allowUiFallback = true } = {}) {
  const candidates = [];
  const add = (id, from) => {
    if (id && ID_RE.test(id)) candidates.push({ id, from });
  };

  // ① 课程列表接口（纯 HTTP，最可靠；不依赖当前打开的是什么页面）
  for (const id of await fetchPersonIds({ context, request })) add(id, '课程列表接口');

  // ② 已打开页面里的课程卡片
  for (const hit of await cardsFromOpenPages(context)) add(hit.id, hit.from);

  // ③ 页面 / frame URL 里的 cpi
  if (context) {
    for (const p of context.pages()) {
      add(cpiFromUrl(p.url()), '页面URL');
      for (const f of p.frames()) add(cpiFromUrl(f.url()), 'frame URL');
    }
  }

  // ④ 页面 HTML 里的 JSON（最弱）
  if (page) {
    const html = await page
      .evaluate(() => document.documentElement.innerHTML.slice(0, 500000))
      .catch(() => '');
    add(cpiFromHtml(html), '页面内容');
  }

  // ⑤ 以上全没找到 → 点「全部课程」把列表拉起来再读
  if (!candidates.length && allowUiFallback) {
    const hit = await cardsViaCourseListTab(page, 20000).catch(() => null);
    if (hit) add(hit.id, hit.from);
  }

  if (!candidates.length) return null;

  /*
   * 加权投票：同一来源对同一 ID **只计一次**权重
   * （接口返回 12 门课 = 12 次重复，简单计数会让它压过一切；
   *  同理多个页面 URL 带同一个 cpi 也不该叠加），可信度高的来源权重更大。
   * 分数相同则取先出现的（候选顺序已按可信度排过）。
   */
  const tally = new Map();
  const counted = new Set(); // `${id}|${from}`：已计过权重的来源
  let votes = 0;
  for (const c of candidates) {
    votes += 1;
    const key = `${c.id}|${c.from}`;
    if (counted.has(key)) continue;
    counted.add(key);
    const cur = tally.get(c.id) || { id: c.id, score: 0, from: c.from };
    cur.score += SOURCE_WEIGHT[c.from] ?? 1;
    tally.set(c.id, cur);
  }
  const best = [...tally.values()].sort((a, b) => b.score - a.score)[0];
  return { id: best.id, from: best.from, score: best.score, votes, total: candidates.length };
}

/**
 * 自动配置：识别 → 写 local.json → 更新内存里的 PERSON_ID。
 *
 * @param {object} opts
 * @param {import('playwright-core').BrowserContext} [opts.context]
 * @param {import('playwright-core').Page} [opts.page]
 * @param {object} [opts.request] 测试用
 * @param {boolean} [opts.allowUiFallback]
 * @param {string|null} [opts.persistFile] 写到哪个文件（缺省 local.json；测试时传临时文件）
 * @returns {Promise<{ok:boolean, id?:string, from?:string, error?:string}>}
 */
export async function autoConfigurePersonId({
  context,
  page,
  request,
  allowUiFallback = true,
  persistFile = null,
} = {}) {
  if (PERSON_ID) return { ok: true, id: PERSON_ID, from: '已配置（local.json）' };

  log('账号 ID 未配置，正在自动识别…', 'info');
  const hit = await discoverPersonId({ context, page, request, allowUiFallback }).catch(() => null);
  if (!hit) {
    log('未能自动识别账号 ID —— 通常是还没登录学习通；登录后会自动识别', 'warn');
    return { ok: false, error: 'not-found' };
  }

  try {
    setPersonId(hit.id, { persist: true, file: persistFile });
    log(`已自动识别账号 ID 并写入 local.json：${hit.id}（来源：${hit.from}）`, 'ok');
    return { ok: true, id: hit.id, from: hit.from };
  } catch (err) {
    // 写盘失败也不致命：本次会话仍可用识别到的值
    setPersonId(hit.id, { persist: false });
    log(`已识别账号 ID：${hit.id}（写入 local.json 失败：${err.message}；本次会话仍可用）`, 'warn');
    return { ok: true, id: hit.id, from: hit.from, error: err.message };
  }
}

/** local.json 的路径（便于测试与排查） */
export function localConfigPath() {
  return PATHS.local;
}

/** local.json 是否存在（界面/日志用来说明"是否已自动配置过"） */
export function hasLocalConfig() {
  try {
    return fs.existsSync(localConfigPath());
  } catch {
    return false;
  }
}
