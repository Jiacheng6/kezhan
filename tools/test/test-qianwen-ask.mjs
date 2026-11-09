/**
 * 验证千问回答链路：上传图片 → 点它给的建议提问 → 发送 → 读回答。
 *
 * 上一轮失败的可疑点已在本次规避：
 *   1) 明确等图片缩略图出现（img[src^="https://workspace-zb-cdn"]）再继续
 *   2) 不再手打 prompt，而是点千问自己给出的建议（等价真实用户操作）
 *   3) 发送后持续观察，并把「生成中」判据放宽（多候选）
 */
import { chromium } from 'playwright-core';
import { DEBUG_PORT, PATHS } from '../../src/config.mjs';
import fs from 'node:fs';
import path from 'node:path';

process.on('unhandledRejection', (e) => {
  if (!/No dialog|handleJavaScriptDialog/i.test(String(e?.message || ''))) console.error('[rej]', e?.message);
});

function pickImage() {
  const dir = path.join(PATHS.answers, 'test');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return path.join(dir, files[0].f);
}

const b = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const ctx = b.contexts()[0];
const page = ctx.pages().find((p) => /qianwen|tongyi/i.test(p.url()));
await page.bringToFront();

// 新建对话
const nc = page.locator('button, a, div').filter({ hasText: /^新对话$/ }).first();
if (await nc.count()) {
  await nc.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2500);
}
for (let i = 0; i < 3; i += 1) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(250);
}

const img = pickImage();
console.log('图片:', path.basename(img));

/* ---------- 1) 上传 ---------- */
console.log('\n① 上传…');
await page.locator('button[aria-label="添加附件"]').first().click({ timeout: 15000 });
await page.waitForTimeout(1200);
const chooserP = page.waitForEvent('filechooser', { timeout: 12000 }).catch(() => null);
await page.locator('[role="menuitem"]', { hasText: '上传图片' }).first().click({ timeout: 10000 });
const chooser = await chooserP;
if (!chooser) { console.error('未捕获 filechooser'); process.exit(1); }
await chooser.setFiles(img);

/* ---------- 2) 等缩略图就绪 ---------- */
console.log('② 等图片就绪（出现 workspace CDN 缩略图）…');
let imgReady = false;
for (let i = 0; i < 30; i += 1) {
  await page.waitForTimeout(1000);
  const ready = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    return imgs.some((e) => /workspace-zb-cdn\.qianwen\.com/.test(e.getAttribute('src') || '') && e.naturalWidth > 0);
  });
  if (ready) { imgReady = true; console.log(`   ✓ ${i + 1} 秒后就绪`); break; }
}
if (!imgReady) { console.error('   ✗ 图片未就绪'); process.exit(1); }

/*
 * 关键一步：关掉图片预览浮层。
 *
 * 实测：上传完成后千问会盖一个全屏遮罩
 *   <div class="fixed left-0 top-0 z-[9999] ... bg-white-80 backdrop-blur-[20px]">
 * 它会拦截所有指针事件（Playwright 报 "subtree intercepts pointer events"），
 * 导致后续对输入框/发送按钮的点击全部落空 —— 这正是之前"消息发出去了但没带图、
 * 千问也不回答"的根因。
 */
console.log('   关闭图片预览浮层…');
for (let i = 0; i < 8; i += 1) {
  const state = await page.evaluate(() => {
    const overlays = Array.from(document.querySelectorAll('div')).filter(
      (d) => /fixed.*inset|fixed left-0 top-0/.test(String(d.className)) && /z-\[9|z-50|z-\[1/.test(String(d.className)),
    );
    const blocking = overlays.filter((d) => {
      const r = d.getBoundingClientRect();
      return r.width > window.innerWidth * 0.8 && r.height > window.innerHeight * 0.8;
    });
    return { count: blocking.length, classes: blocking.map((d) => String(d.className).slice(0, 80)) };
  });
  if (!state.count) {
    console.log(`   ✓ 浮层已消失（第 ${i} 轮）`);
    break;
  }
  // 先找浮层里的关闭按钮
  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    const close = btns.find((b) => /关闭|close|×/i.test((b.getAttribute('aria-label') || '') + (b.textContent || '')));
    if (close) { close.click(); return 'clicked-close'; }
    return 'none';
  });
  if (clicked === 'none') await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(700);
}
const overlayLeft = await page.evaluate(
  () =>
    Array.from(document.querySelectorAll('div')).filter((d) => {
      const cls = String(d.className);
      if (!/fixed left-0 top-0/.test(cls)) return false;
      const r = d.getBoundingClientRect();
      return r.width > window.innerWidth * 0.8 && r.height > window.innerHeight * 0.8;
    }).length,
);
console.log(`   剩余全屏浮层: ${overlayLeft}`);

// 再等建议出现（千问识别图片后会给建议提问）
console.log('   等建议提问出现…');
let suggestion = null;
for (let i = 0; i < 15; i += 1) {
  const s = await page.evaluate(() => {
    const cands = ['解答这道判断题', '解答这道题', '解答这道多选题'];
    for (const c of cands) {
      const el = Array.from(document.querySelectorAll('*')).find(
        (e) => e.children.length === 0 && (e.textContent || '').trim() === c,
      );
      if (el) return c;
    }
    // 兜底：找输入区附近像建议的短文本
    const ed = document.querySelector('[contenteditable="true"]');
    let box = ed;
    for (let k = 0; k < 6 && box; k += 1) box = box.parentElement;
    const found = Array.from((box || document.body).querySelectorAll('*'))
      .filter((e) => e.children.length === 0)
      .map((e) => (e.textContent || '').trim())
      .find((t) => t.length >= 4 && t.length <= 20 && /解答|这题|分析|求解/.test(t));
    return found || null;
  });
  if (s) { suggestion = s; console.log(`   ✓ 建议: "${s}"`); break; }
  await page.waitForTimeout(700);
}

/* ---------- 3) 填提问 ---------- */
console.log('\n③ 填写提问…');

/** 读输入框的真实内容（注意：空时 innerText 会回落到 placeholder，必须排除） */
const readInput = () =>
  page.evaluate(() => {
    const ed = document.querySelector('[contenteditable="true"]');
    if (!ed) return { text: '', isPlaceholder: true };
    const t = (ed.innerText || '').trim();
    const ph = (ed.getAttribute('data-placeholder') || ed.getAttribute('placeholder') || '').trim();
    // 内容等于 placeholder 文本 → 视为空
    return { text: t, isPlaceholder: !!ph && t === ph, placeholder: ph };
  });

const before = await readInput();
console.log(`   输入前: "${before.text}" (占位符=${before.isPlaceholder})`);

// 点建议（用 Playwright 真实点击，先在页面上定位它的可点祖先）
let clickedSuggestion = false;
if (suggestion) {
  const cand = page.locator(`text="${suggestion}"`).first();
  const n = await cand.count().catch(() => 0);
  console.log(`   建议元素数量: ${n}`);
  if (n) {
    // 试着点它自身和最多 3 层祖先，看哪个能真的填进输入框
    for (let up = 0; up < 4 && !clickedSuggestion; up += 1) {
      const target = up === 0 ? cand : cand.locator(`xpath=ancestor::*[${up}]`).first();
      await target.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(900);
      const now = await readInput();
      if (now.text && !now.isPlaceholder) {
        clickedSuggestion = true;
        console.log(`   ✓ 点了第 ${up} 层祖先后输入框被填: "${now.text.slice(0, 60)}"`);
      }
    }
  }
}

if (!clickedSuggestion) {
  console.log('   建议未能填入，改为直接输入文本…');
  const ed = page.locator('[contenteditable="true"]').first();
  await ed.click({ timeout: 8000 });
  // 清空
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Delete').catch(() => {});
  await page.keyboard.type('请给出这道题的答案。只回答答案本身：选择题回答选项字母（多选题形如 AB），判断题回答「对」或「错」。不要解释。', { delay: 10 });
  await page.waitForTimeout(800);
}

const filled = await readInput();
console.log(`   最终输入: "${filled.text.slice(0, 80)}" (占位符=${filled.isPlaceholder})`);

if (!filled.text || filled.isPlaceholder) {
  console.error('   ✗ 输入框仍为空，放弃');
  await page.screenshot({ path: path.join(PATHS.root, 'data', 'probe-out', 'qianwen-noinput.png') }).catch(() => {});
  await b.close();
  process.exit(1);
}

/* ---------- 4) 发送 ---------- */
console.log('\n④ 发送…');
const sendBtn = page.locator('button[aria-label="发送消息"]').first();
const disabled = await sendBtn.isDisabled().catch(() => true);
console.log('   发送按钮禁用:', disabled);
if (disabled) { console.error('   ✗ 发送按钮不可用'); process.exit(1); }
await sendBtn.click({ timeout: 10000 });
console.log('   已发送');

/* ---------- 5) 读回答 ---------- */
console.log('\n⑤ 等待并读取回答…');
const READ = () => {
  const wrap = document.querySelector('.chat-answers-card-wrap');
  const wrapText = wrap ? (wrap.innerText || '').trim() : '';
  // 生成中判据：多种可能
  const stop = Array.from(document.querySelectorAll('button')).some((x) =>
    /停止|stop|暂停|pause/i.test((x.getAttribute('aria-label') || '') + (x.textContent || '')),
  );
  const dots = !!document.querySelector('[class*="loading"], [class*="typing"], [class*="generating"], [class*="blink"]');
  const lastMsg = document.querySelector('.last-message-item');
  return {
    wrapText,
    wrapLen: wrapText.length,
    generating: stop || dots,
    lastMsgLen: lastMsg ? (lastMsg.innerText || '').trim().length : null,
    tail: (document.body.innerText || '').replace(/\s+/g, ' ').slice(-200),
  };
};

const t0 = Date.now();
let lastLen = -1;
let stable = 0;
let answer = '';
for (;;) {
  await page.waitForTimeout(2000);
  const st = await page.evaluate(READ);
  const el = Math.round((Date.now() - t0) / 1000);
  console.log(`  [${String(el).padStart(3)}s] 回答长度=${String(st.wrapLen).padStart(4)} 生成中=${st.generating ? '是' : '否'}`);
  if (st.wrapLen > 0) answer = st.wrapText;

  if (st.wrapLen > 0 && st.wrapLen === lastLen) stable += 1;
  else stable = 0;
  lastLen = st.wrapLen;

  if (st.wrapLen > 0 && stable >= 2 && !st.generating) break;
  if (Date.now() - t0 > 150000) { console.log('  超时'); break; }
}

console.log('\n=== 回答 ===');
console.log(answer ? answer.slice(0, 600) : '(空)');

await page.screenshot({ path: path.join(PATHS.root, 'data', 'probe-out', 'qianwen-reply.png') }).catch(() => {});
console.log('\n截图: data/probe-out/qianwen-reply.png');

await b.close();
