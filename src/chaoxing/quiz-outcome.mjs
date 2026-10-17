// A failed AI request is never an answer. Keep a recoverable question even if
// the very first request failed, before any normal answer item was created.
export function pendingQuizItem(task, q, reason, extra = {}) {
  return {
    id: `${task.key}#q${q.index}`, taskKey: task.key,
    course: task.courseName || task.courseId, courseId: task.courseId,
    clazzId: task.clazzId, knowledgeId: task.knowledgeId,
    secNo: task.secNo, sectionName: task.sectionName,
    questionIndex: q.index, questionId: q.questionId || '', domIndex: q.domIndex,
    qtype: q.qtype, qtypeRaw: q.qtypeRaw,
    options: (q.options || []).map(o => ({ letter: o.letter, text: o.text })),
    aiAnswer: '', aiError: reason, aiErrorCode: 'not-attempted',
    confidence: 'none', confidenceLabel: '待处理', letters: [], textAnswer: '',
    requiresReview: true, autoFilled: false, filled: null,
    parseReason: reason, status: 'pending-review', ...extra,
  };
}

export function queueUnanswered(result, task, questions, reason) {
  for (const q of questions) {
    if (!result.items.some(item => item.questionIndex === q.index)) {
      result.items.push(pendingQuizItem(task, q, reason));
      result.queued += 1;
    }
  }
}

export const AI_BLOCK_CODES = new Set(['verification-required', 'rate-limited', 'not-logged-in', 'draft-not-empty', 'draft-attachment', 'already-generating', 'wrong-ai-page', 'editor-unavailable', 'upload-failed', 'upload-not-ready', 'send-failed', 'exception']);
