/**
 * 登录态探针。
 * P0 只需要判断"能不能访问到学习通个人空间"，不解析具体身份。
 * 更细的身份信息（cpi / 姓名）留到 P1 侦察时抓。
 */
import { TARGETS } from '../config.mjs';

const LOGGED_OUT_HINTS = [
  '/passport2/login',
  'passport2.chaoxing.com/login',
  'authserver',
  'login?',
];

export async function probeLogin(page) {
  if (!page) return { loggedIn: false, reason: '没有页面句柄' };

  const url = page.url();
  let title = '';
  try {
    title = await page.title();
  } catch {
    /* 忽略 */
  }

  const looksLoggedOut =
    LOGGED_OUT_HINTS.some((h) => url.includes(h)) ||
    /登录|登陆/.test(title);

  // 再看 DOM 里有没有明确的登录输入框
  let hasLoginForm = false;
  try {
    hasLoginForm = await page
      .locator('input[type="password"], #phone, input[name="uname"]')
      .first()
      .isVisible({ timeout: 1200 })
      .catch(() => false);
  } catch {
    /* 忽略 */
  }

  const loggedIn = !looksLoggedOut && !hasLoginForm;

  return {
    loggedIn,
    url,
    title,
    reason: loggedIn
      ? '已进入学习通'
      : hasLoginForm
        ? '页面出现登录表单，需要登录'
        : '疑似被重定向到登录页',
  };
}

export async function gotoChaoxingHome(page) {
  await page.goto(TARGETS.chaoxingHome, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 给它一点时间完成跳转/渲染
  await page.waitForTimeout(2500);
  return probeLogin(page);
}
