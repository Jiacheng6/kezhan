/**
 * 上传 GitHub 前的隐私自检。
 *
 * 做两件事：
 *   1) **检查要上传的文件**（有 .git → 只看 `git ls-files`，即真正会被提交的；
 *      没有 .git → 扫工作区，但跳过 .gitignore 里那些目录）里有没有敏感内容；
 *   2) 检查 `.gitignore` 是否覆盖了所有"必须忽略"的路径
 *      —— 少一条就可能把 Cookie 或课程表推上去。
 *
 * 覆盖的敏感模式：
 *   · 学习通 personId（cpi）：从 local.json / .gitignore 注释 / 环境变量里取，取不到就用兜底正则
 *   · Cookie / 令牌类字段名：csrftoken、JSESSIONID、_uid、ktoken、mtEnc、defenc…
 *   · 绝对用户路径：C:\Users\<名字>、D:\tools\…（泄露本机目录结构与用户名）
 *   · 手机号 / 邮箱 / 身份证号
 *
 * 用法: node tools/test/check-privacy.mjs
 *       node tools/test/check-privacy.mjs --all     # 连工作区一起扫（含被忽略的目录，仅供排查）
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLearningTerms, containsLearningTerms } from './privacy-learning.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCAN_ALL = process.argv.includes('--all');

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

/* ---------------- 1) .gitignore 必须覆盖的路径 ---------------- */

const MUST_IGNORE = [
  ['edge-profile/', '登录 Cookie 与浏览器配置'],
  ['logs/', '运行日志与答题留档'],
  ['data/', '侦察报告与调试快照（含令牌）'],
  ['state.json', '进度 / 设置 / 待审队列'],
  ['recon-selection.json', '个人选课范围'],
  ['local.json', '本机 personId 配置（程序自动识别写入）'],
  ['backup-', '手工备份（含以上全部）'],
];

const gitignorePath = path.join(ROOT, '.gitignore');
let gi = '';
try {
  gi = readFileSync(gitignorePath, 'utf8');
} catch {
  /* 下面会报失败 */
}

console.log('=== .gitignore 覆盖检查 ===');
ok('.gitignore 存在', !!gi);
for (const [pattern, why] of MUST_IGNORE) {
  ok(`忽略 ${pattern}（${why}）`, gi.includes(pattern));
}

/* ---------------- 2) 收集"会被提交的文件" ---------------- */

/**
 * 取"会被提交的文件"清单。
 *
 * ⚠ 关键细节：必须确认 git 仓库根**就是本目录**。
 * 如果本目录是某个父仓库的工作区子目录（例如"发布版/"副本放在主项目里，
 * 而主项目已经 git init），`git ls-files` 会去问父仓库要清单 ——
 * 结果是"0 个文件"，于是自检**空过**（实测踩到：副本里报告"有 .git，扫 0 个文件"）。
 * 这种情况按"没有自己的仓库"处理，改为扫工作区。
 */
function gitFiles() {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const same = path.resolve(top).toLowerCase() === path.resolve(ROOT).toLowerCase();
    if (!same) return null; // 仓库根在别处 → 本目录不是独立仓库
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * "未跟踪、且没被 .gitignore 排除"的文件。
 *
 * ⚠ 必须一起扫：它们不在 `git ls-files` 里，但 `git add -A` 会照单全收。
 * 实测踩到两次（local.json.bak 副本、含真实 personId 的新测试文件）——
 * 当时自检都报"没有发现敏感内容"，因为两类文件都是它看不见的。
 */
function untrackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-o', '--exclude-standard', '-z'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

const tracked = gitFiles();
const untracked = tracked ? untrackedFiles() : [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(path.relative(ROOT, full).replace(/\\/g, '/'));
  }
  return out;
}

const IGNORED_DIRS = /^(edge-profile|logs|data|backup-[^/]+|node_modules|\.git|\.refactor-backup)\//;
const files = tracked
  ? [...new Set([...tracked, ...untracked])] // 已跟踪 ∪ 未跟踪未忽略（后者同样会被 git add -A 收走）
  : walk(ROOT).filter((f) => (SCAN_ALL ? true : !IGNORED_DIRS.test(f)));

console.log(`\n=== 扫描范围 ===`);
console.log(
  tracked
    ? `  有 .git（仓库根就是本目录）：扫"会被提交的文件" ${files.length} 个` +
        `（已跟踪 ${tracked.length} + 未跟踪未忽略 ${untracked.length}）`
    : `  没有独立 .git：扫工作区 ${files.length} 个文件（跳过 .gitignore 里的隐私目录${SCAN_ALL ? '，本次 --all 例外' : ''}）`,
);
if (!tracked && !SCAN_ALL) {
  console.log('  提示：`git init` 之后再跑，就只扫"真正会被提交的文件"了');
}

/* ---------------- 2.5) 本机配置文件必须被忽略 ---------------- */
/*
 * 为什么单列一节：只扫"已跟踪文件"有个盲区 ——
 * **未忽略的未跟踪文件**不在清单里，但 `git add -A` 会把它们一起提交。
 * 实测踩到：.gitignore 只写了 `local.json`，于是 local.json.bak /
 * local.json.hidden（都含真实 personId）处于"随时会被推上去"的状态，
 * 而自检报告一切正常。这里把这类文件主动揪出来。
 */
const isLocalConfig = (f) => /(^|\/)local\.json(\..+)?$/i.test(f) || /(^|\/)local\.mjs$/i.test(f);
const localConfigs = walk(ROOT).filter(isLocalConfig);

/** 一份"项目副本"里必然有的隐私路径（Cookie / 状态 / 侦察数据） */
const COPY_MARKERS = /(^|\/)(edge-profile|logs|data)\/|(^|\/)(state\.json|recon-selection\.json|local\.json)$/i;

if (tracked) {
  const leaks = localConfigs.filter((f) => {
    try {
      execFileSync('git', ['check-ignore', '-q', f], { cwd: ROOT, stdio: 'ignore' });
      return false; // 被忽略 → 安全
    } catch {
      return true; // 没被忽略 → 会被 git add -A 收走
    }
  });
  ok(
    `本机配置文件全部被 .gitignore 覆盖${localConfigs.length ? `（${localConfigs.join('、')}）` : '（当前没有这类文件）'}`,
    leaks.length === 0,
    leaks.length ? `⚠ 未忽略、会被提交：${leaks.join('、')}` : '',
  );

  /*
   * 整份"项目副本"是否会被提交。
   *
   * 实测踩到：用户把导出副本改名成 `发布版测试/` 拿来实测 —— 它没被忽略，
   * 于是 `git add -A` 会把副本的 149 个文件当成新文件收进来（重复一份源码树，
   * 还能把过期副本推成"最新代码"）。
   *
   * ⚠ 别把这条写成"会泄露 Cookie"：副本里的 edge-profile/ 等**本身**仍被忽略
   *   （.gitignore 里那些规则没写前导斜杠 → git 在任意深度匹配）。
   *   实测确认过：未忽略的是 149 个源码文件，"Cookie/状态/侦察数据" 0 个。
   *   真正该拦的是"整份副本进仓库"这件事本身。
   */
  const untrackedByTop = new Set(untracked.map((f) => f.split('/')[0]));
  const copyDirs = [];
  for (const name of new Set([...untrackedByTop])) {
    const full = path.join(ROOT, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    // 像"一份项目副本"：自带 package.json + src/，或自带隐私目录
    const looksCopy =
      (existsSync(path.join(full, 'package.json')) && existsSync(path.join(full, 'src'))) ||
      ['edge-profile', 'logs', 'data', 'state.json'].some((m) => existsSync(path.join(full, m)));
    if (looksCopy) copyDirs.push(name);
  }
  ok(
    '没有被忽略的"整份项目副本"会被一起提交',
    copyDirs.length === 0,
    copyDirs.length ? `⚠ 这些目录会被 git add -A 收走：${copyDirs.join('、')}（加进 .gitignore，或别把它放在项目里）` : '',
  );

  /*
   * 硬检查：**会被提交**的文件里，不能出现任何"隐私特征路径"。
   * 这条才是真正的泄露判定 —— 一旦哪天有人加了 `!xxx/logs/` 之类的反向规则，
   * 或者用了别的目录名把 Cookie 放进来，这里就会响。
   */
  const leaked = untracked.filter((f) => COPY_MARKERS.test(f));
  ok(
    '会被提交的文件里没有隐私路径（Cookie/状态/侦察数据）',
    leaked.length === 0,
    leaked.length ? `⚠ ${leaked.length} 个：${leaked.slice(0, 3).join('、')}` : '',
  );
} else {
  console.log('  · 没有独立 .git 仓库，跳过"配置文件是否被忽略"检查');
}

/* ---------------- 3) 敏感模式 ---------------- */

const TEXT_EXT = /\.(mjs|js|json|md|html|css|bat|vbs|cs|txt|yml|yaml|sh|ps1)$/i;

/*
 * 学习通账号内部 ID（cpi）：优先从 local.json 取，其次从环境变量 / 命令行取。
 *
 * 为什么要支持后两种：导出的纯净副本里**没有 local.json**（那是隐私文件），
 * 于是副本自己的自检无法做精确匹配，只能扫通用模式 —— 实测踩到：
 * 副本自检报"没有发现敏感内容"，而副本里其实躺着一处真实 personId。
 * 所以导出脚本会用 `XXT_PERSON_ID=<真实ID>` 再跑一次副本自检。
 *
 * 取不到时**不做正则兜底** —— 兜底只能靠"9 位数字"，会把 courseId/knowledgeId
 * 全算进来（实测 44 处误报），反而让人忽略真正的命中。
 */
function knownPersonId() {
  const arg = process.argv.find((a) => a.startsWith('--person-id='));
  if (arg) return { id: arg.slice('--person-id='.length).trim() || null, from: '命令行参数' };
  if (process.env.XXT_PERSON_ID) return { id: process.env.XXT_PERSON_ID.trim() || null, from: '环境变量 XXT_PERSON_ID' };
  try {
    const id = JSON.parse(readFileSync(path.join(ROOT, 'local.json'), 'utf8')).personId || null;
    return { id, from: 'local.json' };
  } catch {
    return { id: null, from: null };
  }
}

const known = knownPersonId();
const personId = known.id;
const learningTerms = loadLearningTerms(ROOT, [process.env.APPDATA && path.join(process.env.APPDATA, 'XuexitongAssistant')]);
console.log(`  · 本机学习信息精确检查：${learningTerms.length} 条（仅输出命中文件，不输出个人信息）`);

/*
 * 明确打出"精确检查已启用"。这一行是给**调用方**看的：
 * 导出脚本会断言它存在 —— 否则"副本自检通过"可能只是因为
 * 副本里的扫描器不认识 XXT_PERSON_ID（副本过旧），属于假绿。
 * 只打尾号，避免把完整 ID 打进日志/截图。
 */
if (personId) {
  console.log(`  · personId 精确检查已启用（来源：${known.from}）`);
}

const PATTERNS = [
  /*
   * ⚠ 边界用"非数字"而不是 `\b`：卡片属性形如 `info="<clazzId>_<personId>"`，
   * ID 前面是下划线，而下划线属于 \w —— 所以 `\b<ID>\b` **匹配不上**，
   * 实测真实 ID 就这么从眼皮底下漏过去了。
   * （示例数字一律现编：这个文件会跳过自身扫描，写进去的真值没人能替你发现。）
   */
  ...(personId ? [[new RegExp(`(?<!\\d)${personId}(?!\\d)`), '学习通 personId（cpi，账号内部 ID）']] : []),
  /*
   * 只认"真实用户目录"：C:\Users\<真实用户名>。
   * 用户名的字符集限定成 Windows 实际允许的样子（字母/数字/._-），
   * 这样文档里的占位符写法（C:\Users\<用户名>）不会被误报 —— 实测踩到过。
   */
  [/C:\\+Users\\+[A-Za-z0-9._-]{2,20}(?![\\/\w])/, '本机用户目录（泄露 Windows 用户名）'],
  [/AppData\\+(?:Local|Roaming)/i, '用户 AppData 路径'],
  [/\b(csrftoken|JSESSIONID|_uid|_d|uf|k_token|ktoken|mtEnc|defenc|fid)\b\s*[:=]\s*["'][^"']{8,}/i, '疑似会话令牌/Cookie 字段'],
  [/\b1[3-9]\d{9}\b/, '手机号'],
  [/\b[\w.+-]+@(?:[\w-]+\.)+[A-Za-z]{2,}\b/, '邮箱'],
  [/\b\d{17}[\dXx]\b/, '身份证号'],
];

/** 这些文件本身就是"被忽略的本机数据"，不该算命中（local.json 及其 .bak/.hidden 副本） */
const IGNORED_FILES = [/^local\.json(\..+)?$/, /^local\.mjs$/, /^state\.json$/, /^recon-selection\.json$/];
/** 扫描器自己必然含有这些模式文本，跳过自身 */
const SELF = 'tools/test/check-privacy.mjs';

if (!personId) {
  console.log('\n  · 未找到 local.json（personId），跳过 personId 精确检查');
  console.log('    想让它精确检查的话：复制 local.example.json 为 local.json 并填上你的 personId，');
  console.log('    或临时用环境变量指定：XXT_PERSON_ID=<你的ID> node tools/test/check-privacy.mjs');
}

console.log(`\n=== 敏感内容扫描（${files.length} 个文件）===`);
const hits = [];
const skipped = [];
for (const rel of files) {
  if (!TEXT_EXT.test(rel)) continue;
  if (rel === SELF || IGNORED_FILES.some((re) => re.test(rel))) {
    skipped.push(rel);
    continue;
  }
  const full = path.join(ROOT, rel);
  if (!existsSync(full) || !statSync(full).isFile()) continue;
  let text;
  try {
    text = readFileSync(full, 'utf8');
    // npm 锁文件的废弃提示属于上游公共元数据，可能含维护者联系方式。
    // 其余内容继续扫描，不能整份跳过锁文件。
    if (rel === 'package-lock.json') {
      text = JSON.stringify(JSON.parse(text), (key, value) => key === 'deprecated' ? undefined : value);
    }
  } catch {
    continue;
  }
  for (const [re, why] of PATTERNS) {
    const m = text.match(re);
    if (m) hits.push({ rel, why, sample: String(m[0]).slice(0, 60) });
  }
  if (containsLearningTerms(text, learningTerms)) hits.push({ rel, why: '真实课程、章节或其他学习信息' });
}
if (skipped.length) {
  console.log(`  · 跳过 ${skipped.length} 个"本身就是本机数据"的文件：${skipped.join(', ')}`);
}

if (!hits.length) {
  ok('没有发现敏感内容', true);
} else {
  ok('没有发现敏感内容', false, `命中 ${hits.length} 处`);
  const byWhy = {};
  for (const h of hits) {
    byWhy[h.why] = byWhy[h.why] || [];
    byWhy[h.why].push(h.rel);
  }
  for (const [why, list] of Object.entries(byWhy)) {
    console.log(`\n  ⚠ ${why}：${list.length} 个文件`);
    for (const f of list.slice(0, 50)) console.log(`      ${f}`);
    if (list.length > 50) console.log(`      …还有 ${list.length - 50} 个`);
  }
}

/* ---------------- 4) 被忽略的隐私目录是否真的还在工作区 ---------------- */
console.log('\n=== 工作区隐私目录体积（确认它们被忽略、但本地仍在）===');
for (const d of ['edge-profile', 'logs', 'data']) {
  const full = path.join(ROOT, d);
  if (!existsSync(full)) {
    console.log(`  · ${d}/ 不存在（无需忽略）`);
    continue;
  }
  const f = walk(full).length;
  console.log(`  · ${d}/ 本地存在（${f} 个文件）—— 已被 .gitignore 排除，不会上传`);
}

console.log('\n' + '='.repeat(50));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (hits.length) {
  console.log('\n下一步：把上面命中的个人标识挪到 local.json（已忽略），或改用私有仓库。');
}
process.exit(fail ? 1 : 0);
