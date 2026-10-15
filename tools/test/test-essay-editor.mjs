// 全部页面由本地夹具生成，不访问学习通/千问，不使用用户数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const root = fileURLToPath(new URL('../../', import.meta.url));
const testRoot = path.join(root, '.desktop-test');
fs.mkdirSync(testRoot, { recursive: true });
const data = fs.mkdtempSync(path.join(testRoot, 'essay-editor-'));
process.env.XXT_DATA_DIR = data;
process.env.XXT_DESKTOP = '1';
const { ensureDirs } = await import('../../src/config.mjs');
const { findEdge } = await import('../../src/browser/launch.mjs');
const { fillEssayAnswer, readEssayAnswer } = await import('../../src/chaoxing/essay.mjs');
const { registerKeptPage, editKeptEssayReviewAnswer } = await import('../../src/chaoxing/quizrun.mjs');
const { mutateState, listReviewItems, reviewStats } = await import('../../src/state.mjs');
const { startServer } = await import('../../src/server.mjs');
const { startWindowControl, setBrowserVisible, stopWindowControl } = await import('../../src/browser/window-control.mjs');
ensureDirs();
let submitCalls = 0;
const service = await startServer({
  editReviewAnswer: (body) => editKeptEssayReviewAnswer(body.id, body.textAnswer),
  listKeptPages: () => [{ key: 'fixture', submittable: true }],
  submitReviews: () => { submitCalls++; throw new Error('测试禁止提交'); },
});
let context;
try {
  context = await chromium.launchPersistentContext(path.join(data, 'empty-profile'), {
    executablePath: findEdge(), headless: false, args: ['--no-first-run', '--disable-sync'],
  });
  await context.addInitScript(()=>localStorage.setItem('xxt-library-startup','skip'));
  // 题目页的 URL 形状与真实作业一致，内容由 route 完全离线提供。
  await context.route('**/mooc-ans/work/doHomeWorkNew', (route) => route.fulfill({ contentType: 'text/html', body: `
    <div class="TiMu"><h3>【简答题】测试正文同步</h3><div id="container"><iframe id="ueditor_0"></iframe></div><textarea name="answerEditor0" hidden></textarea></div>
    <div class="TiMu"><h3>【简答题】另一道题</h3><textarea id="plain"></textarea></div>
    <div class="TiMu"><div contenteditable="true" id="editable"></div><textarea name="answerEditor2" hidden></textarea></div>
    <div class="TiMu"><iframe id="fallback"></iframe><textarea name="answerEditor3" hidden></textarea></div>
    <div class="TiMu"><textarea readonly>只读答案</textarea></div>
    <div class="TiMu"><textarea>第一框</textarea><textarea>第二框</textarea></div>
    <div class="TiMu"><textarea id="separate"></textarea><div hidden><textarea name="answerEditor6"></textarea></div></div>
    <button class="btnSubmit" onclick="window.submissions++">提交</button>
    <script>window.submissions=0;</script>` }));
  const work = context.pages()[0];
  await work.goto(new URL('/mooc-ans/work/doHomeWorkNew', service.url).href);
  await work.evaluate(() => {
    const iframe = document.querySelector('#ueditor_0');
    const body = iframe.contentDocument.body;
    body.contentEditable = 'true';
    document.querySelector('#fallback').contentDocument.body.contentEditable = 'true';
    window.events = [];
    const storage = document.querySelector('[name="answerEditor0"]');
    window.UE = { instances: { fixture: { isReady: true, container: document.querySelector('#container'), iframe, body,
      setContent(html) { body.innerHTML = html; },
      fireEvent(name) { window.events.push(name); if (name === 'blur') storage.value = body.innerHTML; },
      sync() { window.events.push('sync'); storage.value = body.innerHTML; },
    } } };
  });
  await startWindowControl(context.browser());
  await setBrowserVisible(false);
  const draft = '第一段：协作提高效率。\n第二段：风险具有不确定性。\n\n文本 <script>window.injected = 1</script> & "引号"';
  const auto = await fillEssayAnswer(work.mainFrame(), 0, draft);
  assert.equal(auto.ok, true, auto.error);
  assert.equal(auto.kind, 'ueditor');
  assert.equal(auto.verified, true);
  assert.equal((await setBrowserVisible(false)).visibleCount, 0, '自动填写不得显示浏览器');
  const read = await readEssayAnswer(work.mainFrame(), 0);
  assert.equal(read.visibleText, draft);
  assert.equal(read.storedText, draft);
  assert.deepEqual(await work.evaluate(() => window.events), ['contentchange', 'blur', 'sync']);
  assert.equal(await work.evaluate(() => window.injected), undefined, '正文中的 HTML 不得执行');
  assert.equal(await work.locator('#plain').inputValue(), '', '相邻题不得被误写');
  const preserved = await fillEssayAnswer(work.mainFrame(), 0, '自动生成的新答案');
  assert.equal(preserved.code, 'existing-answer');
  assert.equal((await readEssayAnswer(work.mainFrame(), 0)).visibleText, draft);
  assert.equal((await fillEssayAnswer(work.mainFrame(), 1, '普通文本框答案')).verified, true);
  assert.equal((await fillEssayAnswer(work.mainFrame(), 2, '富文本区域\n下一段')).verified, true);
  assert.equal((await fillEssayAnswer(work.mainFrame(), 3, 'iframe 中的正文')).verified, true);
  assert.equal((await fillEssayAnswer(work.mainFrame(), 4, '不应写入')).ok, false);
  assert.equal((await fillEssayAnswer(work.mainFrame(), 5, '不应写入')).ok, false);
  assert.equal((await fillEssayAnswer(work.mainFrame(), 6, '正文框与隐藏表单分离')).verified, true);
  assert.equal((await fillEssayAnswer(work.mainFrame(), 99, '不应写入')).ok, false);
  await assert.rejects(() => fillEssayAnswer(work.mainFrame(), 0, '停止后不可写入', { overwrite: true, shouldStop: () => true }), { code: 'STOPPED' });
  assert.equal((await readEssayAnswer(work.mainFrame(), 0)).visibleText, draft);
  // 故意让 UEditor 的同步失效，不能把可见正文误报为已保存。
  await work.evaluate(() => { const ed = window.UE.instances.fixture; ed.fireEvent = () => {}; ed.sync = () => {}; });
  assert.equal((await fillEssayAnswer(work.mainFrame(), 0, '同步失败测试', { overwrite: true })).ok, false);
  await work.evaluate(() => { const ed = window.UE.instances.fixture; ed.sync = () => { document.querySelector('[name="answerEditor0"]').value = ed.body.innerHTML; }; });
  registerKeptPage('fixture', work, { name: '简答测试' });
  mutateState((s) => { s.reviewQueue = [{ id: 'fixture#q1', taskKey: 'fixture', questionIndex: 1, domIndex: 0,
    qtype: 'essay', qtypeRaw: '简答题', textAnswer: draft, aiAnswer: draft, requiresReview: true,
    confidence: 'medium', autoFilled: true, filled: auto, status: 'filled' }]; });
  assert.equal(reviewStats().pending, 1, '已填入简答仍需人工确认');
  const ui = await context.newPage();
  await ui.goto(service.url);
  await setBrowserVisible(true);
  await ui.locator('[data-tab="review"]').click();
  await ui.locator('#reviewBody .qedit textarea').waitFor();
  assert.equal(await ui.locator('#reviewBody .qedit textarea').inputValue(), draft);
  const edited = '用户修改第一段。\n补充第二段；emoji 😀 和 <b>原样标签</b>。';
  await ui.locator('#reviewBody .qedit textarea').fill(edited);
  const response = ui.waitForResponse((r) => r.url().endsWith('/api/review/edit') && r.request().method() === 'POST');
  await ui.getByRole('button', { name: '保存并填入', exact: true }).click();
  assert.equal((await (await response).json()).ok, true);
  assert.equal((await readEssayAnswer(work.mainFrame(), 0)).storedText, edited);
  assert.equal(listReviewItems()[0].textAnswer, edited);
  assert.equal(listReviewItems()[0].editedByHuman, true);
  assert.equal(listReviewItems()[0].filled.verified, true);
  assert.equal(reviewStats().pending, 1);
  await ui.locator('#reviewBody').getByText('已人工填入', { exact: true }).waitFor();
  await ui.screenshot({ path: path.join(data, 'essay-review.png'), fullPage: true });
  // 页面关闭仍保存用户草稿，但必须明确告知尚未填入页面。
  await work.close();
  const failed = await fetch(new URL('/api/review/edit', service.url), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'fixture#q1', textAnswer: '关闭页面后仍保留的新草稿' }) });
  assert.equal((await failed.json()).ok, false);
  assert.equal(listReviewItems()[0].textAnswer, '关闭页面后仍保留的新草稿');
  assert.equal(listReviewItems()[0].filled, null);
  assert.equal(submitCalls, 0);
  console.log('✓ 隐藏窗口简答填写、UEditor 同步、相邻题隔离、已有答案保护、三种备用编辑器、回读失败拦截通过');
  console.log('✓ 待审队列正文编辑 → 本地 API → 实际编辑器 → 状态保存完整链路通过，未触发提交');
  console.log(`截图：${path.join(data, 'essay-review.png')}`);
} finally {
  stopWindowControl();
  await context?.close();
  for (const client of service.wss.clients) client.terminate();
  await new Promise((resolve) => service.wss.close(resolve));
  service.server.closeAllConnections();
  await new Promise((resolve) => service.server.close(resolve));
}
