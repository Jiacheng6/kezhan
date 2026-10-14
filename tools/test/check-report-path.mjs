/**
 * 验证"侦察 → 清单"这条路径在目录迁移后仍然通畅（不需要登录/浏览器）。
 *
 * 做法：用一份假侦察结果调 writeTaskReport()，再用 buildChecklist() 读回来。
 * 跑完会把临时报告删掉，恢复成"尚未侦察"的空状态。
 *
 * 用法: node tools/test/check-report-path.mjs
 */
import { existsSync, rmSync, readdirSync } from 'node:fs';
import { PATHS } from '../../src/config.mjs';
import { writeTaskReport } from '../../src/chaoxing/recon.mjs';
import { buildChecklist, invalidateReconCache } from '../../src/chaoxing/checklist.mjs';

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

console.log('=== 路径常量 ===');
console.log(`  PATHS.probeOut   = ${PATHS.probeOut}`);
console.log(`  PATHS.taskReport = ${PATHS.taskReport}`);
ok('probeOut 在 data/ 下', PATHS.probeOut.includes('data'));
ok('taskReport 指向 data/probe-out', PATHS.taskReport === `${PATHS.probeOut}\\task-report.json` || PATHS.taskReport === `${PATHS.probeOut}/task-report.json`);

// 备份现场（用户可能已经有真报告，别覆盖丢了）
const hadReport = existsSync(PATHS.taskReport);
let backup = null;
if (hadReport) {
  const fs = await import('node:fs');
  backup = fs.readFileSync(PATHS.taskReport, 'utf8');
  console.log('  ⚠ 检测到已有真报告，先备份到内存，测完还原');
}

/* 造一份最小假侦察结果 */
const fake = [
  {
    courseId: 'TEST123',
    clazzId: 'CLZ1',
    name: '测试课程',
    empty: false,
    summary: { done: 0, total: 1 },
    chapters: [],
    sections: [
      {
        knowledgeId: 'k1',
        secNo: '1.1',
        name: '测试小节',
        done: false,
        jobTotal: 1,
        taskPoints: [
          {
            idx: 0,
            type: 'video',
            name: 'fake.mp4',
            sizeText: '1 MB',
            jobid: 'fake-job-1',
            finished: false,
            ariaLabel: '任务点未完成',
            cardNum: 1,
          },
        ],
      },
    ],
  },
];

console.log('\n=== 写报告 → 读清单 ===');
const wr = writeTaskReport(fake);
ok('writeTaskReport 返回了路径', !!wr.file, wr.file);
ok('报告落在 data/probe-out 下', existsSync(PATHS.taskReport));
ok('目录里能看到 task-report.json', readdirSync(PATHS.probeOut).includes('task-report.json'));

invalidateReconCache();
const cl = buildChecklist();
ok('buildChecklist 读到了清单', !!cl, cl ? `${cl.courses.length} 门课` : 'null');
ok('课程名对得上', cl?.courses?.[0]?.name === '测试课程', cl?.courses?.[0]?.name);
const t = cl?.courses?.[0]?.tasks?.[0];
ok('任务点信息完整', t && t.name === 'fake.mp4' && t.secNo === '1.1', t ? JSON.stringify({ name: t.name, sec: t.secNo, kid: t.knowledgeId }) : '无');

/* 还原现场 */
console.log('\n=== 还原 ===');
if (backup !== null) {
  const fs = await import('node:fs');
  fs.writeFileSync(PATHS.taskReport, backup, 'utf8');
  console.log('  ✓ 已还原原有报告');
} else {
  rmSync(PATHS.taskReport, { force: true });
  rmSync(`${PATHS.probeOut}/task-report.prev.json`, { force: true });
  console.log('  ✓ 已清掉临时报告（恢复为"尚未侦察"）');
}
invalidateReconCache();
ok('还原后 buildChecklist 回到应有状态', backup === null ? buildChecklist() === null : !!buildChecklist());

console.log('\n' + '='.repeat(50));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
