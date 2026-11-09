/**
 * JavaScript 旧版 escape() 的等价实现。
 *
 * 平台的 [INTERACTIONINFO] 串用的是这个编码，不是 encodeURIComponent：
 * - 字母数字与 `@*-_+./` 原样保留
 * - 码元 < 256 → `%XX`（两位大写十六进制）
 * - 其余 → `%uXXXX`（四位大写）
 *
 * 注意按 **UTF-16 码元** 遍历（charCodeAt），而不是按码点：
 * 真正的 escape() 会把 emoji 拆成代理对，输出 `%uD83D%uDE00`，
 * 按码点遍历会得到 `%u1F600`，与浏览器行为不一致。
 */
const SAFE = new Set('@*-_+./');

export function jsEscape(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const ch = input[i] as string;

    const isAlnum =
      (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

    if (isAlnum || SAFE.has(ch)) {
      out += ch;
    } else if (code < 256) {
      out += `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
    } else {
      out += `%u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }
  return out;
}
