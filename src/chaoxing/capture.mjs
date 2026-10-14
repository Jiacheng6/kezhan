/**
 * 弹窗题现场取证（诊断用）。
 *
 * 功能：记录视频暂停和弹窗题相关的结构，便于定位检测差异。
 * 页面可能已经出现题目，但旧版 popup.mjs 的 detectPopup() 未识别。
 * 说明真实弹窗不是 .customMaskDiv（我们当初从那台"老版 cards 页"里挖出来的结构）。
 *
 * 所以这里不预设结构：暂停发生时把**所有 frame** 里"像弹窗的东西"全抓回来
 * （可见的 fixed/absolute 大块 + 类名/id 含 pop|mask|ti|ques|dialog 的元素），
 * 外加整页截图，事后照着真实 DOM 改检测逻辑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.mjs';
import { log } from '../logbus.mjs';

const SUSPECT = /pop|mask|ti_?mu|ques|dialog|modal|overlay|answer|题|弹/i;

export function captureDir() {
  const dir = path.join(PATHS.probeOut, 'popup-capture');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 抓一次现场，返回写出的文件路径 */
export async function capturePause(page, tag = 'pause') {
  const dir = captureDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(dir, `${tag}-${stamp}`);
  const out = { shot: null, frames: [], suspects: [], notes: [] };

  // 1) 整页截图（弹窗通常盖在视频上，截图最直观）
  try {
    await page.screenshot({ path: `${base}.png`, timeout: 12000 });
    out.shot = `${base}.png`;
  } catch (e) {
    out.notes.push('截图失败: ' + e.message);
  }

  // 2) 逐 frame 找可疑元素
  for (const f of page.frames()) {
    const u = f.url();
    if (!u || u === 'about:blank') continue;
    const r = await f
      .evaluate((suspectSrc) => {
        const re = new RegExp(suspectSrc, 'i');
        const vis = (el) => {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return null;
          const b = el.getBoundingClientRect();
          if (b.width < 80 || b.height < 50) return null;
          return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top), left: Math.round(b.left) };
        };
        const hits = [];
        for (const el of Array.from(document.querySelectorAll('body *'))) {
          const cls = String(el.className || '');
          const id = String(el.id || '');
          const cs = getComputedStyle(el);
          const box = vis(el);
          if (!box) continue;
          const looksFixed = cs.position === 'fixed' || cs.position === 'absolute';
          const nameHit = re.test(cls) || re.test(id);
          const bigOverlay = looksFixed && box.w > 300 && box.h > 200 && Number(cs.zIndex || 0) >= 100;
          if (!nameHit && !bigOverlay) continue;
          hits.push({
            tag: el.tagName,
            id: id.slice(0, 60),
            cls: cls.slice(0, 120),
            pos: cs.position,
            z: cs.zIndex,
            display: cs.display,
            box,
            text: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
            html: el.outerHTML.slice(0, 400),
          });
          if (hits.length > 40) break;
        }
        return {
          hidden: document.hidden,
          hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
          pops: window.__xxtPops || null,
          pauseLog: window.__xxtPauseLog || null,
          customPop: typeof window.showCustomPop,
          hits,
          bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
        };
      }, SUSPECT)
      .catch((e) => ({ error: e.message }));

    out.frames.push({ url: u.slice(0, 140), ...r });
    for (const h of r.hits || []) out.suspects.push({ frame: u.slice(0, 100), ...h });
  }

  fs.writeFileSync(`${base}.json`, JSON.stringify(out, null, 2), 'utf8');
  log(`    [取证] 已抓现场 → ${path.basename(base)}.png / .json（可疑元素 ${out.suspects.length} 个）`, 'warn');
  return base;
}
