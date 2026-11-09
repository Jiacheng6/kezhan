import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import type { Question, QuestionType } from '../../types/domain.js';

/**
 * SCO 模板解析。
 *
 * 现实情况是**两套课件并存**（附录 C-4）：
 *
 * 1. courseware 新课件（本账号课程）：题目用 `data-controltype` / `data-itemtype` 标记
 *    ```html
 *    <div data-controltype="choice" data-id="u3_5_1">
 *      <ul data-itemtype="options">
 *        <li><span>T</span></li>
 *        <li data-solution=""><span>F</span></li>   <!-- 正确项标记，值为空 -->
 *      </ul>
 *      <div data-itemtype="result"></div>
 *    </div>
 *    ```
 * 2. legacy 老课件：`<et-blank answer="...">` 这类自定义标签（规格 §5.2 描述的形态）
 *
 * 两套都实现，按「解析出题数更多」的策略择优，避免绑定单一课程。
 */

export type ParseStrategy = 'courseware' | 'legacy' | 'none';

export interface ScoParseResult {
  questions: Question[];
  /** 识别到但跳过的口语/录音题数 */
  oral: number;
  strategy: ParseStrategy;
  warnings: string[];
}

const CONTROL_TYPE_MAP: Record<string, QuestionType> = {
  filling: 'blank',
  fillinglong: 'blank',
  fill: 'blank',
  fillin: 'blank',
  blank: 'blank',
  choice: 'choice',
  select: 'choice',
  radio: 'choice',
  checkbox: 'choice',
  multi: 'choice',
  multiple: 'choice',
  tof: 'tof',
  truefalse: 'tof',
  matching: 'match',
  match: 'match',
  ordering: 'order',
  order: 'order',
  sort: 'order',
  sequence: 'order',
};

const LEGACY_TYPE_MAP: Record<string, QuestionType> = {
  blank: 'blank',
  fill: 'blank',
  fillin: 'blank',
  tof: 'tof',
  truefalse: 'tof',
  choice: 'choice',
  select: 'choice',
  multi: 'choice',
  multiple: 'choice',
  checkbox: 'choice',
  match: 'match',
  matching: 'match',
  order: 'order',
  sort: 'order',
  sequence: 'order',
};

/** 口语/录音题关键词。刻意不含 audio —— 听力题通常带答案，仍需提交 */
const ORAL_KEYWORDS = ['speak', 'voice', 'record', 'oral', 'pron', 'repeat', 'readaloud'];

function looksOral(text: string): boolean {
  const lower = text.toLowerCase();
  return ORAL_KEYWORDS.some((k) => lower.includes(k));
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 取选项字母。三种真实形态都要兼容：
 * - `<li><span>T</span></li>`                      → "T"
 * - `<li><span><span>A.</span></span><span>…</span></li>` → "A"
 * - 无字母前缀的选项（选词填空）                    → 退回全文
 */
function optionLabel(li: Cheerio<Element>): string {
  const spans = li.children('span');
  if (spans.length >= 2) {
    const head = clean(spans.first().text());
    const m = /^([A-Za-z])[.、)．]?$/.exec(head);
    if (m?.[1]) return m[1].toUpperCase();
  }

  const full = clean(li.text());
  const single = /^([A-Za-z])[.、)．]?$/.exec(full);
  if (single?.[1]) return single[1].toUpperCase();
  return full;
}

/**
 * 填空答案的取值规则（附录 C-6，基于 9 份真实模板统计得出）：
 *
 * | 形态                                   | 权威字段                    |
 * | -------------------------------------- | --------------------------- |
 * | result 与 data-solution 相同            | 任意                        |
 * | result = solution + 中文注释            | data-solution（去注释）      |
 * | solution = `a/b`，result 为其中一段      | 与 result 相同的那一段      |
 * | result 为空（长填空）                    | data-solution               |
 *
 * 也就是说 `/` 表示「多个可接受答案」，不是「题干/空位」分隔。
 */
function stripAnnotation(text: string): string {
  return text.replace(/\s*[（(][^（）()]*[）)]\s*$/u, '').trim();
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function reconcileBlankAnswer(solution: string, result: string): string {
  const sol = clean(solution);
  const res = clean(result);

  if (!sol) return res;
  if (!res) return sol;

  const segments = sol.includes('/')
    ? sol
        .split('/')
        .map((s) => clean(s))
        .filter((s) => s.length > 0)
    : [];
  const resStripped = stripAnnotation(res);

  if (segments.length > 0) {
    const hit = segments.find((s) => sameText(s, res)) ?? segments.find((s) => sameText(s, resStripped));
    if (hit) return hit;
  }

  if (sameText(sol, resStripped)) return resStripped;
  if (sameText(sol, res)) return res;

  return res;
}

/** 每个填空块产出至多一个答案：input/textarea 的 data-solution + result 文本 */
function blankAnswer(block: Cheerio<Element>): string | null {
  const solution = block.find('input[data-solution], textarea[data-solution]').first().attr('data-solution') ?? '';
  const result = block.find('[data-itemtype="result"]').first().text() ?? '';
  const answer = reconcileBlankAnswer(solution, result);
  return answer.length > 0 ? answer : null;
}

function choiceAnswers($: CheerioAPI, block: Cheerio<Element>): string[] {
  const labels: string[] = [];
  const blockEl = block.get(0);

  block.find('[data-solution]').each((_, el) => {
    const node = $(el);
    // 只采集属于本块的元素，避免父块把内嵌子题的答案也算进来
    if (node.closest('[data-controltype]').get(0) !== blockEl) return;

    const label =
      node.prop('tagName')?.toLowerCase() === 'li'
        ? optionLabel(node as Cheerio<Element>)
        : clean(node.text());
    if (label.length > 0) labels.push(label);
  });

  return labels;
}

function parseCourseware(
  $: CheerioAPI,
  skipOral: boolean,
): { questions: Question[]; oral: number; warnings: string[] } {
  const questions: Question[] = [];
  const warnings: string[] = [];
  let oral = 0;

  $('[data-controltype]').each((_, el) => {
    const block = $(el);
    const rawType = (block.attr('data-controltype') ?? '').trim().toLowerCase();
    const type = CONTROL_TYPE_MAP[rawType];

    // 口语题常常是自定义 controltype（如 record / speak），映射表里没有，
    // 所以先判断口语再判断题型，否则会被当成未知块直接跳过
    const isOral = looksOral(rawType) || (type !== undefined && looksOral(block.attr('class') ?? ''));

    if (isOral) {
      // --keep-oral-questions 时尽力从块里捞答案：有的录音题仍带 result 文本
      const recovered = skipOral ? null : recoverOralAnswer($, block, type);
      if (recovered) {
        questions.push(recovered);
      } else {
        oral++;
      }
      return;
    }

    if (!type) return;

    if (type === 'blank') {
      const answer = blankAnswer(block);
      if (!answer) {
        warnings.push(`填空块 ${block.attr('data-id') ?? '(无 id)'} 没有解析到答案`);
        return;
      }
      questions.push({ type: 'blank', answer, tag: rawType });
      return;
    }

    const labels = choiceAnswers($, block);
    if (labels.length === 0) {
      warnings.push(`选择块 ${block.attr('data-id') ?? '(无 id)'} 没有 data-solution 选项`);
      return;
    }

    // 选项只有 T/F 时归一成判断题，其余保持选择
    const isTof = labels.length === 1 && labels.every((l) => l === 'T' || l === 'F') && isBinaryOptions($, block);
    questions.push({
      type: isTof ? 'tof' : type,
      answer: labels.join(','),
      tag: rawType,
    });
  });

  return { questions, oral, warnings };
}

/**
 * `--keep-oral-questions` 时尽力从口语块里捞一个可提交的答案。
 * 口语题大多没有文本答案，捞不到就仍然跳过（不给平台提交垃圾数据）。
 */
function recoverOralAnswer(
  $: CheerioAPI,
  block: Cheerio<Element>,
  type: QuestionType | undefined,
): Question | null {
  const rawType = (block.attr('data-controltype') ?? '').trim().toLowerCase();

  const blank = blankAnswer(block);
  if (blank) return { type: 'blank', answer: blank, tag: rawType };

  const labels = choiceAnswers($, block);
  if (labels.length > 0) return { type: type ?? 'choice', answer: labels.join(','), tag: rawType };

  return null;
}

function isBinaryOptions($: CheerioAPI, block: Cheerio<Element>): boolean {  const options = block.find('li');
  if (options.length !== 2) return false;
  return options.toArray().every((el) => {
    const t = clean($(el).text()).toUpperCase();
    return t === 'T' || t === 'F' || t === 'TRUE' || t === 'FALSE';
  });
}

function parseLegacy($: CheerioAPI): { questions: Question[]; oral: number; warnings: string[] } {
  const questions: Question[] = [];
  const warnings: string[] = [];
  let oral = 0;

  $('*').each((_, el) => {
    const node = $(el);
    const tag = (node.prop('tagName') ?? '').toLowerCase();
    if (!tag.startsWith('et-')) return;

    const short = tag.slice(3);
    const attrs: Record<string, string> = (el as Element).attribs ?? {};
    const attrText = Object.entries(attrs)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');

    if (looksOral(short) || looksOral(attrText)) {
      oral++;
      return;
    }

    let type = LEGACY_TYPE_MAP[short];
    const direct = (name: string): string => clean(attrs[name] ?? '');

    let answer = '';
    if (type === 'blank') {
      answer = direct('answer') || direct('data-answer') || clean(node.text());
    } else {
      answer = direct('key') || direct('answer') || direct('data-answer') || direct('value');
    }

    if (answer.length === 0) return;
    if (!type) {
      type = 'choice';
      warnings.push(`未知题型 <${tag}> 有答案，按 choice 透传`);
    }

    // 多选 "ABC" → "A,B,C"
    if (type === 'choice' && /^[A-Z]{2,8}$/.test(answer)) {
      answer = answer.split('').join(',');
    }

    questions.push({ type, answer, tag: short });
  });

  return { questions, oral, warnings };
}

export interface ParseOptions {
  /**
   * 是否跳过口语/录音题，默认 true。
   * false 时尝试从口语块里捞可提交的答案（捞不到仍跳过）。
   */
  skipOral?: boolean;
}

export function parseSco(html: string, opts: ParseOptions = {}): ScoParseResult {
  if (!html || html.trim().length === 0) {
    return { questions: [], oral: 0, strategy: 'none', warnings: ['模板为空'] };
  }

  const skipOral = opts.skipOral ?? true;
  const $ = load(html);
  const courseware = parseCourseware($, skipOral);
  const legacy = parseLegacy($);

  const preferCourseware = courseware.questions.length >= legacy.questions.length;

  if (courseware.questions.length === 0 && legacy.questions.length === 0) {
    return {
      questions: [],
      oral: courseware.oral + legacy.oral,
      strategy: 'none',
      warnings: [...courseware.warnings, ...legacy.warnings],
    };
  }

  return preferCourseware
    ? {
        questions: courseware.questions,
        oral: courseware.oral,
        strategy: 'courseware',
        warnings: courseware.warnings,
      }
    : { questions: legacy.questions, oral: legacy.oral, strategy: 'legacy', warnings: legacy.warnings };
}
