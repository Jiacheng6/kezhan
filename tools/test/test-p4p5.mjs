// 固定课程、班级和任务编号为匿名示例，实际运行请从清单或命令行传入。
/**
 * P4+P5 完整闭环测试：
 *   1) 跑章节测验（保持页面打开）
 *   2) 检查待审队列接口是否正确返回
 *   3) 检查作业页是否真的还开着（能被提交）
 *   4) 打印界面所需的全部字段（验证 UI 有数据可渲染）
 *
 * 默认**不提交**；加 --submit 才真的提交（用于确认提交链路可用）。
 */
import { chromium } from 'playwright-core';
import { DEBUG_PORT, loadSettings, PERSON_ID } from '../../src/config.mjs';
import { runQuizTask, recordQuizResult } from '../../src/chaoxing/quizrun.mjs';

process.on('unhandledRejection', (e) => {
  if (!/No dialog|handleJavaScriptDialog/i.test(String(e?.message || ''))) console.error('[rej]', e?.message);
});

const args = process.argv.slice(2);
const doSubmit = args.includes('--submit');
const [courseId = '900000008', clazzId = '900000074', kid = '900000472'] = args.filter((a) => !a.startsWith('--'));

const base = 'http://127.0.0.1:8787';
const settings = loadSettings();

console.log('='.repeat(88));
console.log('P4+P5 闭环测试');
console.log('  提交模式:', settings.submitMode, '| 本次是否真的提交:', doSubmit ? '是' : '否');
console.log('='.repeat(88));

const j = await (await fetch(`${base}/api/checklist`)).json();
const course = j.result.courses.find((c) => c.courseId === courseId);
const task = course?.tasks.find((t) => t.knowledgeId === kid);
if (!task) {
  console.error('找不到任务点');
  process.exit(1);
}

const b = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const ctx = b.contexts()[0];
const qianwenPage = ctx.pages().find((p) => /qianwen|tongyi/i.test(p.url()));

console.log(`\n① 跑测验：${task.secNo} ${task.name}`);
const result = await runQuizTask({ ctx, qianwenPage, task, personId: PERSON_ID });
recordQuizResult(result);
console.log(`   ok=${result.ok} phase=${result.phase} 题数=${result.totalQuestions} 填入=${result.answered} 待人工=${result.queued}`);
console.log(`   keepPageOpen=${result.keepPageOpen}`);

console.log('\n② 待审队列接口');
const rev = await (await fetch(`${base}/api/review`)).json();
console.log('   ok:', rev.ok);
console.log('   stats:', JSON.stringify(rev.result?.stats));
console.log('   items 数:', (rev.result?.items || []).length);
console.log('   keptPages:', JSON.stringify(rev.result?.keptPages?.map((k) => ({ key: k.key.slice(0, 40), closed: k.closed, secNo: k.info?.secNo })) || []));

console.log('\n③ 界面渲染所需字段检查');
const first = (rev.result?.items || [])[0];
if (!first) {
  console.log('   ✗ 队列为空，界面无内容可渲染');
} else {
  const need = ['id', 'taskKey', 'course', 'secNo', 'sectionName', 'questionIndex', 'qtype', 'qtypeRaw', 'options', 'imagePath', 'aiAnswer', 'confidence', 'confidenceLabel', 'letters', 'parseReason', 'validation', 'autoFilled', 'status'];
  for (const k of need) {
    const v = first[k];
    const ok = v !== undefined && v !== null && !(Array.isArray(v) && !v.length);
    console.log(`   ${ok ? '✓' : '✗'} ${k}: ${Array.isArray(v) ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 70)}`);
  }
}

console.log('\n④ 图片服务检查');
if (first?.imagePath) {
  const r = await fetch(`${base}/api/answer-image?p=${encodeURIComponent(first.imagePath)}`);
  console.log(`   GET /api/answer-image → ${r.status} ${r.headers.get('content-type')} ${r.headers.get('content-length') || '?'} bytes`);
} else {
  console.log('   无截图路径');
}

console.log('\n⑤ 作业页是否还开着（决定能否提交）');
const wfCheck = ctx.pages().filter((p) => /doHomeWorkNew|mooc-ans\/work|knowledge\/cards/.test(p.url()));
console.log(`   匹配到 ${wfCheck.length} 个候选页`);
for (const p of wfCheck) console.log(`      ${p.isClosed() ? '(已关)' : '(开着)'} ${p.url().slice(0, 100)}`);

console.log('\n   所有页面（排查用）:');
for (const p of ctx.pages()) console.log(`      ${p.isClosed() ? '(已关)' : '      '} ${p.url().slice(0, 100)}`);

if (doSubmit) {
  console.log('\n⑥ 提交（--submit）');
  const r = await fetch(`${base}/api/review/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ all: true }),
  }).then((x) => x.json());
  console.log('   结果:', JSON.stringify(r));
  const after = await (await fetch(`${base}/api/review`)).json();
  console.log('   提交后 stats:', JSON.stringify(after.result?.stats));
} else {
  console.log('\n⑥ 未提交（加 --submit 才会真的提交）');
}

console.log('\n逐题:');
for (const it of result.items || []) {
  console.log(`   第${it.questionIndex}题 [${it.qtype}] ${it.confidenceLabel} → ${it.letters.join('')} | autoFilled=${it.autoFilled} | ${it.status}`);
}

await b.close();
