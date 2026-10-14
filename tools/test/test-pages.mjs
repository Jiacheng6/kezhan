/**
 * 页面台账与清场的离线测试（不需要浏览器）。
 *
 * 这块逻辑最容易出两种恶性 bug：
 *   1) 把"等你手动作答"的页面也关了 → 答案丢了；
 *   2) 把最后一个标签页也关了 → Chromium 直接退出浏览器，CDP 断开，启动失败。
 * 所以用假 page 对象把边界钉死。
 *
 * 用法: node tools/test/test-pages.mjs
 */
import {
  cleanupPages,
  closeTrackedPages,
  isJunkUrl,
  isTaskPageUrl,
  isBlankUrl,
  isSamePageUrl,
  newTaskPage,
  releasePage,
  setPageBusy,
  trackedPages,
} from '../../src/browser/pages.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
};

/* ---------- 假 page / 假 context ---------- */
function mkPage(url) {
  return {
    _url: url,
    _closed: false,
    async goto(u) {
      this._url = u; // 真的导航会改 URL，mock 也照做
    },
    url() {
      return this._url;
    },
    isClosed() {
      return this._closed;
    },
    async close() {
      this._closed = true;
    },
  };
}

function mkContext(urls) {
  const pages = urls.map(mkPage);
  return {
    pages: () => pages.filter((p) => !p._closed),
    async newPage() {
      const p = mkPage('about:blank');
      pages.push(p);
      return p;
    },
    _all: pages,
  };
}

console.log('=== URL 判定 ===');
ok('about:blank 是垃圾页', isJunkUrl('about:blank'));
ok('Edge 新建标签页是垃圾页', isJunkUrl('https://ntp.msn.cn/edge/ntp?locale=zh-CN&title=x'));
ok('学习通首页不是垃圾页', !isJunkUrl('https://i.chaoxing.com/base?t=1'));
ok('控制台不是垃圾页', !isJunkUrl('http://127.0.0.1:8787/'));
ok('cards 页是任务页', isTaskPageUrl('https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1'));
ok('work 页是任务页', isTaskPageUrl('https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew?x=1'));
ok('个人空间不是任务页', !isTaskPageUrl('https://i.chaoxing.com/base'));
ok('isBlankUrl 只认 about:*', isBlankUrl('about:blank') && !isBlankUrl('https://ntp.msn.cn/edge/ntp'));

console.log('\n=== 清场：关该关的、留该留的 ===');
{
  const ctx = mkContext([
    'about:blank',
    'https://ntp.msn.cn/edge/ntp?locale=zh-CN',
    'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&knowledgeid=aaa',
    'https://i.chaoxing.com/base?t=1',
    'http://127.0.0.1:8787/',
  ]);
  const r = await cleanupPages(ctx, {});
  const left = ctx.pages().map((p) => p.url());
  ok('空白页被关', !left.includes('about:blank'));
  ok('Edge 新建标签页被关', !left.some((u) => u.includes('ntp.msn.cn')));
  ok('残留刷课页被关', !left.some((u) => u.includes('knowledge/cards')));
  ok('个人空间保留', left.some((u) => u.includes('chaoxing.com/base')));
  ok('控制台保留', left.some((u) => u.includes('127.0.0.1:8787')));
  ok('关掉 3 个', r.closed.length === 3, `实际 ${r.closed.length}：${r.closed.map((c) => c.reason).join(' / ')}`);
}

console.log('\n=== 白名单：等你手动作答的页面不能关 ===');
{
  const KEEP = 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&knowledgeid=quizing';
  const ctx = mkContext([KEEP, 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&knowledgeid=other']);
  await cleanupPages(ctx, { keepUrls: [KEEP] });
  const left = ctx.pages().map((p) => p.url());
  ok('白名单页面保留', left.includes(KEEP));
  ok('其它刷课页照关', left.length === 1);
}

console.log('\n=== 去重：控制台/千问各留一个 ===');
{
  const ctx = mkContext([
    'http://127.0.0.1:8787/',
    'http://127.0.0.1:8787/',
    'https://www.qianwen.com/?ch=x',
    'https://www.qianwen.com/?ch=y',
    'https://i.chaoxing.com/base',
  ]);
  const r = await cleanupPages(ctx, {});
  const left = ctx.pages().map((p) => p.url());
  ok('控制台只留 1 个', left.filter((u) => u.includes('8787')).length === 1);
  ok('千问只留 1 个', left.filter((u) => u.includes('qianwen')).length === 1);
  ok('去重关掉 2 个', r.closed.length === 2, r.closed.map((c) => c.reason).join(' / '));
}

console.log('\n=== 绝不能关掉最后一个页面 ===');
{
  const ctx = mkContext(['about:blank']);
  const r = await cleanupPages(ctx, {});
  ok('关完之后至少还有页面', ctx.pages().length >= 1, `剩 ${ctx.pages().length} 个`);
  ok('仅剩的垃圾页会被导航到学习通首页', ctx.pages()[0].url().includes('chaoxing.com'), ctx.pages()[0].url());
}

console.log('\n=== 本进程台账 / 退出收摊 ===');
{
  const ctx = mkContext(['https://i.chaoxing.com/base']);
  const p1 = await newTaskPage(ctx, 'video');
  p1._url = 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&knowledgeid=v1';
  const p2 = await newTaskPage(ctx, 'quiz');
  p2._url = 'https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew?x=1';
  ok('台账登记了 2 个', trackedPages().length === 2);

  // 两个都在忙 → 一键清理应全部跳过
  setPageBusy(p1, true);
  setPageBusy(p2, true);
  const r = await cleanupPages(ctx, { preserveBusy: true });
  ok('一键清理时"正忙"的任务页被跳过', !p1.isClosed() && !p2.isClosed());
  ok('此时确实什么都没关', r.closed.length === 0, `closed=${r.closed.length}`);

  // 退出收摊：不管忙不忙，都关掉（保留白名单）
  const closed = await closeTrackedPages({ keepUrls: [] });
  ok('退出收摊关掉全部台账页面', closed.length === 2, `关了 ${closed.length} 个`);
  ok('台账随之清空', trackedPages().length === 0);
}

console.log('\n=== 白名单匹配不能"张冠李戴" ===');
{
  const A = 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&knowledgeid=AAA&num=1';
  const B = 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&knowledgeid=BBB&num=1';
  const B2 = 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?num=1&knowledgeid=BBB&clazzid=1&ut=s'; // 参数顺序不同
  ok('不同 knowledgeid 不是同一页', !isSamePageUrl(A, B));
  ok('参数顺序不同仍算同一页', isSamePageUrl(B, B2));
  ok('完全相同的 URL 算同一页', isSamePageUrl(A, A));
}

console.log('\n=== 正在用的页面必须被保护（否则会关掉 coursePage）===');
{
  const ctx = mkContext([
    'https://passport2.chaoxing.com/login?fid=&a=1',
    'https://passport2.chaoxing.com/login?fid=&a=1',
    'https://i.chaoxing.com/base?t=1',
    'https://i.chaoxing.com/base?t=1', // 重复的个人空间页
    'http://127.0.0.1:8787/',
  ]);
  const coursePage = ctx._all[2]; // 假装 runtime.coursePage 是第一个个人空间页
  const r = await cleanupPages(ctx, { protectedPages: [coursePage] });
  const left = ctx.pages().map((p) => p.url());
  ok('受保护的课程页没被关', !coursePage.isClosed());
  ok('登录页去重到 1 个', left.filter((u) => u.includes('passport2')).length === 1);
  ok('个人空间页去重到 1 个（且是受保护那个）', left.filter((u) => u.includes('i.chaoxing.com/base')).length === 1);
  ok('重复页确实关了 2 个', r.closed.length === 2, r.closed.map((c) => c.reason).join(' / '));
}

console.log('\n' + '='.repeat(50));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
