// 固定课程、班级和任务编号为匿名示例，实际运行请从清单或命令行传入。
/**
 * P4 章节测验端到端实测。
 *
 * 流程：打开含测验的小节 → 读题 → 逐题截图 → 问千问 → 解析分级 → 填入 → （不提交）
 * 跑完打印每题：题型 / 截图路径 / 千问原文 / 解析结果 / 可靠性与是否允许提交。
 *
 * 用法:
 *   node tools/test/test-quizrun.mjs <courseId> <clazzId> <knowledgeId>
 *   node tools/test/test-quizrun.mjs --auto     （用配置里的 submitMode，默认 manual）
 */
import { chromium } from 'playwright-core';
import { DEBUG_PORT, loadSettings, PERSON_ID } from '../../src/config.mjs';
import { runQuizTask, recordQuizResult } from '../../src/chaoxing/quizrun.mjs';
import { confidenceLabel } from '../../src/ai/parse.mjs';

process.on('unhandledRejection', (e) => {
  if (!/No dialog|handleJavaScriptDialog/i.test(String(e?.message || ''))) console.error('[rej]', e?.message);
});

const [courseId = '900000008', clazzId = '900000074', kid = '900000472'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const settings = loadSettings();
console.log('='.repeat(88));
console.log('P4 章节测验端到端实测');
console.log('  提交模式:', settings.submitMode, settings.submitMode === 'manual' ? '（只填不交，安全）' : '（高可靠自动提交）');
console.log('  阈值: 只有「高可靠」答案才会被自动填入');
console.log('='.repeat(88));

const j = await (await fetch('http://127.0.0.1:8787/api/checklist')).json();
const course = j.result.courses.find((c) => c.courseId === courseId);
if (!course) {
  console.error(`清单里找不到课程 ${courseId}`);
  process.exit(1);
}
const task = course.tasks.find((t) => t.knowledgeId === kid);
if (!task) {
  console.error(`课程里找不到小节 ${kid}`);
  console.log('候选任务点：');
  for (const t of course.tasks.filter((x) => x.type === 'work')) {
    console.log(`   kid=${t.knowledgeId} secNo=${t.secNo} name=${t.name}`);
  }
  process.exit(1);
}

console.log(`\n任务点: [${task.type}] ${task.secNo} ${task.name || task.sectionName}`);
console.log(`  willHandle=${task.willHandle} policyHandle=${task.policyHandle} workKind=${task.workKind || '-'}`);

const b = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
const ctx = b.contexts()[0];
const qianwenPage = ctx.pages().find((p) => /qianwen|tongyi/i.test(p.url()));
if (!qianwenPage) {
  console.error('找不到千问标签页——请确认 main 已启动且千问已打开');
  process.exit(1);
}
console.log('千问标签页:', qianwenPage.url().slice(0, 60));

const t0 = Date.now();
const result = await runQuizTask({
  ctx,
  qianwenPage,
  task,
  personId: PERSON_ID,
  onProgress: (p) => {
    if (p.phase === 'asking') process.stdout.write(`  问题 ${p.index + 1}/${p.total} … `);
  },
});

recordQuizResult(result);

console.log('\n' + '='.repeat(88));
console.log('结果:');
console.log('  ok        :', result.ok);
console.log('  阶段      :', result.phase);
console.log('  题目总数  :', result.totalQuestions);
console.log('  已填入    :', result.answered);
console.log('  待人工    :', result.queued);
console.log('  已提交    :', result.submitted);
console.log('  耗时      :', Math.round((Date.now() - t0) / 1000), '秒');
if (result.error) console.log('  错误      :', result.error);

console.log('\n逐题明细:');
for (const it of result.items) {
  console.log(`\n  ── 第 ${it.questionIndex} 题 [${it.qtype}] ${it.qtypeRaw}`);
  console.log(`     可信度: ${confidenceLabel(it.confidence)}  ${it.parseReason}`);
  console.log(`     答案  : ${it.letters.join('') || '(无)'}`);
  console.log(`     选项  : ${it.options.map((o) => `${o.letter}.${o.text}`).join(' | ')}`);
  console.log(`     截图  : ${it.imagePath}`);
  if (it.aiError) console.log(`     AI错误: ${it.aiError}`);
  console.log(`     千问原文: ${(it.aiAnswer || '').replace(/\n/g, ' ').slice(0, 220)}`);
  console.log(`     是否自动填入: ${it.autoFilled ? '是' : '否'}  ${it.validation.errors.length ? '拦截原因: ' + it.validation.errors.join('; ') : ''}`);
  console.log(`     状态: ${it.status}`);
}

console.log('\n' + '='.repeat(88));
console.log('（本次未提交；答案已填入页面但页面已关闭，正式流程会保持页面打开待你在界面确认）');

await b.close();
