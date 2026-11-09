/**
 * 接口地址与 Referer 构造。
 *
 * 所有平台相对路径集中在此，改版时只需要改一个文件。
 * Referer 必须与真实页面一致，否则会触发 request_source_error（附录 C-1）。
 */

export const PATHS = {
  authCourse: '/ajax/authCourse.aspx',
  studyStat: '/ajax/StudyStat.aspx',
  sco: '/Ajax/SCO.aspx',
  courseInfo: '/student/course_info.aspx',
} as const;

export function refStudentIndex(baseUrl: string): string {
  return `${baseUrl}/student/index.aspx`;
}

export function refCourseInfo(baseUrl: string, cid: string): string {
  return `${baseUrl}/student/course_info.aspx?cid=${encodeURIComponent(cid)}`;
}

/** 学习页 Referer，SCO 写操作必须带 */
export function refStudyCourse(
  baseUrl: string,
  params: { cid: string; classid: string; scoid: string },
): string {
  const q = new URLSearchParams({ cid: params.cid, classid: params.classid, sco: params.scoid });
  return `${baseUrl}/Student/StudyCourse.aspx?${q.toString()}`;
}

/** 兼容旧实现：不带 classid 的简版学习页地址，用于 scoAddr 之外的读操作 */
export function refStudyShort(baseUrl: string, cid: string, scoid: string): string {
  const q = new URLSearchParams({ cid, sco: scoid });
  return `${baseUrl}/Student/StudyCourse.aspx?${q.toString()}`;
}
