/**
 * 侦察数据仓库。
 *
 * P1 的产物是"任务点清单"，它是后续 P2 执行的输入，也是控制台「课程树」页的数据源。
 * 这里负责：把 task-report.json 读成结构化数据、支持勾选/排序/排除的持久化。
 *
 * 任务点类型：
 *   video    视频        —— P2 的核心处理对象
 *   work     作业/测验   —— 默认不动（独立模块，需显式开启）
 *   doc      文档/PPT/PDF —— 只做"点开即完成"类
 *   read     阅读材料     —— 同上
 *   live     直播        —— 跳过，转「待人工」
 *   discuss  讨论/话题    —— 跳过，转「待人工」
 *   audio    音频        —— 暂不处理
 */
import fs from 'node:fs';
import { PATHS } from '../config.mjs';
import { loadState } from '../state.mjs';
import { taskCompletion } from '../ui/task-status.js';

/** 执行清单的输入：侦察报告（路径由 config 唯一决定） */
const REPORT_FILE = PATHS.taskReport;
/** 用户的课程/任务点选择（界面「保存选择」写这里） */
const SELECTION_FILE = PATHS.selection;

/**
 * 默认处理策略（按用户在 P1 访谈里的决策）。
 *
 * 注意 work 类型的细分：
 *   学习通把「章节测验」和「作业」都标成 type=work，但名称不同。
 *   用户决策是：章节测验要做（截图问千问），独立作业默认不碰。
 *   所以这里给 work 一个 handle='quiz-only' 的语义，由执行层按名称判断。
 */
export const TYPE_POLICY = {
  video: { handle: true, label: '视频', action: '播放至 ≥90% 并核对绿点' },
  doc: { handle: true, label: '文档/PPT', action: '点开停留后关闭，核对绿点' },
  read: { handle: true, label: '阅读材料', action: '点开停留后关闭，核对绿点' },
  work: { handle: 'quiz-only', label: '测验/作业', action: '章节测验：截图问 AI；独立作业默认不碰' },
  live: { handle: false, label: '直播', action: '跳过 → 记入待人工' },
  discuss: { handle: false, label: '讨论', action: '跳过 → 记入待人工' },
  audio: { handle: false, label: '音频', action: '暂不处理' },
  vote: { handle: false, label: '问卷', action: '跳过 → 记入待人工' },
  other: { handle: false, label: '未识别', action: '跳过 → 记入待人工' },
};

/** 名称里出现这些字样 → 视为「章节测验」（可做） */
const QUIZ_NAME_HINTS = [/测验/, /测试/, /答题/, /随堂/];

/** 名称里出现这些字样 → 视为「独立作业」（默认不碰） */
const HOMEWORK_NAME_HINTS = [/作业/, /练习/, /习题/, /讨论/];

/**
 * 判断一个 work 类任务点该不该做。
 *
 * ⚠ 实测补充（2026-09-23）：章节里的 work 任务点，名字常常只是节号
 * （如 title="3.1"，因为作业附件的元数据只有 title、没有 name），
 * 按名字匹配会落到 'unknown-work' → 被当成"未识别的作业"跳过。
 * 但**章节卡片里的 work 就是章节测验**（独立作业在「作业」列表里，不在这里），
 * 所以名字认不出来时按章节测验处理（可疑的"作业/练习/讨论"名字仍按作业排除）。
 *
 * 安全性：即使误判成测验，默认提交模式是 manual（人工确认），
 * 只有全部题目都是高可靠答案 + submitMode=auto 才会自动提交。
 */
export function classifyWork(name, { fromChapter = true } = {}) {
  const n = String(name || '');
  for (const re of QUIZ_NAME_HINTS) if (re.test(n)) return 'quiz';
  for (const re of HOMEWORK_NAME_HINTS) if (re.test(n)) return 'homework';
  if (fromChapter) return 'quiz';
  return 'unknown-work';
}

let cache = null;
let cacheMtime = 0;

/**
 * 读取清单报告（带 mtime 感知缓存）。
 *
 * 踩过的坑：早期这里缓存后永不失效，于是"重新侦察 → 读取清单"
 * 拿到的还是旧数据。现在按文件修改时间判断，文件一变就重读。
 */
export function loadReconReport({ force = false } = {}) {
  if (!fs.existsSync(REPORT_FILE)) {
    cache = null;
    cacheMtime = 0;
    return null;
  }
  const mtime = fs.statSync(REPORT_FILE).mtimeMs;
  if (cache && !force && mtime === cacheMtime) return cache;
  cache = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
  cacheMtime = mtime;
  return cache;
}

/** 主动让缓存失效（侦察/普查写完之后调用） */
export function invalidateReconCache() {
  cache = null;
  cacheMtime = 0;
}

/**
 * 读取/初始化选择配置。
 * 结构：
 *   {
 *     courseOrder: [courseId, ...],       // 界面里拖拽调整
 *     courses: { [courseId]: { enabled, sectionOrder: [knowledgeId...] } },
 *     taskOrder: { [knowledgeId]: [ {jobid|idx, type}, ... ] },
 *     excluded: [ "courseId:knowledgeId:jobid", ... ]
 *   }
 */
export function loadSelection() {
  try {
    const raw = JSON.parse(fs.readFileSync(SELECTION_FILE, 'utf8'));
    return {
      courseOrder: raw.courseOrder || [],
      courses: raw.courses || {},
      taskOrder: raw.taskOrder || {},
      excluded: raw.excluded || [],
    };
  } catch {
    return { courseOrder: [], courses: {}, taskOrder: {}, excluded: [] };
  }
}

export function saveSelection(sel) {
  fs.writeFileSync(SELECTION_FILE, JSON.stringify(sel, null, 2), 'utf8');
  return sel;
}

/**
 * 任务点的稳定标识（小节内相对位置）。
 *
 * 踩过的坑：早期用 `jobid || "idx" + (idx ?? 0)`，
 * 但很多任务点 jobid 为 null（精简型元数据），idx 又是 undefined，
 * 结果同一小节内所有任务点都退化成 "idx0" —— key 冲突、互相覆盖、
 * 排序失效。所以改为按小节内序号生成，且保证全局唯一。
 */
export function taskUid(seq) {
  return `t${seq}`;
}

/** 全局 key：课程 + 小节 + 小节内序号 */
export function taskKey(courseId, knowledgeId, seq) {
  return `${courseId}:${knowledgeId}:${taskUid(seq)}`;
}

/**
 * 把侦察报告整理成"可执行清单"，套用选择配置。
 * @returns {{courses:Array, summary:object}}
 */
export function buildChecklist({ includeProgress = false } = {}) {
  const report = loadReconReport();
  if (!report) return null;

  const sel = loadSelection();
  const progress = includeProgress ? loadState().taskPoints : {};
  const order = sel.courseOrder.length ? sel.courseOrder : report.courses.map((c) => c.courseId);
  const byId = new Map(report.courses.map((c) => [c.courseId, c]));

  const courses = [];
  const summary = {
    totalCourses: 0,
    totalTasks: 0,
    byType: {},
    handleable: 0,
    skipped: 0,
    pending: 0, // 已完成
    handbook: [], // 转「待人工」的
  };

  for (const courseId of order) {
    const c = byId.get(courseId);
    if (!c) continue;
    byId.delete(courseId);
    courses.push(toCourseEntry(c, sel, summary, progress));
  }
  // 补上没进 order 的
  for (const c of byId.values()) courses.push(toCourseEntry(c, sel, summary, progress));

  summary.totalCourses = courses.length;
  return { courses, summary, generatedAt: report.at };
}

function toCourseEntry(c, sel, summary, progress) {
  if (c.empty) {
    return { courseId: c.courseId, name: c.name, empty: true, sections: [], tasks: [], counts: {} };
  }

  const cs = sel.courses[c.courseId] || {};
  const enabled = cs.enabled !== false; // 默认启用
  const excluded = new Set(sel.excluded);

  // 按小节聚合任务点
  const sectionMap = new Map();
  for (const t of c.taskPoints || []) {
    const key = t.knowledgeId;
    if (!sectionMap.has(key)) {
      sectionMap.set(key, {
        knowledgeId: key,
        secNo: t.secNo,
        name: t.sectionName,
        tasks: [],
      });
    }
    sectionMap.get(key).tasks.push(t);
  }

  // 小节顺序（可被选择配置覆盖）
  const secOrder = cs.sectionOrder || [];
  let sections = [...sectionMap.values()];
  if (secOrder.length) {
    const idx = new Map(secOrder.map((k, i) => [k, i]));
    sections.sort((a, b) => (idx.get(a.knowledgeId) ?? 9999) - (idx.get(b.knowledgeId) ?? 9999));
  }

  const counts = {};
  const tasks = [];

  for (const s of sections) {
    // 先按小节内原始序号确立稳定 uid，再套用用户排序
    const withUid = s.tasks.map((t, i) => ({ ...t, seq: i, uid: taskUid(i) }));

    const tOrder = sel.taskOrder[s.knowledgeId] || [];
    let ts = withUid;
    if (tOrder.length) {
      const idx = new Map(tOrder.map((u, i) => [u, i]));
      ts = [...withUid].sort((a, b) => (idx.get(a.uid) ?? 9999) - (idx.get(b.uid) ?? 9999));
    }

    for (const t of ts) {
      const key = taskKey(c.courseId, s.knowledgeId, t.seq);
      const policy = TYPE_POLICY[t.type] || TYPE_POLICY.other;

      // work 类要再细分：章节测验 vs 独立作业
      let willHandleBase = policy.handle === true;
      let workKind = null;
      if (policy.handle === 'quiz-only') {
        workKind = classifyWork(t.name);
        willHandleBase = workKind === 'quiz';
      }

      const isExcluded = excluded.has(key);
      const willHandle = enabled && willHandleBase && !isExcluded;

      counts[t.type] = (counts[t.type] || 0) + 1;
      summary.byType[t.type] = (summary.byType[t.type] || 0) + 1;
      summary.totalTasks += 1;
      if (willHandle) summary.handleable += 1;
      else summary.skipped += 1;

      if (workKind) {
        summary.workKinds = summary.workKinds || { quiz: 0, homework: 0, 'unknown-work': 0 };
        summary.workKinds[workKind] = (summary.workKinds[workKind] || 0) + 1;
      }

      if (!willHandleBase) {
        summary.handbook.push({
          course: c.name,
          secNo: s.secNo,
          sectionName: s.name,
          type: t.type,
          typeName: t.typeName,
          name: t.name,
          reason:
            policy.handle === 'quiz-only'
              ? workKind === 'homework'
                ? '独立作业：默认不碰（只有 1 次提交机会）'
                : '未识别的作业类任务点：默认不碰'
              : policy.action,
        });
      }

      tasks.push({
        key,
        courseId: c.courseId,
        clazzId: c.clazzId,
        knowledgeId: s.knowledgeId,
        secNo: s.secNo,
        sectionName: s.name,
        type: t.type,
        typeName: t.typeName,
        name: t.name,
        sizeText: t.sizeText,
        sizeBytes: t.sizeBytes ?? null,
        jobid: t.jobid,
        idx: t.idx,
        seq: t.seq,
        uid: t.uid,
        finished: t.finished,
        completion: taskCompletion(t, progress[key]),
        condition: t.condition,
        policy: policy.action,
        policyHandle: willHandleBase,
        workKind,
        willHandle,
        excluded: isExcluded,
      });
    }
  }

  return {
    courseId: c.courseId,
    clazzId: c.clazzId,
    name: c.name,
    empty: false,
    enabled,
    sections: sections.map((s) => ({ knowledgeId: s.knowledgeId, secNo: s.secNo, name: s.name, taskCount: s.tasks.length })),
    tasks,
    counts,
  };
}

