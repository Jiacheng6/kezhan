/**
 * 答案解析与分级 单元测试（纯逻辑，无需浏览器）。
 * 用法: node tools/test/test-parse.mjs
 */
import { parseAnswer, validateBeforeSubmit, confidenceLabel } from '../../src/ai/parse.mjs';

let pass = 0;
let fail = 0;

function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      实际: ${JSON.stringify(actual)}`);
    console.log(`      期望: ${JSON.stringify(expected)}`);
  }
}

/** 造题目的辅助 */
function q(qtype, letters) {
  return {
    index: 1,
    qtype,
    qtypeRaw: `【${{ single: '单选题', multiple: '多选题', judge: '判断题', fill: '填空题' }[qtype] || qtype}】`,
    options: letters.map((l, i) => ({
      letter: l,
      text: `选项${l}`,
      role: qtype === 'judge' ? 'radio' : 'checkbox',
    })),
    stemTextRaw: '（加密原文）',
  };
}

console.log('\n=== 判断题 ===');
// 这是千问对真实截图的回答（实测）
const realJudge = `人类发明技术的初衷是为了满足自身需求、解决实际问题，但随着技术的发展，它逐渐超越了单纯作为工具的角色，开始深刻地重塑人类的生活方式、社会结构乃至思维方式。技术不再是被动使用的工具，而是主动参与塑造人类生活的力量。
因此，"人类发明了技术，但是技术反过来重塑了我们的生活"这一表述是正确的。
答案：
A`;

{
  const r = parseAnswer(realJudge, q('judge', ['true', 'false']));
  eq('真实回答 → 判定为对', r.judge, '对');
  eq('真实回答 → 映射到 true', r.letters, ['true']);
  eq('真实回答 → 高可靠', r.confidence, 'high');
}

eq('「答案：错」→ 错', parseAnswer('答案：错', q('judge', ['true', 'false'])).judge, '错');
eq('「该说法是错误的」→ 错', parseAnswer('该说法是错误的。', q('judge', ['true', 'false'])).judge, '错');
eq('「表述不正确」→ 错', parseAnswer('因此这一表述不正确的。', q('judge', ['true', 'false'])).judge, '错');
eq('「答案：×」→ 错', parseAnswer('答案：×', q('judge', ['true', 'false'])).judge, '错');
eq('无法判定 → low', parseAnswer('嗯，这道题我想想。', q('judge', ['true', 'false'])).confidence, 'low');

console.log('\n=== 判断题：不确定措辞必须降级 ===');
for (const t of [
  '图片看不清，无法确定答案',
  '抱歉，我无法从图片中读取题目',
  '这可能是对的，也可能是错的',
  '大概是正确的',
  '题目不完整，无法判断',
  '不确定，需要更多信息',
]) {
  const r = parseAnswer(t, q('judge', ['true', 'false']));
  eq(`"${t.slice(0, 14)}…" → low`, r.confidence, 'low');
}

console.log('\n=== 多选题 ===');
eq('「答案：AB」→ AB 高可靠', parseAnswer('答案：AB', q('multiple', ['A', 'B', 'C', 'D'])), {
  confidence: 'high',
  letters: ['A', 'B'],
  judge: undefined,
  reason: '明确给出选项 AB（来源：explicit）',
  raw: '答案：AB',
});
eq('「应选 A、B、D」→ ABD', parseAnswer('应选 A、B、D', q('multiple', ['A', 'B', 'C', 'D'])).letters, ['A', 'B', 'D']);
eq('「答案：A、C」→ AC', parseAnswer('答案：A、C', q('multiple', ['A', 'B', 'C', 'D'])).letters, ['A', 'C']);
eq('多选题只给一个 → medium', parseAnswer('答案是 B', q('multiple', ['A', 'B', 'C', 'D'])).confidence, 'medium');
eq('同层级两组候选 → medium', parseAnswer('第一问答案：AB\n第二问答案：AC', q('multiple', ['A', 'B', 'C', 'D'])).confidence, 'medium');
eq('答案不在选项内 → low', parseAnswer('答案是 F', q('multiple', ['A', 'B', 'C', 'D'])).confidence, 'low');
eq('含"如果必须"→ medium', parseAnswer('答案：AB。如果必须单选则选 A', q('multiple', ['A', 'B', 'C', 'D'])).confidence, 'medium');

console.log('\n=== 单选题 ===');
eq('「答案：C」→ C', parseAnswer('答案：C', q('single', ['A', 'B', 'C', 'D'])).letters, ['C']);
eq('「正确选项是 D」→ D', parseAnswer('正确选项是 D', q('single', ['A', 'B', 'C', 'D'])).letters, ['D']);
eq('整行只有字母 → 提取', parseAnswer('分析如下……\n\nB\n', q('single', ['A', 'B', 'C', 'D'])).letters, ['B']);

console.log('\n=== 填空转人工 / 简答草稿 ===');
eq('填空题 → low', parseAnswer('答案是"光合作用"', q('fill', [])).confidence, 'low');
eq('简答题 → medium 草稿', parseAnswer('这个问题从三个方面回答。', q('essay', [])).confidence, 'medium');

console.log('\n=== 提交前防呆 ===');
{
  const qq = q('multiple', ['A', 'B', 'C', 'D']);
  const good = parseAnswer('答案：AB', qq);
  eq('高可靠多选题 → 允许提交', validateBeforeSubmit(good, qq).safe, true);

  const low = parseAnswer('图片看不清', qq);
  eq('低可靠 → 拒绝提交', validateBeforeSubmit(low, qq).safe, false);

  const single = q('single', ['A', 'B', 'C', 'D']);
  const two = { confidence: 'high', letters: ['A', 'B'], reason: '' };
  const v = validateBeforeSubmit(two, single);
  eq('单选题给了两个 → 拒绝', v.safe, false);
  eq('  错误信息包含单选说明', v.errors.some((e) => /单选/.test(e)), true);

  const judgeQ = q('judge', ['true', 'false']);
  const badJudge = { confidence: 'high', letters: ['A'], reason: '' };
  eq('判断题给了非法选项 → 拒绝', validateBeforeSubmit(badJudge, judgeQ).safe, false);
}

console.log('\n=== 分级标签 ===');
eq('high 标签', confidenceLabel('high'), '🟢 高');
eq('medium 标签', confidenceLabel('medium'), '🟡 中');
eq('low 标签', confidenceLabel('low'), '🔴 低');

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
