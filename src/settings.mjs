/**
 * 设置项的「规格 + 校验」（纯逻辑，可在 Node 里单测）。
 *
 * 为什么要单独一层：
 *   设置是**会直接改变行为**的东西（自动提交、提问节流、绿点等待时长…），
 *   界面能改之后就必须有人把关 —— 用户手抖输个 0 或 999999，
 *   轻则白等几小时，重则把千问账号送进风控。
 *   所以：每个键都有类型 + 范围 + 默认值，越界一律夹紧并明确告知，
 *   **未知键一律拒绝**（防止界面写错键名却毫无反馈）。
 */
import { DEFAULT_SETTINGS } from './config.mjs';

/**
 * 设置规格表。
 *   kind: 'select' | 'bool' | 'int' | 'number' | 'text' | 'textarea'
 *   min/max: 数值夹紧范围
 *   unit: 界面上的单位（数值会按 unitScale 换算显示）
 *   advanced: 是否折叠到"高级"里
 */
export const SETTING_SPEC = [
  {
    path: 'submitMode',
    label: '测验提交模式',
    kind: 'select',
    options: [
      ['manual', '人工确认（答案进待审队列，你点提交）'],
      ['auto', '自动提交（仅当全部题目都是高可靠答案）'],
    ],
    help: '简答题始终人工确认提交；低可靠/多候选答案也不会自动提交。',
  },
  { path: 'essayAutoFill', label: '简答题自动填写草稿', kind: 'bool', help: '填写后回读验证，进入待审队列；不会自动交卷。已有答案不覆盖。' },
  { path: 'essayPrompt', label: '简答题提问词', kind: 'textarea', advanced: true },
  { path: 'muted', label: '播放时静音', kind: 'bool', help: '关掉会外放声音。' },
  { path: 'maxRetries', label: '单个任务点失败重试次数', kind: 'int', min: 1, max: 10 },
  { path: 'maxCardProbe', label: '每个小节最多探几张卡片', kind: 'int', min: 1, max: 12, advanced: true, help: '小节是分卡片的，任务点可能在第 2 张卡上。' },
  {
    path: 'greenDotPatientMs',
    label: '播完后等绿点生效的最长时间',
    kind: 'int',
    min: 60000, // 1 分钟：再短没有意义（绿点延迟实测 11 秒到 3 分钟以上）
    max: 1800000,
    unit: '分钟',
    unitScale: 60000,
    step: 0.5,
  },
  { path: 'greenDotPatientStepMs', label: '绿点轮询间隔', kind: 'int', min: 2000, max: 60000, unit: '秒', unitScale: 1000, step: 1 },
  { path: 'docDwellSec', label: '文档/阅读类停留时长', kind: 'int', min: 3, max: 120, unit: '秒' },
  { path: 'quizSubmitTimeoutMs', label: '弹窗题提交后等待反馈上限', kind: 'int', min: 5000, max: 120000, unit: '秒', unitScale: 1000, step: 1, advanced: true },
  { path: 'ai.minIntervalMs', label: '两次问千问的最小间隔', kind: 'int', min: 5000, max: 600000, unit: '秒', unitScale: 1000, step: 1, help: '太短会触发阿里风控（滑块验证）。' },
  { path: 'ai.jitterMs', label: '随机抖动上限', kind: 'int', min: 0, max: 120000, unit: '秒', unitScale: 1000, step: 1, advanced: true },
  {
    path: 'ai.askRetries',
    label: '千问没回答时重新提问几次',
    kind: 'int',
    min: 0,
    max: 4,
    help: '千问卡住/没反应时，不干等也不放弃，而是重新提问（重新粘贴题目再发一次）。0 = 不重问。',
  },
  {
    path: 'ai.answerStuckMs',
    label: '多久没进展算"卡住"',
    kind: 'int',
    min: 15000,
    max: 300000,
    unit: '秒',
    unitScale: 1000,
    step: 5,
    help: '这段时间内既没有吐字、也没在生成中，就判定卡住并重新提问（不用等满总超时）。',
  },
  {
    path: 'ai.answerTimeoutMs',
    label: '单次提问最多等多久',
    kind: 'int',
    min: 60000,
    max: 900000,
    unit: '分钟',
    unitScale: 60000,
    step: 0.5,
    advanced: true,
    help: '正在正常生成时会一直等，直到这个上限。',
  },
  { path: 'ai.freshChatPerQuestion', label: '每道题都新建千问对话', kind: 'bool', advanced: true },
  { path: 'ai.stuckCooldownMs', label: '千问"卡住"时的冷却时间', kind: 'int', min: 30000, max: 1800000, unit: '分钟', unitScale: 60000, step: 0.5, advanced: true },
  { path: 'ai.consecutiveFailLimit', label: '千问连续失败几次就停批', kind: 'int', min: 1, max: 10, advanced: true },
  { path: 'homeworkModule', label: '处理独立作业模块', kind: 'bool', help: '默认关闭：作业通常只有一次提交机会。' },
  { path: 'cardsPopupWatch', label: '监听 cards 页老式弹窗', kind: 'bool', advanced: true, help: '视频内弹窗题走 .ans-videoquiz，与这个无关；默认关闭避免两套监听抢答。' },
  { path: 'quizPrompt', label: '问千问的提问词', kind: 'textarea', advanced: true },
  { path: 'qianwenUrl', label: '千问地址', kind: 'text', advanced: true },
];

/** 只读展示（不允许界面改，避免把安全边界改掉） */
export const READONLY_SPEC = [
  { path: 'progressThreshold', label: '完成阈值', hint: '必须播到片尾（约 99.9%）：学习通服务端比页面写的 90% 更严。' },
  { path: 'finishMarginSec', label: '距片尾多少秒算播完', hint: '默认 1 秒。' },
  { path: 'allowSeek', label: '允许拖拽进度条', hint: '永远关闭：学习通禁止拖拽，程序化 seek 会破坏这条视频。' },
  { path: 'greenDotRetries', label: '完成核对次数', hint: '与上面的"最长时间"配合。核对的是**本任务点**是否完成，不是小节绿点（小节要等所有任务点做完才绿）。' },
  { path: 'greenDotWaitMs', label: '完成核对间隔', hint: '' },
  { path: 'checkpointSec', label: '检查点落盘间隔', hint: '' },
];

/** 按点号路径删值（连带清掉空对象，保持配置文件干净） */
export function deleteByPath(obj, pathStr) {
  const keys = String(pathStr).split('.');
  const stack = [];
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (cur == null || typeof cur !== 'object') return obj;
    stack.push([cur, keys[i]]);
    cur = cur[keys[i]];
  }
  if (cur && typeof cur === 'object') delete cur[keys[keys.length - 1]];
  // 回收空对象
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const [parent, key] = stack[i];
    const child = parent[key];
    if (child && typeof child === 'object' && Object.keys(child).length === 0) delete parent[key];
  }
  return obj;
}

/** 按点号路径取值：'ai.minIntervalMs' → settings.ai.minIntervalMs */
export function getByPath(obj, pathStr) {
  return String(pathStr)
    .split('.')
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** 按点号路径写值（自动建中间对象） */
export function setByPath(obj, pathStr, value) {
  const keys = String(pathStr).split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

function specOf(pathStr) {
  return SETTING_SPEC.find((s) => s.path === pathStr) || null;
}

/**
 * 校验并归一化一份设置补丁。
 *
 * @param {object} patch 形如 { submitMode:'auto', 'ai.minIntervalMs': 60000 }
 *                       （界面按"点号路径"提交，省得处理嵌套）
 * @param {object} base 当前设置（缺省用 DEFAULT_SETTINGS）
 * @returns {{ok:boolean, settings:object, applied:object, errors:string[], rejected:string[]}}
 */
export function normalizeSettings(patch, base = DEFAULT_SETTINGS) {
  const settings = JSON.parse(JSON.stringify(base || DEFAULT_SETTINGS));
  const applied = {};
  const errors = [];
  const rejected = [];

  for (const [key, raw] of Object.entries(patch || {})) {
    const spec = specOf(key);
    if (!spec) {
      rejected.push(key);
      continue;
    }
    const want = raw;

    if (spec.kind === 'bool') {
      if (typeof want !== 'boolean') {
        errors.push(`${spec.label}：需要一个开关值`);
        continue;
      }
      setByPath(settings, key, want);
      applied[key] = want;
      continue;
    }

    if (spec.kind === 'select') {
      const allowed = spec.options.map(([v]) => v);
      if (!allowed.includes(want)) {
        errors.push(`${spec.label}：只能是 ${allowed.join(' / ')}`);
        continue;
      }
      setByPath(settings, key, want);
      applied[key] = want;
      continue;
    }

    if (spec.kind === 'int' || spec.kind === 'number') {
      let n = Number(want);
      if (!Number.isFinite(n)) {
        errors.push(`${spec.label}：不是有效数字（收到「${String(want).slice(0, 20)}」）`);
        continue;
      }
      // 界面按单位提交（如"分钟"），这里换算回毫秒/秒等内部单位
      if (spec.unitScale) n = n * spec.unitScale;
      if (spec.kind === 'int') n = Math.round(n);
      const clamped = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, n));
      if (clamped !== n) {
        const show = (v) => (spec.unitScale ? `${v / spec.unitScale}${spec.unit || ''}` : String(v));
        errors.push(`${spec.label}：超出范围，已夹到 ${show(clamped)}（允许 ${show(spec.min)} ~ ${show(spec.max)}）`);
      }
      setByPath(settings, key, clamped);
      applied[key] = clamped;
      continue;
    }

    // text / textarea
    const s = String(want ?? '');
    if (s.length > 4000) {
      errors.push(`${spec.label}：内容过长（上限 4000 字）`);
      continue;
    }
    setByPath(settings, key, s);
    applied[key] = s;
  }

  return { ok: errors.length === 0 && rejected.length === 0, settings, applied, errors, rejected };
}

/**
 * 界面要显示的值：按单位换算（毫秒 → 分钟/秒）。
 * @returns {Array<{path,label,kind,options?,unit,value,help,advanced,step,min,max}>}
 */
export function describeSettings(current = DEFAULT_SETTINGS) {
  const rows = [];
  for (const spec of SETTING_SPEC) {
    const raw = getByPath(current, spec.path);
    const value = spec.unitScale && raw != null ? raw / spec.unitScale : raw;
    rows.push({
      path: spec.path,
      label: spec.label,
      kind: spec.kind,
      options: spec.options || null,
      unit: spec.unit || '',
      step: spec.step ?? null,
      min: spec.min != null && spec.unitScale ? spec.min / spec.unitScale : (spec.min ?? null),
      max: spec.max != null && spec.unitScale ? spec.max / spec.unitScale : (spec.max ?? null),
      help: spec.help || '',
      advanced: !!spec.advanced,
      value,
      isDefault: JSON.stringify(raw) === JSON.stringify(getByPath(DEFAULT_SETTINGS, spec.path)),
    });
  }
  return rows;
}

/** 对比当前设置与默认值，列出被改过的键（界面用来提示"你改过这些"） */
export function diffFromDefault(current = DEFAULT_SETTINGS) {
  const out = [];
  for (const spec of SETTING_SPEC) {
    const cur = getByPath(current, spec.path);
    const def = getByPath(DEFAULT_SETTINGS, spec.path);
    if (JSON.stringify(cur) !== JSON.stringify(def)) {
      out.push({ path: spec.path, label: spec.label, current: cur, default: def });
    }
  }
  return out;
}

/**
 * 只保留"与默认值不同"的项，生成**稀疏**设置对象存盘。
 *
 * 为什么要稀疏：如果把合并后的整份设置都写进 state.json，
 * 等于把**今天的默认值钉死**了 —— 以后改了 DEFAULT_SETTINGS，
 * 用户那边永远不生效（因为文件里已经写满了旧值）。
 */
export function toSparseSettings(current = DEFAULT_SETTINGS, defaults = DEFAULT_SETTINGS) {
  const sparse = {};
  for (const spec of SETTING_SPEC) {
    const cur = getByPath(current, spec.path);
    const def = getByPath(defaults, spec.path);
    if (cur === undefined) continue;
    if (JSON.stringify(cur) !== JSON.stringify(def)) setByPath(sparse, spec.path, cur);
  }
  return sparse;
}
