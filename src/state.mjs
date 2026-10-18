/**
 * 运行状态持久化（断点续跑）。
 *
 * 设计要求（用户第 16 问）：状态落盘，重开后接着刷，绝不重刷已完成。
 * 所以每次任务点状态变更都立即写盘 —— 目标"断电最多丢 1 个任务点"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.mjs';
import atomicFile from './atomic-file.cjs';

const STATE_FILE = PATHS.state;

const EMPTY = {
  version: 3,
  updatedAt: null,
  /** 任务点状态：key → { status, retries, progress, lastError, updatedAt, ... } */
  taskPoints: {},
  /** 待人工清单：跳过/失败的条目 */
  handbook: [],
  /** 待审队列：AI 答完但需要人工确认的题目 */
  reviewQueue: [],
  /** 测验/作业执行记录：taskKey → 摘要 */
  quizzes: {},
  /** 为人工确认而保持打开的作业页（仅元信息，句柄在本进程内存里） */
  keptPages: {},
  /** 运行摘要 */
  summary: { started: 0, done: 0, failed: 0, skipped: 0 },
};

let cache = null;
let cacheStamp = null; // `${mtimeMs}:${size}` —— 用于判断磁盘文件是否被外部改过

function stampOf() {
  try {
    const st = fs.statSync(STATE_FILE);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

/**
 * 读取运行状态。
 *
 * 关键设计（踩过两次坑才定下来）：
 *
 *   坑 1：长期信任内存缓存 —— 当 state.json 被"另一个进程"改写时
 *        （比如用 CLI 脚本跑了一次测验），服务端读到的仍是旧缓存，
 *        界面显示"队列为空"而磁盘上其实有数据。
 *
 *   坑 2：改成"每次都读盘" —— 结果 saveState() 里再调 loadState() 时，
 *        直接把内存里刚做的修改覆盖成磁盘旧内容，数据静默丢失。
 *        （表现为 saveState 返回 ok，但磁盘上什么都没变。）
 *
 * 最终方案：**mtime 感知缓存** —— 磁盘没变就复用内存对象（保住修改），
 *          磁盘变了就重读（看到别人的改动）。
 */
export function loadState() {
  const stamp = stampOf();
  if (cache && stamp && stamp === cacheStamp) return cache;

  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    cache = {
      ...EMPTY,
      ...raw,
      taskPoints: raw.taskPoints || {},
      handbook: raw.handbook || [],
      reviewQueue: raw.reviewQueue || [],
      quizzes: raw.quizzes || {},
      keptPages: raw.keptPages || {},
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`无法读取进度文件，请保留文件并检查：${STATE_FILE}（${err.message}）`);
    }
    cache = JSON.parse(JSON.stringify(EMPTY));
  }
  cacheStamp = stampOf() || stamp;
  return cache;
}

/** 强制丢弃缓存（外部改了 state.json 后调用） */
export function invalidateCache() {
  cache = null;
  cacheStamp = null;
}

/**
 * 读-改-写 原子操作。
 * 所有修改都必须走这里，避免"读到旧快照再整体覆盖"导致丢数据。
 *
 * @param {(state:object)=>any} mutator 直接改传入的 state 对象
 * @returns {any} mutator 的返回值
 */
export function mutateState(mutator) {
  // 先确保拿到最新磁盘内容（并丢弃可能已过期的缓存）
  invalidateCache();
  const s = loadState();
  const out = mutator(s);
  const written = writeState(s);
  if (!written.ok) {
    invalidateCache();
    throw new Error(`进度保存失败：${written.error}`);
  }
  return out;
}

/** 真正的写盘（不经过 loadState，避免自我覆盖） */
function writeState(s) {
  s.updatedAt = new Date().toISOString();
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    atomicFile.renameWithRetry(tmp, STATE_FILE);
    cacheStamp = stampOf();
    return { ok: true };
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件可能尚未创建 */ }
    return { ok: false, error: err.message };
  }
}

/**
 * 保存当前内存状态。
 *
 * 注意：**不要**在这里调 loadState() —— 那会把调用方刚做的修改覆盖掉
 * （这正是之前"待审队列写不进去"的根因）。直接写 cache 即可。
 */
export function saveState() {
  const s = cache || loadState();
  return writeState(s);
}

export function statePath() {
  return STATE_FILE;
}

/**
 * 记录一个任务点的状态变更并立即落盘。
 *
 * 走 mutateState 保证"读最新 → 改 → 写"，不会覆盖别人的改动。
 *
 * 内建不变量：**已 done 的任务点不允许被降级**。
 * 这条不变量放在这里（而不是靠每个调用方自觉），因为曾经在 finally 里
 * 无条件写入，把一次成功（90.1%）的记录覆盖成了"非任务点 0.0%"，
 * 等于把战果丢了。
 *
 * @param {string} key
 * @param {object} patch
 * @param {object} [opts]
 * @param {boolean} [opts.allowDowngrade] 显式允许降级（如人工重置）
 */
export function setTaskStatus(key, patch, opts = {}) {
  return mutateState((s) => {
    const prev = s.taskPoints[key] || { retries: 0 };
    if (prev.status === 'done' && patch.status && patch.status !== 'done' && !opts.allowDowngrade) {
      return prev; // 保住已完成记录，不写
    }
    s.taskPoints[key] = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    return s.taskPoints[key];
  });
}

export function getTaskStatus(key) {
  return loadState().taskPoints[key] || null;
}

/** 该任务点是否已完成（用于跳过，避免重刷） */
export function isTaskDone(key) {
  const t = getTaskStatus(key);
  return t?.status === 'done';
}

/** 加入「待人工」清单（去重） */
export function addHandbook(entry) {
  return mutateState((s) => {
    const id = entry.key || `${entry.course}:${entry.secNo}:${entry.name}`;
    if (s.handbook.some((h) => (h.key || `${h.course}:${h.secNo}:${h.name}`) === id)) return s.handbook;
    s.handbook.push({ ...entry, addedAt: new Date().toISOString() });
    return s.handbook;
  });
}

/** 本轮运行摘要 */
export function patchSummary(patch) {
  return mutateState((s) => {
    s.summary = { ...s.summary, ...patch };
    return s.summary;
  });
}

/**
 * 与学习通实际状态对账：把已完成的任务点标记为 done，
 * 避免重开后又去刷已经绿了的任务点。
 * @param {Array} tasks 执行清单里的任务点（需带 key 与 finished/绿点信息）
 */
export function reconcile(tasks) {
  return mutateState((s) => {
    let fixed = 0;
    for (const t of tasks) {
      // 清单里的 finished 来自侦察时的 aria-label；为 true 说明学习通认为已完成
      if (t.finished) {
        const cur = s.taskPoints[t.key];
        if (!cur || cur.status !== 'done') {
          s.taskPoints[t.key] = {
            ...(cur || {}),
            status: 'done',
            source: 'reconcile',
            note: '侦察时已显示已完成，跳过不重刷',
            updatedAt: new Date().toISOString(),
          };
          fixed += 1;
        }
      }
    }
    return { fixed };
  });
}

/** 清空状态（用于"重新开始"） */
export function resetState() {
  cache = JSON.parse(JSON.stringify(EMPTY));
  return writeState(cache);
}

/**
 * 启动自愈：把上次崩溃/强杀遗留在 `running` 的任务点改回 `pending`。
 *
 * 场景：服务被强杀（任务管理器结束进程 / 断电）时，正在跑的任务点状态停在
 * `running`。不清理的话，它会永远卡在那个状态 —— 既不会重试也不会被跳过，
 * 用户会看到"有一个任务点一直显示运行中"。
 *
 * @returns {{fixed:number}}
 */
export function healStaleRunning() {
  return mutateState((s) => {
    let fixed = 0;
    for (const [k, v] of Object.entries(s.taskPoints || {})) {
      if (v.status === 'running') {
        s.taskPoints[k] = {
          ...v,
          status: 'pending',
          note: '上次运行被中断，已重置为待处理',
          updatedAt: new Date().toISOString(),
        };
        fixed += 1;
      }
    }
    return { fixed };
  });
}

/**
 * 产出下一个待处理任务。
 * @param {Array} tasks 执行清单
 * @returns {object|null}
 */
export function nextPending(tasks) {
  for (const t of tasks) {
    if (isTaskDone(t.key)) continue;
    return t;
  }
  return null;
}

/* ---------------- 待审队列 ---------------- */

export function listReviewItems() {
  const s = loadState();
  return (s.reviewQueue || []).filter((x) => x.status !== 'submitted' && x.status !== 'discarded');
}

/** 标记某题已提交 / 已丢弃 */
export function markReviewItem(id, patch) {
  return mutateState((s) => {
    const it = (s.reviewQueue || []).find((x) => x.id === id);
    if (!it) return null;
    Object.assign(it, patch, { updatedAt: new Date().toISOString() });
    return it;
  });
}

/** 按任务点移除整个题组 */
export function clearReviewByTask(taskKey, status = 'submitted') {
  return mutateState((s) => {
    let n = 0;
    for (const it of s.reviewQueue || []) {
      if (it.taskKey === taskKey && it.status !== status && !['submitted','discarded'].includes(it.status)) {
        it.status = status;
        it.updatedAt = new Date().toISOString();
        n += 1;
      }
    }
    return n;
  });
}

/** 修改某题的答案（人工改答案） */
export function updateReviewAnswer(id, answer) {
  return mutateState((s) => {
    const it = (s.reviewQueue || []).find((x) => x.id === id);
    if (!it || ['submitted', 'discarded'].includes(it.status)) return null;
    if (Array.isArray(answer)) {
      if (it.qtype === 'essay') throw new Error('简答题请填写正文');
      it.letters = answer;
      it.autoFilled = false;
      it.filled = null;
      it.status = 'pending-review';
    } else {
      if (it.qtype !== 'essay' || typeof answer?.textAnswer !== 'string' || !answer.textAnswer.trim() || answer.textAnswer.length > 10000) throw new Error('简答正文无效');
      it.textAnswer = answer.textAnswer;
      it.requiresReview = true;
      it.autoFilled = false;
      it.fillError = null;
      it.filled = answer.filled;
      it.status = 'filled';
    }
    it.editedByHuman = true;
    it.updatedAt = new Date().toISOString();
    return it;
  });
}

export function reviewStats() {
  const s = loadState();
  const q = s.reviewQueue || [];
  return {
    total: q.length,
    pending: q.filter((x) => x.status === 'pending-review' || (x.status === 'filled' && x.requiresReview)).length,
    filled: q.filter((x) => x.status === 'filled').length,
    submitted: q.filter((x) => x.status === 'submitted').length,
    discarded: q.filter((x) => x.status === 'discarded').length,
  };
}
