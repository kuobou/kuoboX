const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CONFIG = {
  port: process.env.PANEL_PORT || 3000,
  password: process.env.PANEL_PASSWORD || 'changeme123',
  configPath: process.env.SINGBOX_CONFIG || '/etc/sing-box/config.json',
};

// ── Session ───────────────────────────────────────────
const sessions = new Map();

function genToken() { return crypto.randomBytes(32).toString('hex'); }

function authMiddleware(req, res, next) {
  const token = req.headers['x-token'] || req.query.token;
  if (!token || !sessions.has(token)) return res.status(401).json({ error: '未登入' });
  sessions.set(token, Date.now());
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v > 30 * 60 * 1000) sessions.delete(k);
  }
}, 5 * 60 * 1000);

// ── Auth ──────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  if (req.body.password !== CONFIG.password) return res.status(403).json({ error: '密碼錯誤' });
  const token = genToken();
  sessions.set(token, Date.now());
  res.json({ token });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  sessions.delete(req.headers['x-token']);
  res.json({ ok: true });
});

// ── Local exec helper ─────────────────────────────────
async function run(cmd) {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 10000 });
    return { stdout: stdout.trim(), stderr: stderr.trim(), ok: true };
  } catch (e) {
    return { stdout: e.stdout || '', stderr: (e.stderr || e.message).trim(), ok: false };
  }
}

// ── sing-box 狀態 ─────────────────────────────────────
app.get('/api/status', authMiddleware, async (req, res) => {
  const r = await run('/usr/bin/systemctl is-active sing-box');
  const running = r.stdout === 'active';
  let reason = '';
  if (!running) {
    const log = await run('journalctl -u sing-box -n 3 --no-pager --output=cat 2>/dev/null');
    reason = log.stdout;
  }
  res.json({ running, status: r.stdout, reason });
});

// ── 流量統計 ──────────────────────────────────────────
app.get('/api/traffic', authMiddleware, async (req, res) => {
  const hasVnstat = (await run('which vnstat')).ok;
  if (hasVnstat) {
    const r = await run('vnstat --json');
    try {
      const data = JSON.parse(r.stdout);
      const iface = data.interfaces?.[0];
      const months = iface?.traffic?.month || [];
      const latest = months[months.length - 1] || {};
      const total = iface?.traffic?.total || {};
      return res.json({
        source: 'vnstat',
        month_rx: latest.rx || 0,
        month_tx: latest.tx || 0,
        total_rx: total.rx || 0,
        total_tx: total.tx || 0,
        iface: iface?.name || '',
      });
    } catch (_) {}
  }
  const r = await run("awk 'NR>2{gsub(/:/,\"\",$1); if($1!=\"lo\"){rx+=$2; tx+=$10}} END{printf \"%d %d\", rx+0, tx+0}' /proc/net/dev");
  const parts = (r.stdout || '0 0').split(' ');
  res.json({ source: 'proc', rx: parseInt(parts[0]) || 0, tx: parseInt(parts[1]) || 0 });
});

// ── 取得公網 IP ───────────────────────────────────────
app.get('/api/publicip', authMiddleware, async (req, res) => {
  const r = await run('curl -s --max-time 5 ifconfig.me');
  res.json({ ip: r.stdout || '' });
});

// ── 系統資訊 ──────────────────────────────────────────
app.get('/api/sysinfo', authMiddleware, async (req, res) => {
  const [cpu, mem, disk, uptime] = await Promise.all([
    run("top -bn1 | grep '%Cpu' | awk '{printf \"%.1f\", 100-$8}'"),
    run("free -m | awk 'NR==2{printf \"%.0f%%\", $3*100/$2}'"),
    run("df -h / | awk 'NR==2{print $5}'"),
    run('uptime -p'),
  ]);
  res.json({
    cpu: (cpu.stdout || '--') + '%',
    mem: mem.stdout || '--',
    disk: disk.stdout || '--',
    uptime: uptime.stdout || '--',
  });
});

// ── 重啟 sing-box ─────────────────────────────────────
app.post('/api/restart', authMiddleware, async (req, res) => {
  const r = await run('/usr/bin/systemctl restart sing-box');
  if (!r.ok) return res.status(500).json({ error: r.stderr || '重啟失敗' });
  await new Promise(resolve => setTimeout(resolve, 1500));
  const status = await run('/usr/bin/systemctl is-active sing-box');
  res.json({ ok: true, status: status.stdout });
});

// ── 停止 sing-box ─────────────────────────────────────
app.post('/api/stop', authMiddleware, async (req, res) => {
  const r = await run('/usr/bin/systemctl stop sing-box');
  res.json({ ok: r.ok, error: r.stderr });
});

// ── 讀取日誌 ─────────────────────────────────────────
app.get('/api/logs', authMiddleware, async (req, res) => {
  const lines = parseInt(req.query.lines) || 50;
  const r = await run(`journalctl -u sing-box -n ${lines} --no-pager 2>/dev/null || tail -n ${lines} /var/log/sing-box.log 2>/dev/null || echo "無法讀取日誌"`);
  res.json({ logs: r.stdout });
});

// ── 讀取設定 ─────────────────────────────────────────
app.get('/api/config', authMiddleware, async (req, res) => {
  try {
    const content = fs.readFileSync(CONFIG.configPath, 'utf8');
    res.json({ config: content });
  } catch (e) {
    res.status(500).json({ error: `無法讀取 ${CONFIG.configPath}: ${e.message}` });
  }
});

// ── 寫入設定並重啟 ────────────────────────────────────
app.post('/api/config', authMiddleware, async (req, res) => {
  const { config } = req.body;
  try {
    JSON.parse(config);
    if (fs.existsSync(CONFIG.configPath)) {
      fs.copyFileSync(CONFIG.configPath, CONFIG.configPath + '.bak');
    } else {
      fs.mkdirSync(path.dirname(CONFIG.configPath), { recursive: true });
    }
    fs.writeFileSync(CONFIG.configPath, config);
    const hasSingbox = (await run('which sing-box')).ok;
    if (hasSingbox) {
      const check = await run(`sing-box check -c ${CONFIG.configPath}`);
      if (!check.ok && check.stderr) {
        if (fs.existsSync(CONFIG.configPath + '.bak')) {
          fs.copyFileSync(CONFIG.configPath + '.bak', CONFIG.configPath);
        }
        return res.status(500).json({ error: '設定驗證失敗: ' + check.stderr });
      }
    }
    await run('systemctl restart sing-box');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 生成 REALITY 密鑰對 ───────────────────────────────
app.get('/api/gen/reality-keypair', authMiddleware, async (req, res) => {
  const r = await run('sing-box generate reality-keypair');
  res.json({ output: r.stdout || r.stderr });
});

// ── 測試出站連線（TCP + Ping）────────────────────────
app.get('/api/ping', authMiddleware, async (req, res) => {
  const { ip, port } = req.query;
  if (!ip || !/^[\d.a-zA-Z.-]+$/.test(ip)) return res.status(400).json({ error: 'IP 格式錯誤' });
  if (port && (!/^\d+$/.test(port) || +port < 1 || +port > 65535)) return res.status(400).json({ error: 'Port 格式錯誤' });

  const results = {};

  // ICMP ping
  const pingR = await run(`ping -c 3 -W 2 ${ip}`);
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
    const tcpR = await run(`timeout 5 bash -c "echo >/dev/tcp/${ip}/${port}" 2>/dev/null && echo open || echo closed`);
    const elapsed = Date.now() - start;
    results.tcp = {
      ok: tcpR.stdout.trim() === 'open',
      ms: elapsed,
      port: parseInt(port),
    };
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
  if (PANEL_PASSWORD) { existing.PANEL_PASSWORD = PANEL_PASSWORD; CONFIG.password = PANEL_PASSWORD; }
  try {
    fs.writeFileSync(envPath, Object.entries(existing).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 前端路由 fallback ─────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(CONFIG.port, () => {
  console.log(`✓ 中轉管理面板 啟動於 http://0.0.0.0:${CONFIG.port}`);
});
