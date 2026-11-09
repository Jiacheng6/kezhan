/**
 * 「重试真的有用吗」—— 自愈策略的离线测试（不需要浏览器）。
 *
 * 覆盖三处用户实测痛点（2026-11-01）：
 *   1) AI 输入区残留 → 旧逻辑直接拒绝 → 同一题重试 3 次全撞同一堵墙
 *   2) 环境性失败（回答未确认/字体/截图）→ 重试时页面状态没变 → 一直失败
 *   3) 视频"读不到时长" → 旧代码只轮询，不重触发加载，也不看 video.error
 *
 * 用法: node tools/test/test-self-heal.mjs
 */
import { screenshotPlan, clampClip } from '../../src/chaoxing/shot.mjs';
import { shouldResetSession, sessionAction, nextSessionMemory, planComposerReset } from '../../src/ai/session-policy.mjs';
import { durationVerdict } from '../../src/chaoxing/player.mjs';

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

console.log('=== 截图：三级降级顺序 ===');
{
  ok('内置模式 + 有坐标 → 先软件内成像，再 CDP，最后整页',
    JSON.stringify(screenshotPlan({ embeddedMode: true, hasBox: true })) === JSON.stringify(['embedded', 'cdp', 'page']));
  ok('浏览器模式 + 有坐标 → 元素 → 裁剪 → 整页',
    JSON.stringify(screenshotPlan({ embeddedMode: false, hasBox: true })) === JSON.stringify(['element', 'clip', 'page']));
  ok('没有坐标时直接整页（不白等元素稳定）',
    JSON.stringify(screenshotPlan({ embeddedMode: false, hasBox: false })) === JSON.stringify(['page']));

  const vp = { width: 1280, height: 720 };
  let clip = clampClip({ x: -20, y: -5, width: 400, height: 300 }, vp);
  ok('坐标越界被夹到 0', clip.x === 0 && clip.y === 0, JSON.stringify(clip));
  clip = clampClip({ x: 1200, y: 700, width: 500, height: 500 }, vp);
  ok('右下越界时宽度/高度被裁到视口内', clip.width === 80 && clip.height === 20, JSON.stringify(clip));
  ok('退化到 8px 以下视为无效（改走整页）', clampClip({ x: 1279, y: 719, width: 10, height: 10 }, vp) === null);
}

console.log('\n=== AI 会话：哪些失败要在下次换干净起点 ===');
{
  for (const code of ['draft-attachment', 'upload-not-ready', 'send-failed', 'answer-not-confirmed', 'api-empty', 'conversation-unavailable']) {
    ok(`需要重置：${code}`, shouldResetSession({ errorCode: code }) === true);
  }
  ok('验证码/未登录不属于"页面脏了"（不该靠重置解决）', shouldResetSession({ errorCode: 'verification-required' }) === false);
  ok('普通任务失败不重置', shouldResetSession({ errorCode: 'task-failed' }) === false);
  ok('只有文案时也能判定', shouldResetSession({ error: '豆包输入区已有附件，请先处理原草稿' }) === true);

  let a = sessionAction({ lastFailed: false });
  ok('一切正常 → 不重载、不新建对话', a.reload === false && a.freshChat === false && a.clearComposer === false);

  a = sessionAction({ lastFailed: true, lastCode: 'draft-attachment', sameCount: 1 });
  ok('首次残留 → 清输入区（软恢复）', a.clearComposer === true && a.freshChat === true, a.reason);

  a = sessionAction({ lastFailed: true, lastCode: 'draft-attachment', sameCount: 2 });
  ok('同一错误连续 2 次 → 重载页面（硬恢复）', a.reload === true && a.freshChat === true, a.reason);
  ok('硬恢复的原因里写清是"连续 N 次"', /连续 2 次/.test(a.reason), a.reason);

  a = sessionAction({ lastFailed: true, lastCode: 'verification-required' });
  ok('验证码类失败不触发重置（要人来处理）', a.reload === false && a.freshChat === false);

  // 记忆推进
  let m = nextSessionMemory({}, { ok: true });
  ok('成功 → 记忆清零', m.lastFailed === false && m.sameCount === 0);
  m = nextSessionMemory(m, { ok: false, errorCode: 'api-empty' });
  ok('失败 → 记录错误码并标记需重置', m.lastCode === 'api-empty' && m.resetFlag === true && m.sameCount === 1);
  m = nextSessionMemory(m, { ok: false, errorCode: 'api-empty' });
  ok('同一错误再来一次 → 计数变 2', m.sameCount === 2);
  m = nextSessionMemory(m, { ok: false, errorCode: 'send-failed' });
  ok('换了错误码 → 计数重新从 1 开始', m.sameCount === 1 && m.lastCode === 'send-failed');
  m = nextSessionMemory(m, { ok: true });
  ok('成功后又清零', m.sameCount === 0 && m.resetFlag === false);
}

console.log('\n=== 输入区残留：能清就清，用户自己的内容不动 ===');
{
  let p = planComposerReset({ hasAttachment: false, editorText: '' });
  ok('干净 → 什么都不做', p.action === 'none' && p.ok === true);

  p = planComposerReset({ hasAttachment: true, editorText: '' });
  ok('有附件没文本 → 只清附件', p.action === 'clear-attachment' && p.ok === true, p.reason);

  p = planComposerReset({ hasAttachment: true, editorText: '请给出答案…', editorIsOwnDraft: true });
  ok('附件 + 我们自己的提问文本 → 全清', p.action === 'clear-all' && p.ok === true, p.reason);

  p = planComposerReset({ hasAttachment: false, editorText: '请给出答案…', editorIsOwnDraft: true });
  ok('只剩我们自己的提问文本 → 清文本', p.action === 'clear-editor' && p.ok === true);

  p = planComposerReset({ hasAttachment: true, editorText: '这是我自己写的备注', editorIsOwnDraft: false });
  ok('用户自己敲的内容 → 拒绝覆盖', p.action === 'refuse' && p.ok === false, p.reason);

  p = planComposerReset({ hasAttachment: false, editorText: '这是我自己写的备注', editorIsOwnDraft: false });
  ok('用户自己的草稿（无附件）→ 仍然拒绝', p.ok === false);
}

console.log('\n=== 视频元数据：什么时候该重新 load、什么时候该报错 ===');
{
  let v = durationVerdict({ elapsedMs: 0, duration: null });
  ok('刚打开、还没有时长 → 继续等', v.action === 'wait');

  v = durationVerdict({ elapsedMs: 5000, duration: null, loadRetried: false });
  ok('等了 5 秒还没有 → 先重新触发 load()', v.action === 'retry-load');

  v = durationVerdict({ elapsedMs: 8000, duration: null, loadRetried: true });
  ok('已经重试过 load → 不无限重试', v.action === 'wait');

  v = durationVerdict({ elapsedMs: 1200, duration: 558 });
  ok('读到时长 → 完成', v.action === 'done');

  v = durationVerdict({ elapsedMs: 6000, duration: null, mediaError: 4 });
  ok('video.error 有值 → 立刻失败并带错误码（不白等 20 秒）', v.action === 'fail' && v.reason === 'media-error-4', v.reason);

  v = durationVerdict({ elapsedMs: 20000, duration: null, loadRetried: true });
  ok('预算耗尽 → duration-timeout', v.action === 'fail' && v.reason === 'duration-timeout');
}

console.log('\n=== 千问"正在生成"的判定（本次真机验证抓到的大坑）===');
{
  const { generatingFrom } = await import('../../src/ai/ai.mjs');
  // 真实页面上的两个装饰元素：253×0、在回答卡片外、类名含 loading
  const decoration = { visible: true, width: 253, height: 0, inCard: false };
  ok('页面上只有一个 253×0 的装饰元素 → 不算在生成', generatingFrom({ stopButton: false, hits: [decoration] }) === false);
  ok('两个装饰元素也不误判（真机就是两个）', generatingFrom({ hits: [decoration, { ...decoration }] }) === false);
  ok('有可见"停止"按钮 → 一定在生成', generatingFrom({ stopButton: true, hits: [] }) === true);
  ok('卡片内有实际尺寸的 loading 元素 → 在生成', generatingFrom({ hits: [{ visible: true, width: 40, height: 20, inCard: true }] }) === true);
  ok('有尺寸但在回答卡片外 → 不算（避免被页面其它 loading 骗到）', generatingFrom({ hits: [{ visible: true, width: 40, height: 20, inCard: false }] }) === false);
  ok('不可见的命中不算', generatingFrom({ hits: [{ visible: false, width: 40, height: 20, inCard: true }] }) === false);
  ok('什么都没有 → 空闲', generatingFrom({}) === false);
}

console.log('\n=== 题目字体就绪判定（所有 AI 通道共用的成像环节）===');
{
  const { fontReadyVerdict } = await import('../../src/chaoxing/quiz.mjs');
  ok('字体都就绪 → ready', fontReadyVerdict({ pending: 0 }).action === 'ready');
  ok('仍在加载 → wait', fontReadyVerdict({ pending: 2, elapsedMs: 3000 }).action === 'wait');
  // 2026-11-03 改：字体报错先允许"强制恢复"，恢复次数用完才判 fail
  ok('字体文件报错 → 先 recover（不再立刻 fail）', fontReadyVerdict({ pending: 1, failed: true }).action === 'recover');
  ok('恢复次数用完 → fail(font-failed)', fontReadyVerdict({ pending: 1, failed: true, recoverAttempts: 3, recoverBudget: 3 }).code === 'font-failed');
  ok('超预算 → fail(font-not-ready)', fontReadyVerdict({ pending: 1, elapsedMs: 26000 }).action === 'fail' && fontReadyVerdict({ pending: 1, elapsedMs: 26000 }).code === 'font-not-ready');
  ok('预算默认放宽到 25 秒（给恢复留时间）', fontReadyVerdict({ pending: 1, elapsedMs: 20000 }).action === 'wait');
  ok('有字体报错时优先走恢复（不等超时）', fontReadyVerdict({ pending: 3, failed: true, elapsedMs: 100 }).action === 'recover');
}

console.log('\n' + '='.repeat(50));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
