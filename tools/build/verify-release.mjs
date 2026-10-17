import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { ROOT } from '../../src/config.mjs';
import { loadLearningTerms, containsLearningTerms } from '../test/privacy-learning.mjs';
import { isPublicNumericAsset } from '../test/privacy-public-assets.mjs';
const dist = path.join(ROOT, 'dist');
const app = path.join(dist, 'win-unpacked', 'resources', 'app');
for (const excluded of ['edge-profile', 'Partitions', 'browser-session.bin', 'notifications.json', 'logs', 'data', 'local.json', 'state.json', 'recon-selection.json', '.git', 'tools', 'docs']) {
  assert.equal(fs.existsSync(path.join(app, excluded)), false, `发布包不能包含 ${excluded}`);
}
assert.ok(fs.existsSync(path.join(app, 'desktop', 'native', 'BrowserWindowControl.exe')));
assert.ok(fs.existsSync(path.join(app, 'src', 'chaoxing', 'essay.mjs')), '缺少简答填写模块');
for (const relative of ['src/chaoxing/playback-policy.mjs', 'src/ui/task-progress.js', 'src/ui/task-progress.css', 'src/ui/web-pages.js', 'src/ui/workbench-restore.css']) {
  assert.equal(fs.readFileSync(path.join(app, relative)).equals(fs.readFileSync(path.join(ROOT, relative))), true, '缺少或打包版本不一致：' + relative);
}
for (const relative of ['src/ui/run-scope.js', 'src/batch.mjs', 'src/chaoxing/quizrun.mjs', 'src/ui/app.js', 'src/main.mjs', 'desktop/notifications.cjs', 'src/ui/notifications.js', 'src/ui/notifications.css', 'src/chaoxing/quiz-outcome.mjs', 'src/ai/ai.mjs', 'src/onboarding.mjs', 'src/ui/onboarding.js', 'src/ui/onboarding.css', 'src/ui/selection-desk.js', 'src/ui/selection-plan.js', 'src/ui/learning-focus.css', 'src/chaoxing/selection-presets.mjs', 'src/ui/close-dialog.js', 'src/ui/dialogs.css', 'desktop/close-confirmation.cjs', 'desktop/embedded-browser.cjs', 'src/browser/embedded.mjs', 'src/ui/embedded-browser.js', 'src/ui/embedded-browser.css']) {
  assert.ok(fs.existsSync(path.join(app, relative)), '缺少本次更新模块：' + relative);
  assert.equal(fs.readFileSync(path.join(app, relative)).equals(fs.readFileSync(path.join(ROOT, relative))), true, '打包源码不一致：' + relative);
}
for (const file of ['review-recovery.mjs', 'review-lock.mjs']) assert.ok(fs.existsSync(path.join(app, 'src', 'chaoxing', file)), '缺少作业恢复模块：' + file);
assert.ok(fs.existsSync(path.join(app, 'node_modules', 'playwright-core', 'package.json')));
assert.ok(fs.existsSync(path.join(app, 'node_modules', 'ws', 'package.json')));
assert.ok(fs.existsSync(path.join(app, 'node_modules', 'electron-updater', 'package.json')));
assert.ok(fs.existsSync(path.join(app, 'desktop', 'updates.cjs')));
assert.ok(fs.existsSync(path.join(dist, 'win-unpacked', 'resources', 'app-update.yml')));
assert.ok(fs.existsSync(path.join(dist, 'latest.yml')), '缺少在线更新清单');
assert.equal(fs.existsSync(path.join(app, 'node_modules', 'electron-builder')), false);
assert.equal(fs.existsSync(path.join(app, 'desktop', 'App.cs')), false);
const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
assert.equal(fs.readFileSync(path.join(app, 'src/ai/question-prompt.mjs')).equals(fs.readFileSync(path.join(ROOT, 'src/ai/question-prompt.mjs'))), true, '发布包必须包含无字母选项说明修复');
assert.equal(fs.readFileSync(path.join(app, 'src/ai/web-chat.mjs')).equals(fs.readFileSync(path.join(ROOT, 'src/ai/web-chat.mjs'))), true, '发布包必须包含本次 AI 网页输入恢复修复');
assert.equal(pkg.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
assert.equal(pkg.main, 'desktop/main.cjs');
const archive = path.join(app, 'src/ui/library/archive');
assert.match(fs.readFileSync(path.join(archive, 'LICENSE.txt'), 'utf8'), /LBEILC/);
const hash = (file, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);
const { verifyArchiveModel } = await import('../ui/course-archive/scripts/verify-model.mjs');
assert.equal(hash(path.join(archive, 'assets/archive-cassette.glb')), hash(path.join(ROOT, 'src/ui/library/archive/assets/archive-cassette.glb')), '发布包必须与当前档案模型一致');
await verifyArchiveModel(path.join(ROOT, 'tools/ui/course-archive/public/assets/archive-cassette.glb'), path.join(archive, 'assets/archive-cassette.glb'));
assert.equal(fs.existsSync(path.join(archive, 'assets/course-folio.glb')), false, '运行版不应包含已弃用的文件夹设计');
const studio = JSON.parse(fs.readFileSync(path.join(archive, 'assets/archive-studio.json'), 'utf8'));
assert.equal(studio.format, 'rgba-f16-le');
assert.equal(gunzipSync(fs.readFileSync(path.join(archive, 'assets/archive-studio.bin.gz'))).length, studio.width * studio.height * 8);
for (const relative of ['desktop/assets/icon.ico', 'desktop/assets/icon.png', 'desktop/assets/icon.svg', 'src/ui/icon.svg']) {
  assert.equal(hash(path.join(app, relative)), hash(path.join(ROOT, relative)), `打包图标与源码不一致：${relative}`);
}
const icon = fs.readFileSync(path.join(app, 'desktop/assets/icon.ico'));
assert.ok(icon.readUInt16LE(4) >= 6, 'Windows 图标必须包含小尺寸');
const feed = fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8');
assert.match(feed, new RegExp(`^version: ${pkg.version.replaceAll('.', '\\.')}\\s*$`, 'm'));
const installerName = `XuexitongAssistant-${pkg.version}-Setup.exe`;
assert.ok(feed.includes(`path: ${installerName}`), '在线更新应指向本次安装包');
const expectedSha512 = hash(path.join(dist, installerName), 'sha512', 'base64');
assert.ok(feed.includes(`sha512: ${expectedSha512}`), '在线更新 SHA-512 校验值不一致');
assert.ok(feed.includes(`size: ${fs.statSync(path.join(dist, installerName)).size}`), '在线更新大小不一致');
assert.ok(feed.includes('releaseNotes:'), '在线更新清单必须包含更新内容');
const sourcePackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const releaseNotes = fs.readFileSync(path.join(ROOT, sourcePackage.build.releaseInfo.releaseNotesFile), 'utf8');
for (const line of releaseNotes.split(/\r?\n/).filter(line => line.startsWith('- '))) {
  assert.ok(feed.includes(line), '更新清单应完整包含本次更新说明');
}
const updateConfig = fs.readFileSync(path.join(dist, 'win-unpacked/resources/app-update.yml'), 'utf8');
assert.match(updateConfig, /owner: Jiacheng6/);
assert.match(updateConfig, /repo: xuexitong-assistant-releases/);

// Inspect the actual packaged application, including files omitted from Git.
// Dependency contact details are public; personal learning terms are checked everywhere.
const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(directory, entry.name);
  assert.equal(entry.isSymbolicLink(), false, '发布目录不能通过符号链接引入本机数据');
  return entry.isDirectory() ? walk(full) : [full];
});
const learningTerms = loadLearningTerms(ROOT, [process.env.APPDATA && path.join(process.env.APPDATA, 'XuexitongAssistant')]);
const personIds = new Set();
for (const base of [ROOT, process.env.APPDATA && path.join(process.env.APPDATA, 'XuexitongAssistant')].filter(Boolean)) {
  const file = path.join(base, 'local.json');
  if (!fs.existsSync(file)) continue;
  const id = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, '')).personId;
  if (id) personIds.add(String(id));
}
let scanned = 0;
for (const full of walk(app)) {
  const relative = path.relative(app, full).replaceAll('\\', '/');
  const own = !relative.startsWith('node_modules/');
  if (own) assert.equal(/(?:^|\/)(?:edge-profile|Partitions|logs|data|\.git|\.desktop-test)(?:\/|$)|(?:^|\/)(?:browser-session\.bin(?:\..*)?|local\.json(?:\..*)?|state\.json|recon-selection\.json|\.privacy-blocklist\.local\.json)$/i.test(relative), false, `发布包含个人数据路径：${relative}`);
  if (!/\.(?:m?js|cjs|json|html|css|md|txt|yml|yaml|svg)$/i.test(relative)) continue;
  const content = fs.readFileSync(full, 'utf8');
  scanned++;
  assert.equal(containsLearningTerms(content, learningTerms), false, `发布包含真实学习信息：${relative}`);
  for (const id of personIds) assert.equal(new RegExp(`(?<!\\d)${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`).test(content), false, `发布包含本机账号标识：${relative}`);
  if (!own) continue;
  assert.equal(/C:\\+Users\\+[A-Za-z0-9._-]{2,20}(?![\\/\w])|AppData\\+(?:Local|Roaming)/i.test(content), false, `发布包含本机用户路径：${relative}`);
  assert.equal(/\b(?:csrftoken|JSESSIONID|_uid|ktoken|mtEnc|defenc)\b\s*[:=]\s*["'][^"']{8,}/i.test(content), false, `发布包疑似含会话令牌：${relative}`);
  assert.equal(/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/.test(content), false, `发布包疑似含 GitHub 凭据：${relative}`);
  if (!isPublicNumericAsset(relative, content)) assert.equal(/\b1[3-9]\d{9}\b|\b\d{17}[\dXx]\b/.test(content), false, `发布包疑似含手机号或身份证号：${relative}`);
}
const files = fs.readdirSync(dist).filter((name) => name.startsWith(`XuexitongAssistant-${pkg.version}-`) && /\.(exe|zip)$/.test(name));
assert.ok(files.some((name) => name.endsWith('-Setup.exe')), '缺少安装包');
assert.ok(files.some((name) => name.endsWith('.zip')), '缺少免安装包');
const manifest = files.map((name) => {
  const file = path.join(dist, name);
  return { file: name, bytes: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
});
const sidecars = [installerName + '.blockmap', 'latest.yml'].map((name) => ({ file: name, bytes: fs.statSync(path.join(dist, name)).size, sha256: hash(path.join(dist, name)) }));
fs.writeFileSync(path.join(dist, 'release-manifest.json'), JSON.stringify({ version: pkg.version, files: manifest, updateFiles: sidecars, privacyCheck: 'passed', scannedTextFiles: scanned }, null, 2));
fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), [...manifest, ...sidecars].map((entry) => `${entry.sha256}  ${entry.file}`).join('\n') + '\n');
console.log(`✓ 发布包依赖、图标、许可、更新校验与隐私扫描通过（${scanned} 个文本文件）`);
for (const entry of manifest) console.log(`${entry.file} ${(entry.bytes / 1024 / 1024).toFixed(1)} MB`);
