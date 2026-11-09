/**
 * SCORM 时间解析。
 *
 * 平台在不同接口里给的时间格式不一致：可能是纯秒数 "372"、
 * 也可能是 "00:06:12"，个别课件会给 ISO8601 的 "PT6M12S"。
 * 统一解析成秒，失败按 0 处理（宁可少算，也不要抛错打断整节）。
 */

const CLOCK_RE = /^(\d+):([0-5]?\d):([0-5]?\d)$/;
const ISO_RE = /^P(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;

export function parseScormTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof value !== 'string') return 0;

  const text = value.trim();
  if (text.length === 0) return 0;

  if (/^\d+$/.test(text)) return Number(text);

  const clock = CLOCK_RE.exec(text);
  if (clock?.[1] && clock[2] !== undefined && clock[3] !== undefined) {
    return Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  }

  const iso = ISO_RE.exec(text);
  if (iso) {
    const h = Number(iso[1] ?? 0);
    const m = Number(iso[2] ?? 0);
    const s = Number(iso[3] ?? 0);
    return Math.round(h * 3600 + m * 60 + s);
  }

  return 0;
}
