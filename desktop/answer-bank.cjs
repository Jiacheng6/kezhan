const fs = require('node:fs');
const path = require('node:path');
const { renameWithRetry } = require('../src/atomic-file.cjs');
const BANK_ORIGIN = 'https://tk.wanjuantiku.com';

function bankOrigin(value) {
  const url = new URL(String(value || ''));
  if (url.origin !== BANK_ORIGIN || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('题库令牌仅可用于已核实的 AXE 服务地址');
  }
  return url.origin;
}

function classifyBankResponse(body) {
  if (!body || typeof body !== 'object' || ![0, 1, '0', '1'].includes(body.code)) return { kind: 'unusable' };
  const message = typeof body.msg === 'string' ? body.msg.trim() : '';
  if (/额度|余额|充值|次数不足|次数已用|激活|token|登录|限流|频繁|维护|暂停|网络/i.test(message)) return { kind: 'unavailable' };
  if (Number(body.code) === 0) {
    const noMatch = /^(?:未找到(?:该)?(?:题目|答案)|暂无(?:匹配)?(?:题目|答案)|题库未(?:收录|命中)|没有找到(?:匹配的)?(?:题目|答案))[。！!]?$/u.test(message);
    const belowMatch = /^相似度低于\d+(?:\.\d+)?%[：:]\s*\d+(?:\.\d+)?%$/u.test(message);
    return { kind: noMatch || belowMatch ? 'miss' : 'unusable' };
  }
  const candidates = body.data?.questions;
  if (!Array.isArray(candidates) || candidates.length !== 1) return { kind: 'unusable' };
  const { tm, answer, percent } = candidates[0] || {};
  if (typeof tm !== 'string' || tm.length > 10000 || typeof answer !== 'string' || !answer.trim() || answer.length > 4000 || message === 'ai') return { kind: 'unusable' };
  return { kind: 'candidate', stem: tm, answer, similarity: percent };
}

function createAnswerBank({ dataDir, safeStorage, fetchImpl = fetch, onQuota = () => {} }) {
  const file = path.join(dataDir, 'answer-bank.bin');
  const jobs = new Map();
  let quota = { kind: 'unknown' };
  let generation = 0;
  let lastUpdate = 0;
  let sequence = 0;
  let refresh;
  const updateQuota = (account, order, next) => {
    if (generation !== account || order < lastUpdate) return;
    lastUpdate = order;
    quota = { ...next, at: Date.now() };
    onQuota(quota);
  };
  const load = () => {
    if (!fs.existsSync(file)) return {};
    if (!safeStorage.isEncryptionAvailable()) throw new Error('本机加密暂不可用');
    try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(file))); }
    catch { throw new Error('无法读取已保存的题库配置，请重新配置'); }
  };
  const status = () => {
    const config = load();
    return { origin: config.origin || '', configured: Boolean(config.origin && config.token) };
  };
  const save = (patch = {}) => {
    const old = load();
    const origin = bankOrigin(patch.origin);
    const token = patch.clear ? '' : String(patch.token || (origin === old.origin ? old.token : '') || '').trim();
    if (!patch.clear && !/^[a-z0-9]{32}$/.test(token)) throw new Error('请输入服务方提供的 32 位题库令牌');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('本机加密暂不可用，未保存令牌');
    fs.mkdirSync(dataDir, { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, safeStorage.encryptString(JSON.stringify({ origin, token })));
    renameWithRetry(temporary, file);
    if (token !== old.token) {
      generation++;
      refresh = undefined;
      updateQuota(generation, ++sequence, { kind: token ? 'unknown' : 'unconfigured' });
    }
    return status();
  };
  function quotaStatus() {
    return status().configured ? quota : { kind: 'unconfigured' };
  }
  async function refreshQuota() {
    const { origin, token } = load();
    if (!origin || !token) return { kind: 'unconfigured' };
    if (refresh) return refresh;
    const account = generation;
    const order = ++sequence;
    const pending = (async () => {
      let result = { kind: 'unavailable' };
      try {
        const response = await fetchImpl(new URL('/api/checkLeft', bankOrigin(origin)), {
          method: 'POST', body: new URLSearchParams({ token }), redirect: 'error', signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          const reply = await response.json();
          if (reply?.needlogin === true || reply?.data === -1 || /从未在官网登录/.test(reply?.msg || '')) {
            result = { kind: 'needs-login' };
          } else if ([1, '1'].includes(reply?.code) && Number.isSafeInteger(reply.data) && reply.data >= 0) {
            result = { kind: 'known', left: reply.data };
          }
        }
      } catch { /* A failed check does not mean zero quota. */ }
      updateQuota(account, order, result);
      return quotaStatus();
    })();
    refresh = pending;
    try { return await pending; }
    finally { if (refresh === pending) refresh = undefined; }
  }
  async function query({ stem, type, options, blanks, jobId }) {
    const config = load();
    if (!config.origin || !config.token) return { kind: 'unavailable' };
    if (typeof stem !== 'string' || !stem.trim() || stem.length > 8000 || ![0, 1, 2, 3].includes(type) ||
        !Array.isArray(options) || options.length > 11 || options.some(option => typeof option !== 'string' || option.length > 1500) ||
        !Number.isInteger(blanks) || blanks < 0 || blanks > 50) return { kind: 'unusable' };
    const controller = new AbortController();
    const account = generation;
    const order = ++sequence;
    jobs.set(jobId, controller);
    try {
      const payload = new URLSearchParams({ token: config.token, tm: stem, type: String(type), options: JSON.stringify(options),
        answernum: String(blanks), questionnum: '1', ai: '0' });
      const response = await fetchImpl(new URL('/api/query?v=2', bankOrigin(config.origin)), {
        method: 'POST', body: payload, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) return { kind: 'unavailable' };
      const reply = await response.json();
      const result = classifyBankResponse(reply);
      const left = reply?.data?.lefts ?? reply?.left;
      if (Number.isSafeInteger(left) && left >= 0 && result.kind !== 'unusable') {
        updateQuota(account, order, { kind: 'known', left });
      } else if (result.kind === 'unavailable' && /(?:额度|余额|次数)(?:已用完|不足|耗尽)/.test(reply?.msg || '')) {
        updateQuota(account, order, { kind: 'exhausted' });
      }
      if (result.kind === 'candidate' && (result.stem.includes(config.token) || result.answer.includes(config.token))) return { kind: 'unusable' };
      return result;
    } catch {
      return { kind: 'unavailable' };
    } finally {
      jobs.delete(jobId);
    }
  }
  return { status, save, quotaStatus, refreshQuota, query, cancel: jobId => jobs.get(jobId)?.abort() };
}

module.exports = { BANK_ORIGIN, createAnswerBank, classifyBankResponse };
