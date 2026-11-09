/**
 * P6 弹窗检测链路测试。
 *
 * 说明：当前账号的课程里没有视频内弹窗题，无法做真实端到端验证。
 * 本测试改为**注入模拟弹窗**（按实测的真实 DOM 结构）来验证：
 *   1) detectPopup() 能否正确检出
 *   2) findPopupFrame() 能否定位到题目 frame
 *   3) closePopup() 能否关掉
 *
 * 真实的题目提取/作答/提交逻辑与章节测验共用同一套代码（已在 P4 拿到 100 分验证）。
 */
import { chromium } from 'playwright-core';
import { DEBUG_PORT } from '../../src/config.mjs';
import { detectPopup, findPopupFrame, closePopup, shootPopup } from '../../src/chaoxing/popup.mjs';
import { extractQuestions } from '../../src/chaoxing/quiz.mjs';
import fs from 'node:fs';
import path from 'node:path';

process.on('unhandledRejection', (e) => {
  if (!/No dialog|handleJavaScriptDialog/i.test(String(e?.message || ''))) console.error('[rej]', e?.message);
});

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

const b = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const ctx = b.contexts()[0];
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept().catch(() => {}));

// 打开一个真实小节页（为了拿到和线上一致的宿主环境）
await page.goto('https://i.chaoxing.com/base', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
console.log('宿主页面:', page.url().slice(0, 80));

console.log('\n=== 1) 无弹窗时应判定为不可见 ===');
{
  const r = await detectPopup(page);
  check('detectPopup 返回 visible=false', r.visible === false, JSON.stringify(r));
}

console.log('\n=== 2) 注入模拟弹窗（按实测真实结构）===');
await page.evaluate(() => {
  // 移除旧的
  document.querySelector('#__testMask')?.remove();

  const mask = document.createElement('div');
  mask.id = '__testMask';
  mask.className = 'customMaskDiv';
  mask.style.cssText = 'z-index:10000;display:block;position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,.3)';

  const box = document.createElement('div');
  box.className = 'popDiv2 wid640 customFrameDiv';
  box.style.cssText = 'width:640px;height:480px;background:#fff;margin:40px auto';

  const ifr = document.createElement('iframe');
  ifr.id = 'popFrameId';
  ifr.style.cssText = 'width:640px;height:480px;border:0';
  // 用 srcdoc 造一个同源题目页，模拟真实弹窗内容
  ifr.srcdoc = `<!doctype html><html><body>
    <div class="TiMu newTiMu" data="1">
      <div class="Zy_TItle"><i>1</i><div><span class="newZy_TItle">【单选题】</span><p>模拟题目</p></div></div>
      <ul class="Zy_ulTop">
        <li role="radio" qid="9001" qtype="0" aria-label="A 选项甲"><label><span class="num_option" data="A">A</span></label><a class="after"><p>选项甲</p></a></li>
        <li role="radio" qid="9001" qtype="0" aria-label="B 选项乙"><label><span class="num_option" data="B">B</span></label><a class="after"><p>选项乙</p></a></li>
      </ul>
    </div>
    <a class="btnSubmit">提交</a>
  </body></html>`;

  box.appendChild(ifr);
  mask.appendChild(box);
  document.body.appendChild(mask);
});
await page.waitForTimeout(1200);

console.log('\n=== 3) detectPopup 应检出 ===');
{
  const r = await detectPopup(page);
  check('visible=true', r.visible === true, JSON.stringify(r));
  check('kind=popup', r.kind === 'popup', `kind=${r.kind}`);
}

console.log('\n=== 4) findPopupFrame 应定位到题目 frame ===');
{
  const f = await findPopupFrame(page);
  check('找到 frame', !!f, f ? f.url().slice(0, 70) : '(未找到)');
  if (f) {
    const qs = await extractQuestions(f).catch((e) => [{ error: e.message }]);
    check('能从弹窗 frame 提取到题目', qs.length > 0 && !qs[0].error, `题数=${qs.length}`);
    if (qs.length) {
      const q = qs[0];
      check('题型识别正确', q.qtype === 'single', `qtype=${q.qtype} raw=${q.qtypeRaw}`);
      check('选项字母正确', q.options.map((o) => o.letter).join(',') === 'A,B', q.options.map((o) => `${o.letter}.${o.text}`).join(' | '));
    }
  }
}

console.log('\n=== 5) 弹窗截图 ===');
{
  const dir = path.join(process.cwd(), 'logs', 'answers', 'popup-test');
  const f = await shootPopup(page, dir, 'mock');
  const ok = fs.existsSync(f) && fs.statSync(f).size > 0;
  check('截图生成', ok, `${path.basename(f)} ${ok ? Math.round(fs.statSync(f).size / 1024) + 'KB' : ''}`);
}

console.log('\n=== 6) closePopup 应能关掉 ===');
{
  const r = await closePopup(page);
  check('执行了关闭', r.closed === true, JSON.stringify(r));
  await page.waitForTimeout(800);
  const after = await detectPopup(page);
  check('关闭后不可见', after.visible === false, JSON.stringify(after));
}

// 清理
await page.evaluate(() => document.querySelector('#__testMask')?.remove()).catch(() => {});

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('注：真实弹窗题的作答与提交复用 P4 已验证的同一套代码路径。');

await page.close().catch(() => {});
await b.close();
process.exit(fail ? 1 : 0);
