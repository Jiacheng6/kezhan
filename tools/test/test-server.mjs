import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, isPathInside } from '../../src/server.mjs';
import { PATHS, ensureDirs } from '../../src/config.mjs';
import { bus } from '../../src/logbus.mjs';
import { WebSocket } from 'ws';

assert.ok(process.env.XXT_DATA_DIR, '请通过 npm test 在隔离数据目录运行');
ensureDirs();
assert.equal(isPathInside(PATHS.answers, PATHS.answers + '-other/secret.png'), false);
assert.equal(isPathInside(PATHS.answers, path.join(PATHS.answers, 'question.png')), true);
const baseline = bus.listenerCount('status');
let actions = 0;
const { server, wss, url } = await startServer({ ping: async () => { actions++; return 'pong'; } });
try {
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(new URL('/api/action/ping', url))).status, 405);
  const invoked = await fetch(new URL('/api/action/ping', url), { method: 'POST' });
  assert.equal((await invoked.json()).result, 'pong');
  assert.equal(actions, 1);
  assert.equal((await fetch(new URL('/api/action/ping', url), { method: 'POST', headers: { Origin: 'https://unrelated.example' } })).status, 403);
  assert.equal(actions, 1);
  assert.equal((await fetch(url + '%')).status, 400);
  assert.ok([403, 404].includes((await fetch(url + '%2e%2e%2fconfig.mjs')).status));
  const photo = path.join(PATHS.answers, 'question-100%.png');
  fs.writeFileSync(photo, 'test-image');
  const query = new URL('/api/answer-image', url);
  query.searchParams.set('p', photo);
  assert.equal(await (await fetch(query)).text(), 'test-image', '百分号路径只能解码一次');
  query.searchParams.set('p', PATHS.answers + '-other/secret.png');
  assert.equal((await fetch(query)).status, 403);
  assert.equal((await fetch(new URL('/api/status', url))).status, 200, '错误请求后服务继续可用');
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace('http:', 'ws:') + 'ws', { origin: 'https://unrelated.example' });
    ws.once('open', () => { ws.terminate(); reject(new Error('不应接受跨站 WebSocket')); });
    ws.once('error', (err) => { assert.match(err.message, /40[13]/); resolve(); });
  });
} finally {
  for (const client of wss.clients) client.terminate();
  await new Promise((resolve) => wss.close(resolve));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
assert.equal(bus.listenerCount('status'), baseline, '重启不能累积监听器');
console.log('✓ 错误请求恢复、文件目录边界、重复解码、动作方法、跨站请求和监听器释放通过');
