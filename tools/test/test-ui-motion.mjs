// Integrated Electron home validation with isolated records; all account/task actions are mocked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
const root = process.cwd();
const output = process.env.XXT_LIBRARY_CAPTURE_DIR || path.join(root, '.desktop-test/library-ui');
fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(path.join(root, '.desktop-test'), { recursive: true });
const data = fs.mkdtempSync(path.join(root, '.desktop-test/library-ui-'));
fs.mkdirSync(path.join(data, 'data/probe-out'), { recursive: true });
const report = { at: '2026-01-01T00:00:00Z', courses: ['设计入门', '英语听说练习', '信息与媒介', '计算与思考'].map((name, c) => ({
  name, courseId: 'library-course-' + c, clazzId: 'library-class-' + c,
  taskPoints: ['观察日常空间', '从物品到设计', '材料与表达'].flatMap((sectionName, s) => ['video', 'work'].map((type, t) => ({
    knowledgeId: `library-section-${c}-${s}`, secNo: '1.' + (s + 1), sectionName, name: t ? '章节测验' : sectionName + ' · 视频', type, typeName: t ? '章节测验' : '视频', finished: false, cardNum: t, idx: 0,
  }))),
})) };
const records = { version: 3, taskPoints: {
  'library-course-0:library-section-0-0:t0': { status: 'done' },
  'library-course-0:library-section-0-0:t1': { status: 'manual' },
  'library-course-0:library-section-0-1:t0': { status: 'done' },
}, reviewQueue: [] };
fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify(records));
fs.writeFileSync(path.join(data, 'data/probe-out/task-report.json'), JSON.stringify(report));
const application = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root, '--test-mode'], env: { ...process.env, XXT_TEST_DATA_DIR: data } });
const checks = {}, errors = [];
try {
  const page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForURL('http://127.0.0.1:*/');
  await page.locator('#libraryHome #appearance').click(); await page.locator('#libraryHome #showOnStartup').uncheck(); await page.locator('#libraryHome #enterWorkspace').click();
  await application.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1240, 800); win.showInactive(); });
  await page.locator('.tab[data-tab=courses]').click();
  const panelMotion = await page.locator('#panel-courses').evaluate(el => ({ animations: el.getAnimations().length, transform: getComputedStyle(el).transform }));
  assert.ok(panelMotion.animations > 0); assert.notEqual(panelMotion.transform, 'none'); checks.realPanelTransition = true;
  for (const tab of ['settings', 'review', 'courses']) await page.locator('.tab[data-tab=' + tab + ']').click();
  await page.waitForTimeout(450); assert.equal(await page.locator('.panel.active').count(), 1); assert.equal(await page.locator('#panel-courses').evaluate(el => el.getAnimations().length), 0); checks.interruptedNavigationSettles = true;
  await page.locator('.treehead .caret').first().click(); await page.waitForTimeout(70);
  const heightDuring = await page.locator('.treebody').first().evaluate(el => el.getBoundingClientRect().height);
  await page.waitForTimeout(350); const heightAfter = await page.locator('.treebody').first().evaluate(el => el.getBoundingClientRect().height);
  assert.ok(heightDuring > 0 && heightDuring < heightAfter, JSON.stringify({ heightDuring, heightAfter })); checks.measuredExpansion = true;
  await page.locator('.treehead .caret').first().click(); await page.waitForTimeout(55); await page.locator('.treehead .caret').first().click(); await page.waitForTimeout(400);
  assert.equal(await page.locator('.treecourse').first().evaluate(el => el.classList.contains('open')), true); checks.rapidReverseExpansion = true;
  await page.evaluate(() => { window.__untouchedCourse = document.querySelectorAll('.treecourse')[1]; });
  const checkbox = page.locator('.tprow input[type=checkbox]').nth(1); await checkbox.focus(); await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.motionKey), 'library-course-0:library-section-0-0:t1:selected');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.treecourse')[1] === window.__untouchedCourse), true); checks.focusAndUnchangedNodesPreserved = true;
  const sectionCheck = page.locator('.sechead input').first(); await sectionCheck.focus(); await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.motionKey), 'library-course-0:section:library-section-0-0');
  await page.locator('.selection-tools summary').click(); await page.locator('[data-tree=expandAll]').click(); await page.waitForTimeout(350);
  assert.equal(await page.locator('.treecourse.open').count(), 4);
  await page.locator('.selection-tools summary').click(); await page.locator('.tprow input[type=checkbox]').first().focus(); await page.keyboard.press('Space');
  assert.equal(await page.locator('.treecourse.open').count(), 4); checks.sectionFocusAndBulkExpandedState = true;
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.locator('.tab[data-tab=settings]').click();
  assert.equal(await page.locator('#panel-settings').evaluate(el => el.getAnimations().length), 0); checks.systemReducedMotion = true;
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('#enterLibrary').click(); await page.locator('#libraryHome #appearance').click(); await page.locator('#libraryHome #motion').click(); await page.locator('#libraryHome #enterWorkspace').click();
  await page.locator('.tab[data-tab=logs]').click(); assert.equal(await page.locator('#panel-logs').evaluate(el => el.getAnimations().length), 0); checks.sharedMotionPreference = true;
  await page.locator('#enterLibrary').click(); await page.locator('#libraryHome #appearance').click(); await page.locator('#libraryHome #motion').click(); await page.locator('#libraryHome #enterWorkspace').click();
  const cadence = await page.evaluate(() => new Promise(resolve => { const values = []; let previous = 0; const step = now => { if (previous) values.push(now - previous); previous = now; if (values.length < 90) requestAnimationFrame(step); else { const sorted = values.toSorted((a, b) => a - b); resolve({ samples: values.length, p95Ms: sorted[Math.floor(sorted.length * .95)], over50: values.filter(ms => ms > 50).length }); } }; requestAnimationFrame(step); }));
  assert.deepEqual(errors, []);
  fs.mkdirSync('.build-cache/original-motion', { recursive: true }); fs.writeFileSync('.build-cache/original-motion/motion-checks.json', JSON.stringify({ checks, panelMotion, heightDuring, heightAfter, cadence, errors }, null, 2));
  console.log(JSON.stringify({ checks, cadence }, null, 2));
} finally { await application.evaluate(({ app, dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); app.quit(); }).catch(() => {}); await application.close().catch(() => {}); }
