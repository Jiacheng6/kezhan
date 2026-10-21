import { readZhihuishuPage, isZhihuishuUrl } from './read-page.mjs';
import { studyCourse } from './catalog.mjs';
import { savePlatformCourses } from '../catalog.mjs';
import { newTaskPage, releasePage } from '../../browser/pages.mjs';
import { throwIfStopped } from '../../control.mjs';
function checkBlockers(state) {
  if(state.blockers.includes('user-consent'))throw Object.assign(Error('智慧树首次进入此课要求本人确认在线学习诚信承诺书，请在保留的网页自行阅读处理后重新扫描'),{code:'USER_CONSENT_REQUIRED'});
  if(state.blockers.includes('progress-save-failed'))throw Object.assign(Error('智慧树提示学习进度提交失败，请按平台提示返回学堂重新进入后再扫描；原课程清单保留'),{code:'PROGRESS_SAVE_FAILED'});
  if(state.blockers.length)throw Object.assign(Error('智慧树需要人工验证，请完成验证后重新扫描；原课程清单保留'),{code:'VERIFICATION_REQUIRED'});
}
export function scanGuard() {
  // Scan pages only: don't start media while inspecting course directories.
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.__scanDestinations = [];
  const capture = value => { if (value) window.__scanDestinations.push(String(value)); };
  window.open = value => {
    capture(value);
    const destination = {}; Object.defineProperty(destination, 'href', { set: capture });
    const child = { close() {}, focus() {} }; Object.defineProperty(child, 'location', { get: () => destination, set: capture }); return child;
  };
}
export async function waitScanPage(page, predicate, { shouldStop, timeoutMs = 25000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfStopped(shouldStop);
    const state = await readZhihuishuPage(page);
    checkBlockers(state);
    if (state.loginState === 'signed-out') throw Error('智慧树尚未登录，请在软件内登录');
    if (predicate(state)) return state;
    await page.waitForTimeout(200);
  }
  throw Error('智慧树课程页面读取超时，原清单保留');
}
export async function openScannedCourse(page, expected, { shouldStop } = {}) {
  const state = await readZhihuishuPage(page), index = state.courses.findIndex(c => c.key === expected.key);
  if (index < 0 || state.courses.filter(c => c.key === expected.key).length !== 1) throw Error('课程列表变化，无法唯一定位课程');
  await page.evaluate(() => { window.__scanDestinations = []; });
  const home = page.url();
  await page.locator('#sharingClassed dl,#flipLessoned dl').filter({ has: page.locator('.courseName') }).nth(index).locator('.courseName').click();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    throwIfStopped(shouldStop);
    const destination = await page.evaluate(() => window.__scanDestinations?.find(url => url && url !== 'about:blank') || null).catch(() => null);
    if (destination) {
      const url = new URL(destination, home);
      if (!isZhihuishuUrl(url.href) || url.hostname !== 'studyvideoh5.zhihuishu.com') throw Error('课程入口尚未适配，未跳转到未知页面');
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 45000 }); break;
    }
    if (page.url() !== home) break;
    checkBlockers(await readZhihuishuPage(page));
    await page.waitForTimeout(100);
  }
  // Progress markers arrive after the directory. Don't snapshot every video as
  // pending from the first directory render while the progress request settles.
  const started = Date.now(); let signature = '', stableSince = started;
  const study = await waitScanPage(page, s => {
    if(s.pageKind !== 'study' || !s.videos.length)return false;
    const next=JSON.stringify([s.course?.key,s.videos.map(v=>[v.key,v.completion]),s.chapterTests.map(t=>t.key)]);
    if(next!==signature){signature=next;stableSince=Date.now();}
    return Date.now()-started>=2000&&Date.now()-stableSince>=1000;
  }, { shouldStop });
  if (study.course?.key !== expected.key) throw Error('课程身份与主页卡片不一致，未保存目录');
  return study;
}
export async function scanZhihuishuCourses(context, { shouldStop, onProgress = () => {}, onFailure = async () => {} } = {}) {
  const page = await newTaskPage(context, 'recon-course'); let keep = false;
  try {
    await page.addInitScript(scanGuard);
    await page.goto('https://onlineweb.zhihuishu.com/onlinestuh5', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const home = await waitScanPage(page, s => s.pageKind === 'home' && s.courses.length > 0, { shouldStop });
    if (home.courses.some(c => !c.key) || new Set(home.courses.map(c => c.key)).size !== home.courses.length) throw Error('部分课程缺少唯一标识，未覆盖原课程清单');
    const courses = [], skipped = [];
    for (let index = 0; index < home.courses.length; index++) {
      throwIfStopped(shouldStop); const card = home.courses[index]; onProgress({ index, total: home.courses.length, course: card.name });
      if (card.kind !== 'shared') { skipped.push({ key: card.key, reason: '翻转课目录尚未适配' }); continue; }
      if (index) {
        await page.goto('https://onlineweb.zhihuishu.com/onlinestuh5', { waitUntil: 'domcontentloaded' });
        await waitScanPage(page, s => s.pageKind === 'home' && s.courses.length > 0, { shouldStop });
      }
      const state = await openScannedCourse(page, card, { shouldStop });
      courses.push(studyCourse(state, page.url(), [{ courseId: card.key, name: card.name }]));
    }
    throwIfStopped(shouldStop);
    if (!courses.length) throw Error('没有可扫描的共享课，原清单保留');
    savePlatformCourses('zhihuishu', courses);
    return { courses: courses.length, videos: courses.reduce((n, c) => n + c.taskPoints.filter(t => t.type === 'video').length, 0), skipped };
  } catch (error) { keep = error.code !== 'STOPPED'; await onFailure(page, error); throw error; }
  finally { releasePage(page); if (!keep) await page.close().catch(() => {}); }
}
