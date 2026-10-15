/**
 * src 模块结构自检（离线）。
 *
 * **为什么需要它**：重构时我用"数花括号"的脚本删函数，遇到了模板字符串里的
 * `{`/`}` —— 计数被骗，把 `src/browser/inject.mjs` 从 195 行切成 53 行。
 * 而切完**语法仍然合法**，`node --check` 一点不报错，
 * 离线自检也没覆盖到该模块 —— 差点把"抗失焦注入"整段删掉还不自知。
 *
 * 所以这里做两层保护：
 *   1) 逐个 import 所有 src 模块（能发现导入/语法级损坏）；
 *   2) 对关键模块做**内容指纹断言**（关键标记必须在，且文件不能异常变短）。
 * 第 2 条是重点：它抓的是"语法合法但内容被删"这类事故。
 *
 * 用法: node tools/test/check-modules.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

/* ---------- 1) 逐模块 import ---------- */
function walkMjs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name.startsWith('_') || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walkMjs(full, out);
    else if (name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

/*
 * main.mjs 是**入口**：import 它就会真的去接管 Edge、起控制台服务。
 * 自检不能有副作用，所以只对它做内容指纹检查，不 import。
 */
const NO_IMPORT = new Set(['src/main.mjs']);

const modules = walkMjs(path.join(ROOT, 'src'));
console.log(`=== 逐模块 import（${modules.length} 个 .mjs，入口除外）===`);
for (const m of modules) {
  const rel = path.relative(ROOT, m).replace(/\\/g, '/');
  if (NO_IMPORT.has(rel)) {
    console.log(`  · 跳过 import ${rel}（入口会真启动服务，只做内容指纹检查）`);
    pass += 1;
    continue;
  }
  try {
    const mod = await import(`file://${m.replace(/\\/g, '/')}`);
    const names = Object.keys(mod);
    ok(`import ${rel}`, true, `${names.length} 个导出`);
  } catch (err) {
    ok(`import ${rel}`, false, err.message.split('\n')[0]);
  }
}

/* ---------- 2) 关键模块内容指纹 ---------- */
/*
 * 每个条目：文件 → { 必须包含的标记数组, 最少行数 }
 * 行数下限故意留有余量（比当前值略低），目的是抓"被整段删掉"而不是抓正常改动。
 */
const FINGERPRINTS = [
  {
    file: 'src/browser/inject.mjs',
    minLines: 150,
    markers: ['__xxtDefence', 'document.hasFocus', '__xxtPauseLog', '__xxtPops', 'installDefence', 'checkDefence'],
    why: '抗失焦/反节流注入 + 弹窗题暂停取证钩子',
  },
  {
    file: 'src/browser/pages.mjs',
    minLines: 180,
    markers: ['newTaskPage', 'cleanupPages', 'closeTrackedPages', 'isJunkUrl', 'pageIdentity', 'isTaskPageUrl'],
    why: '页面台账：清场/去重/白名单/退出收摊',
  },
  {
    file: 'src/chaoxing/player.mjs',
    minLines: 400,
    markers: ['watchUntilDone', 'guardResume', 'pause-storm', 'greenDotPatientMs', 'findVideoQuiz'],
    why: '播放守卫：纠偏 / 暂停风暴 / 弹窗期间不纠偏',
  },
  {
    file: 'src/chaoxing/videoquiz.mjs',
    minLines: 380,
    markers: ['findVideoQuiz', 'extractVideoQuiz', 'submitVideoQuiz', 'watchVideoQuiz', 'ans-videoquiz'],
    why: '视频内弹窗题：检测/截图/作答/提交',
  },
  {
    file: 'src/chaoxing/runner.mjs',
    minLines: 600,
    markers: [
      'runVideoTask',
      'runDocTask',
      'openSectionCard',
      'registerKeptPage',
      'quiz-needs-human',
      'checkPointFinished',
      'verifyTaskCompletion',
      'describeCompletion',
    ],
    why: '任务执行器 + 完成判定（任务点级为主、小节绿点兜底）',
  },
  {
    file: 'src/chaoxing/quizrun.mjs',
    minLines: 450,
    markers: ['runQuizTask', 'submitWork', 'recordQuizResult', 'MAX_KEPT_PAGES'],
    why: '章节测验执行器',
  },
  {
    file: 'src/chaoxing/recon.mjs',
    minLines: 450,
    markers: ['reconAll', 'reconCourse', 'readSectionTasks', 'writeTaskReport', 'EXTRACT_ATTACH'],
    why: '侦察与清单报告',
  },
  {
    file: 'src/chaoxing/identity.mjs',
    minLines: 150,
    markers: [
      'discoverPersonId',
      'autoConfigurePersonId',
      'fetchPersonIds',
      'personIdsFromCourseListHtml',
      'COURSE_LIST_API',
      'courselistdata',
      'input.curPersonId',
      "getAttribute('info')",
      'cpiFromUrl',
      'cpiFromHtml',
    ],
    why: '账号 ID 自动识别（HTTP 接口为主 + 页面兜底，交给别人用时不用手填配置）',
  },
  {
    file: 'src/chaoxing/section.mjs',
    minLines: 60,
    markers: ['cardsUrl', 'openSectionCard', 'waitAttachOrEmpty', 'waitForAttachments'],
    why: '多卡片小节定位（"刷不成功"的根治点）',
  },
  {
    file: 'src/chaoxing/attach.mjs',
    minLines: 150,
    markers: [
      'checkTaskTracking',
      'readPointStatusFromPage',
      'alreadyFinished',
      'ans-job-finished',
      'readVideoModuleRecord',
      'videoPassedVerdict',
      'watchedRatio',
      'isPassed',
    ],
    why: '读卡片页上的任务点状态（含视频模块的服务端权威记录；视频/文档/测验共用，避免循环依赖）',
  },
  {
    file: 'src/chaoxing/skip.mjs',
    minLines: 30,
    markers: ['skipDecision', 'describeSkip', 'task-point', 'section-green'],
    why: '跳过判定（避免重做已完成的任务点）',
  },
  {
    file: 'src/chaoxing/checklist.mjs',
    minLines: 200,
    markers: ['buildChecklist', 'classifyWork', 'loadSelection', 'invalidateReconCache'],
    why: '执行清单与选择配置',
  },
  {
    file: 'src/ai/ai.mjs',
    minLines: 400,
    markers: [
      'askImage',
      'pasteImage',
      'waitAnswer',
      'detectVerification',
      'answerBaseline',
      'answerProgressVerdict',
      'shouldReask',
      'stopGenerating',
      'askRetries',
    ],
    why: '千问答题通道（含"没回答就重新提问"）',
  },
  {
    file: 'src/ai/parse.mjs',
    minLines: 250,
    markers: ['parseAnswer', 'validateBeforeSubmit', 'buildArchive', 'findJudgeAnswer'],
    why: '答案解析 + 安全阀',
  },
  {
    file: 'src/ai/throttle.mjs',
    minLines: 70,
    markers: ['waitTurn', 'markAsked', 'reportSuccess', 'reportFailure'],
    why: '千问节流（防风控）',
  },
  {
    file: 'src/settings.mjs',
    minLines: 150,
    markers: ['SETTING_SPEC', 'normalizeSettings', 'describeSettings', 'toSparseSettings', 'READONLY_SPEC'],
    why: '设置规格与校验',
  },
  {
    file: 'src/batch.mjs',
    minLines: 250,
    markers: ['classifyTaskResult', 'CONSECUTIVE_FAIL_LIMIT', 'batchRunner'],
    why: '批量执行与记账分类',
  },
  {
    file: 'src/state.mjs',
    minLines: 200,
    markers: ['mutateState', 'setTaskStatus', 'addHandbook', 'listReviewItems', 'reconcile'],
    why: '状态落盘（mtime 缓存 + 原子读改写）',
  },
  {
    file: 'src/main.mjs',
    minLines: 500,
    markers: ['startRun', 'stopRun', 'cleanupPages', 'saveSettings', 'gracefulShutdown', 'readoptKeptPages'],
    why: '启动编排与 hooks',
  },
  {
    file: 'src/server.mjs',
    minLines: 200,
    markers: ['/api/checklist', '/api/settings', '/api/selection', 'startServer'],
    why: '控制台 HTTP/WS 服务',
  },
  {
    file: 'src/ui/selection.js',
    minLines: 150,
    markers: ['batchSelect', 'willSummary', 'willList', 'keepFirstN', 'courseVisible'],
    why: '课程树选择算术（纯函数）',
  },
];

console.log('\n=== 关键模块内容指纹 ===');
for (const fp of FINGERPRINTS) {
  const full = path.join(ROOT, fp.file);
  let text;
  try {
    text = readFileSync(full, 'utf8');
  } catch (err) {
    ok(`${fp.file} 存在`, false, err.message);
    continue;
  }
  const lines = text.split('\n').length;
  const missing = fp.markers.filter((m) => !text.includes(m));
  const longEnough = lines >= fp.minLines;
  ok(
    `${fp.file} 完整（${fp.why}）`,
    missing.length === 0 && longEnough,
    missing.length
      ? `缺少标记: ${missing.join(', ')}`
      : `${lines} 行 ≥ 下限 ${fp.minLines}`,
  );
}

/* ---------- 3) 所有相对 import 必须能解析到真实文件 ---------- */
/*
 * 目录搬运最容易犯的错：相对层级写错（../ 少一层或多一层）。
 * 那种错误在开发工具脚本里往往要等到"真的去跑它"才暴露，
 * 这里静态检查一遍，几秒钟就能发现。
 */
console.log('\n=== 相对 import 可解析性（src + tools 全量）===');
{
  const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/g;
  const files = [...walkMjs(path.join(ROOT, 'src')), ...walkMjs(path.join(ROOT, 'tools'))];
  let checked = 0;
  const broken = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1];
      const target = path.resolve(path.dirname(f), spec);
      checked += 1;
      if (!existsSync(target)) {
        broken.push(`${path.relative(ROOT, f).replace(/\\/g, '/')} → ${spec}`);
      }
    }
  }
  ok(`检查了 ${checked} 条相对 import`, broken.length === 0, broken.length ? `${broken.length} 条解析失败` : '全部可解析');
  for (const b of broken.slice(0, 10)) console.log(`      ✗ ${b}`);
}

console.log('\n' + '='.repeat(50));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
