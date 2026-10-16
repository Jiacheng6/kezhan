const clean = text => text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`_]/g, '').trim();
export function summarizeReleaseNotes(notes, maxItems = 3, maxLength = 68) {
  const raw = String(notes || '').trim();
  if (!raw || raw === '此版本未提供更新说明。') return { items: [], hasMore: false };
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const highlightHeading = /^(?:#{1,6}\s*)?(?:本次更新|更新内容|主要变化|新增与修复|what'?s new|highlights?|changes?)\s*[:：]?$/i;
  const start = lines.findIndex(line => highlightHeading.test(clean(line.trim())));
  const entries = []; let versions = 0;
  for (const rawLine of lines.slice(start < 0 ? 0 : start + 1)) {
    const line = rawLine.trim(); if (!line) continue;
    if (/^(?:#{1,6}\s*)?(?:下载|升级|安装|使用说明|注意事项|系统要求|download|install|upgrad)/i.test(line)) break;
    if (/^(?:#{1,6}\s*)?(?:学习通助手\s*)?v?\d+\.\d+\.\d+/i.test(line)) { if (++versions > 1 || entries.length) break; continue; }
    if (/^#{1,6}\s/.test(line) || /^(?:新增|改进|修复|优化|fixes|improvements)[:：]?$/i.test(line)) continue;
    const item = clean(line.replace(/^\s*(?:[-+*•]\s*|\d+[.)、]\s*)/, ''));
    if (!item || /^https?:\/\//i.test(item) || /^[-=|\s]+$/.test(item)) continue;
    if (/^(?:Windows\s*\d|安装版[:：]|免安装版[:：]|发布包不包含|打开软件不会)/i.test(item)) continue;
    if (/^\s{2,}\S/.test(rawLine) && !/^\s*(?:[-+*•]|\d+[.)、])/.test(rawLine) && entries.length) entries[entries.length - 1] += ' ' + item;
    else entries.push(item);
  }
  let shortened = false;
  const items = entries.slice(0, maxItems).map(text => {
    // Split at a sentence/clause boundary; full text remains available below.
    const first = text.split(/[。！？；;]/)[0].trim() || text;
    const points = [...first]; const clipped = points.length > maxLength;
    if (first !== text.replace(/[。！？；;]$/, '') || clipped) shortened = true;
    return clipped ? points.slice(0, maxLength - 1).join('') + '…' : first;
  });
  return { items, hasMore: shortened || entries.length > maxItems || start > 0 || lines.some(line => /^(?:#{1,6}\s*)?(?:下载|升级|安装)/.test(line.trim())) };
}
