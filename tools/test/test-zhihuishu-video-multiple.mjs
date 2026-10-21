// Replica of the observed non-graded multi-select dialog. No live account.
// A proper subset can be selected while the site renders no .answer feedback.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findEdge } from '../../src/browser/launch.mjs';
import { handleZhihuishuVideoPrompt, readZhihuishuVideoPrompt } from '../../src/platforms/zhihuishu/video.mjs';

const browser = await chromium.launch({ executablePath: findEdge(), headless: true });
const key = 'zhihuishu:course:term:video:1.1';
let mode = 'normal';
const html = () => `<meta charset="utf-8">
  <a href="https://stuonline.zhihuishu.com/report?courseId=course&recruitId=term">成绩</a>
  <li class="video current_play"><b class="hour">1.1</b><span class="catalogue_title">示例视频</span></li>
  <video></video><div id="vjs_container"><button class="videoArea" onclick="window.actions.push('play');window.playing=true">播放</button></div>
  <div role="dialog" aria-label="弹题测验">
    <div class="el-dialog__header">弹题是为了帮助同学们巩固知识点，不会影响到大家作业和考试的成绩。</div>
    <ul class="el-pager"><li class="number active">1</li></ul>
    <div class="radio"><p class="topic-title"><span class="title-tit">【多选题】</span><span>示例多选题干</span></p>
      <ul class="topic-list">${['A', 'B', 'C'].map(letter => `<li class="topic-item" onclick="window.actions.push('select:${letter}');if(event.isTrusted&&'${mode}'!=='unconfirmed')this.querySelector('.topic-option-item').classList.toggle('active')">
        <svg class="icon topic-option"><use href="#iconfuxuan"></use></svg>
        <span class="topic-option-item ${mode === 'preselected' && letter === 'B' ? 'active' : ''}">${letter}.</span><div class="item-topic"><p>示例选项${letter}</p></div></li>`).join('')}
      </ul>
    </div>
    <div class="el-dialog__footer"><div class="btn" onclick="window.actions.push('close');if(document.querySelector('.topic-option-item.active'))this.closest('[role=dialog]').hidden=true">关闭</div></div>
  </div>
  <script>window.actions=[];window.t=10;window.playing=false;const v=document.querySelector('video');Object.defineProperties(v,{currentTime:{get:()=>window.t},paused:{get:()=>!window.playing},ended:{get:()=>false}});setInterval(()=>{if(window.playing)window.t+=.1},60);</script>`;

try {
  const page = await browser.newPage();
  await page.route('https://studyvideoh5.zhihuishu.com/**', r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html() }));
  await page.goto('https://studyvideoh5.zhihuishu.com/stuStudy');
  let prompt = await readZhihuishuVideoPrompt(page);
  assert.equal(prompt.multiple, true);
  assert.equal(prompt.supported, true);
  assert.equal(prompt.answered, false, '未选择不能算作答');
  assert.equal(prompt.feedbackShown, false);
  let result = await handleZhihuishuVideoPrompt(page, { expectedKey: key });
  assert.equal(result.ok, true);
  assert.deepEqual(result.answered[0].letters, ['A']);
  assert.deepEqual(await page.evaluate(() => window.actions), ['select:A', 'close', 'play']);
  assert.ok(result.after > result.before, '关闭后必须验证视频时间推进');

  await page.reload();
  result = await handleZhihuishuVideoPrompt(page, { expectedKey: key, choose: () => ['A', 'C'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.answered[0].letters, ['A', 'C']);
  assert.deepEqual(await page.evaluate(() => window.actions), ['select:A', 'select:C', 'close', 'play']);

  mode = 'preselected'; await page.reload();
  result = await handleZhihuishuVideoPrompt(page, { expectedKey: key });
  assert.equal(result.ok, true);
  assert.deepEqual(result.answered[0].letters, ['B']);
  assert.deepEqual(await page.evaluate(() => window.actions), ['close', 'play'], '保留用户已选项，不能重复点击取消选择');

  mode = 'normal'; await page.reload();
  await page.locator('.el-dialog__footer').evaluate(e => { e.style.position = 'fixed'; e.style.top = '2000px'; });
  result = await handleZhihuishuVideoPrompt(page, { expectedKey: key });
  assert.equal(result.ok, true);
  assert.deepEqual(await page.evaluate(() => window.actions), ['select:A', 'close', 'play']);

  await page.reload();
  result = await handleZhihuishuVideoPrompt(page, { expectedKey: key, choose: () => ['A', 'Z'] });
  assert.equal(result.reason, 'invalid-option');
  assert.deepEqual(await page.evaluate(() => window.actions), [], '完整校验选项后才能开始点击');

  mode = 'unconfirmed'; await page.reload();
  result = await handleZhihuishuVideoPrompt(page, { expectedKey: key });
  assert.equal(result.reason, 'answer-not-confirmed');
  assert.deepEqual(await page.evaluate(() => window.actions), ['select:A'], '点击后没有实际选中，不能关闭或播放');

  console.log('✓ 智慧树多选弹题：无答案反馈的选择回读、多选项、已有选择保护、小视口关闭、无效选项及未选中不续播通过');
} finally { await browser.close(); }
