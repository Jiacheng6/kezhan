// Verify the fixed internal platform entry without visiting a remote site.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { _electron as electron } from 'playwright-core';
fs.mkdirSync('.desktop-test', { recursive: true });
const data = fs.mkdtempSync(path.resolve('.desktop-test/platform-entry-'));
const application = await electron.launch({
  executablePath: path.resolve('node_modules/electron/dist/electron.exe'),
  args: [process.cwd(), '--test-mode'], env: { ...process.env, XXT_TEST_DATA_DIR: data },
});
try {
  const result = await application.evaluate(async ({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const command = require('./desktop/embedded-browser.cjs').EmbeddedBrowser.prototype.command;
    const opened = [], selected = [];
    const fixture = { views: new Map(), create: async options => opened.push(options),
      snapshot: () => ({ visible: true }), activate: (id, show) => { selected.push({ id, show }); return { visible: show }; } };
    await command.call(fixture, { action: 'open-zhihuishu', url: 'https://untrusted.invalid' });
    fixture.views.set(7, { view: { webContents: { id: 7, getURL: () => 'https://onlineweb.zhihuishu.com/onlinestuh5#/course' } } });
    await command.call(fixture, { action: 'open-zhihuishu' });
    return { opened, selected };
  });
  assert.deepEqual(result.opened, [{ url: 'https://onlineweb.zhihuishu.com/onlinestuh5', show: true }]);
  assert.deepEqual(result.selected, [{ id: 7, show: true }]);
  console.log('PASS: platform entry uses fixed URL and reuses existing internal tab');
} finally {
  // This process owns only its disposable test instance.
  await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await application.close().catch(() => {});
}
