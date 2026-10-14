/**
 * 课程树「选择」的纯逻辑（不碰 DOM，所以能在 Node 里直接跑测试）。
 *
 * 抽出来的原因：用户反馈课程选择"不丝滑、批量选不自由"，需要一堆批量操作
 * （全选/反选/只选未完成/按类型/按章节/节号区间/搜索过滤）。
 * 这类"选择算术"最容易出错又最难肉眼验证 —— 放成纯函数 + 单元测试最稳。
 *
 * 术语：
 *   course.enabled      这门课是否处理（界面上的课程复选框）
 *   task.excluded       这个任务点是否被单独排除（界面上的任务复选框）
 *   task.policyHandle   策略上"该不该做"（视频/测验/文档=true；直播/作业=false）
 *   task.willHandle     最终会不会被执行 = enabled && policyHandle && !excluded
 */

/** 任务点归到哪一类（批量选按这个分组） */
export function typeGroup(type) {
  if (type === 'video') return 'video';
  if (type === 'work') return 'work';
  if (type === 'doc' || type === 'read') return 'doc';
  return 'other';
}

/** 重新计算 willHandle（任何改动后都要调） */
export function recalc(course) {
  for (const t of course.tasks || []) {
    t.willHandle = course.enabled !== false && t.policyHandle !== false && !t.excluded;
  }
  return course;
}

export function recalcAll(courses) {
  for (const c of courses || []) if (!c.empty) recalc(c);
  return courses;
}

/** 节号比较：把 "2.10" 这类按数字段比大小，支持区间判断 */
export function secNoValue(secNo) {
  const m = String(secNo || '').match(/^(\d+)(?:\.(\d+))?/);
  if (!m) return NaN;
  return Number(m[1]) * 1000 + Number(m[2] || 0);
}

export function inSecRange(secNo, from, to) {
  const v = secNoValue(secNo);
  if (Number.isNaN(v)) return false;
  const a = from ? secNoValue(from) : -Infinity;
  const b = to ? secNoValue(to) : Infinity;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return v >= lo && v <= hi;
}

/** 搜索匹配：课程名 / 节号 / 小节名 / 任务点名 */
export function matchesQuery(courseName, task, q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return true;
  const hay = [courseName, task.secNo, task.sectionName, task.name, task.type, task.typeName]
    .map((x) => String(x || '').toLowerCase())
    .join(' ');
  // 空格分隔的多个关键词要全部命中（"示例课程甲 3.1" 这种组合更好用）
  return s.split(/\s+/).every((kw) => hay.includes(kw));
}

/** 课程名是否命中搜索词 */
export function courseNameMatches(course, q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return true;
  return String(course.name || '').toLowerCase().includes(s);
}

/**
 * 课程是否该显示：课程名命中，或它下面有任务点命中 / 有章节命中。
 * 课程名命中时整门课都显示（便于"只想看这门课"）。
 */
export function courseVisible(course, q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return true;
  if (courseNameMatches(course, q)) return true;
  for (const t of course.tasks || []) {
    if (matchesQuery(course.name, t, q)) return true;
  }
  for (const sec of course.sections || []) {
    if (String(sec.secNo || '').toLowerCase().includes(s)) return true;
    if (String(sec.name || '').toLowerCase().includes(s)) return true;
  }
  return false;
}

/**
 * 批量勾选 / 取消。
 *
 * @param {Array} courses 清单里的课程数组（会被就地修改）
 * @param {'select'|'deselect'|'invert'} action
 * @param {object} opts
 * @param {object} opts.scope 类型范围 {video,work,doc,other}，缺省全 true
 * @param {string} opts.from 节号区间起点（含）
 * @param {string} opts.to   节号区间终点（含）
 * @param {string} opts.query 只作用于当前搜索结果（界面"只影响筛选结果"开关）
 * @param {boolean} opts.finishedOnly 只处理"未完成"的
 * @param {string[]} opts.courseIds 只作用于这些课程（缺省全部**已启用**课程）
 * @param {boolean} opts.includeDisabled 是否也动"被停用"的课程（缺省 false）
 * @returns {{changed:number, affected:number}}
 */
export function batchSelect(courses, action, opts = {}) {
  const scope = { video: true, work: true, doc: true, other: true, ...(opts.scope || {}) };
  const courseIds = opts.courseIds ? new Set(opts.courseIds) : null;
  let changed = 0;
  let affected = 0;

  for (const c of courses || []) {
    if (c.empty) continue;
    /*
     * 只动**已启用**的课程。
     * 为什么：界面上的"本次将刷 N"只统计启用的课，批量操作要是把手伸进
     * 停用的课里，用户既看不见、也解释不通（实测：区间操作"没反应"就是
     * 因为它命中了一个停用课程的小节）。
     */
    if (!opts.includeDisabled && c.enabled === false) continue;
    if (courseIds && !courseIds.has(c.courseId)) continue;
    // 搜索过滤：课程完全不可见就跳过；课程名命中则整门课都算在范围内
    if (opts.query && !courseVisible(c, opts.query)) continue;
    const nameHit = courseNameMatches(c, opts.query);

    for (const t of c.tasks || []) {
      /*
       * 策略上"不处理"的任务点（直播 / 独立作业）**不参与批量勾选**。
       * 它们本来就不会被执行，让它们跟着变 excluded 只会让数字对不上、
       * 也让"本次将刷 N 个"变得不可解释。
       */
      if (t.policyHandle === false) continue;
      if (!scope[typeGroup(t.type)]) continue;
      if (opts.from || opts.to) {
        if (!inSecRange(t.secNo, opts.from, opts.to)) continue;
      }
      if (opts.finishedOnly && t.finished) continue;
      if (opts.query && !nameHit && !matchesQuery(c.name, t, opts.query)) continue;

      affected += 1;
      const before = !!t.excluded;
      if (action === 'select') t.excluded = false;
      else if (action === 'deselect') t.excluded = true;
      else if (action === 'invert') t.excluded = !t.excluded;
      if (!!t.excluded !== before) changed += 1;
    }
    recalc(c);
  }
  return { changed, affected };
}

/** 勾选/取消**满足条件**的任务点（章节级/自定义范围都用它） */
export function batchSelectWhere(course, predicate, action) {
  let changed = 0;
  for (const t of course.tasks || []) {
    if (t.policyHandle === false) continue; // 策略不做的（直播/独立作业）不动
    if (!predicate(t)) continue;
    const before = !!t.excluded;
    t.excluded = action === 'deselect';
    if (!!t.excluded !== before) changed += 1;
  }
  recalc(course);
  return { changed };
}

/** 勾选/取消某一门课的**整个小节** */
export function batchSelectChapter(course, section, action) {
  return batchSelectWhere(course, (t) => t.knowledgeId === section.knowledgeId, action);
}

/** 勾选/取消某一门课的**整章**（同章 = 节号第一段相同，如 2.1/2.9 同属第 2 章） */
export function batchSelectBookChapter(course, chapterNo, action) {
  return batchSelectWhere(course, (t) => String(t.secNo || '').split('.')[0] === String(chapterNo), action);
}

/** 一批任务点的勾选状态：全选 / 全不选 / 部分 */
export function selectionState(tasks) {
  const list = (tasks || []).filter((t) => t.policyHandle !== false);
  if (!list.length) return { total: 0, selected: 0, state: 'none' };
  const selected = list.filter((t) => !t.excluded).length;
  return {
    total: list.length,
    selected,
    state: selected === 0 ? 'none' : selected === list.length ? 'all' : 'partial',
  };
}

/** 某个小节/章节下的任务点 */
export function tasksOf(course, { knowledgeId = null, chapterNo = null } = {}) {
  return (course.tasks || []).filter((t) => {
    if (knowledgeId && t.knowledgeId !== knowledgeId) return false;
    if (chapterNo != null && String(t.secNo || '').split('.')[0] !== String(chapterNo)) return false;
    return true;
  });
}

/** 整门课：只留前 N 个可处理任务点（其余排除） */
export function keepFirstN(course, n) {
  const keep = Number(n);
  if (!Number.isFinite(keep) || keep < 0) return { changed: 0 };
  let seen = 0;
  let changed = 0;
  for (const t of course.tasks || []) {
    if (t.policyHandle === false) continue;
    seen += 1;
    const shouldKeep = seen <= keep;
    const before = !!t.excluded;
    t.excluded = !shouldKeep;
    if (!!t.excluded !== before) changed += 1;
  }
  recalc(course);
  return { changed, kept: Math.min(seen, keep), total: seen };
}

/** 这门课里某个小节的"勾选"状态：全选 / 全不选 / 部分 */
export function chapterState(course, section) {
  return selectionState(tasksOf(course, { knowledgeId: section.knowledgeId }));
}

/** 汇总"本次将刷什么" */
export function willSummary(courses) {
  const byType = { video: 0, work: 0, doc: 0, other: 0 };
  let tasks = 0;
  const courses0 = [];
  for (const c of courses || []) {
    if (c.empty || c.enabled === false) continue;
    let n = 0;
    for (const t of c.tasks || []) {
      if (!t.willHandle) continue;
      n += 1;
      byType[typeGroup(t.type)] += 1;
    }
    if (n) {
      courses0.push({ courseId: c.courseId, name: c.name, tasks: n });
      tasks += n;
    }
  }
  return { courses: courses0.length, tasks, byType, list: courses0 };
}

/** 将被执行的任务明细（预览用） */
export function willList(courses) {
  const out = [];
  for (const c of courses || []) {
    if (c.empty || c.enabled === false) continue;
    for (const t of c.tasks || []) {
      if (!t.willHandle) continue;
      out.push({
        key: t.key,
        course: c.name,
        secNo: t.secNo,
        sectionName: t.sectionName,
        name: t.name,
        type: t.type,
        sizeText: t.sizeText || '',
      });
    }
  }
  return out;
}
