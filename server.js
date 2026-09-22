'use strict';
// kuoboX 中轉管理面板：零依賴 Node.js 伺服器（只使用內建模組）。
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const dgram = require('node:dgram');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { createConfigStore, revision } = require('./lib/config-store');
const { savedNodes, parseConfig } = require('./lib/saved-nodes');
const { addRelay, removeInbound, parseStrict, listOutbounds } = require('./lib/relay');
const { buildOutbound, describeOutbound, isHost } = require('./lib/links');
const { setEnv } = require('./lib/env-file');
const firewall = require('./lib/firewall');
const { version: PANEL_VERSION } = require('./package.json');

const SESSION_TTL = 30 * 60 * 1000;
const BODY_LIMIT = 2 * 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

function defaultRun(cmd, args = [], options = {}) {
  if (cmd === 'sing-box') cmd = process.env.SINGBOX_BINARY || 'sing-box';
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: options.timeout || 15000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || '').trim(), stderr: String(stderr || (err && err.message) || '').trim() });
    });
  });
}

function loadStatic(dir) {
  const files = new Map();
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    const body = fs.readFileSync(full);
    files.set('/' + name, { body, type: MIME[path.extname(name)] || 'application/octet-stream', etag: '"' + crypto.createHash('sha1').update(body).digest('base64url') + '"' });
  }
  return files;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) { reject(httpError(413, '請求超過 2 MB 限制')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
      } catch { reject(httpError(400, '請求格式錯誤')); }
    });
    req.on('error', reject);
  });
}

function fetchText(url, timeout = 5000) {
  return new Promise(resolve => {
    const req = https.get(url, { timeout, headers: { 'User-Agent': 'curl/8' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return resolve(''); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => { if (data.length < 4096) data += d; });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(''));
  });
}

function portAvailable(port, network) {
  const tcp = () => new Promise(resolve => {
    const s = net.createServer();
    s.once('error', e => resolve(e.code !== 'EADDRINUSE'));
    s.listen({ port, host: '0.0.0.0', exclusive: true }, () => s.close(() => resolve(true)));
  });
  const udp = () => new Promise(resolve => {
    const s = dgram.createSocket('udp4');
    s.once('error', e => { s.close(); resolve(e.code !== 'EADDRINUSE'); });
    s.bind({ port, address: '0.0.0.0', exclusive: true }, () => s.close(() => resolve(true)));
  });
  const checks = network === 'udp' ? [udp] : network === 'tcp+udp' ? [tcp, udp] : [tcp];
  return Promise.all(checks.map(c => c())).then(r => r.every(Boolean));
}

function createApp(options = {}) {
  const run = options.run || defaultRun;
  const cfg = {
    password: options.password,
    configPath: options.configPath || '/etc/sing-box/config.json',
    envPath: options.envPath || path.join(__dirname, '.env'),
    statePath: options.statePath || path.join(path.dirname(options.envPath || path.join(__dirname, '.env')), 'panel-state.json'),
    publicDir: options.publicDir || path.join(__dirname, 'public'),
    portAvailable: options.portAvailable || portAvailable,
  };
  if (!cfg.password) throw new Error('請先在 .env 設定 PANEL_PASSWORD');
  const store = createConfigStore(cfg.configPath, run, options.settle);
  const statics = loadStatic(cfg.publicDir);
  const sessions = new Map();
  const attempts = new Map();
  const routes = new Map();
  const route = (method, pathname, handler, auth = true) => routes.set(`${method} ${pathname}`, { handler, auth });

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of sessions) if (now - v > SESSION_TTL) sessions.delete(k);
    for (const [k, v] of attempts) if (now > v.resetAt) attempts.delete(k);
  }, 5 * 60 * 1000);
  sweeper.unref();

  // ── 快取的系統資訊 ─────────────────────────────────
  const cache = (ms, fn) => {
    let value, at = 0, pending = null;
    const get = async () => {
      if (value !== undefined && Date.now() - at < ms) return value;
      if (!pending) pending = fn().then(v => { value = v; at = Date.now(); return v; }).finally(() => { pending = null; });
      return pending;
    };
    get.reset = () => { at = 0; };
    return get;
  };

  const singboxVersion = cache(5 * 60 * 1000, async () => {
    const r = await run('sing-box', ['version']);
    return (/version\s+v?([\w.+-]+)/i.exec(r.stdout) || [])[1] || '';
  });

  let cpuPrevious = null;
  const sysinfo = cache(3000, async () => {
    const total = os.cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0) }), { idle: 0, total: 0 });
    const delta = cpuPrevious ? total.total - cpuPrevious.total : 0;
    const cpu = delta > 0 ? Math.max(0, Math.min(100, 100 * (1 - (total.idle - cpuPrevious.idle) / delta))) : null;
    cpuPrevious = total;
    let available = os.freemem();
    try { available = Number(/MemAvailable:\s+(\d+)/.exec(await fs.promises.readFile('/proc/meminfo', 'utf8'))[1]) * 1024; } catch {}
    let disk = null;
    try { const s = await fs.promises.statfs('/'); disk = { total: s.blocks * s.bsize, used: (s.blocks - s.bavail) * s.bsize }; } catch {}
    return { cpu, cores: os.cpus().length, mem: { total: os.totalmem(), used: os.totalmem() - available }, disk, load: os.loadavg(), uptime: Math.floor(os.uptime()), hostname: os.hostname() };
  });

  const traffic = cache(1500, async () => {
    const content = await fs.promises.readFile('/proc/net/dev', 'utf8');
    const rows = content.trim().split('\n').slice(2).map(line => {
      const [name, values] = line.trim().split(':');
      const f = values.trim().split(/\s+/);
      return { name: name.trim(), rx: Number(f[0]), tx: Number(f[8]) };
    });
    let iface = process.env.TRAFFIC_INTERFACE;
    if (!iface) {
      const routesText = await fs.promises.readFile('/proc/net/route', 'utf8').catch(() => '');
      iface = routesText.split('\n').slice(1).map(l => l.trim().split(/\s+/)).find(f => f[1] === '00000000')?.[0];
    }
    const row = rows.find(r => r.name === iface) || (!iface && rows.find(r => r.name !== 'lo'));
    if (!row) throw new Error('找不到流量網卡，請在 .env 設定 TRAFFIC_INTERFACE');
    return { iface: row.name, rx: row.rx, tx: row.tx, timestamp: Date.now() };
  });

  const publicIP = cache(60 * 60 * 1000, async () => {
    for (const url of ['https://api.ipify.org', 'https://ipv4.icanhazip.com', 'https://ifconfig.me/ip', 'https://myip.ipip.net']) {
      const ip = (/\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(await fetchText(url)) || [])[1];
      if (ip && net.isIPv4(ip)) return ip;
    }
    return '';
  });

  async function serviceState() {
    const r = await run('systemctl', ['is-active', 'sing-box']);
    const running = r.stdout === 'active';
    let reason = '';
    if (!running) reason = (await run('journalctl', ['-u', 'sing-box', '-n', '5', '--no-pager', '--output=cat'])).stdout;
    return { running, status: r.stdout || 'unknown', reason };
  }

  // ── Auth ──────────────────────────────────────────
  route('POST', '/api/login', async (req, body) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const att = attempts.get(ip) || { count: 0, resetAt: now + 60000 };
    if (now > att.resetAt) { att.count = 0; att.resetAt = now + 60000; }
    if (attempts.size >= 10000 && !attempts.has(ip)) throw httpError(429, '登入繁忙，請稍後重試');
    att.count++;
    attempts.set(ip, att);
    if (att.count > 10) throw httpError(429, '嘗試次數過多，請 1 分鐘後再試');
    const supplied = crypto.createHash('sha256').update(String(body.password || '')).digest();
    const expected = crypto.createHash('sha256').update(cfg.password).digest();
    if (!crypto.timingSafeEqual(supplied, expected)) throw httpError(403, '密碼錯誤');
    att.count = 0;
    if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now());
    return { token };
  }, false);

  route('POST', '/api/logout', req => { sessions.delete(req.headers['x-token']); return { ok: true }; });

  route('POST', '/api/password', async (req, body) => {
    try { setEnv(cfg.envPath, 'PANEL_PASSWORD', body.password); }
    catch (e) { throw httpError(400, e.message); }
    cfg.password = body.password;
    sessions.clear();
    return { ok: true };
  });

  // ── 概覽 ──────────────────────────────────────────
  route('GET', '/api/overview', async () => {
    const [service, version, sys] = await Promise.all([serviceState(), singboxVersion(), sysinfo()]);
    return { service: { ...service, version }, sys, panel: { version: PANEL_VERSION } };
  });
  route('GET', '/api/traffic', async () => {
    try { return await traffic(); } catch (e) { throw httpError(503, e.code === 'ENOENT' ? '此系統無法讀取 /proc 流量資料' : e.message); }
  });
  route('GET', '/api/publicip', async () => ({ ip: await publicIP() }));

  route('POST', '/api/service', async (req, body) => {
    if (!['start', 'stop', 'restart'].includes(body.action)) throw httpError(400, '不支援的操作');
    return store.control(body.action);
  });

  route('GET', '/api/logs', async (req, body, url) => {
    const lines = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('lines'), 10) || 100));
    const r = await run('journalctl', ['-u', 'sing-box', '-n', String(lines), '--no-pager', '--output=short-iso']);
    if (!r.ok) throw httpError(500, r.stderr || '無法讀取日誌');
    return { logs: r.stdout };
  });

  // ── 設定檔 ────────────────────────────────────────
  route('GET', '/api/config', async () => {
    try {
      const content = await store.read();
      return { config: content, revision: revision(content), path: cfg.configPath };
    } catch (e) { throw httpError(500, `無法讀取 ${cfg.configPath}：${e.message}`); }
  });
  route('POST', '/api/config', (req, body) => store.apply(body.config, body.revision));
  route('POST', '/api/config/check', (req, body) => store.check(body.config));
  route('GET', '/api/config/backup', async () => {
    try { return { config: await fs.promises.readFile(cfg.configPath + '.bak', 'utf8') }; }
    catch { throw httpError(404, '目前沒有備份（第一次套用設定後才會產生）'); }
  });

  // ── 中轉節點 ──────────────────────────────────────
  // 節點顯示名稱存在 panel-state.json（面板更新時保留）
  const readNames = () => {
    try {
      const names = JSON.parse(fs.readFileSync(cfg.statePath, 'utf8')).names;
      return names && typeof names === 'object' && !Array.isArray(names) ? names : {};
    } catch { return {}; }
  };
  const writeNames = update => {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(cfg.statePath, 'utf8')) || {}; } catch {}
    state.names = update(readNames());
    fs.writeFileSync(cfg.statePath + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(cfg.statePath + '.tmp', cfg.statePath);
  };

  const hostOf = (value, req) => {
    const host = String(value || '').trim().replace(/^\[|\]$/g, '') || String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!isHost(host)) throw httpError(400, '請填入有效的公網 IP 或域名');
    return host;
  };

  route('GET', '/api/nodes', async (req, body, url) => {
    const content = await store.read();
    let parsed;
    try { parsed = parseConfig(content); } catch (e) { throw httpError(422, '設定檔不是有效 JSON：' + e.message); }
    let editable = true;
    try { parseStrict(content); } catch { editable = false; }
    return { nodes: savedNodes(content, hostOf(url.searchParams.get('host'), req), readNames()), outbounds: listOutbounds(parsed), editable, revision: revision(content) };
  });

  route('POST', '/api/nodes', async (req, body) => {
    const content = await store.read();
    if (body.revision !== revision(content)) throw httpError(409, '設定已在其他地方變更，請重新整理後再試');
    const version = await singboxVersion();
    const result = addRelay(parseStrict(content), body.relay, { version });
    const text = JSON.stringify(result.config, null, 2) + '\n';
    if (body.dryRun) return { config: text };
    if (!await cfg.portAvailable(result.port, result.network)) throw httpError(409, `端口 ${result.port} 已被本機其他程式佔用，請換一個端口`);
    const applied = await store.apply(text, body.revision);
    try { writeNames(names => ({ ...names, [result.tag]: result.name })); } catch (e) { console.error('無法儲存節點名稱：', e.message); }
    const fw = await firewall.openPort(run, result.port, result.network).catch(() => ({ kind: null, ok: false }));
    let node = null;
    try { node = savedNodes(text, hostOf(body.host, req), readNames()).find(n => n.tag === result.tag) || null; } catch {}
    return { ok: true, revision: applied.revision, tag: result.tag, port: result.port, network: result.network, firewall: fw, node };
  });

  route('POST', '/api/nodes/delete', async (req, body) => {
    const content = await store.read();
    if (body.revision !== revision(content)) throw httpError(409, '設定已在其他地方變更，請重新整理後再試');
    const tag = String(body.tag || '');
    const result = removeInbound(parseStrict(content), tag);
    const applied = await store.apply(JSON.stringify(result.config, null, 2) + '\n', body.revision);
    try { writeNames(names => { const next = { ...names }; delete next[tag]; return next; }); } catch {}
    if (result.port) await firewall.closePort(run, result.port, result.network).catch(() => {});
    return { ok: true, revision: applied.revision };
  });

  route('POST', '/api/parse-link', (req, body) => {
    const { outbound, name } = buildOutbound({ mode: body.mode || 'link', ...body });
    return { outbound, name, summary: describeOutbound(outbound) };
  });

  // ── 工具 ──────────────────────────────────────────
  route('POST', '/api/test', async (req, body) => {
    const host = String(body.host || '').trim().replace(/^\[|\]$/g, '');
    const port = body.port === '' || body.port == null ? null : Number(body.port);
    if (!isHost(host) || host.startsWith('-')) throw httpError(400, '地址格式錯誤');
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw httpError(400, '端口格式錯誤');
    const result = {};
    const tasks = [run('ping', ['-c', '3', '-W', '2', '--', host]).then(r => {
      const avg = /=\s*[\d.]+\/([\d.]+)/.exec(r.stdout);
      const loss = /(\d+(?:\.\d+)?)%\s*packet loss/.exec(r.stdout);
      result.ping = { ok: r.ok && Number(loss?.[1] ?? 100) < 100, avg: avg ? Number(avg[1]) : null, loss: loss ? Number(loss[1]) : 100 };
    })];
    if (port) {
      tasks.push(new Promise(resolve => {
        const start = process.hrtime.bigint();
        const socket = net.createConnection({ host, port });
        const done = (ok, error) => { socket.destroy(); result.tcp = { ok, ms: Math.round(Number(process.hrtime.bigint() - start) / 1e6), port, error }; resolve(); };
        socket.setTimeout(5000);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false, '逾時'));
        socket.once('error', e => done(false, e.code === 'ECONNREFUSED' ? '連線被拒絕' : e.code === 'ENOTFOUND' ? '無法解析域名' : e.code || e.message));
      }));
    }
    await Promise.all(tasks);
    return result;
  });

  route('POST', '/api/cert', async (req, body) => {
    const domain = String(body.domain || 'www.bing.com').trim();
    if (!isHost(domain) || net.isIP(domain)) throw httpError(400, '請填入域名（例如 www.bing.com）');
    const dir = path.join(path.dirname(cfg.configPath), 'kuobox-cert');
    const cert = path.join(dir, 'cert.pem');
    const key = path.join(dir, 'key.pem');
    if (!fs.existsSync(cert) || !fs.existsSync(key)) {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      const args = ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '3650', '-subj', '/CN=' + domain];
      let r = await run('openssl', [...args, '-addext', 'subjectAltName=DNS:' + domain]);
      if (!r.ok) r = await run('openssl', args);
      if (!r.ok) throw httpError(500, '產生憑證失敗：' + r.stderr);
      await fs.promises.chmod(key, 0o600).catch(() => {});
    }
    return { certificate_path: cert, key_path: key };
  });

  // ── 請求處理 ──────────────────────────────────────
  function send(res, status, payload, headers = {}) {
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length, ...headers });
    res.end(body);
  }

  function serveStatic(req, res, pathname) {
    const file = statics.get(pathname) || (path.extname(pathname) ? null : statics.get('/index.html'));
    if (!file) return send(res, 404, { error: '找不到檔案' });
    if (req.headers['if-none-match'] === file.etag) { res.writeHead(304, { ...SECURITY_HEADERS, ETag: file.etag }); return res.end(); }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': file.type, 'Content-Length': file.body.length, 'Cache-Control': 'no-cache', ETag: file.etag });
    res.end(req.method === 'HEAD' ? undefined : file.body);
  }

  const handler = async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, { error: '請求格式錯誤' }); }
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: '不支援的方法' });
      return serveStatic(req, res, pathname === '/' ? '/index.html' : pathname);
    }
    const entry = routes.get(`${req.method} ${pathname}`);
    if (!entry) return send(res, 404, { error: 'API 不存在' });
    try {
      if (entry.auth) {
        const token = req.headers['x-token'];
        const seen = typeof token === 'string' && sessions.get(token);
        if (!seen || Date.now() - seen > SESSION_TTL) { if (token) sessions.delete(token); return send(res, 401, { error: '未登入或登入已過期' }); }
        sessions.set(token, Date.now());
      }
      const body = req.method === 'POST' ? await readBody(req) : {};
      send(res, 200, await entry.handler(req, body, url));
    } catch (e) {
      const status = e.status || 500;
      if (!e.status) console.error(e);
      send(res, status, { error: e.message || '伺服器錯誤' });
    }
  };
  handler.sessions = sessions;
  return handler;
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PANEL_PORT) || 3000;
  const handler = createApp({ password: process.env.PANEL_PASSWORD || '', configPath: process.env.SINGBOX_CONFIG });
  const certFile = path.join(__dirname, 'cert', 'cert.pem');
  const keyFile = path.join(__dirname, 'cert', 'key.pem');
  let server, scheme, host;
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    server = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, handler);
    scheme = 'https'; host = process.env.PANEL_HOST || undefined;
  } else if (process.env.PANEL_ALLOW_HTTP === '1') {
    server = http.createServer(handler);
    scheme = 'http'; host = process.env.PANEL_HOST || '127.0.0.1';
  } else {
    throw new Error('缺少 HTTPS 憑證；反向代理部署可明確設定 PANEL_ALLOW_HTTP=1（預設僅監聽本機）');
  }
  server.headersTimeout = 20000;
  server.requestTimeout = 150000;
  server.listen(port, host, () => console.log(`kuoboX ${PANEL_VERSION} 已啟動：${scheme}://${host || '0.0.0.0'}:${port}`));
}
