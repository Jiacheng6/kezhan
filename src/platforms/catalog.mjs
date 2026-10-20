import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.mjs';
import atomicFile from '../atomic-file.cjs';
const file = () => path.join(PATHS.data, 'platform-catalog.json');
export function readPlatformCatalog() {
  try {
    const value = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (value.version !== 1 || !Array.isArray(value.courses)) throw Error('格式无效');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return { version: 1, courses: [] }; throw Error('多平台课程清单无法读取，原数据已保留', { cause: error }); }
}
export function savePlatformCourses(platform, courses) {
  if (platform !== 'zhihuishu' || courses.some(c => c.platform !== platform || !c.courseId?.startsWith(platform + ':'))) throw Error('平台课程标识无效');
  const previous = readPlatformCatalog();
  // Update only observed courses. A closed course page must not erase its saved tasks.
  const merged = new Map(previous.courses.map(c => [c.courseId, c]));
  for (const c of courses) {
    const old = merged.get(c.courseId);
    merged.set(c.courseId, old && !c.taskPoints?.length ? { ...old, name: c.name } : c);
  }
  const value = { version: 1, at: new Date().toISOString(), courses: [...merged.values()] };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const temp = file() + '.tmp'; fs.writeFileSync(temp, JSON.stringify(value, null, 2)); atomicFile.renameWithRetry(temp, file());
  return value;
}
export function mergeCourseReports(legacy, extra) {
  const courses = [...(legacy?.courses || []).map(c => ({ ...c, platform: c.platform || 'chaoxing' })), ...(extra?.courses || [])];
  if (new Set(courses.map(c => c.courseId)).size !== courses.length) throw Error('课程标识重复，已停止合并');
  return courses.length ? { at: extra?.at || legacy?.at, courses } : legacy;
}
