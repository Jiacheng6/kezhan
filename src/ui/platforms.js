// Shared, extensible labels. Legacy records without a platform are Chaoxing.
export const PLATFORMS = Object.freeze({
  chaoxing: { name: '学习通', short: '学', color: '#286b54' },
  zhihuishu: { name: '智慧树', short: '知', color: '#365f9d' },
  ucampus: { name: 'U校园', short: 'U', color: '#c0392b' },
  welearn: { name: 'WeLearn', short: 'W', color: '#875c9d' },
});
export const PLATFORM_DESCRIPTIONS=Object.freeze({chaoxing:'视频、作业与课程任务',zhihuishu:'视频学习与章节测验',ucampus:'英语课程与课内练习',welearn:'课件解析，无需 AI'});
export const enabledPlatformIds=(settings={})=>Object.keys(PLATFORMS).filter(id=>settings?.platforms?.[id]!==false);
export const platformEnabled=(settings,id)=>enabledPlatformIds(settings).includes(id);
export const enabledCourses=(courses=[],settings={})=>courses.filter(c=>platformEnabled(settings,platformOf(c)));
export function platformBusy(status={},id){
  status||={};
  const running=status.platforms?.[id]?.running??status.platformRuns?.[id]?.running??(id==='chaoxing'?status.running:false);
  return !!(running||status.startingPlatforms?.includes(id)||(id==='chaoxing'?status.reconRunning:status[id+'Scan']?.running));
}
export function assertPlatformChange(before,after,status){
  for(const id of Object.keys(PLATFORMS))if(platformEnabled(before,id)!==platformEnabled(after,id)&&platformBusy(status,id))throw Error(`请先停止${platformInfo(id).name}的任务或扫描，再修改平台开关`);
}
export function platformOf(record) {
  const raw = String(record?.courseId || record?.taskKey || record?.key || '');
  if (record?.platform) return record.platform;
  if (raw.startsWith('zhihuishu:')) return 'zhihuishu';
  if (raw.startsWith('ucampus:')) return 'ucampus';
  if (raw.startsWith('welearn:')) return 'welearn';
  return 'chaoxing';
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
