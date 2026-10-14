/**
 * 「这个任务点还要不要做」的判定 —— 纯函数，可离线测试。
 *
 * 为什么单独抽出来：重复劳动是这类工具最烦人的问题（一条视频 23 分钟，
 * 已经做完却又播一遍）。而"做完了没有"有四个来源，可靠性和新鲜度都不同：
 *
 *   ① 本地状态 state.json          —— 最可信的"我们自己的记录"，但可能没有
 *   ② 上次侦察报告的 finished 标记  —— 快照，**会过期**（用户可能在手机上做了）
 *   ③ 学习通页面上本任务点的标记    —— 实时、权威（卡片附件里的"已完成"绿勾）
 *   ④ 学习通页面上**整节**的绿点    —— 实时；整节全绿必然蕴含本点完成
 *
 * 三条规则（按优先级，任一成立就跳过，绝不重做）：
 *   ① > ② > ③ > ④
 *
 * ⚠ 反过来不行：**小节不绿不等于本任务点没完成**（一个小节里"视频 + 章节测验"时，
 *   视频做完了小节照样不绿）。所以判"没完成"时只能信 ③ —— 这正是
 *   "一直重复视频"那个坑的根源，详见 runner.mjs 的 verifyTaskCompletion。
 */

/** 本地状态里哪些值算"已完成"（manual/failed/pending 都要继续做） */
const DONE_STATES = new Set(['done']);

/**
 * @param {object} o
 * @param {object} o.task 执行清单里的任务点（含 finished 快照标记）
 * @param {string|null} [o.stateStatus] state.json 里该任务点的状态
 * @param {boolean|null} [o.pointFinished] 学习通上**本任务点**是否已完成（null=读不出）
 * @param {object|null} [o.section] 该小节状态（readSectionStatus 的返回，含 done/jobPending）
 * @returns {{skip:boolean, source:'state'|'manifest'|'task-point'|'section-green'|null, reason:string}}
 */
export function skipDecision({ task, stateStatus = null, pointFinished = null, section = null } = {}) {
  if (stateStatus && DONE_STATES.has(stateStatus)) {
    return { skip: true, source: 'state', reason: '本地记录显示已完成' };
  }
  if (task && task.finished === true) {
    return { skip: true, source: 'manifest', reason: '上次侦察时学习通已标记完成' };
  }
  if (pointFinished === true) {
    return { skip: true, source: 'task-point', reason: '学习通显示本任务点已完成' };
  }
  const sectionDone = section && (section.done === true || section.jobPending === 0);
  if (sectionDone) {
    return { skip: true, source: 'section-green', reason: '学习通显示该小节已全部完成' };
  }
  return { skip: false, source: null, reason: '' };
}

/** 跳过时统一口径的日志文案（让用户一眼看出"为什么没做"） */
export function describeSkip(decision) {
  if (!decision || !decision.skip) return '';
  return `⊘ 跳过：${decision.reason}`;
}
