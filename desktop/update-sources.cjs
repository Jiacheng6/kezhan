const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

const CNB_REPOSITORY = 'kezhan-app/kezhan-releases';
const RELEASE_REPOSITORY = 'Jiacheng6/kezhan-releases';
const SOURCES = [
  { id: 'cnb', name: '国内下载（CNB）', page: `https://cnb.cool/${CNB_REPOSITORY}/-/releases`,
    provider: { provider: 'generic', url: `https://cnb.cool/${CNB_REPOSITORY}/-/releases/download/latest/`, useMultipleRangeRequest: false } },
  { id: 'github', name: 'GitHub', page: `https://github.com/${RELEASE_REPOSITORY}/releases/latest`,
    provider: { provider: 'github', owner: 'Jiacheng6', repo: 'kezhan-releases' } },
];
const preferencesFile = dataDir => path.join(dataDir, 'updates', 'preferences.json');
function validatePreference(value) {
  if (!['auto', 'cnb', 'github'].includes(value)) throw new Error('请选择自动、国内下载或 GitHub。');
  return value;
}
function readPreference(dataDir) {
  try { return validatePreference(JSON.parse(fs.readFileSync(preferencesFile(dataDir), 'utf8')).source); }
  catch { return 'auto'; }
}
function writePreference(dataDir, source) {
  validatePreference(source);
  const file = preferencesFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ source }));
  fs.renameSync(temp, file);
}
function orderedSources(sources, preference) {
  return preference === 'auto' ? sources : sources.filter(source => source.id === preference);
}
function installerIdentity(info) {
  const file = info?.files?.find(item => /\.exe(?:$|\?)/i.test(item.url));
  return file && { version: info.version, sha512: file.sha512, size: file.size };
}
function sameInstaller(left, right) {
  return !!left?.sha512 && !!right?.sha512 && left.version === right.version && left.sha512 === right.sha512 &&
    (!left.size || !right.size || left.size === right.size);
}
function isNewerStableVersion(version, current) {
  const parse = value => {
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
    const parts = value.split('.').map(Number);
    return parts.every(Number.isSafeInteger) ? parts : null;
  };
  const next = parse(version), previous = parse(current);
  if (!next || !previous) return false;
  for (let i = 0; i < 3; i++) if (next[i] !== previous[i]) return next[i] > previous[i];
  return false;
}

// Import only the installer named in the release manifest. This detects damage or
// mismatched downloads; it does not claim the user-supplied manifest is a signature.
async function prepareOfflineUpdate({ installer, manifest }, { dataDir, currentVersion }) {
  const metaStat = fs.lstatSync(manifest);
  if (!metaStat.isFile() || metaStat.isSymbolicLink() || metaStat.size > 512 * 1024) throw new Error('更新校验文件无效。');
  const meta = JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^\ufeff/, ''));
  if (!isNewerStableVersion(meta.version, currentVersion)) {
    throw new Error('请选择比当前版本更新的正式安装包。');
  }
  const expectedName = `XuexitongAssistant-${meta.version}-Setup.exe`;
  if (path.basename(installer) !== expectedName) throw new Error('安装包名称与更新校验文件不一致，请选择同一版本的文件。');
  const entry = meta.files?.find(item => item.file === expectedName);
  if (!entry || !/^[a-f0-9]{64}$/i.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) throw new Error('更新校验文件未包含有效的课栈安装包信息。');
  const stat = fs.lstatSync(installer);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes) throw new Error('安装包大小校验失败，请重新下载。');
  const cacheRoot = path.join(dataDir, 'updates', 'offline');
  fs.mkdirSync(cacheRoot, { recursive: true });
  const temp = fs.mkdtempSync(path.join(cacheRoot, 'import-'));
  let server;
  const cleanup = async () => {
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.rmSync(temp, { recursive: true, force: true });
  };
  try {
    const cached = path.join(temp, expectedName);
    const sha256 = crypto.createHash('sha256'), sha512 = crypto.createHash('sha512');
    // Hash the exact bytes copied to our own cache, avoiding changes to the original
    // file between verification and installation.
    await pipeline(fs.createReadStream(installer), new Transform({ transform(chunk, encoding, cb) {
      sha256.update(chunk); sha512.update(chunk); cb(null, chunk);
    } }), fs.createWriteStream(cached, { flags: 'wx' }));
    if (sha256.digest('hex').toLowerCase() !== entry.sha256.toLowerCase() || fs.statSync(cached).size !== entry.bytes) throw new Error('安装包校验失败，请下载同一版本的完整安装包和校验文件。');
    const digest = sha512.digest('base64');
    const feed = JSON.stringify({ version: meta.version, files: [{ url: expectedName, sha512: digest, size: entry.bytes }],
      path: expectedName, sha512: digest, releaseNotes: '从本地文件更新，安装前会保存登录状态、课程与进度。', releaseDate: new Date().toISOString() });
    const secret = crypto.randomBytes(24).toString('hex');
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      const prefix = `/${secret}/`;
      res.setHeader('Cache-Control', 'no-store');
      if (pathname === prefix + 'latest.yml') {
        res.setHeader('Content-Type', 'application/yaml'); res.end(feed);
      } else if (pathname === prefix + expectedName) {
        res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Length', entry.bytes);
        if (req.method === 'HEAD') res.end();
        else { const stream=fs.createReadStream(cached); stream.on('error',()=>res.destroy()); res.on('close',()=>stream.destroy()); stream.pipe(res); }
      } else { res.statusCode = 404; res.end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    server.unref();
    return { provider: { provider: 'generic', url: `http://127.0.0.1:${server.address().port}/${secret}/`, useMultipleRangeRequest: false }, close: cleanup };
  } catch (error) { await cleanup(); throw error; }
}

module.exports = { SOURCES, RELEASE_REPOSITORY, CNB_REPOSITORY, validatePreference, readPreference, writePreference,
  orderedSources, installerIdentity, sameInstaller, prepareOfflineUpdate };
