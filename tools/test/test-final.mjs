/** P7 最终全面验收：所有接口 + 状态 + 界面 */
const base = 'http://127.0.0.1:8787';
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

console.log('=== 1) 核心接口 ===');
const status = await (await fetch(`${base}/api/status`)).json();
check('GET /api/status', status.phase === 'P4', `阶段=${status.phase} 登录=${status.login.loggedIn}`);
check('  Edge 已接管', status.edge?.connected === true, status.edge?.version || '');
check('  待审计数可用', typeof status.reviewCount === 'number', `reviewCount=${status.reviewCount}`);

const checklist = await (await fetch(`${base}/api/checklist`)).json();
check('GET /api/checklist', checklist.ok === true);
const sm = checklist.result.summary;
check('  任务点统计', sm.totalTasks === 657, `总数=${sm.totalTasks} 将处理=${sm.handleable} 跳过=${sm.skipped}`);
check('  work 细分', !!sm.workKinds, JSON.stringify(sm.workKinds));

const review = await (await fetch(`${base}/api/review`)).json();
check('GET /api/review', review.ok === true, `待审=${review.result?.stats?.total}`);

const logs = await (await fetch(`${base}/api/logs`)).json();
check('GET /api/logs', Array.isArray(logs), `${logs.length} 条`);

console.log('\n=== 2) 静态资源 ===');
for (const p of ['/', '/style.css', '/app.js']) {
  const r = await fetch(`${base}${p}`);
  check(`  ${p}`, r.ok, `${r.status}`);
}

console.log('\n=== 3) 动作接口 ===');
const info = await (await fetch(`${base}/api/action/info`, { method: 'POST' })).json();
check('  /api/action/info', info.ok === true, info.result?.consoleUrl || '');
const st = await (await fetch(`${base}/api/action/stateInfo`, { method: 'POST' })).json();
check('  /api/action/stateInfo', st.ok === true, JSON.stringify(st.result?.byStatus));
const rs = await (await fetch(`${base}/api/action/runStatus`, { method: 'POST' })).json();
check('  /api/action/runStatus', rs.ok === true, `running=${rs.result?.running}`);
const kept = await (await fetch(`${base}/api/action/listKeptPages`, { method: 'POST' })).json();
check('  /api/action/listKeptPages', kept.ok === true, `${(kept.result || []).length} 个`);

console.log('\n=== 4) 错误处理 ===');
const bad = await fetch(`${base}/api/action/doesNotExist`, { method: 'POST' });
check('  未知动作返回 404', bad.status === 404);
const traversal = await fetch(`${base}/../package.json`);
check('  目录穿越被拦', traversal.status === 404 || traversal.status === 403);

console.log('\n=== 5) 题目截图服务安全性 ===');
const evil = await fetch(`${base}/api/answer-image?p=${encodeURIComponent('D:/tools/学习通脚本/package.json')}`);
check('  非 answers 目录被拒绝', evil.status === 403, `status=${evil.status}`);

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
