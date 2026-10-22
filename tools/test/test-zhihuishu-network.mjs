// Isolated replica of the observed progress-save warning. No live account.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

fs.mkdirSync('.desktop-test', { recursive: true });
process.env.XXT_DATA_DIR = fs.mkdtempSync(path.resolve('.desktop-test/zhs-network-'));
const { findEdge } = await import('../../src/browser/launch.mjs');
const { runZhihuishuVideo } = await import('../../src/platforms/zhihuishu/runner.mjs');
const { loadState } = await import('../../src/state.mjs');
const browser = await chromium.launch({ executablePath: findEdge(), headless: true });
try {
  const context = await browser.newContext();
  await context.route('https://onlineweb.zhihuishu.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<div id="student-page"><div id="sharingClassed"><dl><div class="courseName" onclick="window.open(\'https://studyvideoh5.zhihuishu.com/stuStudy\',\'_blank\')">示例课程</div><a href="https://stuonline.zhihuishu.com/report?courseId=course&recruitId=term">成绩</a></dl></div></div>'}));
  await context.route('https://studyvideoh5.zhihuishu.com/**', route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<meta charset="utf-8">
      <a href="https://stuonline.zhihuishu.com/report?courseId=course&recruitId=term">成绩</a>
      <li class="video current_play"><b class="hour">1.1</b><span class="catalogue_title">示例视频</span></li>
      <video></video><div id="vjs_container"><button class="videoArea" onclick="window.playClicks++">播放</button></div>
      <div role="dialog" aria-label="温馨提示">因网络连接问题，导致学习进度提交失败，为保证您不丢失学习进度，请回到学堂重新进入视频学习页。
      <button onclick="window.returnClicks++">返回学堂</button></div>
      <script>window.playClicks=0;window.returnClicks=0;window.pauseCalls=0;document.querySelector('video').pause=()=>window.pauseCalls++;</script>`,
  }));
  const task = {
    platform: 'zhihuishu', type: 'video', courseId: 'zhihuishu:course:term',
    key: 'zhihuishu:course:term:video:1.1:t0', platformTaskKey: 'zhihuishu:course:term:video:1.1',
    name: '示例视频', studyUrl: 'https://studyvideoh5.zhihuishu.com/stuStudy',
  };
  const result = await runZhihuishuVideo({ task, context, shouldStop: () => false, onProgress: () => { throw Error('错误状态不能报告正常播放进度'); } });
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'needs-human');
  assert.match(result.error, /学习进度提交失败/);
  assert.equal(loadState().taskPoints[task.key].status, 'pending', '平台未确认完成，不得记完成');
  assert.equal(context.pages().length, 1, '保留错误页面供用户处理');
  assert.deepEqual(await context.pages()[0].evaluate(() => ({ play: window.playClicks, returned: window.returnClicks, paused: window.pauseCalls })), { play: 0, returned: 0, paused: 1 });
  console.log('✓ 智慧树进度保存失败：明确原因、保留页面、暂停媒体、不自动续播、不误记完成通过');
} finally { await browser.close(); }
