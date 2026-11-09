/**
 * 「OpenAI 兼容 API 回答提取」的离线测试（不需要网络、不需要密钥）。
 *
 * 为什么值得测：用户反馈"不管换成我的 API 还是豆包千问都是一样的问题"。
 * 排查发现 API 通道只认 `choices[0].message.content` 这一种形状，
 * 其它常见形状（内容数组、旧版 text、Responses 风格、Anthropic 风格、
 * 推理模型把正文放在 reasoning_content）全部被判成 `api-empty` ——
 * 看起来就像"API 坏了"，其实只是取错了字段。
 *
 * 用法: node tools/test/test-api-answer.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractApiAnswer } = require('../../desktop/ai-api.cjs');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
};

console.log('=== 常见返回形状都要能取到正文 ===');
{
  const cases = [
    ['标准字符串', { choices: [{ message: { content: '答案 D' } }] }, '答案 D', 'message.content'],
    ['内容数组（视觉模型）', { choices: [{ message: { content: [{ type: 'text', text: '答案 C' }] } }] }, '答案 C', 'message.content'],
    ['旧版 completions', { choices: [{ text: '答案 A' }] }, '答案 A', 'choice.text'],
    ['Responses 风格', { output_text: '答案 B' }, '答案 B', 'output_text'],
    ['output[].content', { output: [{ content: [{ type: 'text', text: '答案 B2' }] }] }, '答案 B2', 'output[].content'],
    ['Anthropic 风格', { content: [{ type: 'text', text: '答案 AB' }] }, '答案 AB', 'content'],
    ['推理模型（正文在 reasoning）', { choices: [{ message: { content: '', reasoning_content: '答案 T' } }] }, '答案 T', 'message.reasoning_content'],
  ];
  for (const [name, input, want, source] of cases) {
    const r = extractApiAnswer(input);
    ok(`${name} → 取到正文`, r.text === want, `${JSON.stringify(r.text)} / 来源 ${r.source}`);
    ok(`${name} → 来源可追溯`, r.source === source, r.source);
  }
}

console.log('\n=== 空回答要能自证原因（方便用户诊断，而不是只说"不兼容"）===');
{
  let r = extractApiAnswer({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });
  ok('被 max_tokens 截断 → 记录 finish_reason', r.text === '' && r.finishReason === 'length');

  r = extractApiAnswer({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] });
  ok('被安全策略拦截 → 记录 finish_reason', r.finishReason === 'content_filter');

  r = extractApiAnswer({});
  ok('空响应体不抛异常', r.text === '' && r.finishReason === '');

  r = extractApiAnswer(null);
  ok('null 也不抛异常', r.text === '');
}

console.log('\n=== 不该误取的东西 ===');
{
  const r = extractApiAnswer({ choices: [{ message: { role: 'assistant', content: '' } }], id: 'chatcmpl-1' });
  ok('没有正文时不会把 role/id 当答案', r.text === '');
}

console.log('\n' + '='.repeat(50));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
