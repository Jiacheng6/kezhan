/**
 * 用「粘贴」方式上传图片到千问（替代文件选择器）。
 *
 * 动机：走 添加附件→上传图片→filechooser 这条路会在上传后盖一个
 * z-[9999] 全屏层，拦截所有指针事件，导致输入框和发送按钮点不到。
 * 而 Ctrl+V 粘贴图片是聊天框的常规路径，不经过那个预览流程。
 *
 * 实现：Playwright 的 DataTransfer 注入 —— 把 PNG 以 File 形式塞进 paste 事件。
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
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(400);

const imgPath = pickImage();
const b64 = fs.readFileSync(imgPath).toString('base64');
const name = path.basename(imgPath);
console.log('图片:', name, `(${Math.round(b64.length / 1024)} KB base64)`);

/* ---------- 1) 聚焦输入框 ---------- */
console.log('\n① 聚焦输入框…');
const ed = page.locator('[contenteditable="true"]').first();
await ed.click({ timeout: 10000, force: true });
await page.waitForTimeout(500);

/* ---------- 2) 注入 paste 事件携带图片 ---------- */
console.log('② 注入粘贴事件（携带图片 File）…');
const pasteResult = await page.evaluate(
  async ({ b64, name }) => {
    const ed = document.querySelector('[contenteditable="true"]');
    if (!ed) return { ok: false, error: 'no editor' };

    // base64 → File
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], name, { type: 'image/png' });

    const dt = new DataTransfer();
    dt.items.add(file);

    ed.focus();
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    // 某些实现读 clipboardData.files，某些读 items，都塞上
    try {
      Object.defineProperty(ev, 'clipboardData', { value: dt });
    } catch (e) {}
    ed.dispatchEvent(ev);

    return { ok: true, fileSize: file.size, type: file.type, dtFiles: dt.files.length };
  },
  { b64, name },
);
console.log('   注入结果:', JSON.stringify(pasteResult));

/* ---------- 3) 等缩略图出现 ---------- */
console.log('③ 等缩略图出现…');
let ready = false;
for (let i = 0; i < 30; i += 1) {
  await page.waitForTimeout(1000);
  const st = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img')).filter((e) => {
      const s = e.getAttribute('src') || '';
      return /workspace-zb-cdn|blob:|data:image/.test(s) && e.naturalWidth > 0;
    });
    return { count: imgs.length, srcs: imgs.map((e) => (e.getAttribute('src') || '').slice(0, 50)) };
  });
  if (st.count) {
    ready = true;
    console.log(`   ✓ ${i + 1} 秒后出现缩略图 × ${st.count}`);
    for (const s of st.srcs) console.log(`        ${s}`);
    break;
  }
}

if (!ready) {
  console.log('   ✗ 粘贴未生效（缩略图未出现）');
  await page.screenshot({ path: path.join(PATHS.root, 'data', 'probe-out', 'qianwen-paste-fail.png') }).catch(() => {});
  await b.close();
  process.exit(1);
}

/* ---------- 4) 检查是否还有全屏遮罩拦截点击 ---------- */
const overlay = await page.evaluate(() => {
  const ed2 = document.querySelector('[contenteditable="true"]');
  const r = ed2.getBoundingClientRect();
  // 取输入框中心点，看点下去命中的是谁
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return {
    editorRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    hitTag: hit?.tagName,
    hitCls: hit ? String(hit.className).slice(0, 80) : null,
    hitIsEditorOrChild: hit ? (ed2 === hit || ed2.contains(hit)) : false,
  };
});
console.log('\n④ 输入框命中测试:', JSON.stringify(overlay, null, 2));

/* ---------- 5) 填提问并发送 ---------- */
console.log('\n⑤ 填提问…');
await ed.click({ timeout: 8000, force: true });
await page.keyboard.type('请给出这道题的答案。只回答答案本身：选择题回答选项字母（多选题形如 AB），判断题回答「对」或「错」。不要解释。', { delay: 10 });
await page.waitForTimeout(800);

const readInput = () =>
  page.evaluate(() => {
    const e = document.querySelector('[contenteditable="true"]');
    const t = (e?.innerText || '').trim();
    const ph = (e?.getAttribute('data-placeholder') || '').trim();
    return { text: t, isPlaceholder: !!ph && t === ph };
  });
const inp = await readInput();
console.log(`   输入内容: "${inp.text.slice(0, 70)}" (占位符=${inp.isPlaceholder})`);

console.log('\n⑥ 发送…');
const sendBtn = page.locator('button[aria-label="发送消息"]').first();
console.log('   发送按钮禁用:', await sendBtn.isDisabled().catch(() => '?'));
await sendBtn.click({ timeout: 10000, force: true });
console.log('   已发送');

/* ---------- 7) 读回答 ---------- */
console.log('\n⑦ 等回答…');
const t0 = Date.now();
let lastLen = -1;
let stable = 0;
let answer = '';
for (;;) {
  await page.waitForTimeout(2000);
  const st = await page.evaluate(() => {
    const wrap = document.querySelector('.chat-answers-card-wrap');
    const txt = wrap ? (wrap.innerText || '').trim() : '';
    const generating = Array.from(document.querySelectorAll('button')).some((x) =>
      /停止|stop/i.test((x.getAttribute('aria-label') || '') + (x.textContent || '')),
    ) || !!document.querySelector('[class*="loading"], [class*="generating"], [class*="typing"]');
    return { len: txt.length, txt, generating };
  });
  const el = Math.round((Date.now() - t0) / 1000);
  console.log(`  [${String(el).padStart(3)}s] 回答长度=${String(st.len).padStart(4)} 生成中=${st.generating ? '是' : '否'}`);
  if (st.len > 0) answer = st.txt;

  if (st.len > 0 && st.len === lastLen) stable += 1;
  else stable = 0;
  lastLen = st.len;

  if (st.len > 0 && stable >= 2 && !st.generating) break;
  if (Date.now() - t0 > 150000) { console.log('  超时'); break; }
}

console.log('\n=== 千问回答 ===');
console.log(answer ? answer.slice(0, 800) : '(空)');

await page.screenshot({ path: path.join(PATHS.root, 'data', 'probe-out', 'qianwen-paste-reply.png') }).catch(() => {});
console.log('\n截图: data/probe-out/qianwen-paste-reply.png');

await b.close();
