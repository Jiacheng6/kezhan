import { AppError } from '../errors.js';

/**
 * 会话失效识别。
 *
 * 实测（附录 C-2）：未登录时 welearn 并不是 302，而是返回
 *   <script>if(this==top) location.href='/user/prelogin.aspx?loginret=...'</script>
 * 所以必须按正文特征判断，不能只看状态码。
 */

const LOGIN_WALL_PATTERNS = [/\/user\/prelogin\.aspx/i, /\/Account\/Login/i, /name=["']Account["']/i];

export function isLoginWall(text: string, status: number): boolean {
  if (status === 401 || status === 403) return true;
  const head = text.slice(0, 4000);
  return LOGIN_WALL_PATTERNS.some((re) => re.test(head));
}

/** 解析 JSON；失败统一抛 CONTRACT_CHANGED，并保留响应片段便于排查 */
export function parseJsonOrThrow<T>(text: string, context: string): T {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new AppError({ code: 'CONTRACT_CHANGED', message: `${context}：响应为空` });
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new AppError({
      code: 'CONTRACT_CHANGED',
      message: `${context}：响应不是合法 JSON，前 200 字符为 ${trimmed.slice(0, 200).replace(/\s+/g, ' ')}`,
    });
  }
}

/** 平台写操作成功判定：响应体包含 "ret":0 */
export function isRetOk(text: string): boolean {
  return /"ret"\s*:\s*0/.test(text);
}
