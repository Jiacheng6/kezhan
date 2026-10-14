import assert from 'node:assert/strict';
import { parseAnswer, validateBeforeSubmit, buildArchive, MAX_ESSAY_LENGTH } from '../../src/ai/parse.mjs';
import { canAutoSubmitItems } from '../../src/chaoxing/quizrun.mjs';
import { loadSettings, DEFAULT_SETTINGS } from '../../src/config.mjs';
import { normalizeSettings } from '../../src/settings.mjs';
const q = { qtype: 'essay', options: [], index: 1 };
for (const text of ['分工提高效率。\n合作有利于创新。', '风险具有不确定性，应通过评估降低损失。', '5', '<script>alert(1)</script> 是原样文本']) {
  const result = parseAnswer(text, q);
  assert.equal(result.canFill, true);
  assert.equal(result.textAnswer, text);
  assert.equal(result.requiresReview, true);
  assert.equal(result.confidence, 'medium');
  assert.equal(validateBeforeSubmit(result, q).safe, false);
}
assert.equal(parseAnswer('```text\n参考答案： 第一段\r\n第二段\n```', q).textAnswer, '第一段\n第二段');
for (const text of ['', '抱歉，图片看不清', '我不确定正确答案', '（千问调用失败：timeout）', 'a'.repeat(MAX_ESSAY_LENGTH + 1)]) {
  assert.equal(parseAnswer(text, q).canFill, false, text.slice(0, 20));
}
const draft = { qtype: 'essay', confidence: 'high', autoFilled: true, requiresReview: false };
const choice = { qtype: 'single', confidence: 'high', autoFilled: true, requiresReview: false };
assert.equal(canAutoSubmitItems([draft]), false, '即使错误标为高可靠也不能自动提交简答');
assert.equal(canAutoSubmitItems([choice, draft]), false, '混合题组不可自动提交');
assert.equal(canAutoSubmitItems([]), false);
assert.equal(canAutoSubmitItems([choice], 2), false, '未答全不可自动提交');
assert.equal(canAutoSubmitItems([{ ...choice, autoFilled: false }]), false, '填入失败不可自动提交');
assert.equal(canAutoSubmitItems([choice]), true);
assert.equal(loadSettings().essayAutoFill, true);
assert.equal(normalizeSettings({ essayAutoFill: false }, DEFAULT_SETTINGS).settings.essayAutoFill, false);
const archive = buildArchive({ question: q, parsed: parseAnswer('完整的简答正文', q), validation: { safe: false } });
assert.equal(archive.parsed.textAnswer, '完整的简答正文');
assert.equal(archive.parsed.requiresReview, true);
console.log('✓ 简答解析、正文保留、拒答过滤、设置、留档与自动提交隔离通过');
