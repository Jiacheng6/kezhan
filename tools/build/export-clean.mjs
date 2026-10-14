// 固定课程、班级和任务编号为匿名示例，实际运行请从清单或命令行传入。
/**
 * 导出"可直接上传 GitHub 的纯净副本"。
 *
 * 做法：**只从 git 索引导出**（`git checkout-index`），因此：
 *   · 只包含会被提交的文件 —— 隐私数据（edge-profile / logs / data / state.json /
 *     local.json / backup-* / node_modules / 构建产物）自然一个都不在里面；
 *   · 行尾与二进制判定按 `.gitattributes` 生效（.bat 是 CRLF、UTF-16 的 .vbs 原样）；
 *   · 不复制 .git（副本可独立 init/push）。
 *
 * 导出后做完整性校验：
 *   ① 目录里不能出现任何隐私路径；② 文件数与索引一致；
 *   ③ .bat 是 CRLF、.vbs 是 UTF-16LE+BOM；④ 所有 .mjs 语法可解析。
 *
 * 用法: node tools/build/export-clean.mjs [目标目录]     （缺省 发布版）
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(ROOT, process.argv[2] || '发布版');

const run = (args, opts = {}) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

/**
 * 读索引文件清单。
 * ⚠ 必须用 `-z`（NUL 分隔）：默认输出会把中文名转义成八进制
 * （`"\345\220\257\345\212\250.bat"`），导致比对/正则全部失效 —— 实测踩到。
 */
const trackedFiles = () => run(['ls-files', '-z']).split('\0').filter(Boolean);

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

/* ---------- 0) 前置检查：索引必须是干净的 ---------- */
console.log('=== 前置检查 ===');
try {
  const tracked = trackedFiles();
  ok(`git 索引里有 ${tracked.length} 个文件`, tracked.length > 0);

  // 索引里若混进隐私文件，直接拒绝导出（宁可不出，也不能出脏包）
  const dirtyRe = /(^|\/)(edge-profile|logs|data|backup-[^/]+|node_modules)\/|(^|\/)(state\.json|recon-selection\.json|local\.json)$|\.exe$/;
  const dirty = tracked.filter((f) => dirtyRe.test(f));
  ok('索引里没有隐私文件', dirty.length === 0, dirty.length ? dirty.slice(0, 5).join(', ') : '干净');
  if (dirty.length) {
    console.error('\n索引里混进了隐私文件，已中止导出。先 `git rm --cached` 它们再重试。');
    process.exit(1);
  }
} catch (err) {
  console.error('读不到 git 索引：', String(err.message).split('\n')[0]);
  console.error('先在本项目里 `git init` 并 `git add -A`（见 README「上传 GitHub」）。');
  process.exit(1);
}

/* ---------- 1) 导出 ---------- */
console.log('\n=== 导出 ===');

/*
 * 导出走的是 **git 索引**（这样才带得上 .gitattributes 的行尾/编码属性，也不会
 * 把 .gitignore 里的隐私文件带出去）。代价是：**改了但没暂存的文件不在副本里**。
 * 实测踩到一次假绿 —— 我修了隐私自检脚本却没 `git add`，于是副本里还是旧的
 * 扫描器，它对真实 personId 视而不见却报"通过"。这里明确提示差异，别再踩。
 */
try {
  const unstaged = execFileSync('git', ['diff', '--name-only'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (unstaged.length) {
    console.log(`  ⚠ 有 ${unstaged.length} 个已改但**未暂存**的文件不会进副本（先 git add 才是最新版）：`);
    for (const f of unstaged.slice(0, 8)) console.log(`      ${f}`);
    if (unstaged.length > 8) console.log(`      …还有 ${unstaged.length - 8} 个`);
  }
} catch {
  /* 提示而已，失败不影响导出 */
}

if (existsSync(OUT)) {
  rmSync(OUT, { recursive: true, force: true });
  console.log(`  已清空旧副本 ${path.relative(ROOT, OUT)}`);
}
// git checkout-index 要求目标目录**已经存在**（它只写文件、不建目录）
mkdirSync(OUT, { recursive: true });
execFileSync('git', ['checkout-index', '-a', '-f', `--prefix=${OUT}${path.sep}`], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
console.log(`  已写入 ${path.relative(ROOT, OUT)}`);

/* ---------- 2) 校验 ---------- */
function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

const files = walk(OUT).sort();
const tracked = trackedFiles().sort();

/* ---------- 1.5) 抹掉本机标识（只改副本，主项目原样保留） ---------- */
/*
 * 为什么需要这一步：账号 personId 已经抽到 local.json 了，但**课程 / 班级 /
 * 知识点 ID 还硬编码在若干排查脚本和文档示例里**（`const clazzId = '…'`、
 * 课程表那种）。它们是弱标识（不是钥匙，但能看出你上的是哪门课），
 * 而你要的是一份"无我个人信息"的副本。
 *
 * 取舍：那些脚本是你自己的排障工具，改了就不好使 —— 所以**只抹副本**：
 * 主项目保持能用，副本里换成同样位数的假号（工具在新用户手里本来也要
 * 换成他自己的课，所以不影响可用性）。
 */
const NO_SCRUB = process.argv.includes('--no-scrub');
const SCRUB_TEXT = /\.(mjs|js|json|md|html|css|txt|cs|bat|cmd)$/i;

/** 从本机隐私数据里收集"你的"标识（9 位数字：personId/courseId/clazzId/knowledgeId） */
function collectLocalIds() {
  const ids = new Set();
  const eat = (p) => {
    try {
      for (const m of readFileSync(p, 'utf8').matchAll(/(?<!\d)\d{9}(?!\d)/g)) ids.add(m[0]);
    } catch {
      /* 文件不存在就算了 */
    }
  };
  eat(path.join(ROOT, 'local.json'));
  eat(path.join(ROOT, 'state.json'));
  eat(path.join(ROOT, 'recon-selection.json'));
  const dirs = [path.join(ROOT, 'data', 'probe-out')];
  let backups = [];
  try {
    backups = readdirSync(ROOT).filter((n) => n.startsWith('backup-'));
  } catch {
    /* ignore */
  }
  for (const b of backups) {
    eat(path.join(ROOT, b, 'state.json'));
    eat(path.join(ROOT, b, 'recon-selection.json'));
    dirs.push(path.join(ROOT, b, 'probe-out'));
  }
  for (const d of dirs) {
    try {
      for (const n of readdirSync(d)) if (/\.json$/.test(n)) eat(path.join(d, n));
    } catch {
      /* ignore */
    }
  }
  return ids;
}

let scrubCount = 0;
let scrubIds = 0;
const localIds = collectLocalIds();
if (!NO_SCRUB) {
  const ids = [...localIds];
  scrubIds = ids.length;
  const fake = new Map(ids.map((id, i) => [id, `9${String(i + 1).padStart(8, '0')}`]));
  for (const rel of files) {
    if (!SCRUB_TEXT.test(rel)) continue;
    const full = path.join(OUT, rel);
    let text = readFileSync(full, 'utf8');
    let changed = false;
    for (const [real, sub] of fake) {
      const re = new RegExp(`(?<!\\d)${real}(?!\\d)`, 'g');
      const hits = text.match(re);
      if (hits) {
        scrubCount += hits.length;
        text = text.replace(re, sub);
        changed = true;
      }
    }
    if (changed) writeFileSync(full, text, 'utf8');
  }
  console.log(`\n=== 抹掉本机标识 ===`);
  console.log(`  本机识别到 ${scrubIds} 个标识，副本里替换 ${scrubCount} 处为同位数假号`);
  console.log(`  （主项目不受影响；要保留原样导出用 --no-scrub）`);
}

console.log('\n=== 完整性校验 ===');
ok('文件数与索引一致', files.length === tracked.length, `副本 ${files.length} / 索引 ${tracked.length}`);
const missing = tracked.filter((f) => !files.includes(f));
ok('索引里的文件都在副本里', missing.length === 0, missing.slice(0, 5).join(', '));

const dirtyRe2 = /(^|\/)(edge-profile|logs|data|backup-[^/]+|node_modules)\/|(^|\/)(state\.json|recon-selection\.json|local\.json)$|\.exe$|^\.git$/;
const dirty2 = files.filter((f) => dirtyRe2.test(f));
ok('副本里没有隐私文件/构建产物/.git', dirty2.length === 0, dirty2.slice(0, 5).join(', '));

/*
 * 抹标识的效果必须**回读验证**（不能只信"我替换过了"）：
 * 刚才就是靠回读才发现"修了但没暂存"导致的假绿。
 */
if (!NO_SCRUB) {
  const leftovers = [];
  for (const rel of files) {
    if (!SCRUB_TEXT.test(rel)) continue;
    let text = '';
    try {
      text = readFileSync(path.join(OUT, rel), 'utf8');
    } catch {
      continue;
    }
    for (const id of localIds) {
      if (new RegExp(`(?<!\\d)${id}(?!\\d)`).test(text)) leftovers.push(`${rel}:${id}`);
    }
  }
  ok(
    '副本里没有你的课程/账号标识',
    leftovers.length === 0,
    leftovers.length ? `残留 ${leftovers.length} 处：${leftovers.slice(0, 3).join(', ')}` : `已替换 ${scrubCount} 处`,
  );

  /*
   * 软检查（只提示不判失败）：副本里**剩余**的 9 位数字，应该全是我刚换上去的假号。
   * 若出现别的，说明有一处真实 ID 没被收集到 —— 实测踩到：某个源码注释里
   * 举例用的题目 ID 不在侦察数据里，收集不到就抹不掉。
   * 不做成硬失败是因为正常的 9 位常量（比如毫秒数）会误报。
   */
  const PLACEHOLDER = new Set(['900000467', '900000468', '900000469', '900000470', '900000471']);
  const fakeSet = new Set([...localIds].map((_, i) => `9${String(i + 1).padStart(8, '0')}`));
  const unknown = new Map();
  for (const rel of files) {
    if (!SCRUB_TEXT.test(rel)) continue;
    let text = '';
    try {
      text = readFileSync(path.join(OUT, rel), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/(?<!\d)\d{9}(?!\d)/g)) {
      if (!fakeSet.has(m[0]) && !PLACEHOLDER.has(m[0])) unknown.set(m[0], (unknown.get(m[0]) || 0) + 1);
    }
  }
  if (unknown.size) {
    console.log(`  ⚠ 副本里还有 ${unknown.size} 个"不是替换产生"的 9 位数字，人工确认下是不是你的课程 ID：`);
    console.log(`      ${[...unknown.entries()].slice(0, 8).map(([k, v]) => `${k}×${v}`).join('  ')}`);
    console.log('      （若是，把它从源码里换成假号再导出；这类值不在本机侦察数据里，收集不到）');
  } else {
    console.log('  ✓ 副本里剩余的 9 位数字全是替换后的假号');
  }
}

/* 行尾与编码 */
const bat = path.join(OUT, '启动.bat');
if (existsSync(bat)) {
  const b = readFileSync(bat);
  let crlf = 0;
  let lfOnly = 0;
  for (let i = 0; i < b.length; i += 1) {
    if (b[i] === 10) {
      if (i > 0 && b[i - 1] === 13) crlf += 1;
      else lfOnly += 1;
    }
  }
  ok('启动.bat 是 CRLF 换行', crlf > 0 && lfOnly === 0, `CRLF ${crlf} / 纯LF ${lfOnly}`);
}
const vbs = path.join(OUT, '启动（无窗口）.vbs');
if (existsSync(vbs)) {
  const b = readFileSync(vbs);
  const isUtf16 = b.length > 2 && b[0] === 0xff && b[1] === 0xfe;
  ok('启动（无窗口）.vbs 仍是 UTF-16LE+BOM', isUtf16, isUtf16 ? '编码正确' : '编码被破坏');
}

/* 语法 */
let syntaxBad = 0;
for (const rel of files.filter((f) => f.endsWith('.mjs') || f.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', path.join(OUT, rel)], { stdio: 'pipe' });
  } catch {
    syntaxBad += 1;
    console.log(`      ✗ ${rel}`);
  }
}
ok(`所有 .mjs/.js 语法可解析（${files.filter((f) => /\.(mjs|js)$/.test(f)).length} 个）`, syntaxBad === 0);

/* 关键文件齐全 */
for (const need of [
  '.gitignore',
  '.gitattributes',
  'README.md',
  'docs/开发说明.md',
  'package.json',
  'package-lock.json',
  'local.example.json',
  'src/main.mjs',
  'src/chaoxing/runner.mjs',
  'src/ai/ai.mjs',
  'desktop/App.cs',
  '构建桌面版.bat',
  'tools/test/test-offline.mjs',
  'tools/build/build-desktop.mjs',
]) {
  ok(`包含 ${need}`, files.includes(need));
}

/*
 * 副本隐私自检 —— 必须带上**真实 personId** 再跑一次。
 *
 * 为什么不能只靠"副本里跑一遍自检"：副本按设计不含 local.json，
 * 于是副本自己的自检只能扫通用模式，做不了 personId 精确匹配。
 * 实测踩到：副本自检报"没有发现敏感内容"，而里面躺着一处真实 personId
 * （我自己写测试夹具时把真 ID 抄了进去）。这里用环境变量把真实 ID 传进去，
 * 让它按"真正会上传的内容"逐字比对。
 */
{
  const pid = (() => {
    try {
      return JSON.parse(readFileSync(path.join(ROOT, 'local.json'), 'utf8')).personId || null;
    } catch {
      return null;
    }
  })();
  const scanner = path.join(OUT, 'tools/test/check-privacy.mjs');
  if (!existsSync(scanner)) {
    ok('副本里有隐私自检脚本', false, 'tools/test/check-privacy.mjs 缺失');
  } else if (!pid) {
    console.log('  · 主项目没有 local.json，副本自检只能按通用模式跑（做不了 personId 精确检查）');
    try {
      execFileSync(process.execPath, [scanner], { cwd: OUT, stdio: 'pipe' });
      ok('副本隐私自检（通用模式）', true);
    } catch (e) {
      ok('副本隐私自检（通用模式）', false, String(e.stdout || '').split('\n').filter((l) => l.includes('⚠')).join(' ') || '有命中');
    }
  } else {
    try {
      const out2 = execFileSync(process.execPath, [scanner], {
        cwd: OUT,
        stdio: 'pipe',
        env: { ...process.env, XXT_PERSON_ID: pid },
      });
      const text = String(out2);
      const line = text.split('\n').find((l) => l.includes('通过')) || '';
      /*
       * ⚠ 光看"通过"不算数：副本里的扫描器可能是**过旧版本**，
       * 不认 XXT_PERSON_ID → 静默跳过精确匹配 → 照样报"通过"（实测假绿过一次，
       * 因为导出走 git 索引，我改了扫描器但没暂存）。
       * 所以必须断言"精确检查确实启用了"这一行存在。
       */
      const enabled = /personId 精确检查已启用/.test(text);
      ok('副本隐私自检（含 personId 精确匹配）', enabled, enabled ? line.trim() : '副本里的扫描器不支持 XXT_PERSON_ID（副本过旧？先 git add 再导出）');
    } catch (e) {
      const hits = String(e.stdout || '')
        .split('\n')
        .filter((l) => l.includes('⚠') || l.trim().startsWith('tools/') || l.trim().startsWith('src/'))
        .map((l) => l.trim())
        .join(' ');
      ok('副本隐私自检（含 personId 精确匹配）', false, hits || '有命中，详见上面输出');
    }
  }
}

console.log('\n' + '='.repeat(52));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log(`\n副本位置：${OUT}`);
if (!fail) {
  console.log('\n下一步（在该目录里执行）：');
  console.log('  git init');
  console.log('  git add .');
  console.log('  git commit -m "学习通自动刷课 + AI 答题助手"');
  console.log('  git branch -M main');
  console.log('  git remote add origin https://github.com/<你的用户名>/<仓库名>.git');
  console.log('  git push -u origin main');
}
process.exit(fail ? 1 : 0);
