/**
 * 账号 ID 自动识别的离线测试（不需要浏览器、不需要登录）。
 *
 * 为什么值得测：这段逻辑决定"别人拿到项目后能不能直接跑" ——
 * 识别错了会把任务点 URL 拼到别人账号上；识别不到会让人以为工具坏了。
 * 这里用假 context/page 把各来源、投票、持久化都钉住。
 *
 * 用法: node tools/test/test-identity.mjs
 */
import { readFileSync, existsSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PERSON_ID, setPersonId } from '../../src/config.mjs';
import {
  cpiFromUrl,
  cpiFromHtml,
  personIdsFromCourseListHtml,
  fetchPersonIds,
  COURSE_LIST_API,
  discoverPersonId,
  autoConfigurePersonId,
  localConfigPath,
  hasLocalConfig,
} from '../../src/chaoxing/identity.mjs';

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

/* ---------------- 假 frame / page / context ---------------- */
/**
 * frame.evaluate 的结果可定制；不真正执行浏览器逻辑。
 * 注意：同一个 frame 会被问两件事 —— "卡片有几张"（findCourseFrame）和
 * "卡片里的 ID 是什么"（cardFromFrame），这里按回调源码区分，否则会互相串味。
 */
function mkFrame({ url = 'about:blank', evalResult = null } = {}) {
  return {
    url: () => url,
    evaluate: async (fn) => {
      const src = typeof fn === 'function' ? fn.toString() : '';
      if (src.includes('learnCourse') && src.includes('length')) return evalResult ? 1 : 0;
      return evalResult;
    },
  };
}
function mkPage({ url = 'about:blank', frames = [], html = '' } = {}) {
  return {
    url: () => url,
    frames: () => frames,
    evaluate: async () => html,
  };
}
function mkContext(pages) {
  return { pages: () => pages };
}

/** 假 APIRequestContext：可返回 HTML、可指定状态码、可直接抛错 */
function mkRequest({ html = '', status = 200, throwError = null } = {}) {
  const calls = [];
  return {
    calls,
    post: async (url, opts) => {
      calls.push({ url, opts });
      if (throwError) throw new Error(throwError);
      return {
        ok: () => status >= 200 && status < 300,
        status: () => status,
        text: async () => html,
      };
    },
  };
}

/** 真实课程卡片的 HTML 片段（照抄实测结构：info="<clazzId>_<personId>"） */
const cardHtml = (clazzId, personId) =>
  `<div class="course clearfix learnCourse stu_1" info="${clazzId}_${personId}">` +
  `<input class="courseId" value="${clazzId}"><input class="curPersonId" value="${personId}"></div>`;

/** 假个人空间页：frames() 在"点过全部课程"之后才给出课程列表 frame */
function mkSpacePage({ listFrame = null, clickable = true } = {}) {
  let clicked = false;
  return {
    clicked: () => clicked,
    url: () => 'https://i.chaoxing.com/base',
    frames: () => (clicked && listFrame ? [listFrame] : []),
    evaluate: async () => '<html>no id here</html>',
    locator: clickable
      ? () => ({ first: () => ({ click: async () => { clicked = true; } }) })
      : undefined,
  };
}

/* ---------------- URL / HTML 解析 ---------------- */
console.log('=== 解析函数 ===');
ok('从 URL 取 cpi', cpiFromUrl('https://mooc1.chaoxing.com/x?clazzid=1&cpi=12345678&ut=s') === '12345678');
ok('没 cpi 返回 null', cpiFromUrl('https://i.chaoxing.com/base?t=1') === null);
ok('太短的当噪声', cpiFromUrl('https://x/?cpi=123') === null);
ok('从 HTML 取 "personId":"…"', cpiFromHtml('var cfg={"personId":"87654321"};') === '87654321');
ok('从 HTML 取 cpi=…', cpiFromHtml('iframe src="/a?cpi=55555555&x=1"') === '55555555');
ok('HTML 里没有就 null', cpiFromHtml('<html>nothing</html>') === null);

console.log('\n=== 课程列表接口返回值解析 ===');
{
  // 夹具一律用编造的数字：真实 personId 绝不能进仓库，哪怕是测试数据
  const html = cardHtml(1234567, '87654321') + cardHtml(7654321, '87654321');
  const ids = personIdsFromCourseListHtml(html);
  // 真实卡片同时带 info 属性和 input.curPersonId，所以每张卡贡献 2 次命中 —— 去重交给投票
  ok('从课程列表 HTML 抽 ID（两门课全部一致）',
    ids.length >= 2 && ids.every((x) => x === '87654321'), JSON.stringify(ids));
  ok('带 input.curPersonId 的片段也能抽',
    personIdsFromCourseListHtml('<input class="curPersonId" value="87654321">')[0] === '87654321');
  ok('空 HTML 返回空数组', personIdsFromCourseListHtml('').length === 0);
  ok('非卡片的 info 属性不当 ID', personIdsFromCourseListHtml('info="abc_def"').length === 0);
}

/* ---------------- 来源① 纯 HTTP 接口 ---------------- */
console.log('\n=== 来源①：课程列表接口（纯 HTTP）===');
{
  const req = mkRequest({ html: cardHtml(1, '11111111') + cardHtml(2, '11111111') });
  const ids = await fetchPersonIds({ request: req });
  ok('能取到 ID', ids.length === 2 && ids[0] === '11111111');
  ok('请求打到了课程列表接口', req.calls[0] && req.calls[0].url === COURSE_LIST_API, req.calls[0]?.url);
  ok('带了 courseType 等表单参数', req.calls[0]?.opts?.form?.courseType === '1' && 'pageHeader' in (req.calls[0]?.opts?.form || {}));

  ok('HTTP 500 时返回空（不抛异常）', (await fetchPersonIds({ request: mkRequest({ status: 500 }) })).length === 0);
  ok('网络异常时返回空（不抛异常）', (await fetchPersonIds({ request: mkRequest({ throwError: 'socket hang up' }) })).length === 0);
  ok('没传 request/context 时返回空', (await fetchPersonIds({})).length === 0);

  // 识别：即使当前打开的页面毫无线索，接口也能认出（这正是实测失败的那条路）
  const ctx = mkContext([mkPage({ url: 'https://i.chaoxing.com/base' })]);
  const r = await discoverPersonId({ context: ctx, request: req, page: mkPage({}) });
  ok('无页面线索时靠接口识别成功', r && r.id === '11111111', r ? `${r.id}（来源：${r.from}）` : '未识别');
  ok('来源标记为课程列表接口', r && r.from === '课程列表接口');
  // 接口返回 12 门课 = 同一 ID 重复 12 次；同来源重复**不该**叠加权重（实测曾把 24 次算成 72 分）
  const many = mkRequest({ html: Array.from({ length: 12 }, (_, i) => cardHtml(i + 1, '11111111')).join('') });
  const r2 = await discoverPersonId({ context: mkContext([mkPage({})]), request: many });
  ok('同来源重复不叠权重（接口 = 权重 3）', r2 && r2.score === 3, r2 ? `得分 ${r2.score}（候选 ${r2.total} 个）` : '未识别');
}
{
  /*
   * 关键语义：弱来源"数量多"不能压过强来源。
   * 5 个页面 URL 都带 cpi=99999999（权重 2，去重后只算一次），
   * 1 张课程卡片给出 11111111（权重 3）→ 应取更强的那个。
   */
  const pages = Array.from({ length: 5 }, () => mkPage({ url: 'https://mooc1.chaoxing.com/x?cpi=99999999' }));
  pages.push(
    mkPage({
      url: 'https://i.chaoxing.com/base',
      frames: [mkFrame({ url: 'https://mooc2-ans.chaoxing.com/f', evalResult: { id: '11111111', from: '课程列表卡片' } })],
    }),
  );
  const r = await discoverPersonId({ context: mkContext(pages) });
  ok('强来源胜过弱来源的"多"', r && r.id === '11111111', r ? `${r.id}（分 ${r.score}，候选 ${r.total}）` : '未识别');
}
{
  // 接口未登录（返回空列表）时，不能污染结果，应回落到页面来源
  const ctx = mkContext([mkPage({ url: 'https://mooc1.chaoxing.com/x?cpi=22222222' })]);
  const r = await discoverPersonId({ context: ctx, request: mkRequest({ html: '<html>请登录</html>' }) });
  ok('接口没结果时回落到页面 URL', r && r.id === '22222222', r ? r.from : '未识别');
}
{
  // 接口结果权重大于页面内容兜底
  const ctx = mkContext([mkPage({ url: 'https://i.chaoxing.com/base' })]);
  const page = mkPage({ html: 'var c={"personId":"99999999"}' });
  const r = await discoverPersonId({ context: ctx, request: mkRequest({ html: cardHtml(3, '33333333') }), page });
  ok('接口优先于页面 HTML 兜底', r && r.id === '33333333', r ? `${r.id}（分 ${r.score}）` : '未识别');
}

/* ---------------- 来源⑤ 交互兜底：点「全部课程」 ---------------- */
console.log('\n=== 来源⑤：点「全部课程」兜底（个人空间首页本身不含 ID）===');
{
  const listFrame = mkFrame({ url: 'https://mooc2-ans.chaoxing.com/visit/interaction', evalResult: { id: '55555555', from: '课程列表卡片' } });
  const page = mkSpacePage({ listFrame });
  const ctx = mkContext([mkPage({ url: 'https://i.chaoxing.com/base' })]);
  const r = await discoverPersonId({ context: ctx, request: mkRequest({ html: '' }), page });
  ok('点开后识别成功', r && r.id === '55555555', r ? r.from : '未识别');
  ok('确实点了「全部课程」', page.clicked() === true);
}
{
  const listFrame = mkFrame({ url: 'https://mooc2-ans.chaoxing.com/visit/interaction', evalResult: { id: '55555555', from: '课程列表卡片' } });
  const page = mkSpacePage({ listFrame });
  const ctx = mkContext([mkPage({ url: 'https://i.chaoxing.com/base' })]);
  const r = await discoverPersonId({ context: ctx, page, allowUiFallback: false });
  ok('allowUiFallback=false 时不点页面', page.clicked() === false && r === null);
}
{
  // 已经有线索时不该再去点页面（避免无谓扰动用户界面）
  const page = mkSpacePage({ listFrame: mkFrame({ evalResult: { id: '55555555', from: '课程列表卡片' } }) });
  const ctx = mkContext([mkPage({ url: 'https://mooc1.chaoxing.com/x?cpi=22222222' })]);
  const r = await discoverPersonId({ context: ctx, page });
  ok('已有线索时不动页面', page.clicked() === false && r && r.id === '22222222');
}

/* ---------------- 各识别来源 ---------------- */
console.log('\n=== 识别来源 ===');
{
  const ctx = mkContext([
    mkPage({ url: 'https://i.mooc.chaoxing.com/space/index', frames: [mkFrame({ url: 'https://mooc2-ans.chaoxing.com/f', evalResult: { id: '11111111', from: '课程列表卡片' } })] }),
  ]);
  const r = await discoverPersonId({ context: ctx });
  ok('来源①：课程列表卡片', r && r.id === '11111111', r ? r.from : '未识别');
}
{
  const ctx = mkContext([mkPage({ url: 'https://mooc1.chaoxing.com/x?clazzid=1&cpi=22222222&ut=s' })]);
  const r = await discoverPersonId({ context: ctx });
  ok('来源③：页面 URL', r && r.id === '22222222', r ? r.from : '未识别');
}
{
  const ctx = mkContext([mkPage({ url: 'https://i.chaoxing.com/base', frames: [mkFrame({ url: 'https://mooc1.chaoxing.com/y?cpi=33333333' })] })]);
  const r = await discoverPersonId({ context: ctx });
  ok('来源③：frame URL', r && r.id === '33333333', r ? r.from : '未识别');
}
{
  const ctx = mkContext([mkPage({ url: 'https://i.chaoxing.com/base' })]);
  const page = mkPage({ html: '<script>var u={"personId":"44444444"}</script>' });
  const r = await discoverPersonId({ context: ctx, page });
  ok('来源④：页面 HTML 兜底', r && r.id === '44444444', r ? r.from : '未识别');
}
{
  const ctx = mkContext([mkPage({ url: 'https://i.chaoxing.com/base' })]);
  const r = await discoverPersonId({ context: ctx, page: mkPage({ html: '<html>empty</html>' }) });
  ok('都找不到时返回 null', r === null);
}

console.log('\n=== 多来源投票（同一 ID 被印证优先）===');
{
  const ctx = mkContext([
    mkPage({ url: 'https://a/?cpi=99999999' }), // 单次出现
    mkPage({ url: 'https://b/?cpi=12345678' }),
    mkPage({ url: 'https://c/', frames: [mkFrame({ url: 'https://d/?cpi=12345678' })] }), // 12345678 出现两次
  ]);
  const r = await discoverPersonId({ context: ctx });
  ok('取出现次数最多的', r && r.id === '12345678', r ? `${r.id}（${r.votes}/${r.total}）` : '未识别');
}

/* ---------------- 自动配置 + 持久化 ---------------- */
console.log('\n=== 自动配置与持久化 ===');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'xxt-identity-'));
  const file = path.join(dir, 'local.json');

  // 先清空内存里的 ID，模拟"全新克隆、没有 local.json"
  const original = PERSON_ID;
  setPersonId('', { persist: false });
  ok('内存 ID 已清空（模拟全新环境）', PERSON_ID === '');

  const ctx = mkContext([
    mkPage({ url: 'https://i.mooc.chaoxing.com/space/index', frames: [mkFrame({ evalResult: { id: '77777777', from: '课程列表卡片' } })] }),
  ]);

  const r = await autoConfigurePersonId({ context: ctx, persistFile: file });
  ok('自动配置成功', r.ok === true && r.id === '77777777', JSON.stringify(r));
  ok('内存里的 PERSON_ID 已更新', PERSON_ID === '77777777');
  ok('local.json 已写出', existsSync(file));
  const written = JSON.parse(readFileSync(file, 'utf8'));
  ok('文件里 personId 正确', written.personId === '77777777', JSON.stringify(written.personId));
  ok('文件里带说明字段', typeof written._说明 === 'string' && written._说明.length > 10);

  // 二次调用应"已配置"且不再改写文件
  writeFileSync(file, JSON.stringify({ _说明: '手动改过', personId: '77777777', keep: 1 }, null, 2), 'utf8');
  const r2 = await autoConfigurePersonId({ context: ctx, persistFile: file });
  ok('已配置时直接返回，不重复写盘', r2.ok === true && /已配置/.test(r2.from || ''), r2.from);
  const after2 = JSON.parse(readFileSync(file, 'utf8'));
  ok('没有覆盖已有文件的其它字段', after2.keep === 1 && after2._说明 === '手动改过');

  // 识别不到时不应写文件（先把内存 ID 清掉，否则会走"已配置"短路）
  setPersonId('', { persist: false });
  const r3 = await autoConfigurePersonId({ context: mkContext([mkPage({})]), persistFile: path.join(dir, 'none.json') });
  ok('识别不到时 ok=false', r3.ok === false, r3.error);
  ok('识别不到时不创建文件', !existsSync(path.join(dir, 'none.json')));

  // 还原现场
  setPersonId(original, { persist: false });
  rmSync(dir, { recursive: true, force: true });
}

/* ---------------- 本机真实配置检查 ---------------- */
console.log('\n=== 本机现状（仅供参考，不作为断言）===');
console.log(`  local.json 路径: ${localConfigPath()}`);
console.log(`  local.json 是否存在: ${hasLocalConfig()}`);
console.log(`  当前 PERSON_ID: ${PERSON_ID ? PERSON_ID.slice(0, 3) + '****' + PERSON_ID.slice(-2) : '(空)'}`);

console.log('\n' + '='.repeat(50));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
