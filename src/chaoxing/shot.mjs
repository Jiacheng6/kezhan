/**
 * 区域截图（题目 / 弹窗 / 讨论题面）—— 带**三级降级**与显式超时。
 *
 * 为什么需要（用户实测反馈 2026-11-01）：
 *   日志里反复出现 `elementHandle.screenshot: Timeout 30000ms exceeded`，
 *   卡在 "attempting scroll into view action / waiting for element to be stable"。
 *   原因是裸调 `element.screenshot({path})` 用的是 Playwright 默认 30 秒超时，
 *   而它要求"元素稳定"（连续两帧盒子不变）—— 在内置网页被隐藏、
 *   页面不出帧、或元素有持续动画时，这个条件**永远不会满足**，
 *   于是每题白等 30 秒，最后判失败；3 次就触发"全局暂停"。
 *
 * 现在的顺序（能过就过，过不了就降级，最后一定给出结果或明确错误）：
 *   软件内模式：native 成像 → CDP 裁剪 → 整页
 *   浏览器模式：元素截图（8 秒）→ 页面裁剪（8 秒）→ 整页（8 秒）
 */
import fs from 'node:fs';
import { embedded, captureEmbeddedPage } from '../browser/embedded.mjs';

/**
 * 纯函数：给一次截图挑选尝试顺序（可离线测试）。
 * @param {{embeddedMode?:boolean, hasBox?:boolean}} o
 * @returns {string[]}
 */
export function screenshotPlan({ embeddedMode = false, hasBox = false } = {}) {
  if (embeddedMode) return hasBox ? ['embedded', 'cdp', 'page'] : ['page'];
  return hasBox ? ['element', 'clip', 'page'] : ['page'];
}

/** 把盒子裁进视口，避免 clip 越界被 Chromium 直接拒绝 */
export function clampClip(box, viewport) {
  if (!box) return null;
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const width = Math.min(Math.ceil(box.width), Math.max(1, (viewport?.width || 0) - x));
  const height = Math.min(Math.ceil(box.height), Math.max(1, (viewport?.height || 0) - y));
  if (width < 8 || height < 8) return null;
  return { x, y, width, height };
}

/**
 * 截图；失败自动降级。
 *
 * @param {import('playwright-core').Page} page
 * @param {{boundingBox?:Function, screenshot?:Function}} locator 目标元素（可为 null → 整页）
 * @param {string} file 输出路径
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] 每一步的超时（默认 8000，远低于旧的 30000）
 * @param {boolean} [opts.preferEmbedded] 是否用软件内 native 成像
 * @returns {Promise<{file:string, via:string}>}
 */
export async function captureArea(page, locator, file, { timeoutMs = 8000, preferEmbedded = embedded } = {}) {
  let box = null;
  if (locator?.boundingBox) {
    box = await locator
      .boundingBox({ timeout: Math.min(3000, timeoutMs) })
      .catch(() => null);
  }
  const plan = screenshotPlan({ embeddedMode: !!preferEmbedded, hasBox: !!box });
  const problems = [];

  for (const step of plan) {
    try {
      if (step === 'embedded') {
        const viewport = await page
          .evaluate(() => ({ width: innerWidth, height: innerHeight }))
          .catch(() => ({ width: 0, height: 0 }));
        const rect = clampClip(box, viewport);
        if (!rect) throw new Error('题面不在可视区域内');
        const shot = await captureEmbeddedPage(page, rect);
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        return { file, via: step };
      }
      if (step === 'element') {
        await locator.screenshot({ path: file, timeout: timeoutMs });
        return { file, via: step };
      }
      if (step === 'clip' || step === 'cdp') {
        const viewport = await page
          .evaluate(() => ({ width: innerWidth, height: innerHeight }))
          .catch(() => ({ width: 0, height: 0 }));
        const rect = clampClip(box, viewport);
        if (!rect) throw new Error('裁剪区域无效');
        if (step === 'clip') {
          await page.screenshot({ path: file, clip: rect, timeout: timeoutMs });
          return { file, via: step };
        }
        // CDP：不依赖"元素稳定"，也不要求窗口可见
        const session = await page.context().newCDPSession(page);
        try {
          await session.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
          await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
          const metrics = await session.send('Page.getLayoutMetrics');
          const vp = metrics.cssLayoutViewport || metrics.layoutViewport;
          const shot = await session.send('Page.captureScreenshot', {
            format: 'png',
            fromSurface: true,
            captureBeyondViewport: true,
            clip: { x: rect.x + vp.pageX, y: rect.y + vp.pageY, width: rect.width, height: rect.height, scale: 1 },
          });
          fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
          return { file, via: step };
        } finally {
          await session.detach().catch(() => {});
        }
      }
      // 最后一级：整页（一定截得到，只是可能包含多余区域）
      await page.screenshot({ path: file, timeout: timeoutMs });
      return { file, via: 'page' };
    } catch (error) {
      problems.push(`${step}：${String(error.message || error).slice(0, 80)}`);
    }
  }

  throw Object.assign(
    new Error(`截图失败（已尝试 ${plan.join(' → ')}）：${problems.join('；').slice(0, 240)}`),
    { captureStage: '截图' },
  );
}
