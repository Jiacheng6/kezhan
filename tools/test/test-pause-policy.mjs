/**
 * 「失败分级 + 何时暂停整批」的离线测试（不需要浏览器）。
 *
 * 为什么值得测：用户实测反馈"前面好好的，跑一会儿莫名暂停，重试也不管用，
 * 手动做完提交又恢复，然后再重复"。根因之一就是所有失败一视同仁 ——
 * 环境性失败（截图超时/字体未加载/草稿残留/视频元数据晚到）连撞 3 次就停整批。
 * 这里把"哪些算环境性失败""两条连击怎么算""什么时候才停"钉死。
 *
 * 用例文案直接取自真实运行日志 logs/run-*.jsonl。
 *
 * 用法: node tools/test/test-pause-policy.mjs
 */
import { classifyFailure, advanceStreaks, pauseDecision, formatPauseDetail } from '../../src/failure-policy.mjs';

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

console.log('=== 失败分级：真实日志里的文案 ===');
{
  const cases = [
    ['视频准备失败：读不到视频时长（duration）', 'video-duration'],
    ['elementHandle.screenshot: Timeout 30000ms exceeded.\nCall log:\n  - taking element screenshot', 'screenshot-timeout'],
    ['题目截图超时（题目字体尚未加载）', 'font-not-ready'],
    ['题目字体加载失败，请刷新题目后重试；未发送可能乱码的截图', 'font-not-ready'],
    ['豆包输入区已有附件，请先处理原草稿，避免混入其他题目', 'ai-draft'],
    ['豆包输入框已有草稿，请先处理，避免覆盖你的内容', 'ai-draft'],
    ['DeepSeek本次回答未能确认，已保留本题；请打开软件内 AI 网页核对', 'ai-answer-unconfirmed'],
    ['API 未返回可读取的回答，请核对模型和接口兼容性', 'ai-api-empty'],
    ['豆包仍在回答上一条消息，请等待结束后再开始', 'ai-busy'],
    ['任务点列表尚未渲染', 'page-not-ready'],
  ];
  for (const [text, tag] of cases) {
    const r = classifyFailure({ error: text });
    ok(`环境性：${tag}`, r.kind === 'transient' && r.tag === tag, `${r.kind}/${r.tag}`);
  }

  // 真失败不能被误判成环境性（否则永远不会停）
  const real = [
    '题目答错了',
    'element not found: .btnSubmit',
    '登录态失效，需要重新登录',
    '视频播放未达标：进度 42%',
    '未知错误',
  ];
  for (const text of real) {
    const r = classifyFailure({ error: text });
    ok(`真失败：${text.slice(0, 16)}`, r.kind === 'real', `${r.kind}/${r.tag}`);
  }

  ok('完全没有原因时算真失败（保守）', classifyFailure({}).kind === 'real');
  ok('errorCode 也能参与判定', classifyFailure({ errorCode: 'answer-not-confirmed' }).kind === 'transient');
}

console.log('\n=== 两条连击：各自独立推进，成功一起清零 ===');
{
  let s = { consecutiveFail: 0, consecutiveTransient: 0 };
  s = advanceStreaks({ ...s, outcome: 'failed', failureKind: 'real' });
  s = advanceStreaks({ ...s, outcome: 'failed', failureKind: 'real' });
  s = advanceStreaks({ ...s, outcome: 'failed', failureKind: 'transient' });
  ok('真失败累加到 2，环境性失败累加到 1（互不干扰）', s.consecutiveFail === 2 && s.consecutiveTransient === 1, JSON.stringify(s));

  s = advanceStreaks({ ...s, outcome: 'ok' });
  ok('一次成功两条同时清零', s.consecutiveFail === 0 && s.consecutiveTransient === 0, JSON.stringify(s));

  s = advanceStreaks({ ...s, outcome: 'failed', failureKind: 'transient' });
  ok('环境性失败只加自己那条', s.consecutiveFail === 0 && s.consecutiveTransient === 1);
}

console.log('\n=== 暂停决策：真失败 3 次停；环境性失败 3 次不停 ===');
{
  const limits = { pauseAfterFailures: 3, pauseAfterTransient: 5 };

  let d = pauseDecision({ consecutiveFail: 2, consecutiveTransient: 0, limits });
  ok('真失败 2 次 → 不停', d.pause === false);

  d = pauseDecision({ consecutiveFail: 3, consecutiveTransient: 0, limits });
  ok('真失败 3 次 → 暂停', d.pause === true && d.kind === 'real', d.reason);

  // 核心回归：这正是用户遇到的那种"莫名暂停"
  d = pauseDecision({ consecutiveFail: 0, consecutiveTransient: 3, limits });
  ok('环境性失败 3 次 → **不再**暂停（旧版在这里停整批）', d.pause === false);

  d = pauseDecision({ consecutiveFail: 0, consecutiveTransient: 4, limits });
  ok('环境性失败 4 次 → 仍不停', d.pause === false);

  d = pauseDecision({ consecutiveFail: 0, consecutiveTransient: 5, limits });
  ok('环境性失败 5 次 → 暂停（并在原因里说明该清理页面状态）', d.pause === true && d.kind === 'transient', d.reason);
  ok('原因里点明"环境性"而不是笼统的失败数', /环境性失败/.test(d.reason), d.reason);

  // 混合：两条都没到阈值 → 不停
  d = pauseDecision({ consecutiveFail: 2, consecutiveTransient: 4, limits });
  ok('两条都差一点 → 不停', d.pause === false);
}

console.log('\n=== 阈值可配 + 越界夹紧 ===');
{
  let d = pauseDecision({ consecutiveFail: 1, consecutiveTransient: 0, limits: { pauseAfterFailures: 1 } });
  ok('把"真失败上限"设成 1 → 第一次失败就停', d.pause === true);

  d = pauseDecision({ consecutiveFail: 9, consecutiveTransient: 0, limits: { pauseAfterFailures: 0 } });
  ok('填 0 被夹到 1（不允许把保护关死）', d.pause === true && d.limits.pauseAfterFailures === 1);

  d = pauseDecision({ consecutiveFail: 99, consecutiveTransient: 0, limits: { pauseAfterFailures: 999 } });
  ok('填 999 被夹到 10', d.limits.pauseAfterFailures === 10);

  d = pauseDecision({ consecutiveFail: 0, consecutiveTransient: 1, limits: { pauseAfterTransient: 1 } });
  ok('环境性上限填 1 被夹到 2', d.limits.pauseAfterTransient === 2 && d.pause === false, JSON.stringify(d.limits));
}

console.log('\n=== 暂停原因：要告诉用户"该处理哪几题" ===');
{
  const recent = [
    { secNo: '2.8.2', name: '示例学习内容.mp4', tag: 'video-duration' },
    { secNo: '2.9', name: '函数的连续性.mp4', tag: 'video-duration' },
    { secNo: '3.1', name: '章节测验', tag: 'ai-draft' },
    { secNo: '3.2', name: '章节测验', tag: 'ai-draft' },
  ];
  // 更具体的规则优先：这条同时含"截图"和"字体"，真正成因是字体没就绪
  ok('"题目截图超时（题目字体尚未加载）"优先判为字体问题', classifyFailure({ error: '题目截图超时（题目字体尚未加载）' }).tag === 'font-not-ready');

  const text = formatPauseDetail({ reason: '连续 3 个任务点失败（上限 3）', recent, max: 2 });
  ok('包含任务定位（节号 + 名称）', /3\.1/.test(text) && /3\.2/.test(text), text);
  ok('只列最近的 N 条（2.8.2/2.9 被截掉）', !/2\.8\.2/.test(text) && !/2\.9 /.test(text), text);
  ok('包含失败标签', /ai-draft/.test(text));
  ok('没有失败记录时退化为纯原因', formatPauseDetail({ reason: '测试' }) === '测试');
}

console.log('\n=== 设置层集成：新阈值能存、能夹紧、界面能显示 ===');
{
  const { normalizeSettings, describeSettings } = await import('../../src/settings.mjs');

  let r = normalizeSettings({ 'batch.pauseAfterFailures': 5, 'batch.pauseAfterTransient': 8 });
  ok('设置可保存', r.ok === true && r.applied['batch.pauseAfterFailures'] === 5 && r.applied['batch.pauseAfterTransient'] === 8, JSON.stringify(r.applied));
  ok('写进嵌套对象 batch.*', r.settings.batch.pauseAfterFailures === 5 && r.settings.batch.pauseAfterTransient === 8);

  r = normalizeSettings({ 'batch.pauseAfterFailures': 0 });
  ok('填 0 被夹到下限 1 并提示', r.settings.batch.pauseAfterFailures === 1 && r.errors.length > 0, r.errors[0] || '');

  r = normalizeSettings({ 'batch.pauseAfterTransient': 999 });
  ok('填 999 被夹到上限 20', r.settings.batch.pauseAfterTransient === 20);

  r = normalizeSettings({ 'batch.nonsense': 1 });
  ok('未知键仍被拒绝', r.rejected.includes('batch.nonsense'));

  const rows = describeSettings();
  const paths = rows.map((x) => x.path);
  ok('界面规格里有这两项', paths.includes('batch.pauseAfterFailures') && paths.includes('batch.pauseAfterTransient'));
  const row = rows.find((x) => x.path === 'batch.pauseAfterTransient');
  ok('默认值显示为 5', Number(row.value) === 5, `value=${row.value}`);
}

console.log('\n=== 「AI 还在生成」不算需要人工处理 ===');
{
  const { isBusyOnlyFailure } = await import('../../src/failure-policy.mjs');
  ok('already-generating 是"忙"，不是"要人处理"', isBusyOnlyFailure({ aiErrorCode: 'already-generating' }) === true);
  ok('只有文案也能识别', isBusyOnlyFailure({ error: '千问仍在回答上一条消息，请等待结束后再开始' }) === true);
  ok('风控验证不是"忙"（必须人工）', isBusyOnlyFailure({ aiErrorCode: 'verification-required', error: '千问要求人工验证' }) === false);
  ok('未登录不是"忙"', isBusyOnlyFailure({ aiErrorCode: 'not-logged-in' }) === false);
  ok('普通失败不是"忙"', isBusyOnlyFailure({ error: '找不到第 3 题的元素' }) === false);
}

console.log('\n' + '='.repeat(50));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
