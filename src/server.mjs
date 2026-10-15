/**
 * 本地可视化控制台服务：HTTP 静态资源 + WebSocket 实时推送。
 * 只监听 127.0.0.1，不对外网暴露。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { PATHS, CONSOLE_PORT_START, CONSOLE_PORT_MAX_TRIES } from './config.mjs';
import { bus, getRecentLogs, getStatus, patchStatus, log } from './logbus.mjs';
import { buildChecklist, loadSelection, saveSelection, loadReconReport } from './chaoxing/checklist.mjs';
import { listReviewItems, reviewStats, updateReviewAnswer, markReviewItem } from './state.mjs';

/** 读取请求体 JSON（限长，防滥用） */
function readJson(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(new Error(`JSON 解析失败: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
};

export function isPathInside(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isFileInside(base, target) {
  return isPathInside(base, target) && isPathInside(fs.realpathSync(base), fs.realpathSync(target));
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const full = path.join(PATHS.ui, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!isPathInside(PATHS.ui, full)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 not found');
    return;
  }
  if (!isFileInside(PATHS.ui, full)) return res.writeHead(403).end('forbidden');
  res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
}

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * @param {object} hooks 由 main 注入的动作处理器
 */
export async function startServer(hooks = {}) {
  const server = http.createServer(async (req, res) => {
    try {
    const expectedHost = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)) {
      return json(res, 403, { ok: false, error: '仅允许本软件调用本地服务' });
    }
    const { pathname } = new URL(req.url, 'http://x');

    if (pathname === '/api/status') return json(res, 200, getStatus());
    if (pathname === '/api/logs') return json(res, 200, getRecentLogs());

    // 任务点清单（P1 产物）
    if (pathname === '/api/checklist') {
      try {
        const data = buildChecklist({ includeProgress: true });
        return json(res, 200, { ok: true, result: data });
      } catch (err) {
        return json(res, 200, { ok: false, error: err.message });
      }
    }

    // 保存界面里的勾选与排序
    if (pathname === '/api/selection' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        saveSelection({
          courseOrder: body.courseOrder || [],
          courses: body.courses || {},
          taskOrder: body.taskOrder || {},
          excluded: body.excluded || [],
        });
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }

    /*
     * 保存设置（设置页可编辑）。
     * 校验交给 settings.normalizeSettings（纯函数、有单测）：
     * 未知键拒绝、数值夹紧、类型不符报错 —— 免得界面写错键名却毫无反馈。
     */
    if (pathname === '/api/settings' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        if (typeof hooks.saveSettings !== 'function') {
          return json(res, 500, { ok: false, error: '设置保存未就绪' });
        }
        const r = await hooks.saveSettings(body.patch || body || {});
        return json(res, 200, { ok: r.ok !== false, result: r });
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }

    /** 读当前设置（含单位换算后的展示值） */
    if (pathname === '/api/settings') {
      try {
        if (typeof hooks.getSettings !== 'function') {
          return json(res, 500, { ok: false, error: '设置读取未就绪' });
        }
        return json(res, 200, { ok: true, result: await hooks.getSettings() });
      } catch (err) {
        return json(res, 500, { ok: false, error: err.message });
      }
    }

    if (pathname === '/api/recon-report') {
      try {
        const report = loadReconReport();
        if (!report) return json(res, 200, { ok: false, error: '还没有侦察数据' });
        return json(res, 200, { ok: true, result: report });
      } catch (err) {
        return json(res, 200, { ok: false, error: err.message });
      }
    }

    // —— 待审队列 ——
    if (pathname === '/api/review') {
      try {
        const items = listReviewItems();
        /*
         * 注意：hooks 里的方法都是 async，必须 await。
         * 且不能写成 `await p.catch(...)` —— await 先求值，那里没有 catch 可调，
         * 会得到 undefined（这正是 keptPages 一直是 undefined 的原因）。用 try/catch。
         */
        let keptPages = [];
        if (typeof hooks.listKeptPages === 'function') {
          try {
            keptPages = (await hooks.listKeptPages()) || [];
          } catch {
            keptPages = [];
          }
        }
        return json(res, 200, {
          ok: true,
          result: { items, stats: reviewStats(), keptPages: keptPages || [] },
        });
      } catch (err) {
        return json(res, 200, { ok: false, error: err.message });
      }
    }

    // 题目截图（浏览器不能直接读本地任意路径，必须由服务端转发）
    if (pathname === '/api/answer-image') {
      const p = new URL(req.url, 'http://x').searchParams.get('p');
      if (!p) return json(res, 400, { ok: false, error: '缺少 p 参数' });

      // 安全：只允许读 answers 目录下的文件
      const resolved = path.resolve(p);
      const base = path.resolve(PATHS.answers);
      if (!isPathInside(base, resolved)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden');
        return;
      }
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
        return;
      }
      if (!isFileInside(base, resolved)) return res.writeHead(403).end('forbidden');
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
      fs.createReadStream(resolved).on('error', () => res.destroy()).pipe(res);
      return;
    }

    if (pathname === '/api/review/edit' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        if (Object.hasOwn(body, 'textAnswer') && !hooks.editReviewAnswer) throw new Error('当前服务无法连接简答编辑器');
        const it = hooks.editReviewAnswer ? await hooks.editReviewAnswer(body) : updateReviewAnswer(body.id, body.letters || []);
        if (!it) return json(res, 404, { ok: false, error: '题目不存在' });
        return json(res, 200, { ok: true, result: it });
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }

    if (pathname === '/api/review/discard' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        const it = hooks.discardReviewItem?await hooks.discardReviewItem(body):markReviewItem(body.id, { status: 'discarded' });
        if (!it) return json(res, 404, { ok: false, error: '题目不存在' });
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }

    if (pathname === '/api/review/open' && req.method === 'POST') {
      try{
        const body=await readJson(req);
        if(typeof hooks.openReview!=='function')throw new Error('作业恢复功能未就绪');
        return json(res,200,{ok:true,result:await hooks.openReview(body)});
      }catch(error){return json(res,400,{ok:false,error:error.message});}
    }

    if (pathname === '/api/review/submit' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        if (typeof hooks.submitReviews !== 'function') {
          return json(res, 500, { ok: false, error: '提交功能未就绪' });
        }
        const result = await hooks.submitReviews(body);
        const ok=result.submitted>0&&!result.failed;
        return json(res, 200, { ok, result, error:ok?null:result.note||(result.details||[]).filter(item=>!item.ok).map(item=>item.error).join('；')||'未确认任何作业提交成功' });
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }

    if (pathname.startsWith('/api/action/')) {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: '动作需要 POST 请求' });
      const name = pathname.slice('/api/action/'.length);
      const fn = hooks[name];
      if (typeof fn !== 'function') return json(res, 404, { ok: false, error: `未知动作: ${name}` });
      try {
        const out = await fn(req);
        return json(res, 200, { ok: true, result: out ?? null });
      } catch (err) {
        log(`动作 ${name} 失败: ${err.message}`, 'error');
        return json(res, 500, { ok: false, error: err.message });
      }
    }

    serveStatic(req, res);
    } catch (err) {
      if (!res.headersSent && !res.destroyed) json(res, 400, { ok: false, error: err.message });
      else res.destroy();
    }
  });

  // 端口探测：占用则 +1
  let port = CONSOLE_PORT_START;
  for (let i = 0; i < CONSOLE_PORT_MAX_TRIES; i += 1) {
    try {
      await listen(server, port);
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      log(`端口 ${port} 被占用，尝试 ${port + 1}`, 'debug');
      port += 1;
      if (i === CONSOLE_PORT_MAX_TRIES - 1) {
        throw new Error(`端口 ${CONSOLE_PORT_START}~${port} 全部被占用，请释放其中之一`);
      }
    }
  }

  const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }) => {
    const expected = `127.0.0.1:${port}`;
    return req.headers.host === expected && (!req.headers.origin || req.headers.origin === `http://${expected}`);
  } });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'status', data: getStatus() }));
    ws.send(JSON.stringify({ type: 'logs', data: getRecentLogs() }));
    ws.send(JSON.stringify({ type: 'hello', data: { port } }));
  });

  const forward = (type) => (data) => {
    const msg = JSON.stringify({ type, data });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  };
  const listeners = ['log', 'status', 'state'].map((type) => [type, forward(type)]);
  for (const [type, listener] of listeners) bus.on(type, listener);
  server.once('close', () => { for (const [type, listener] of listeners) bus.off(type, listener); });

  const url = `http://127.0.0.1:${port}/`;
  patchStatus({ consoleUrl: url, consolePort: port });
  return { server, wss, port, url };
}
