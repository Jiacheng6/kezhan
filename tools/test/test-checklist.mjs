/** 验证 /api/checklist 与 /api/selection 是否正常 */
const base = 'http://127.0.0.1:8787';

const res = await fetch(`${base}/api/checklist`);
const j = await res.json();

if (!j.ok) {
  console.log('✗ 返回错误:', j.error);
  process.exit(0);
}
if (!j.result) {
  console.log('（无清单数据，需先侦察）');
  process.exit(0);
}

const s = j.result.summary;
console.log('✓ checklist 可用');
console.log('  课程数      :', s.totalCourses);
console.log('  任务点总数  :', s.totalTasks);
console.log('  将处理      :', s.handleable);
console.log('  跳过        :', s.skipped);
console.log('  类型分布    :', JSON.stringify(s.byType));
console.log('  待人工条数  :', (s.handbook || []).length);
console.log('');

console.log('分课程（前 5）:');
for (const c of j.result.courses.slice(0, 5)) {
  if (c.empty) {
    console.log(`  ${c.name} —— 空课程`);
    continue;
  }
  const will = c.tasks.filter((t) => t.willHandle).length;
  console.log(`  ${c.name}`);
  console.log(`     任务点 ${c.tasks.length} · 将处理 ${will} · 小节 ${c.sections.length} · 计数 ${JSON.stringify(c.counts)}`);
  const f = c.tasks[0];
  if (f) {
    console.log(`     首个: [${f.type}] ${(f.name || f.sectionName || '').slice(0, 40)}`);
    console.log(`           willHandle=${f.willHandle} policy=${f.policy}`);
  }
}

console.log('\n待人工清单样例（前 5）:');
for (const h of (s.handbook || []).slice(0, 5)) {
  console.log(`  ${h.course} / ${h.secNo} [${h.typeName}] ${(h.name || h.sectionName || '').slice(0, 34)} —— ${h.reason}`);
}

// 测 selection 往返
console.log('\n=== 测试选择保存往返 ===');
const sel = {
  courseOrder: j.result.courses.map((c) => c.courseId),
  courses: { [j.result.courses[0].courseId]: { enabled: true } },
  taskOrder: {},
  excluded: [],
};
const save = await (await fetch(`${base}/api/selection`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(sel),
})).json();
console.log('保存结果:', JSON.stringify(save));

const again = await (await fetch(`${base}/api/checklist`)).json();
console.log('重新读取后 courseOrder 是否生效:', again.result.courses.length, '门课');
console.log('第一门课名:', again.result.courses[0].name);

const bad = await (await fetch(`${base}/api/selection`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"broken":',
})).json();
console.log('非法 JSON 处理:', JSON.stringify(bad));
