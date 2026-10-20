// Shared, extensible labels. Legacy records without a platform are Chaoxing.
export const PLATFORMS = Object.freeze({
  chaoxing: { name: '学习通', short: '学', color: '#286b54' },
  zhihuishu: { name: '智慧树', short: '知', color: '#365f9d' },
});
export function platformOf(record) {
  return record?.platform || (String(record?.courseId || record?.taskKey || record?.key || '').startsWith('zhihuishu:') ? 'zhihuishu' : 'chaoxing');
}
export function platformInfo(record) {
  const id = typeof record === 'string' ? record : platformOf(record);
  return { id, ...(PLATFORMS[id] || { name: '其他平台', short: '课', color: '#625b82' }) };
}
export function platformBadge(record) {
  const info = platformInfo(record), badge = document.createElement('span');
  badge.className = 'platform-badge'; badge.dataset.platform = info.id;
  badge.textContent = info.name; return badge;
}
