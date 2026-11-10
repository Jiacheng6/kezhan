/**
 * U校园 AI 版：纯逻辑层（可离线测试，不碰浏览器）。
 *
 * 平台事实（2026-11-01 真机侦察，见 docs/qa/2026-11-01-ucampus-recon.md）：
 *   · 一门"课程"下挂若干"教程"（courseResourceList），每个教程有
 *     finishPointNum（已学任务）/ totalPointNum（任务总数）/ readProcess（百分比）
 *   · 教程的必修节点来自策略接口 courseUnitStrategyList[].requiredTask[]
 *     （本样本 6 单元 × 7 = 42，与界面 1/42 一致）
 *   · 学习动作在跨域播放器 ucontent.unipus.cn 里，进度由播放器自己上报
 *
 * 这里只做"数据整形 + 判定"，让执行器的决策可被单测覆盖。
 */

/** 任务 key：平台前缀 + 课程资源 + 节点，保证与学习通/智慧树不冲突 */
export function ucampusTaskKey(courseResourceId, nodeId) {
  if (!courseResourceId || !nodeId) throw new Error('U校园任务标识缺少课程或节点');
  return `ucampus:${courseResourceId}:${nodeId}`;
}

/** Completion is durable only after the platform confirms credit, not a click. */
export function confirmedUcampusOutcome(result) {
  if(!result?.ok)return result;
  const advanced=result.before!=null&&result.after!=null&&Number.isFinite(Number(result.before))&&Number.isFinite(Number(result.after))&&Number(result.after)>Number(result.before);
  if(result.phase==='already-finished'||advanced&&(result.credited===true||result.delta==='advanced'))return result;
  return {...result,ok:false,phase:'needs-human',error:'U校园平台尚未确认此节点完成，未记完成'};
}

/** 从任务 key 里取回课程与节点 */
export function parseUcampusTaskKey(key) {
  const parts = String(key || '').split(':');
  if (parts[0] !== 'ucampus' || parts.length !== 3) throw new Error('不是 U校园任务 key：' + key);
  return { courseResourceId: parts[1], nodeId: parts[2] };
}

/**
 * 把"教程 + 单元策略"整理成统一的 taskPoints 结构。
 *
 * @param {object} o
 * @param {{id:number|string, name:string, resourceId?:string, instanceId?:string}} o.tutorial
 * @param {Array<{unitName:string, requiredTask:string[]}>} o.units
 * @param {object} [o.progress] 已知进度 { [nodeId]: 'done'|'todo' }
 * @returns {Array<object>} taskPoints
 */
/**
 * 每个单元的 7 个必修，在教程树里是**固定顺序**（真机逐个核对过）：
 *   0 单词卡 Vocabulary（Vocabulary learning › Vocabulary）
 *   1 选择题 Quiz（Vocabulary learning › Quiz）
 *   2 自评 Review & check
 *   3 选择题 Vocabulary（Unit test 内）
 *   4 选词填空 Banked cloze（Unit test 内）
 *   5 选择题 Reading（Unit test 内）
 *   6 翻译 Translation（Unit test 内）
 * 批量执行按这个表分派到不同的执行器。
 */
export const UCAMPUS_NODE_KINDS = [
  { kind: 'vocab-cards', typeName: '单词卡' },
  { kind: 'video-quiz', typeName: '选择题（视频区）' },
  { kind: 'review', typeName: '自评' },
  { kind: 'unit-vocab', typeName: '选择题（Unit test）' },
  { kind: 'unit-cloze', typeName: '选词填空' },
  { kind: 'unit-reading', typeName: '选择题（Unit test）' },
  { kind: 'unit-translation', typeName: '翻译' },
];

/** 按单元内序号推断节点类型（超出表长时回落到学习节点） */
export function kindOfNodeIndex(nodeIndex) {
  return UCAMPUS_NODE_KINDS[nodeIndex - 1] || { kind: 'study', typeName: '学习节点' };
}

/** 该类型需要 AI 作答（决定是否要走"全高可靠才提交"的门槛） */
export function needsAnswers(kind) {
  return ['video-quiz', 'unit-vocab', 'unit-reading', 'unit-cloze', 'unit-translation'].includes(kind);
}

export function buildTaskPoints({ tutorial, units, progress = {} }) {
  const points = [];
  // 只有"6 单元 × 7 必修 = 42"这种结构核对过的教程才套题型表
  const totalRequired = (units || []).reduce((n, u) => n + (u.requiredTask || []).length, 0);
  const structureVerified = totalRequired === 42;
  for (const [unitIndex, unit] of (units || []).entries()) {
    /*
     * 真机核对过：读写教程每个单元正好 7 个必修，顺序固定（见 UCAMPUS_NODE_KINDS）。
     * 但同一门课里别的教程（例如听力）单元结构不同 —— 数量对不上时**不套这张表**，
     * 否则会把题型标错、批量执行时打不开节点。这种单元一律按"学习节点"处理。
     */
    const shapeKnown = structureVerified && (unit.requiredTask || []).length === UCAMPUS_NODE_KINDS.length;
    for (const [nodeIndex, nodeId] of (unit.requiredTask || []).entries()) {
      const state = progress[nodeId];
      points.push({
        platform: 'ucampus',
        courseResourceId: String(tutorial.id),
        tutorialName:String(tutorial.name||''),
        courseInstanceId: String(tutorial.instanceId || ''),
        knowledgeId: String(nodeId),
        secNo: `U${unitIndex + 1}.${nodeIndex + 1}`,
        sectionName: unit.unitName || `Unit ${unitIndex + 1}`,
        name: unit.unitName ? `${unit.unitName} · 节点 ${nodeIndex + 1}` : `Unit ${unitIndex + 1} 节点 ${nodeIndex + 1}`,
        type: shapeKnown ? kindOfNodeIndex(nodeIndex + 1).kind : 'study',
        typeName: shapeKnown ? kindOfNodeIndex(nodeIndex + 1).typeName : '学习节点',
        platformTaskKey: String(nodeId),
        platformNumber: points.length + 1,
        finished: state === 'done',
        unitIndex: unitIndex + 1,
        nodeIndex: nodeIndex + 1,
      });
    }
  }
  return points;
}

/** 还有哪些节点没完成（执行器的输入） */
export function pendingNodes(taskPoints = []) {
  return taskPoints.filter((p) => p.finished !== true);
}

/**
 * 进度对比：平台口径的"已学任务数"有没有涨。
 * 执行器用它判断一个节点是否真的被平台记账（而不是自己以为完成了）。
 * @returns {'advanced'|'unchanged'|'regressed'}
 */
export function progressDelta(before, after) {
  const a = Number(before?.finishPointNum);
  const b = Number(after?.finishPointNum);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'unchanged';
  if (b > a) return 'advanced';
  if (b < a) return 'regressed';
  return 'unchanged';
}

/**
 * 单个节点执行结果的归类（供批次记账复用现有的停止/待人工语义）。
 * @param {{delta:string, error?:string, stopped?:boolean}} o
 */
export function classifyNodeOutcome({ delta, error = '', stopped = false } = {}) {
  if (stopped) return { ok: false, phase: 'stopped' };
  if (delta === 'advanced') return { ok: true, phase: 'completed' };
  return { ok: false, phase: 'needs-human', error: error || '平台未记录进度增长，请手工核对' };
}

/**
 * 节点类型判定（供执行器选择完成动作）。
 *
 * 真机确认（2026-11-01）：
 *   · `Review & check` 是「自评表格」：每行一条 "I can ..."，右侧有 Got it 方框；
 *   · `Unit test` / `Quiz` 是测验（有选项控件）；
 *   · 其余多为阅读/视频节点。
 *
 * @param {{hasSelfAssessTable:boolean, hasVideo:boolean, hasAudio:boolean, hasOptions:boolean, hasEssay:boolean}} o
 * @returns {'self-assessment'|'quiz'|'video'|'audio'|'reading'}
 */
export function nodeKind({ hasSelfAssessTable = false, hasVideo = false, hasAudio = false, hasOptions = false, hasEssay = false } = {}) {
  if (hasSelfAssessTable) return 'self-assessment';
  if (hasVideo) return 'video';
  if (hasAudio) return 'audio';
  if (hasOptions || hasEssay) return 'quiz';
  return 'reading';
}

/** 教程进度摘要（写进清单，给界面显示） */
export function summarizeTutorial(tutorial) {
  const finish = Number(tutorial?.finishPointNum) || 0;
  const total = Number(tutorial?.totalPointNum) || 0;
  return {
    finish,
    total,
    percent: total ? Math.round((finish / total) * 1000) / 10 : 0,
    label: total ? `已学任务 ${finish}/${total}` : '未开始',
  };
}

/**
 * 判断一个已完成数量是否满足"全部任务完成"。
 * 注意：U校园 的 totalPointNum 是平台口径，和策略里 requiredTask 数量可能不同，
 * 以平台口径为准（用户看到的就是这个数字）。
 */
export function isTutorialComplete(tutorial) {
  const { finish, total } = summarizeTutorial(tutorial);
  return total > 0 && finish >= total;
}
