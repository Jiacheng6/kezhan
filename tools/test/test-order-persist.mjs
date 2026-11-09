/**
 * 精确验证顺序持久化：锁定某一个 knowledgeId，对比 UI 与 API 的该小节顺序。
 *
 * 注意：taskOrder 里存的必须是服务端下发的 **uid**（如 t0/t1），
 * 不是任务点名称。曾经写成名称，导致"测试失败但功能其实正常"的误判。
 */
import fs from 'node:fs';
import { DEBUG_PORT } from '../../src/config.mjs';

const COURSE_KEYWORD = '计算思维';
const KNOWLEDGE_ID = '1246477123'; // 计算思维 1.3 课程视频（2 个任务点）

const base = 'http://127.0.0.1:8787';

async function apiSection() {
  const j = await (await fetch(`${base}/api/checklist`)).json();
  const c = j.result.courses.find((x) => x.name.includes(COURSE_KEYWORD));
  return c.tasks.filter((t) => t.knowledgeId === KNOWLEDGE_ID).map((t) => ({ uid: t.uid, name: t.name }));
}

console.log('=== 测试前 API 顺序 ===');
const before = await apiSection();
for (const t of before) console.log(`  ${t.uid}  ${t.name}`);

const j = await (await fetch(`${base}/api/checklist`)).json();
const reversedUids = before.map((t) => t.uid).reverse();
const sel = {
  courseOrder: j.result.courses.map((c) => c.courseId),
  courses: {},
  taskOrder: { [KNOWLEDGE_ID]: reversedUids },
  excluded: [],
};
console.log('\n写入反转后的 uid 顺序:', JSON.stringify(reversedUids));

const saveRes = await (
  await fetch(`${base}/api/selection`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sel),
  })
).json();
console.log('保存返回:', JSON.stringify(saveRes));

const after = await apiSection();
console.log('\n=== 保存后 API 顺序 ===');
for (const t of after) console.log(`  ${t.uid}  ${t.name}`);

const ok = JSON.stringify(after.map((t) => t.uid)) === JSON.stringify(reversedUids);
console.log(`\n反转是否生效: ${ok ? '✓ 顺序持久化正确' : '✗ 未生效'}`);

// 还原
await fetch(`${base}/api/selection`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ courseOrder: j.result.courses.map((c) => c.courseId), courses: {}, taskOrder: {}, excluded: [] }),
});
const restored = await apiSection();
const back = JSON.stringify(restored.map((t) => t.uid)) === JSON.stringify(before.map((t) => t.uid));
console.log(`已还原原顺序: ${back ? '✓' : '✗'}`);

