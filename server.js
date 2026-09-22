const express = require('express');
const https = require('https');
const { execFile } = require('child_process');
const os = require('os');
const net = require('net');
const { createConfigStore, revision } = require('./lib/config-store');
const { savedNodes } = require('./lib/saved-nodes');
const { promisify } = require('util');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(execFile);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const CONFIG = {
  port: process.env.PANEL_PORT || 3000,
  password: process.env.PANEL_PASSWORD || '',
  configPath: process.env.SINGBOX_CONFIG || '/etc/sing-box/config.json',
};
if (!CONFIG.password || CONFIG.password === 'changeme123') throw new Error('請先設定非預設 PANEL_PASSWORD');
const configStore = createConfigStore(CONFIG.configPath, run);

// ── Session ───────────────────────────────────────────
const sessions = new Map();
const loginAttempts = new Map(); // ip -> { count, resetAt }

function genToken() { return crypto.randomBytes(32).toString('hex'); }

function authMiddleware(req, res, next) {
  const token = req.headers['x-token'];
  if (!token || !sessions.has(token) || Date.now() - sessions.get(token) > 30 * 60 * 1000) {
    sessions.delete(token);
    return res.status(401).json({ error: '未登入或登入已過期' });
  }
  sessions.set(token, Date.now());
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v > 30 * 60 * 1000) sessions.delete(k);
  }
  for (const [k, v] of loginAttempts) {
    if (now > v.resetAt) loginAttempts.delete(k);
  }
}, 5 * 60 * 1000);

// ── Auth ──────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const att = loginAttempts.get(ip) || { count: 0, resetAt: now + 60 * 1000 };
  if (now > att.resetAt) { att.count = 0; att.resetAt = now + 60 * 1000; }
  att.count++;
  if (loginAttempts.size >= 10000 && !loginAttempts.has(ip)) return res.status(429).json({ error: '登入繁忙，請稍後重試' });
  loginAttempts.set(ip, att);
  if (att.count > 10) return res.status(429).json({ error: '嘗試次數過多，請 1 分鐘後再試' });

  const supplied = crypto.createHash('sha256').update(String(req.body?.password || '')).digest();
  const expected = crypto.createHash('sha256').update(CONFIG.password).digest();
  if (!crypto.timingSafeEqual(supplied, expected)) return res.status(403).json({ error: '密碼錯誤' });
  att.count = 0;
  if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
  const token = genToken();
  sessions.set(token, Date.now());
  res.json({ token });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  sessions.delete(req.headers['x-token']);
  res.json({ ok: true });
});

// ── Local exec helper ─────────────────────────────────
async function run(cmd, args = []) {
  try {
    if (cmd === 'sing-box') cmd = process.env.SINGBOX_BINARY || 'sing-box';
    const { stdout, stderr } = await execAsync(cmd, args, { timeout: 15000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
    return { stdout: stdout.trim(), stderr: stderr.trim(), ok: true };
  } catch (e) {
    return { stdout: String(e.stdout || '').trim(), stderr: String(e.stderr || e.message).trim(), ok: false };
  }
}

// ── sing-box 狀態 ─────────────────────────────────────
app.get('/api/status', authMiddleware, async (req, res) => {
  const r = await run('systemctl', ['is-active', 'sing-box']);
  const running = r.stdout === 'active';
  let reason = '';
  if (!running) {
    const log = await run('journalctl', ['-u', 'sing-box', '-n', '3', '--no-pager', '--output=cat']);
    reason = log.stdout;
  }
  res.json({ running, status: r.stdout, reason });
});

// ── 流量統計 ──────────────────────────────────────────
let trafficCache, trafficAt = 0, trafficPending;
async function sampleTraffic() {
  const content = await fs.promises.readFile('/proc/net/dev', 'utf8');
  const rows = content.trim().split('\n').slice(2).map(line => {
    const [name, values] = line.trim().split(':');
    const fields = values.trim().split(/\s+/);
    return { name: name.trim(), rx: Number(fields[0]), tx: Number(fields[8]) };
  });
  let iface = process.env.TRAFFIC_INTERFACE;
  if (!iface) {
    const routes = await fs.promises.readFile('/proc/net/route', 'utf8').catch(() => '');
    iface = routes.split('\n').slice(1).map(l => l.trim().split(/\s+/)).find(f => f[1] === '00000000')?.[0];
  }
  const row = rows.find(r => r.name === iface) || (!iface && rows.find(r => r.name !== 'lo'));
  if (!row) throw new Error('找不到流量網卡，請設定 TRAFFIC_INTERFACE');
  return { source: 'proc', iface: row.name, rx: row.rx, tx: row.tx, timestamp: Date.now() };
}
app.get('/api/traffic', authMiddleware, async (req, res) => {
  try {
    if (!trafficCache || Date.now() - trafficAt > 1800) {
      if (!trafficPending) trafficPending = sampleTraffic().then(d => { trafficCache = d; trafficAt = Date.now(); }).finally(() => { trafficPending = null; });
      await trafficPending;
    }
    res.json(trafficCache);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
let publicIP = '', publicIPAt = 0;
app.get('/api/publicip', authMiddleware, async (req, res) => {
  if (Date.now() - publicIPAt > 3600000) {
    const r = await run('curl', ['-fsS', '--connect-timeout', '3', '--max-time', '5', 'https://api.ipify.org']);
    if (net.isIP(r.stdout)) { publicIP = r.stdout; publicIPAt = Date.now(); }
  }
  res.json({ ip: publicIP });
});
let cpuPrevious = null;
let sysCache, sysAt = 0, sysPending;
app.get('/api/sysinfo', authMiddleware, async (req, res) => {
  try {
    if (!sysCache || Date.now() - sysAt > 5000) {
      if (!sysPending) sysPending = (async () => {
        const total = os.cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0) }), { idle: 0, total: 0 });
        const delta = cpuPrevious ? total.total - cpuPrevious.total : 0;
        const cpu = delta > 0 ? (100 * (1 - (total.idle - cpuPrevious.idle) / delta)).toFixed(1) + '%' : '--';
        cpuPrevious = total;
        const mem = await fs.promises.readFile('/proc/meminfo', 'utf8');
        const available = Number(mem.match(/MemAvailable:\s+(\d+)/)?.[1]) * 1024;
        const disk = await fs.promises.statfs('/');
        sysCache = { cpu, mem: (100 * (1 - available / os.totalmem())).toFixed(0) + '%', disk: (100 * (1 - disk.bavail / disk.blocks)).toFixed(0) + '%', uptime: Math.floor(os.uptime() / 3600) + ' 小時' };
        sysAt = Date.now();
      })().finally(() => { sysPending = null; });
      await sysPending;
    }
    res.json(sysCache);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 重啟 sing-box ─────────────────────────────────────
for (const action of ['restart', 'stop']) {
  app.post('/api/' + action, authMiddleware, async (req, res) => {
    try { res.json(await configStore.control(action)); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
}

// ── 讀取日誌 ─────────────────────────────────────────
app.get('/api/logs', authMiddleware, async (req, res) => {
  const lines = Math.min(1000, Math.max(1, parseInt(req.query.lines) || 50));
  const r = await run('journalctl', ['-u', 'sing-box', '-n', String(lines), '--no-pager']);
  if (!r.ok) return res.status(500).json({ error: r.stderr || '無法讀取日誌' });
  res.json({ logs: r.stdout });
});

// ── 讀取設定 ─────────────────────────────────────────
app.get('/api/nodes', authMiddleware, async (req, res) => {
  try { res.json({ nodes: savedNodes(await configStore.read(), req.query.host || req.hostname) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/config', authMiddleware, async (req, res) => {
  try {
    const content = await configStore.read();
    res.json({ config: content, revision: revision(content) });
  } catch (e) {
    res.status(500).json({ error: `無法讀取 ${CONFIG.configPath}: ${e.message}` });
  }
});

// ── 寫入設定並重啟 ────────────────────────────────────
app.post('/api/config', authMiddleware, async (req, res) => {
  try { res.json(await configStore.apply(req.body?.config, req.body?.revision)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── 生成 REALITY 密鑰對 ───────────────────────────────
app.get('/api/gen/reality-keypair', authMiddleware, async (req, res) => {
  const r = await run('sing-box', ['generate', 'reality-keypair']);
  res.json({ output: r.stdout || r.stderr });
});

// ── 測試出站連線（TCP + Ping）────────────────────────
app.get('/api/ping', authMiddleware, async (req, res) => {
  const { ip, port } = req.query;
  if (typeof ip !== 'string' || !(net.isIP(ip) || /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(ip))) return res.status(400).json({ error: 'IP 格式錯誤' });
  if (port && (!/^\d+$/.test(port) || +port < 1 || +port > 65535)) return res.status(400).json({ error: 'Port 格式錯誤' });

  const results = {};

  // ICMP ping
  const pingR = await run('ping', ['-c', '3', '-W', '2', '--', ip]);
  const avgMatch = pingR.stdout.match(/rtt.*=\s*[\d.]+\/([\d.]+)/);
  const lossMatch = pingR.stdout.match(/(\d+)%\s*packet loss/);
  results.ping = {
    ok: pingR.ok && parseInt(lossMatch?.[1] || 100) < 100,
    avg: avgMatch ? parseFloat(avgMatch[1]) : null,
    loss: lossMatch ? parseInt(lossMatch[1]) : 100,
  };

  // TCP port check
  if (port) {
    const start = Date.now();
    const open = await new Promise(resolve => {
      const socket = net.createConnection({ host: ip, port: Number(port) });
      const finish = ok => { socket.destroy(); resolve(ok); };
      socket.setTimeout(5000);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });
    results.tcp = { ok: open, ms: Date.now() - start, port: Number(port) };
  }

  res.json(results);
});

// ── 儲存面板設定 ──────────────────────────────────────
app.post('/api/saveenv', authMiddleware, (req, res) => {
  const { PANEL_PASSWORD } = req.body || {};
  const envPath = path.join(__dirname, '.env');
  const existing = {};
  try {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const eq = line.indexOf('=');
      if (eq > 0) existing[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    });
  } catch (_) {}
  if (typeof PANEL_PASSWORD !== 'string' || PANEL_PASSWORD.length < 12 || /[\r\n\0]/.test(PANEL_PASSWORD)) return res.status(400).json({ error: '密碼至少 12 字元，且不得含換行' });
  existing.PANEL_PASSWORD = JSON.stringify(PANEL_PASSWORD);
  try {
    const tmpPath = envPath + '.tmp';
    fs.writeFileSync(tmpPath, Object.entries(existing).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    fs.renameSync(tmpPath, envPath);
    CONFIG.password = PANEL_PASSWORD;
    sessions.clear();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 面板狀態（公鑰等不在 config.json 的資料）────────────
const STATE_PATH = path.join(__dirname, 'panel-state.json');

app.get('/api/state', authMiddleware, (req, res) => {
  try {
    const data = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : {};
    res.json(data);
  } catch { res.json({}); }
});

app.post('/api/state', authMiddleware, (req, res) => {
  try {
    const current = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : {};
    const merged = { ...current, ...req.body };
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_PATH);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 前端路由 fallback ─────────────────────────────────
app.use('/api', (_, res) => res.status(404).json({ error: 'API 不存在' }));
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.status === 413 ? '設定超過 2 MB 限制' : '請求格式錯誤' }));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── 啟動 HTTPS ────────────────────────────────────────
const certDir = path.join(__dirname, 'cert');
const certFile = path.join(certDir, 'cert.pem');
const keyFile = path.join(certDir, 'key.pem');

if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
  const httpsOptions = {
    key: fs.readFileSync(keyFile),
    cert: fs.readFileSync(certFile),
  };
  https.createServer(httpsOptions, app).listen(CONFIG.port, () => {
    console.log(`✓ 中轉管理面板 啟動於 https://0.0.0.0:${CONFIG.port}`);
  });
} else if (process.env.PANEL_ALLOW_HTTP === '1') {
  app.listen(CONFIG.port, process.env.PANEL_HOST || '127.0.0.1', () => {
    console.log(`✓ 中轉管理面板 啟動於 http://${process.env.PANEL_HOST || '127.0.0.1'}:${CONFIG.port} （明確啟用 HTTP）`);
  });
}

else { throw new Error('缺少 HTTPS 憑證；反向代理部署可明確設定 PANEL_ALLOW_HTTP=1，預設僅監聽本機'); }
