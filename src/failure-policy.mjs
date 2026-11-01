/**
 * 失败分级与「该不该暂停整批」的策略 —— 纯函数，可离线单测。
 *
 * 为什么单独一层（用户实测反馈，2026-11-01）：
 *   旧逻辑里"连续 3 个任务点失败 → 全局暂停"是所有失败一视同仁的。
 *   但实测日志（logs/run-*.jsonl）显示，真正把计数喂满的多数是**环境性失败**：
 *
 *     ✗ 视频准备失败：读不到视频时长（duration）        ← 重试换个页面就成功
 *     ✗ elementHandle.screenshot: Timeout 30000ms       ← 页面没稳定/视图被隐藏
 *     ✗ 题目字体加载失败，请刷新题目后重试               ← 刷新一次就好
 *     ⛔ 豆包输入区已有附件，请先处理原草稿               ← 清理残留就好
 *     ⛔ DeepSeek本次回答未能确认 / API 未返回可读的回答  ← 换会话/重载就好
 *
 *   这些失败"重试本身没错，错在重试前没清理状态"，而且它们**不能代表任务真的做不了**。
 *   把它们的连击直接当成"任务失败"，后果就是用户看到的：
 *   "前面好好的，跑一会儿莫名暂停；重试也不管用；手动做完又恢复"。
 *
 * 所以拆成两条独立连击：
 *   · 真失败（real）      —— 连续 pauseAfterFailures（默认 3）个 → 暂停
 *   · 环境性失败（transient）—— 连续 pauseAfterTransient（默认 5）次 → 暂停
 *   任一条达成即暂停；成功会同时清零两条。
 */

/** 环境性失败的特征（按日志里出现过的真实文案写，宁可窄一点也别乱归类） */
const TRANSIENT_RULES = [
  /*
   * ⚠ 顺序有意义：更具体的规则必须排在前面。
   * 例如 "题目截图超时（题目字体尚未加载）" 同时命中"截图"和"字体"，
   * 它真正的成因是字体没就绪 —— 先判字体，才能给出可操作的 tag。
   */
  { tag: 'font-not-ready', re: /字体.*(加载|未就绪|失败)|fonts?\s*(not|load|ready)/i },
  { tag: 'screenshot-timeout', re: /screenshot.*timeout|截图.*超时|题目截图读取超时|题目截图超时/i },
  { tag: 'video-duration', re: /读不到视频时长|video.*duration/i },
  { tag: 'ai-draft', re: /draft-attachment|已有附件|输入框已有草稿|draft-not-empty/i },
  { tag: 'ai-answer-unconfirmed', re: /answer-not-confirmed|回答未能确认/i },
  { tag: 'ai-api-empty', re: /api-empty|未返回可读取的回答/i },
  { tag: 'ai-busy', re: /already-generating|仍在回答上一条/i },
  { tag: 'page-not-ready', re: /任务点列表尚未渲染|frame 未出现|no-video-element/i },
];

/**
 * 纯粹的"AI 还在忙"（不是需要人来处理的障碍）。
 *
 * 实测（2026-11-01 真机验证）：上一轮生成还没结束时提问，会拿到
 * `already-generating`，旧逻辑把它当 needs-human → **暂停整批**，
 * 5 道题全部变成空壳待审；而它通常几十秒就自己好了。
 * 所以这类只记「待续跑」，不暂停整批。
 *
 * @param {{aiErrorCode?:string, error?:string, needsHuman?:string}} r
 * @returns {boolean}
 */
export function isBusyOnlyFailure(r = {}) {
  const code = String(r.aiErrorCode || '');
  if (code === 'already-generating') return true;
  return /仍在回答上一条|正在回答上一条|还在生成|still generating/i.test(String(r.error || r.needsHuman || ''));
}

/**
 * 判断一次失败属于哪一类。
 *
 * @param {object} o
 * @param {string} [o.error] 失败文案
 * @param {string} [o.errorCode] 执行器给的错误码（如 aiErrorCode）
 * @returns {{kind:'transient'|'real', tag:string, reason:string}}
 */
export function classifyFailure({ error = '', errorCode = '' } = {}) {
  const text = `${errorCode || ''} ${error || ''}`.trim();
  if (!text) return { kind: 'real', tag: 'unknown', reason: '未给出失败原因' };
  for (const rule of TRANSIENT_RULES) {
    if (rule.re.test(text)) {
      return { kind: 'transient', tag: rule.tag, reason: `环境性失败（${rule.tag}）` };
    }
  }
  return { kind: 'real', tag: 'task-failed', reason: '任务本身失败' };
}

/**
 * 推进两条连击（成功即同时清零）。
 *
 * @param {object} o
 * @param {number} o.consecutiveFail 当前真失败连击
 * @param {number} o.consecutiveTransient 当前环境性失败连击
 * @param {'ok'|'failed'} o.outcome 本次结果
 * @param {'real'|'transient'} [o.failureKind] outcome=failed 时的分类
 * @returns {{consecutiveFail:number, consecutiveTransient:number}}
 */
export function advanceStreaks({
  consecutiveFail = 0,
  consecutiveTransient = 0,
  outcome = 'ok',
  failureKind = 'real',
} = {}) {
  if (outcome === 'ok') return { consecutiveFail: 0, consecutiveTransient: 0 };
  if (failureKind === 'transient') {
    return { consecutiveFail, consecutiveTransient: consecutiveTransient + 1 };
  }
  return { consecutiveFail: consecutiveFail + 1, consecutiveTransient };
}

/** 把设置里的阈值收进合法范围（防止用户填 0/100 把保护关死或天天暂停） */
function normalizeLimits(limits = {}) {
  const clamp = (v, def, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  return {
    pauseAfterFailures: clamp(limits.pauseAfterFailures, 3, 1, 10),
    pauseAfterTransient: clamp(limits.pauseAfterTransient, 5, 2, 20),
  };
}

/**
 * 是否该暂停整批。
 *
 * @param {object} o
 * @param {number} o.consecutiveFail
 * @param {number} o.consecutiveTransient
 * @param {object} [o.limits] { pauseAfterFailures, pauseAfterTransient }
 * @returns {{pause:boolean, kind?:'real'|'transient', reason?:string, limits:object}}
 */
export function pauseDecision({ consecutiveFail = 0, consecutiveTransient = 0, limits = {} } = {}) {
  const lim = normalizeLimits(limits);
  if (consecutiveFail >= lim.pauseAfterFailures) {
    return {
      pause: true,
      kind: 'real',
      reason: `连续 ${consecutiveFail} 个任务点失败（上限 ${lim.pauseAfterFailures}）`,
      limits: lim,
    };
  }
  if (consecutiveTransient >= lim.pauseAfterTransient) {
    return {
      pause: true,
      kind: 'transient',
      reason:
        `连续 ${consecutiveTransient} 次环境性失败（上限 ${lim.pauseAfterTransient}）：` +
        `截图超时/字体未就绪/草稿残留/视频元数据晚到这一类，重试前应先清理页面状态`,
      limits: lim,
    };
  }
  return { pause: false, limits: lim };
}

/**
 * 暂停原因的人话版本：带上最近几个失败的任务点，用户一眼知道该去处理哪几题。
 * （旧版只写"连续 3 个失败"，用户看到的就是"莫名暂停"。）
 *
 * @param {object} o
 * @param {string} o.reason 决策给出的原因
 * @param {Array<{secNo?:string,name?:string,tag?:string,error?:string}>} [o.recent]
 * @param {number} [o.max] 最多列几条
 */
export function formatPauseDetail({ reason = '', recent = [], max = 3 } = {}) {
  const items = (recent || [])
    .slice(-Math.max(1, max))
    .map((r) => {
      const where = [r.secNo, r.name].filter(Boolean).join(' ');
      const why = r.tag || r.error || '';
      return `${where}${where && why ? '：' : ''}${why}`.trim();
    })
    .filter(Boolean);
  return items.length ? `${reason}｜最近：${items.join('；')}` : reason;
}
