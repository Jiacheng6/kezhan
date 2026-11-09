/**
 * 统一请求头。
 *
 * 实测要点（见 docs/NODE_CLI_SPEC.md 附录 C-1）：
 * 平台对多数 ajax 接口做来源校验，缺少 Referer 会返回
 * `{"ret":1001,"mess":"request_source_error"}`，且 HTTP 状态仍是 200。
 * 因此 Referer 不是可选项，必须逐接口传入。
 */

export const ACCEPT_HTML =
  'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
export const ACCEPT_JSON = 'application/json, text/javascript, */*; q=0.01';

export interface HeaderInput {
  userAgent: string;
  referer?: string;
  /** 是否附带 Origin（表单 POST 需要） */
  origin?: string;
  contentType?: string;
  accept?: string;
  cookie?: string;
  /** 额外的接口专属头 */
  extra?: Record<string, string>;
}

export function buildHeaders(input: HeaderInput): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': input.userAgent,
    Accept: input.accept ?? ACCEPT_HTML,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'max-age=0',
  };

  if (input.referer) headers['Referer'] = input.referer;
  if (input.origin) headers['Origin'] = input.origin;
  if (input.contentType) headers['Content-Type'] = input.contentType;
  if (input.cookie) headers['Cookie'] = input.cookie;
  if (input.extra) Object.assign(headers, input.extra);

  return headers;
}

/** 由 URL 推导 Origin（协议 + 主机 + 端口） */
export function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.origin;
  } catch {
    return undefined;
  }
}
