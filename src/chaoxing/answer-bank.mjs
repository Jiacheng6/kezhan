import { randomInt, randomUUID } from 'node:crypto';
import { embedded, embeddedRequest } from '../browser/embedded.mjs';
import { throwIfStopped, waitForRead } from '../control.mjs';

const types = { single: 0, multiple: 1, fill: 2, judge: 3 };
const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
const yes = new Set(['对', '正确', '是', 'true', '√']);
const no = new Set(['错', '错误', '否', 'false', '×']);

function truth(value) {
  const text = clean(value).toLowerCase();
  if (yes.has(text)) return true;
  if (no.has(text)) return false;
  return null;
}

export function bankAnswer(reply, question) {
  if (reply.kind !== 'candidate') return reply;
  // Formula spelling is significant: NFKC would turn x² into x2. Keep the
  // exact provider-compatible representation, never use a similarity score
  // to approve a different formula or a different resource URL.
  const compare = question.bankFormat === 'legacy-math' ? value => String(value ?? '').trim() : clean;
  if (!compare(reply.stem) || compare(reply.stem) !== compare(question.bankStem ?? question.stemTextRaw)) return { kind: 'unusable' };
  if (question.qtype === 'fill') {
    const blanks = reply.answer.split('#!#').map(part => part.trim());
    return blanks.length === question.bankBlankCount && blanks.every(Boolean) ? { kind: 'hit', blanks } : { kind: 'unusable' };
  }
  let options;
  if (question.qtype === 'judge') {
    const expected = truth(reply.answer);
    if (expected === null) return { kind: 'unusable' };
    options = question.options.filter(option => (truth(option.letter) ?? truth(option.text)) === expected);
    if (options.length !== 1) return { kind: 'unusable' };
  } else {
    if (question.bankFormat === 'legacy-math' && question.qtype === 'multiple' &&
        question.options.some(option => (option.bankAnswerKeys || [option.bankText]).some(key => key?.includes('#')))) return { kind: 'unusable' };
    const parts = question.qtype === 'multiple' ? reply.answer.split('#') : [reply.answer];
    if (parts.length < (question.qtype === 'multiple' ? 2 : 1)) return { kind: 'unusable' };
    options = [];
    for (const part of parts) {
      if (!clean(part)) return { kind: 'unusable' };
      const matches = question.options.filter(option => (question.bankFormat === 'legacy-math'
        ? option.bankAnswerKeys || [option.bankText ?? option.text] : [option.bankText ?? option.text]).some(key => compare(key) === compare(part)));
      if (matches.length !== 1 || options.includes(matches[0])) return { kind: 'unusable' };
      options.push(matches[0]);
    }
  }
  const letters = options.map(option => option.letter);
  return letters.every(Boolean) && new Set(letters).size === letters.length ? { kind: 'hit', letters } : { kind: 'unusable' };
}

export function randomBankAnswer(question, pick = randomInt) {
  if (!['single', 'multiple', 'judge'].includes(question.qtype)) return null;
  const options = question.options.map(option => option.letter);
  if (options.length < 2 || options.some(letter => !letter) || new Set(options).size !== options.length) return null;
  const count = question.qtype === 'multiple' ? 2 + pick(options.length - 1) : 1;
  const letters = [];
  while (letters.length < count) letters.push(options.splice(pick(options.length), 1)[0]);
  return { kind: 'random', letters };
}

export function randomEligible(outcomes, total) {
  if (!Number.isInteger(total) || total < 1 || outcomes.length !== total) return false;
  return outcomes.every(kind => ['hit', 'miss', 'restored'].includes(kind)) && outcomes.filter(kind => kind === 'miss').length * 5 <= total;
}

export async function prepareBankAnswers(questions, reusable, { shouldStop, query = queryAnswerBank, onProgress } = {}) {
  const answers = new Map();
  let serviceDown = false;
  for (const question of questions) {
    throwIfStopped(shouldStop);
    if (reusable.has(question.index)) continue;
    onProgress?.(question);
    const response = serviceDown ? { kind: 'unavailable' } : await query(question, shouldStop);
    if (response.kind === 'unavailable') serviceDown = true;
    answers.set(question.index, response);
  }
  return answers;
}

export async function bankConfigured() {
  return embedded && Boolean((await embeddedRequest('bank-status').catch(() => null))?.configured);
}

async function queryAnswerBank(question, shouldStop) {
  if (!question.bankTextSafe) return { kind: 'unsupported', reason: question.bankTextIssue || 'question-text' };
  const type = Object.hasOwn(types, question.qtype) ? types[question.qtype] : undefined;
  if (type === undefined) return { kind: 'unsupported', reason: 'question-type' };
  const stem = question.bankStem ?? question.stemTextRaw;
  const options = question.options.map(option => option.bankText ?? option.text);
  if (!clean(stem) || (type === 2 && !question.bankBlankCount) ||
      (type < 2 && (options.length < 2 || options.some(option => !clean(option))))) return { kind: 'unsupported', reason: 'question-text' };
  const jobId = randomUUID();
  try {
    const response = await waitForRead(() => embeddedRequest('bank-query', {
      jobId, stem, type, blanks: question.bankBlankCount || 0, options,
    }), { shouldStop, timeoutMs: 6500, message: '题库查询超时' });
    throwIfStopped(shouldStop);
    return bankAnswer(response, question);
  } catch (error) {
    if (error.code === 'STOPPED') throw error;
    return { kind: 'unavailable' };
  } finally {
    void embeddedRequest('bank-cancel', { jobId }).catch(() => {});
  }
}
