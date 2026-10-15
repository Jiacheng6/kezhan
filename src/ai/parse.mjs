/**
 * 答案解析 + 可靠性分级 + 提交前防呆校验。
 *
 * 设计原则（对应用户第 13/17 问的安全阀）：
 *   - 只有**高可靠**的答案才允许自动提交
 *   - 出现"不确定 / 无法判断 / 图片不清 / 多候选"一律降级
 *   - 简答可填写正文草稿，必须人工核对；填空仍转人工
 *   - 提交前做防呆：答案必须与题目选项结构自洽，否则拒绝提交
 *
 * 分级：
 *   high   —— 唯一、明确、能精确映射到选项
 *   medium —— 能映射但有歧义（多候选、用了"应选/可能"等措辞）
 *   low    —— 不可靠（含不确定措辞、解析失败、填空题、答案不在选项里）
 */

/* ---------------- 不可靠信号 ---------------- */

/** 出现这些措辞 → 直接判 low */
const UNCERTAIN_PATTERNS = [
  /无法(确定|判断|识别|看清)/,
  /看不清|不清晰|模糊/,
  /图片(不清|不全|缺失|有问题)/,
  /题目(不全|缺失|不完整)/,
  /无法从(图片|图中)/,
  /抱歉|sorry/i,
  /不能确定|不确定/,
  /可能(是|为|选)/,
  /也许|大概|似乎|应该(是|选)/,
  /仅供参考/,
];

/**
 * 出现这些措辞 → 至少降为 medium。
 *
 * ⚠ 踩坑（2026-09-23）：早期这里是 `/之一|-{1,2}>|或者/`，
 * 结果**"三分之一"里的"之一"**把一条完全明确的判断题答案
 * （"答案 A、对 … 因此正确答案为『对』"）降级成 medium，
 * 于是安全阀把整道题判成"不可靠"，任务被挂起转人工。
 * 数值里的"之一"不是犹豫措辞 —— 必须要求它紧跟在**答案候选**后面。
 */
const HEDGE_PATTERNS = [
  /如果必须|若必须|建议选|倾向于|较为可能/,
  /(?:答案|选项|其中)\s*之一/,
  /[A-H]\s*(?:或|或者|\/|、)\s*[A-H]/,
  /-{1,2}>/,
];

/* ---------------- 答案解析 ---------------- */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const MAX_ESSAY_LENGTH = 10000;

export function normalizeEssayText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000\u200b\ufeff]/g, '').trim();
}

export function parseEssayAnswer(rawAnswer) {
  const raw = String(rawAnswer || '');
  let textAnswer = normalizeEssayText(raw);
  textAnswer = textAnswer.replace(/^```(?:text|plaintext|markdown)?\s*\n([\s\S]*?)\n```$/i, '$1');
  textAnswer = normalizeEssayText(textAnswer.replace(/^(?:参考)?答案\s*[:：]\s*/, ''));
  const result = { confidence: 'low', letters: [], reason: '', raw, textAnswer, canFill: false, requiresReview: true };
  if (!textAnswer) { result.reason = '简答正文为空'; return result; }
  if (textAnswer.length > MAX_ESSAY_LENGTH) { result.reason = '简答正文过长，请人工处理'; return result; }
  if (/千问调用失败|未取到回答|图片上传失败/.test(textAnswer)) { result.reason = '未取得可用的简答正文'; return result; }
  // 正文中的“不确定性”等概念不代表模型拒答；仅拦截无法读取/回答题目的说明。
  for (const re of [/无法(确定|判断|识别|作答|回答|看清)/, /看不清|图片(?:不清|不全|缺失|有问题)|题目(?:不全|缺失|不完整)/,
    /^(?:抱歉|sorry|我不确定)/i, /不确定(?:答案|该题|正确答案)/]) {
    if (re.test(textAnswer)) { result.reason = '简答回答含不确定或无法作答的说明，请人工处理'; return result; }
  }
  result.confidence = 'medium';
  result.canFill = true;
  result.reason = '简答正文可填写为草稿，内容需人工核对后提交';
  return result;
}

/**
 * 从文本里提取候选答案，并**分级**。
 *
 * 关键教训：早先用一组正则把所有匹配收进数组再"取最后一个"，
 * 结果「答案：AB」会同时匹配到 AB（贪婪吃两个）和 A（备选分支），
 * 数组变成 ["AB","A"]，"取最后"反而丢掉了正确的 AB、还误判为"多候选"。
 *
 * 所以改为按优先级分层：显式声明（答案：/应选：）最高优先，
 * 只有完全没有显式声明时才退到"整行只有字母"。
 *
 * @returns {{tier:'explicit'|'list'|'bare', letters:string, text:string}[]}
 */
function extractCandidates(text) {
  const out = [];

  // 第 1 层：显式声明（最可信）
  // 字母表支持「连写 AB」和「分隔 A、B、C」两种形态：
  //   [A-H] 后面跟 (分隔符 + 字母) 或直接跟字母，都算
  const LETTERS_RE = '([A-H](?:(?:\\s*[,、，和及\\/]\\s*|(?=[A-H]))[A-H])*)';
  const explicit = [
    new RegExp(`(?:正确)?(?:答案|正确选项|参考答案)\\s*(?:是|为)?\\s*[:：]?\\s*${LETTERS_RE}`, 'gi'),
    new RegExp(`应\\s*选\\s*${LETTERS_RE}`, 'gi'),
    new RegExp(`选\\s*(?:择|项)?\\s*[:：]\\s*${LETTERS_RE}`, 'gi'),
  ];
  for (const re of explicit) {
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push({ tier: 'explicit', letters: m[1].replace(/[^A-Za-z]/g, '').toUpperCase(), text: m[0].trim() });
    }
  }
  if (out.length) return out;

  // 第 2 层：结论句里的连续字母（如 "因此选 AB"）
  const listRe = /(?:因此|所以|综上|故)\s*(?:应|选|选择)?\s*[:：]?\s*([A-H]{1,6})(?![\u4e00-\u9fa5A-Za-z])/gi;
  let m2;
  while ((m2 = listRe.exec(text)) !== null) {
    out.push({ tier: 'list', letters: m2[1].toUpperCase(), text: m2[0].trim() });
  }
  if (out.length) return out;

  // 第 3 层：整行只有字母（兜底，最不可信）
  const bareRe = /^[ \t]*([A-H]{1,6})[ \t]*$/gim;
  let m3;
  while ((m3 = bareRe.exec(text)) !== null) {
    out.push({ tier: 'bare', letters: m3[1].toUpperCase(), text: m3[0].trim() });
  }
  return out;
}

/** 提取判断题的对错 */
function findJudgeAnswer(text) {
  /*
   * 关键教训：不能按"先试错误分支、再试正确分支"的顺序匹配。
   * 「这一表述不正确的」里，"正确"是"不正确"的子串，
   * 若"正确"分支先命中就会把答案判反 —— 这是最危险的错误类型。
   *
   * 正确做法：找出所有候选匹配，取**位置最靠前**的；同一位置取**更长**的
   * （即"不正确"优先于"正确"）。
   */
  // 注意词表要同时覆盖「对/错」（用户提问里指定的回答格式）与「正确/错误」
  const NEG = '不正确|错误|不对|错|×|✗|✘';
  const POS = '正确|对|√|✓|✔';
  const re = new RegExp(
    `(?:表述|说法|题目|陈述|观点|这句话|判断|结论|答案)\\s*(?:是|为)?\\s*[:：是为]?\\s*(${NEG}|${POS})`,
    'g',
  );

  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    hits.push({ index: m.index, raw: m[1], full: m[0] });
  }

  if (hits.length) {
    // 位置最靠前优先；同位置取更长的（不正确 > 正确）
    hits.sort((a, b) => a.index - b.index || b.raw.length - a.raw.length);
    const best = hits[0].raw;
    return /不正确|错误|不对|错|×|✗|✘/.test(best) ? '错' : '对';
  }

  // 兜底：全文只出现一种表述
  const hasWrong = /(不正确|错误|不对|错|×|✗|✘)/.test(text);
  const hasRight = /(正确|对|√|✓|✔)/.test(text) && !hasWrong;
  if (hasWrong && !hasRight) return '错';
  if (hasRight && !hasWrong) return '对';
  return null;
}

/**
 * 把 AI 回答解析成结构化答案。
 *
 * @param {string} rawAnswer 千问原始回答
 * @param {object} question quiz.mjs 提取出的题目对象
 * @returns {{confidence:'high'|'medium'|'low', letters:string[], judge?:string, reason:string, raw:string}}
 */
export function parseAnswer(rawAnswer, question) {
  if (question.qtype === 'essay') return parseEssayAnswer(rawAnswer);
  const raw = String(rawAnswer || '');
  const text = raw.trim();
  const result = { confidence: 'low', letters: [], judge: undefined, reason: '', raw };

  if (!text) {
    result.reason = '回答为空';
    return result;
  }

  // 1) 不确定信号 → 直接 low
  for (const re of UNCERTAIN_PATTERNS) {
    if (re.test(text)) {
      result.reason = `回答含不确定措辞（匹配 ${re}）`;
      return result;
    }
  }

  const availableLetters = (question.options || [])
    .map((o) => String(o.letter || '').toUpperCase())
    .filter((l) => /^[A-H]$/.test(l));

  const qtype = question.qtype;

  /* ---- 判断题 ---- */
  if (qtype === 'judge') {
    const j = findJudgeAnswer(text);
    if (!j) {
      result.reason = '未能从回答中判定对错';
      return result;
    }
    const norm = /对|正确|√|✓|T/i.test(j) ? '对' : '错';
    // 判断题的选项 data 是 true/false
    const opt = (question.options || []).find((o) =>
      norm === '对' ? /^true$/i.test(o.letter) || /对/.test(o.text) : /^false$/i.test(o.letter) || /错/.test(o.text),
    );
    if (!opt) {
      result.reason = `判定为「${norm}」但题目里找不到对应选项`;
      return result;
    }
    for (const re of HEDGE_PATTERNS) {
      if (re.test(text)) {
        result.confidence = 'medium';
        result.judge = norm;
        result.letters = [opt.letter];
        result.reason = '判定明确但回答含犹豫措辞';
        return result;
      }
    }
    result.confidence = 'high';
    result.judge = norm;
    result.letters = [opt.letter];
    result.reason = `明确判定为「${norm}」`;
    return result;
  }

  /* ---- 选择题（单选/多选）---- */
  if (qtype === 'single' || qtype === 'multiple' || qtype === 'unknown') {
    if (!availableLetters.length) {
      result.reason = '题目没有可选字母，无法映射';
      return result;
    }

    const candidates = extractCandidates(text);
    if (!candidates.length) {
      result.reason = '未能从回答中提取明确选项';
      return result;
    }

    // 只取最高层级的候选（explicit > list > bare），层内取最后一个（结论通常在最后）
    const topTier = candidates[0].tier;
    const sameTier = candidates.filter((c) => c.tier === topTier);
    const chosen = sameTier[sameTier.length - 1];

    const letters = [...new Set(chosen.letters.split(''))].filter((l) => availableLetters.includes(l));

    if (!letters.length) {
      result.reason = `提取到「${chosen.letters}」但不在题目选项 [${availableLetters.join(',')}] 内`;
      return result;
    }

    // 同层级出现多个**不同**的答案 → 多候选，降为 medium
    const distinct = [...new Set(sameTier.map((c) => c.letters))];
    const ambiguous = distinct.length > 1;

    // 多选题只给一个字母 → 可疑（可能是按单选回答的）
    const multiMismatch = qtype === 'multiple' && letters.length < 2;

    if (ambiguous) {
      result.confidence = 'medium';
      result.letters = letters;
      result.reason = `回答中出现多组候选同层级答案（${distinct.join(' / ')}），已取最后一组`;
      return result;
    }
    if (multiMismatch) {
      result.confidence = 'medium';
      result.letters = letters;
      result.reason = '多选题但只给出一个选项，可能是漏选';
      return result;
    }
    for (const re of HEDGE_PATTERNS) {
      if (re.test(text)) {
        result.confidence = 'medium';
        result.letters = letters;
        result.reason = '答案明确但含犹豫措辞';
        return result;
      }
    }
    result.confidence = 'high';
    result.letters = letters;
    result.reason = `明确给出选项 ${letters.join('')}（来源：${topTier}）`;
    return result;
  }

  /* ---- 填空仍转人工 ---- */
  if (qtype === 'fill') {
    result.reason = '填空题不做自动填写，转人工';
    return result;
  }

  result.reason = `不支持的题型：${qtype}`;
  return result;
}

/* ---------------- 提交前防呆校验 ---------------- */

/**
 * 校验解析结果是否可以安全提交。
 *
 * @param {object} parsed parseAnswer 的结果
 * @param {object} question 题目对象
 * @returns {{safe:boolean, errors:string[]}}
 */
export function validateBeforeSubmit(parsed, question) {
  const errors = [];
  if (question.qtype === 'essay') return { safe: false, errors: ['简答题需要人工核对后确认提交'], canFill: !!parsed.canFill };

  if (parsed.confidence === 'low') errors.push(`可靠性低：${parsed.reason}`);
  if (!parsed.letters.length) errors.push('没有解析出任何选项');

  const available = (question.options || [])
    .map((o) => String(o.letter || '').toUpperCase())
    .filter((l) => /^[A-H]$/.test(l));
  const availableJudge = (question.options || []).map((o) => String(o.letter || ''));

  for (const l of parsed.letters) {
    const ok =
      available.includes(String(l).toUpperCase()) || availableJudge.includes(String(l));
    if (!ok) errors.push(`选项 ${l} 不在题目选项中`);
  }

  if (question.qtype === 'multiple' && parsed.letters.length < 2) {
    errors.push('多选题选中项少于 2 个');
  }
  if (question.qtype === 'single' && parsed.letters.length > 1) {
    errors.push('单选题选中项多于 1 个');
  }
  if (question.qtype === 'judge' && parsed.letters.length !== 1) {
    errors.push('判断题选中项不是 1 个');
  }

  return { safe: errors.length === 0, errors };
}

/** 人类可读的分级标签 */
export function confidenceLabel(c) {
  return { high: '🟢 高', medium: '🟡 中', low: '🔴 低' }[c] || c;
}

/**
 * 生成一次答题的完整留档记录（对应安全阀 2：提交前强制留档）。
 */
export function buildArchive({ question, imagePath, aiAnswer, parsed, validation, action, note }) {
  return {
    at: new Date().toISOString(),
    questionIndex: question.index,
    questionId: question.questionId || '',
    qtype: question.qtype,
    qtypeRaw: question.qtypeRaw,
    options: (question.options || []).map((o) => ({ letter: o.letter, text: o.text })),
    stemTextRaw: question.stemTextRaw,
    imagePath,
    aiAnswerRaw: aiAnswer,
    parsed: {
      confidence: parsed.confidence,
      letters: parsed.letters,
      judge: parsed.judge,
      textAnswer: parsed.textAnswer,
      requiresReview: !!parsed.requiresReview,
      reason: parsed.reason,
    },
    validation,
    action,
    note: note || null,
  };
}
