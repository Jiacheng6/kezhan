// Actual embedded engine with isolated persistent data. No automatic task execution.
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
const root = process.cwd(); fs.mkdirSync('.desktop-test', { recursive: true });
const testRoot = path.resolve('.desktop-test');
const remembered=path.join(testRoot,'embedded-preview.json');let previous='';
try{previous=JSON.parse(fs.readFileSync(remembered,'utf8')).directory||'';}catch{}
const saved=previous&&path.resolve(testRoot,previous);
const reusable=saved&&saved.startsWith(testRoot+path.sep)&&path.basename(saved)===previous&&previous.startsWith('embedded-preview-')&&fs.existsSync(saved)&&fs.statSync(saved).isDirectory();
const data = process.argv[2] ? path.resolve(process.argv[2]) : reusable?saved:fs.mkdtempSync(path.join(testRoot, 'embedded-preview-'));
if (!data.startsWith(testRoot + path.sep) || !path.basename(data).startsWith('embedded-preview-') || !fs.statSync(data).isDirectory()) throw new Error('预览只能使用独立的 embedded-preview 数据目录');
fs.writeFileSync(remembered,JSON.stringify({directory:path.basename(data)},null,2));
const app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root, '--embedded-test'],
  env: { ...process.env, XXT_TEST_DATA_DIR: data, XXT_EMBEDDED_TEST_HOME: '' }, timeout: 30000 });
try {
  const page = await app.firstWindow(); await page.waitForURL('http://127.0.0.1:*/');
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1360, 940); w.setTitle('课栈 · 修复验收（独立数据，保留登录）'); w.show(); w.focus(); });
  console.log(JSON.stringify({ url: page.url(), data, externalBrowser: false }));
  await new Promise(resolve => app.process().once('exit', resolve));
} finally { await app.close().catch(() => {}); }
