import { readZhihuishuPage, isZhihuishuUrl } from './read-page.mjs';
import { savePlatformCourses, readPlatformCatalog } from '../catalog.mjs';
export function studyCourse(snapshot, url, known = []) {
  if (snapshot.pageKind !== 'study' || !snapshot.course?.key || !isZhihuishuUrl(url)) return null;
  const id = snapshot.course.key, name = known.find(c => c.courseId === id)?.name || '智慧树课程';
  return { platform: 'zhihuishu', courseId: id, clazzId: snapshot.course.recruitId, name,
    studyUrl: url, sectionTreeKnown: true, sections: [], taskPoints: snapshot.videos.map(v => ({
      knowledgeId: v.key, secNo: v.number, sectionName: v.name, name: v.name, type: 'video', typeName: '视频',
      platformTaskKey: v.key, platformNumber: v.number, finished: v.completion === 'completed',
    })).concat((snapshot.chapterTests || []).filter(t=>t.key).map(t=>({
      knowledgeId:t.key,secNo:t.number,sectionName:t.chapterName,name:`${t.number} 章节测验`,type:'work',typeName:'章节测验',
      platformTaskKey:t.key,platformTestName:t.name,platformTestIndex:t.index,finished:false,
    }))) };
}
// Read only already-open pages. No playing, navigation, quiz or submission.
export async function collectZhihuishuCourses(context) {
  const observations = [];
  for (const page of context.pages().filter(p => isZhihuishuUrl(p.url()))) {
    observations.push({ state: await readZhihuishuPage(page), url: page.url() });
  }
  if (!observations.length) throw Error('请先在软件内打开智慧树并登录，再读取课程');
  const known = [...readPlatformCatalog().courses];
  for (const { state } of observations) for (const c of state.courses) {
    if (!c.key) continue;
    known.push({ platform: 'zhihuishu', courseId: c.key, clazzId: c.recruitId, name: c.name, taskPoints: [], sections: [], sectionTreeKnown: false });
  }
  const courses = new Map(known.filter(c => c.platform === 'zhihuishu').map(c => [c.courseId, c]));
  for (const { state, url } of observations) {
    const c = studyCourse(state, url, [...courses.values()]); if (c) courses.set(c.courseId, c);
  }
  if (!courses.size) throw Error('尚未读取到可辨识的课程，请在智慧树网页进入课程后再读取');
  const saved = savePlatformCourses('zhihuishu', [...courses.values()]);
  return { courses: courses.size, videos: saved.courses.filter(c => c.platform === 'zhihuishu').reduce((n, c) => n + c.taskPoints.length, 0),
    unrecognized: observations.reduce((n, { state }) => n + state.courses.filter(c => !c.key).length, 0) };
}
