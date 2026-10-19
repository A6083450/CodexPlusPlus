'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function version(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error('无效的 Claude 更新版本');
  return value.split('.').map(Number);
}

function selectRelease(feed, installed) {
  const target = version(feed.currentRelease);
  const current = version(installed);
  const difference = target.map((part, i) => part - current[i]).find((part) => part !== 0) || 0;
  if (difference <= 0) return null;
  const release = feed.releases?.find((item) => item.version === feed.currentRelease)?.updateTo;
  if (!release || release.version !== feed.currentRelease || !/^[a-f0-9]{64}$/i.test(release.sha256)
      || !Number.isSafeInteger(release.size) || release.size <= 0) throw new Error('Claude 官方更新信息不完整');
  const url = new URL(release.url);
  if (url.protocol !== 'https:' || url.hostname !== 'downloads.claude.ai' || url.port || url.username || url.password
      || !url.pathname.endsWith('.zip')) throw new Error('拒绝非官方 Claude 更新包');
  return release;
}

function runPython(options, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.python, [path.join(__dirname, 'managed-update.py'), ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk) => { error = (error + chunk).slice(-3000); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(error.trim() || 'Claude 更新准备失败')));
  });
}

async function download(fetch, release, file) {
  const response = await fetch(release.url, { signal: AbortSignal.timeout(600000) });
  if (!response.ok || !response.body) throw new Error(`下载 Claude 更新失败：HTTP ${response.status}`);
  const hash = createHash('sha256');
  let bytes = 0;
  const verify = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > release.size) return callback(new Error('Claude 更新包大小不匹配'));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), verify, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  if (bytes !== release.size || hash.digest('hex') !== release.sha256.toLowerCase()) throw new Error('Claude 更新包 SHA-256 或大小校验失败');
}

function installUpdater({ app, autoUpdater, net }, options, log) {
  let busy = false;
  let ready = null;
  let installing = false;
  autoUpdater.checkForUpdates = async () => {
    if (busy || installing) return;
    busy = true;
    try {
      autoUpdater.emit('checking-for-update');
      const feedURL = new URL(autoUpdater.getFeedURL());
      if (feedURL.protocol !== 'https:' || feedURL.hostname !== 'api.anthropic.com' || feedURL.port
          || !feedURL.pathname.startsWith('/api/desktop/darwin/')) throw new Error('拒绝非官方 Claude 更新源');
      const response = await net.fetch(feedURL.href, { signal: AbortSignal.timeout(30000) });
      if ([204, 404].includes(response.status)) { ready = null; autoUpdater.emit('update-not-available'); return; }
      if (!response.ok) throw new Error(`检查 Claude 更新失败：HTTP ${response.status}`);
      const release = selectRelease(await response.json(), app.getVersion());
      if (!release) { ready = null; autoUpdater.emit('update-not-available'); return; }
      autoUpdater.emit('update-available');
      if (ready?.release.version !== release.version) {
        ready = null;
        const root = path.join(__dirname, 'updates', randomUUID());
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        const archive = path.join(root, 'update.zip');
        await download(net.fetch.bind(net), release, archive);
        const plan = path.join(root, 'plan.json');
        fs.writeFileSync(plan, JSON.stringify({ ...options, release, parentPid: process.pid }), { mode: 0o600 });
        await runPython(options, ['--prepare', plan]);
        ready = { release, plan };
        log('managed update prepared: ' + release.version);
      }
      autoUpdater.emit('update-downloaded', {}, release.notes || '', release.name || release.version,
        new Date(release.pub_date), release.url);
    } catch (error) {
      ready = null;
      log('managed update failed: ' + error.message);
      autoUpdater.emit('error', error);
    } finally {
      busy = false;
    }
  };
  autoUpdater.quitAndInstall = () => {
    if (!ready || installing) return;
    installing = true;
    const output = fs.openSync(path.join(path.dirname(ready.plan), 'install.log'), 'a', 0o600);
    let child;
    try {
      child = spawn(options.python, [path.join(__dirname, 'managed-update.py'), '--install', ready.plan],
        { detached: true, stdio: ['ignore', 'pipe', output] });
    } finally { fs.closeSync(output); }
    let acknowledged = false;
    const timer = setTimeout(() => {
      child.kill();
      installing = false;
      autoUpdater.emit('error', new Error('Claude 更新安装器启动超时，应用保持运行'));
    }, 10000);
    child.once('error', (error) => { clearTimeout(timer); installing = false; autoUpdater.emit('error', error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (!acknowledged) {
        installing = false;
        autoUpdater.emit('error', new Error(`Claude 更新安装器未就绪 (${code})，应用保持运行`));
      }
    });
    let message = '';
    child.stdout.on('data', (chunk) => {
      message += chunk.toString();
      if (acknowledged || !message.includes('ready\n')) return;
      acknowledged = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.unref();
      autoUpdater.emit('before-quit-for-update');
      app.quit();
    });
  };
}

module.exports = { selectRelease, download, installUpdater };
