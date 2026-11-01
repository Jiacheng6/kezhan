/**
 * AI 网页通道的「状态自愈」策略 —— 纯函数，可离线测试。
 *
 * 背景（用户实测反馈 2026-11-01）：
 *   "运行一段时间，前面好好的，答题都行，后面就不行了，一直报错，重试也不管用，
 *    有时我手动做完提交后，又恢复，然后重复上述步骤。"
 *
 * 日志证据（logs/run-*.jsonl）：
 *   ⛔ 豆包输入区已有附件，请先处理原草稿，避免混入其他题目     ×9
 *   ✗ 题目字体加载失败，请刷新题目后重试                     ×8
 *   ⛔ DeepSeek本次回答未能确认 / AI请求失败（answer-not-confirmed）
 *   ✗ API 未返回可读取的回答（api-empty）
 *
 * 这些失败的共同点：**原因在页面状态，不在题目**。
 * 而旧的"重试"只是把同一个 ask 再跑一遍，不清附件、不换会话、不重载页面 ——
 * 于是每次重试都撞同一堵墙，直到"连续失败 → 全局暂停"。
 *
 * 本模块只做判定，不做页面操作：
 *   · shouldResetSession()  这次失败是否意味着"下次必须先清页面"
 *   · sessionAction()       根据上一次结果决定下一次 ask 怎么开（重载/新对话/照常）
 *   · planComposerReset()   输入区有残留时该清什么、还是拒绝
 */

/** 这些错误码意味着"页面/会话状态坏了"，下次必须换一个干净起点 */
const RESET_CODES = new Set([
  'draft-attachment', // 输入区残留附件
  'draft-not-empty', // 输入框残留草稿
  'upload-not-ready', // 附件没上传完成
  'send-failed', // 点了发送但没发出去
  'answer-not-confirmed', // 回答没确认到（可能停在半截）
  'api-empty', // API 空回答（多数是上下文太脏）
  'conversation-unavailable', // 原对话打不开
]);

/**
 * @param {{errorCode?:string, error?:string}} o
 * @returns {boolean}
 */
export function shouldResetSession({ errorCode = '', error = '' } = {}) {
  if (RESET_CODES.has(String(errorCode || '').trim())) return true;
  // 错误码缺失时退回看文案（老调用方可能只给 error）
  return /已有附件|已有草稿|未能确认|未返回可读取|上传未完成|发送失败/i.test(String(error || ''));
}

/**
 * 依据"上一次的结果"决定这一次 ask 的起手式。
 *
 * @param {object} o
 * @param {boolean} [o.lastFailed] 上一次是否失败
 * @param {string} [o.lastCode] 上一次的错误码
 * @param {number} [o.sameCount] 同一错误码连续出现几次
 * @param {boolean} [o.resetFlag] 外部（上一次调用）标记的"必须重置"
 * @returns {{reload:boolean, freshChat:boolean, clearComposer:boolean, reason:string}}
 */
export function sessionAction({ lastFailed = false, lastCode = '', sameCount = 0, resetFlag = false } = {}) {
  const needReset = resetFlag || (lastFailed && shouldResetSession({ errorCode: lastCode }));
  if (!needReset) return { reload: false, freshChat: false, clearComposer: false, reason: '' };
  // 同一错误连续 2 次以上：连"清一下"都不够，直接换页面（重载 + 新对话）
  const hard = sameCount >= 2;
  return {
    reload: true,
    freshChat: true,
    clearComposer: true,
    reason: hard
      ? `同一错误（${lastCode || '未知'}）已连续 ${sameCount} 次，本次重载页面并新建对话`
      : `上次失败与页面状态有关（${lastCode || '未知'}），本次先清理输入区再问`,
  };
}

/** 记一次结果，返回新的会话记忆（纯函数，便于测试） */
export function nextSessionMemory(memory = {}, { ok = false, errorCode = '' } = {}) {
  const code = String(errorCode || '');
  if (ok) return { lastFailed: false, lastCode: '', sameCount: 0, resetFlag: false };
  const same = memory.lastCode && memory.lastCode === code ? (memory.sameCount || 0) + 1 : 1;
  return {
    lastFailed: true,
    lastCode: code,
    sameCount: same,
    resetFlag: shouldResetSession({ errorCode: code }),
  };
}

/**
 * 输入区有残留时怎么办。
 *
 * 原则：**能清就清，不能清才拒绝**；但绝不动用户自己敲的内容。
 *
 * @param {object} o
 * @param {boolean} o.hasAttachment 输入区是否已有附件
 * @param {string} [o.editorText] 输入框现有文本
 * @param {boolean} [o.editorIsOwnDraft] 现有文本是否就是本次要发的提问（我们上一轮的残留）
 * @returns {{action:'none'|'clear-attachment'|'clear-editor'|'clear-all'|'refuse', ok:boolean, reason:string}}
 */
export function planComposerReset({ hasAttachment = false, editorText = '', editorIsOwnDraft = false } = {}) {
  const hasText = !!String(editorText || '').trim();
  if (!hasAttachment && !hasText) return { action: 'none', ok: true, reason: '输入区是干净的' };
  if (hasText && !editorIsOwnDraft) {
    return { action: 'refuse', ok: false, reason: '输入框里有你自己的内容，不覆盖' };
  }
  if (hasAttachment && hasText) return { action: 'clear-all', ok: true, reason: '清掉上次残留的附件和提问文本' };
  if (hasAttachment) return { action: 'clear-attachment', ok: true, reason: '清掉上次残留的附件' };
  return { action: 'clear-editor', ok: true, reason: '清掉上次残留的提问文本' };
}
