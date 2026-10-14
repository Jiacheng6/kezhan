import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { ROOT } from '../../src/config.mjs';
const dist = path.join(ROOT, 'dist');
const app = path.join(dist, 'win-unpacked', 'resources', 'app');
for (const excluded of ['edge-profile', 'logs', 'data', 'local.json', 'state.json', 'recon-selection.json', '.git', 'tools', 'docs']) {
  assert.equal(fs.existsSync(path.join(app, excluded)), false, `发布包不能包含 ${excluded}`);
}
assert.ok(fs.existsSync(path.join(app, 'desktop', 'native', 'BrowserWindowControl.exe')));
assert.ok(fs.existsSync(path.join(app, 'src', 'chaoxing', 'essay.mjs')), '缺少简答填写模块');
assert.ok(fs.existsSync(path.join(app, 'node_modules', 'playwright-core', 'package.json')));
assert.ok(fs.existsSync(path.join(app, 'node_modules', 'ws', 'package.json')));
assert.ok(fs.existsSync(path.join(app, 'node_modules', 'electron-updater', 'package.json')));
assert.ok(fs.existsSync(path.join(app, 'desktop', 'updates.cjs')));
assert.ok(fs.existsSync(path.join(dist, 'win-unpacked', 'resources', 'app-update.yml')));
assert.ok(fs.existsSync(path.join(dist, 'latest.yml')), '缺少在线更新清单');
assert.equal(fs.existsSync(path.join(app, 'node_modules', 'electron-builder')), false);
assert.equal(fs.existsSync(path.join(app, 'desktop', 'App.cs')), false);
const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
assert.equal(pkg.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
assert.equal(pkg.main, 'desktop/main.cjs');
const files = fs.readdirSync(dist).filter((name) => name.startsWith(`XuexitongAssistant-${pkg.version}-`) && /\.(exe|zip)$/.test(name));
assert.ok(files.some((name) => name.endsWith('-Setup.exe')), '缺少安装包');
assert.ok(files.some((name) => name.endsWith('.zip')), '缺少免安装包');
const manifest = files.map((name) => {
  const file = path.join(dist, name);
  return { file: name, bytes: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
});
fs.writeFileSync(path.join(dist, 'release-manifest.json'), JSON.stringify({ version: pkg.version, files: manifest, privacyCheck: 'passed' }, null, 2));
console.log('✓ 发布包运行依赖、入口、窗口组件、个人数据排除通过');
for (const entry of manifest) console.log(`${entry.file} ${(entry.bytes / 1024 / 1024).toFixed(1)} MB`);
