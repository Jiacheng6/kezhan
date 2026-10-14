/**
 * 浏览器接管层。
 *
 * 职责：
 *  1. 找到 Edge 可执行文件
 *  2. 用【专用 Profile + 调试端口】拉起 Edge（若尚未拉起）
 *  3. Playwright connectOverCDP 接管
 *  4. 提供「取/建 页面」的便捷方法
 *
 * 关键约束：运行中的 Edge 无法追加启动参数，所以必须另起实例 + 专用 Profile。
 * 好处：你日常那个 Edge 完全不受影响，可以边刷课边上網。
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { chromium } from 'playwright-core';
import { PATHS, DEBUG_PORT, EDGE_FLAGS, TARGETS } from '../config.mjs';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
let ownedProcess = null;

/** 仅在启动尚未完成或 CDP 已断开时，清理本进程自己拉起的浏览器。 */
export async function stopOwnedEdge() {
  const child = ownedProcess;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 4000 }, () => resolve());
  });
}

export function findEdge() {
  for (const p of EDGE_CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/** 探测某个 TCP 端口是否已有服务在监听 */
export function isPortOpen(port, host = '127.0.0.1', timeoutMs = 700) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

/** CDP 端点是否真的可用（不只是端口开着） */
async function cdpAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function waitForCdp(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const info = await cdpAlive();
    if (info) return info;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

/**
 * 确保有一个"带调试端口、用专用 Profile"的 Edge 在跑。
 * @returns {{edgePath:string, launched:boolean, version:any}}
 */
export async function ensureEdge(log = () => {}) {
  const edgePath = findEdge();
  if (!edgePath) {
    throw new Error(
      '未找到 msedge.exe。请确认已安装 Microsoft Edge，或手动修改 src/config.mjs 里的路径。',
    );
  }

  let info = await cdpAlive();
  if (info) {
    log(`调试端口 ${DEBUG_PORT} 已在监听，直接接管（无需重开 Edge）`, 'info');
    return { edgePath, launched: false, version: info };
  }

  // 端口被别的程序占用（但不是 CDP）
  if (await isPortOpen(DEBUG_PORT)) {
    throw new Error(
      `端口 ${DEBUG_PORT} 被其他程序占用，但不是 Edge 调试端口。请释放该端口，或修改 src/config.mjs 的 DEBUG_PORT。`,
    );
  }

  fs.mkdirSync(PATHS.edgeProfile, { recursive: true });
  log(`正在用专用配置拉起 Edge…`, 'info');
  log(`  配置目录: ${PATHS.edgeProfile}`, 'dim');
  log(`  调试端口: ${DEBUG_PORT}`, 'dim');

  /*
   * 启动 URL 用学习通首页，**不再用 about:blank**。
   *
   * 实测反馈：以前这里写 `about:blank`，而没人去关它 ——
   * 于是每次 Edge 从"完全关闭"状态被拉起，都会稳定多一个空白页。
   * 直接用目标页还能省掉一次导航。
   */
  const child = spawn(edgePath, [...EDGE_FLAGS, TARGETS.chaoxingHome], {
    detached: true,
    stdio: 'ignore',
  });
  ownedProcess = child;
  const spawnFailed = new Promise((resolve, reject) => {
    child.once('error', (err) => reject(new Error(`无法启动 Edge：${err.message}`)));
  });
  child.unref();

  info = await Promise.race([waitForCdp(30000), spawnFailed]);
  if (!info) {
    throw new Error(
      `Edge 已启动，但 ${DEBUG_PORT} 端口在 30 秒内没有就绪。\n` +
        `常见原因：\n` +
        `  1) 另一个 Edge 正在使用同一个 edge-profile 目录 → 请先关掉它\n` +
        `  2) 安全软件拦截了 --remote-debugging-port\n` +
        `  3) Edge 弹了"首个运行体验"窗口挡住了初始化`,
    );
  }

  log(`Edge 就绪：${info.Browser}`, 'ok');
  return { edgePath, launched: true, version: info };
}

/** 接管，返回 browser */
export async function connect() {
  return chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
}

export function contextOf(browser) {
  return browser.contexts()[0];
}

/** 按 URL 片段找页面 */
export function findPage(context, urlPart) {
  return context.pages().find((p) => p.url().includes(urlPart)) || null;
}

/**
 * 等一个匹配 urlPart 的页面出现（用于 Edge 恢复会话 / 启动页还在导航中的情况）。
 *
 * 为什么要等：Edge 带 `--restore-last-session` 时标签页是**异步恢复**的，
 * 而启动 URL 也要先经历 about:blank 再提交。不等就会出现"以为没有 → 新建一个"
 * —— 结果就是**同一个页面开两个**（实测冷启动后出现两个学习通个人空间页）。
 *
 * @returns {Promise<import('playwright-core').Page|null>}
 */
export async function waitForPage(context, urlPart, timeoutMs = 6000) {
  const t0 = Date.now();
  for (;;) {
    const p = findPage(context, urlPart);
    if (p) return p;
    if (Date.now() - t0 >= timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** 等多个 URL 片段里任意一个出现 */
export async function waitForAnyPage(context, urlParts, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    for (const part of urlParts) {
      const p = findPage(context, part);
      if (p) return p;
    }
    if (Date.now() - t0 >= timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * 取一个页面：优先复用匹配 urlPart 的已有页面，否则新建。
 * 会把页面带到前台（学习通的视频判定与节流都和前台相关）。
 */
export async function getPage(context, urlPart, { create = true, navigate = null } = {}) {
  let page = findPage(context, urlPart);
  if (!page && create) {
    page = await context.newPage();
  }
  if (!page) return null;

  if (navigate && !page.url().includes(urlPart)) {
    await page.goto(navigate, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }
  return page;
}

/** 把页面带到前台（失败不抛） */
export async function bringToFront(page) {
  try {
    await page.bringToFront();
  } catch {
    /* 忽略 */
  }
}

export { TARGETS };
