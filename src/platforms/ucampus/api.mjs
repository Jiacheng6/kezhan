/**
 * U校园 AI 版：页面内接口调用（复用页面自己的登录态，不复刻令牌）。
 *
 * 为什么不直连：ucontent 的接口带 Authorization / appId / x-annotator-auth-token
 * 三个前端拦截器现拼的头，外部复刻会 401（实测）。
 * uai 主站的接口用 cookie 即可，所以扫描走页面内 fetch。
 */
import { waitForRead } from '../../control.mjs';

/** 在页面里发一个 JSON 请求（同源，带 cookie） */
export async function pageFetch(page, path, { method = 'GET', body = null, timeoutMs = 20000, shouldStop } = {}) {
  const text = await waitForRead(
    () =>
      page.evaluate(
        async ({ path, method, body }) => {
          try {
            const res = await fetch(path, {
              method,
              credentials: 'include',
              headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
              body: body ? JSON.stringify(body) : undefined,
            });
            return JSON.stringify({ status: res.status, text: (await res.text()).slice(0, 2000000) });
          } catch (error) {
            return JSON.stringify({ status: 0, text: String(error && error.message).slice(0, 200) });
          }
        },
        { path, method, body },
      ),
    { shouldStop, timeoutMs, message: `U校园页面读取超时（${path}）` },
  );
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('U校园返回无法解析：' + String(text).slice(0, 120));
  }
  if (parsed.status !== 200) throw new Error(`U校园接口 ${path} 返回 HTTP ${parsed.status}`);
  let json;
  try {
    json = JSON.parse(parsed.text);
  } catch {
    throw new Error('U校园返回不是 JSON：' + String(parsed.text).slice(0, 120));
  }
  return json;
}

/** 学生课程 + 教程清单（含 finishPointNum/totalPointNum/readProcess） */
export async function readStudentCourses(page, opts = {}) {
  const json = await pageFetch(page, '/api/cmgt/course/getCourseListByStudent', opts);
  if (!json?.value?.courseList) throw new Error('读不到 U校园 课程列表，可能登录已失效');
  return json.value.courseList;
}

/** 必修节点策略（单元 → requiredTask nodeId 列表） */
export async function readStrategy(page, { strategyId, courseResourceId }, opts = {}) {
  const json = await pageFetch(page, '/api/tla/courseStudyStrategy/detail', {
    ...opts,
    method: 'POST',
    body: { id: strategyId, courseResourceId },
  });
  const list = json?.value?.courseUnitStrategyList;
  if (!Array.isArray(list)) throw new Error('读不到 U校园 必修节点策略');
  return list;
}

/** 教程详情（拿到续学 URL 等） */
export async function readTutorialDetail(page, tutorial, course, opts = {}) {
  const json = await pageFetch(page, '/api/tla/courseStudy/courseDetail', {
    ...opts,
    method: 'POST',
    body: {
      courseResourceId: tutorial.id,
      courseId: course.id,
      resourceId: tutorial.resourceId,
      courseInstanceId: tutorial.instanceId,
      strategyId: tutorial.strategyId,
    },
  });
  return json?.value || null;
}
