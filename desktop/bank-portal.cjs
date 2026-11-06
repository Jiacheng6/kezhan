const { BANK_ORIGIN } = require('./answer-bank.cjs');
const { setTimeout: delay } = require('node:timers/promises');

function isBankAccount(url) {
  try {
    const page = new URL(url);
    return page.origin === BANK_ORIGIN && /^\/user\/?$/.test(page.pathname);
  } catch { return false; }
}

async function bankPortalRejected(contents) {
  if (!contents || contents.isDestroyed() || contents.getURL() !== BANK_ORIGIN + '/') return false;
  return contents.executeJavaScript(`(() => location.origin === ${JSON.stringify(BANK_ORIGIN)} &&
    location.pathname === '/' && [...document.querySelectorAll('.toast-message')].some(
      item => /^(?:参数异常|参数错误|登录失败|授权失败)[。！!]?$/u.test(item.textContent.trim())))()`);
}

async function readBankPortalToken(contents) {
  if (!contents || contents.isDestroyed() || !isBankAccount(contents.getURL())) return '';
  const token = await contents.executeJavaScript(`(() => {
    if (location.origin !== ${JSON.stringify(BANK_ORIGIN)} || !/^\\/user\\/?$/.test(location.pathname)) return '';
    const label = [...document.querySelectorAll('.list li > label')].find(item => item.textContent.trim() === 'Token');
    const field = label?.nextElementSibling;
    return field?.matches('span') ? [...field.childNodes].filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent).join('').trim() : '';
  })()`);
  return !contents.isDestroyed() && isBankAccount(contents.getURL()) && /^[a-z0-9]{32}$/.test(token) ? token : '';
}

async function openBankEdge(profileDir, account) {
  const { findEdge } = await import('../src/browser/launch.mjs');
  const executablePath = findEdge();
  if (!executablePath) throw Error('找不到 Microsoft Edge，可返回向导手动填写令牌。');
  const { chromium } = require('playwright-core');
  const browser = await chromium.launchPersistentContext(profileDir, { executablePath, headless: false, timeout: 15000 });
  try {
    const page = browser.pages()[0] || await browser.newPage();
    await page.goto(account ? BANK_ORIGIN + '/user/' : BANK_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.bringToFront();
    const wechat = page.locator('#wx_login');
    const login = page.locator('.lbt').filter({hasText:/登录|用户中心/}).first();
    if (page.url() === BANK_ORIGIN + '/') {
      if (!await wechat.isVisible() && await login.isVisible()) await login.click({timeout:3500}).catch(() => {});
      if (await wechat.isVisible()) await wechat.click({timeout:3500}).catch(() => {});
    }
    return { browser, page };
  } catch {
    await browser.close().catch(() => {});
    throw Error('Edge 未能打开题库官网，请检查网络后重试。');
  }
}

async function waitBankEdgeToken(page, isCurrent) {
  const contents = {
    isDestroyed: () => page.isClosed(),
    getURL: () => page.url(),
    executeJavaScript: script => page.evaluate(script),
  };
  const deadline = Date.now() + 5 * 60_000;
  while (isCurrent() && !page.isClosed() && Date.now() < deadline) {
    const token = await readBankPortalToken(contents).catch(() => '');
    if (token) return token;
    await delay(700, undefined, { ref: false });
  }
  return '';
}

module.exports = { readBankPortalToken, bankPortalRejected, openBankEdge, waitBankEdgeToken };
