/**
 * 批量执行器（P2 自动翻页 + P3 断点续跑）。
 *
 * 流程：
 *   载入清单 → 过滤出脚本该处理的类型 → 与学习通状态对账 →
 *   逐个跑，每个完成即落盘 → 失败重试 ≤ maxRetries 次后入「待人工」并继续 →
 *   连续 N 个失败或登录失效则全局暂停告警。
 */
import { loadSettings } from './config.mjs';
import { log } from './logbus.mjs';
import { runVideoTask, runDocTask, HANDLED_TYPES } from './chaoxing/runner.mjs';
import { runQuizTask, recordQuizResult } from './chaoxing/quizrun.mjs';
import {
  loadState,
  setTaskStatus,
  getTaskStatus,
  isTaskDone,
  addHandbook,
  patchSummary,
  reconcile,
  nextPending,
  saveState,
} from './state.mjs';

/** 连续失败多少次就全局暂停（防雪崩式误操作） */
const CONSECUTIVE_FAIL_LIMIT = 3;

/**
 * 一次执行结果该怎么记账（**纯函数**，便于离线测试）。
 *
 * 返回：
 *   'done'        正常完成 / 本来就没事（已完成、非任务点、待审）
 *   'needs-human' 需要人（如视频弹窗题判不准）—— 不重试，整批继续
 *   'stopped'     用户主动中止 —— **不是失败**，保留 pending 下次续跑
 *   'blocked'     触发风控等硬障碍 —— 立刻停整批
 *   'failed'      真失败 —— 重试
 *
 * 踩坑记录：早期这里没有 'stopped'，用户点停止被判成失败，
 * 白白重试还把任务记成「待人工」。现在把它单列出来并写测试。
 */
export function classifyTaskResult(r) {
  if (!r) return 'failed';
  if (r.ok || r.phase === 'no-tracking' || r.phase === 'already-finished' || r.phase === 'awaiting-review') {
    return 'done';
  }
  if (r.phase === 'needs-human') return 'needs-human';
  if (r.phase === 'stopped') return 'stopped';
  if (r.needsHuman || r.phase === 'blocked-verification' || r.phase === 'blocked-throttled') return 'blocked';
  return 'failed';
}

export class BatchRunner {
  constructor() {
    this.running = false;
    this.stopRequested = false;
    this.stats = {
      total: 0,
      processed: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      handbook: 0,
      consecutiveFail: 0,
      startedAt: null,
      current: null,
    };
    this.onUpdate = null; // 由 main 注入，用于推 UI
  }

  requestStop() {
    if (this.running) {
      this.stopRequested = true;
      log('收到停止请求，将在当前任务点结束后停止…', 'warn');
    }
    return { stopping: true };
  }

  /**
   * @param {object} opts
   * @param {import('playwright-core').BrowserContext} opts.ctx
   * @param {import('playwright-core').Page} [opts.qianwenPage] 千问标签页（做题需要）
   * @param {Array} opts.tasks 执行清单（已按用户排序/勾选）
   * @param {object} opts.command 该批次的命令（含 courseId/clazzId/personId）
   * @param {Function} opts.onUpdate 每次状态变化回调
   */
  async start({ ctx, tasks, command, onUpdate, qianwenPage = null }) {
    if (this.running) return { started: false, reason: 'already-running' };
    const settings = loadSettings();

    this.running = true;
    this.stopRequested = false;
    this.onUpdate = onUpdate;
    this.qianwenPage = qianwenPage;
    this.stats.startedAt = Date.now();
    this.stats.total = tasks.length;
    this.stats.processed = 0;
    this.stats.done = 0;
    this.stats.failed = 0;
    this.stats.skipped = 0;
    this.stats.consecutiveFail = 0;
    this.stats.skipReasons = {};

    // 只处理该处理的类型
    const runnable = tasks.filter((t) => t.willHandle && HANDLED_TYPES.has(t.type));
    const notHandled = tasks.filter((t) => !t.willHandle || !HANDLED_TYPES.has(t.type));

    log('='.repeat(60), 'info');
    log(`批量执行开始：清单 ${tasks.length} 个 · 本批处理 ${runnable.length} 个 · 跳过 ${notHandled.length} 个`, 'info');

    // 把不处理的类型登记到「待人工」
    for (const t of notHandled) {
      addHandbook({
        key: t.key,
        course: t.courseName || t.courseId,
        secNo: t.secNo,
        sectionName: t.sectionName,
        type: t.type,
        typeName: t.typeName,
        name: t.name,
        reason: t.policy || '不在处理范围',
      });
      this.stats.handbook += 1;
    }

    // 与学习通状态对账，避免重刷已完成
    const rec = reconcile(runnable);
    if (rec.fixed) log(`对账：${rec.fixed} 个任务点在学习通上已显示完成，本次跳过`, 'ok');

    try {
      for (const task of runnable) {
        if (this.stopRequested) {
          log('已按请求停止', 'warn');
          break;
        }
        if (isTaskDone(task.key)) {
          this.stats.skipped += 1;
          this.stats.skipReasons = this.stats.skipReasons || {};
          this.stats.skipReasons.state = (this.stats.skipReasons.state || 0) + 1;
          continue;
        }

        this.stats.current = {
          key: task.key,
          name: task.name,
          secNo: task.secNo,
          sectionName: task.sectionName,
          courseName: task.courseName,
          type: task.type,
        };
        this.push();

        const attemptNo = (getTaskStatus(task.key)?.retries || 0) + 1;
        setTaskStatus(task.key, { status: 'running', retries: attemptNo, name: task.name });

        /*
         * 内联重试：一个任务点在本次批量运行内最多尝试 maxRetries 次。
         * 之前只是把状态标成 pending 就往下走了 —— 那不叫重试，
         * 得等下一次整批运行才会再碰到它，等于没重试。
         */
        let r = null;
        let lastTry = 0;
        for (let tryIdx = 1; tryIdx <= settings.maxRetries; tryIdx += 1) {
          if (this.stopRequested) break;
          lastTry = tryIdx;
          log(
            `[${this.stats.processed + 1}/${runnable.length}] ${task.secNo} ${task.name || task.sectionName}` +
              (tryIdx > 1 ? `（第 ${tryIdx} 次尝试）` : ''),
            'info',
          );

          // 按任务点类型分派到不同执行器
          const onProg = (p) => {
            this.stats.current = {
              ...this.stats.current,
              progress: p.progress,
              currentTime: p.currentTime,
              duration: p.duration,
              resumes: p.resumes,
              paused: p.paused,
              questionIndex: p.index,
              questionTotal: p.total,
              phase: p.phase,
            };
            this.push();
          };
          const stopFn = () => this.stopRequested;

          if (task.type === 'work') {
            r = await runQuizTask({
              ctx,
              qianwenPage: this.qianwenPage,
              task,
              personId: command.personId,
              onProgress: onProg,
              shouldStop: stopFn,
            });
            recordQuizResult(r);
          } else if (task.type === 'video') {
            r = await runVideoTask({
              ctx,
              task,
              personId: command.personId,
              onProgress: onProg,
              shouldStop: stopFn,
              qianwenPage: this.qianwenPage,
            });
          } else {
            r = await runDocTask({ ctx, task, personId: command.personId, onProgress: onProg, shouldStop: stopFn });
          }

          /*
           * 记账分类：完成 / 需人工 / 用户中止 / 硬障碍 / 失败。
           * 前四种都不该重试 —— 尤其"用户中止"和"弹窗题等人"，
           * 重试只会把同一条视频再播一遍。
           */
          const kind = classifyTaskResult(r);
          if (kind === 'done' || kind === 'stopped' || kind === 'needs-human') break;

          if (kind === 'blocked') {
            /*
             * 需要人工介入（如千问风控要求扫码）→ 立刻停止整批。
             * 继续跑只会一个个白等到超时，毫无意义。
             */
            log(`⛔ 需要人工处理：${r.needsHuman || r.error}`, 'error');
            this.stats.paused = true;
            this.stats.pauseReason = r.needsHuman || r.error;
            this.stopRequested = true;
            break;
          }

          // kind === 'failed' → 记下这次失败并重试
          setTaskStatus(task.key, { retries: tryIdx, lastError: r.error, progress: r.progress });
          if (tryIdx < settings.maxRetries) {
            log(`    第 ${tryIdx} 次失败：${r.error} —— 重试中`, 'warn');
            await new Promise((res) => setTimeout(res, 2500));
          }
        }

        const kind = classifyTaskResult(r);
        if (kind === 'done') {
          this.stats.done += 1;
          this.stats.consecutiveFail = 0;
          /*
           * 记下"这次其实是被跳过（本来就完成了）"的原因 ——
           * 执行器把 already-finished 也归到 done，用户在汇总里要能看出
           * 哪些是"真跑了"，哪些是"学习通上早就完成了、没重做"。
           */
          if (r && r.phase === 'already-finished') {
            const src = r.skippedBecause || (r.skipReason ? 'task-point' : null);
            if (src) {
              this.stats.skipReasons = this.stats.skipReasons || {};
              this.stats.skipReasons[src] = (this.stats.skipReasons[src] || 0) + 1;
            }
          }
        } else if (kind === 'needs-human') {
          /*
           * 弹窗题等人：runner 已把任务点写成 manual 并登记「待人工」，
           * 这里只计数，**不计入连续失败**（否则一道难题就能把整批拖停）。
           */
          this.stats.skipped += 1;
          this.stats.handbook += 1;
          this.stats.consecutiveFail = 0;
        } else if (kind === 'stopped') {
          /*
           * 用户主动停止：**不是失败**。
           *
           * 实测踩坑：早期没有这一支，`stopped` 掉进了"失败"分支 ——
           * 点了停止还要把同一个任务点重试 3 次（每次都被 stop 立刻拦下），
           * 最后记成「待人工」，而它其实只是"没跑完、下次接着跑"。
           * 现在：保留 pending（runner/quizrun 已写好）+ 进度，不计失败、
           * 不计连续失败；外层循环下一轮即因 stopRequested 退出。
           */
          setTaskStatus(task.key, {
            status: 'pending',
            progress: r?.progress,
            note: '被用户中止，下次续跑',
          });
          this.stats.skipped += 1;
          this.stats.consecutiveFail = 0;
          log('    ⏸ 被用户中止：保留为「待续跑」（不计失败、不重试）', 'warn');
        } else {
          const reason = r ? r.error : '未执行';
          setTaskStatus(task.key, { status: 'manual', lastError: reason, progress: r?.progress });
          addHandbook({
            key: task.key,
            course: task.courseName || task.courseId,
            secNo: task.secNo,
            sectionName: task.sectionName,
            type: task.type,
            typeName: task.typeName,
            name: task.name,
            reason: `重试 ${settings.maxRetries} 次仍失败：${reason}`,
          });
          this.stats.failed += 1;
          this.stats.handbook += 1;
          this.stats.consecutiveFail += 1;
          // 用**实际**尝试次数，别写死 maxRetries（用户中止时只试了 1 次，
          // 日志却写"已重试 3 次"，排查时会带偏）
          log(`    ✗ 已尝试 ${lastTry || 1} 次仍未成功，转「待人工」：${reason}`, 'error');
        }

        this.stats.processed += 1;
        patchSummary({ started: this.stats.startedAt, done: this.stats.done, failed: this.stats.failed, skipped: this.stats.skipped });
        this.push();

        // 连续失败过多 → 全局暂停
        if (this.stats.consecutiveFail >= CONSECUTIVE_FAIL_LIMIT) {
          log(`连续 ${this.stats.consecutiveFail} 个任务点失败，已全局暂停。请检查后手动继续。`, 'error');
          this.stats.paused = true;
          this.stats.pauseReason = `连续 ${this.stats.consecutiveFail} 个失败`;
          break;
        }
      }
    } finally {
      this.running = false;
      this.stats.current = null;
      this.stats.endedAt = Date.now();
      saveState();
      this.push();
      log(
        `批量执行结束：完成 ${this.stats.done} · 失败 ${this.stats.failed} · 跳过 ${this.stats.skipped}` +
          ` · 待人工 ${this.stats.handbook}`,
        'ok',
      );
      /*
       * 跳过原因单独汇总 —— 用户最关心的是"有没有重复劳动"：
       * "跳过"里既有"学习通上早就完成了"（好事），也有"被你的勾选排除"（另一回事）。
       * 不区分的话，看到一串"跳过"反而会怀疑是不是漏做了。
       */
      const sk = this.stats.skipReasons || {};
      const detail = [
        sk.state ? `本地记录已完成 ${sk.state}` : '',
        sk.manifest ? `侦察时已完成 ${sk.manifest}` : '',
        sk['task-point'] ? `学习通上已完成 ${sk['task-point']}` : '',
        sk['section-green'] ? `整节已完成 ${sk['section-green']}` : '',
      ].filter(Boolean);
      if (detail.length) log(`  其中跳过原因：${detail.join(' · ')}（都不会重做）`, 'info');
      log('='.repeat(60), 'info');
    }

    return { started: true, stats: { ...this.stats } };
  }

  snapshot() {
    return {
      running: this.running,
      stopRequested: this.stopRequested,
      stats: { ...this.stats },
    };
  }

  push() {
    if (this.onUpdate) {
      try {
        this.onUpdate(this.snapshot());
      } catch {
        /* 推送失败不影响执行 */
      }
    }
  }
}

export const batchRunner = new BatchRunner();

/**
 * 从清单构造执行任务列表（保持用户排序）。
 */
export function buildRunTasks(checklist) {
  const out = [];
  for (const c of checklist.courses) {
    if (c.empty || c.enabled === false) continue;
    for (const t of c.tasks) out.push({ ...t, courseName: c.name });
  }
  return out;
}

export { nextPending, loadState };
