const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

async function start(t, initial = '') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kuobox-srv-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  if (initial) await fs.writeFile(configPath, initial);
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'systemctl' && args[0] === 'is-active') return { ok: true, stdout: 'active', stderr: '' };
    if (cmd === 'sing-box' && args[0] === 'version') return { ok: true, stdout: 'sing-box version 1.12.4', stderr: '' };
    if (cmd === 'ufw' || cmd === 'firewall-cmd' || cmd === 'iptables') return { ok: false, stdout: '', stderr: 'not found' };
    return { ok: true, stdout: '', stderr: '' };
  };
  const handler = createApp({ password: 'correct-horse-battery', configPath, envPath: path.join(dir, '.env'), run, settle: async () => {}, portAvailable: async () => true });
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'x-token': token }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, headers: res.headers, data: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  };
  const login = async () => { token = (await call('POST', '/api/login', { password: 'correct-horse-battery' })).data.token; };
  return { call, login, calls, configPath, dir, base };
}

test('static files, security headers and authentication', async t => {
  const s = await start(t);
  const page = await s.call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(page.data, /<title>kuoboX<\/title>/);
  assert.equal((await s.call('GET', '/relays')).status, 200, 'SPA fallback');
  assert.equal((await s.call('GET', '/missing.js')).status, 404);
  assert.equal((await s.call('GET', '/api/config')).status, 401);
  assert.equal((await s.call('POST', '/api/login', { password: 'wrong' })).status, 403);
  await s.login();
  const cfg = await s.call('GET', '/api/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.headers.get('cache-control'), 'no-store');
  assert.equal((await s.call('GET', '/api/nope')).status, 404);
  assert.equal((await s.call('POST', '/api/logout')).status, 200);
  assert.equal((await s.call('GET', '/api/config')).status, 401);
});

test('relay wizard end-to-end: preview, create, list, delete', async t => {
  const s = await start(t);
  await s.login();
  let nodes = await s.call('GET', '/api/nodes?host=203.0.113.7');
  assert.deepEqual(nodes.data.nodes, []);
  const relay = { name: '香港', port: 25000, inbound: { type: 'vless-reality', sni: 'www.apple.com' }, exit: { mode: 'link', link: 'ss://' + Buffer.from('aes-256-gcm:pw').toString('base64url') + '@exit.example.com:8388#E' } };

  const preview = await s.call('POST', '/api/nodes', { relay, revision: nodes.data.revision, dryRun: true });
  assert.equal(preview.status, 200);
  assert.equal(JSON.parse(preview.data.config).inbounds[0].listen_port, 25000);
  assert.equal(await fs.readFile(s.configPath, 'utf8').catch(() => ''), '', 'dry run must not write');

  const created = await s.call('POST', '/api/nodes', { relay, revision: nodes.data.revision, host: '203.0.113.7' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.match(created.data.node.link, /^vless:\/\/[0-9a-f-]{36}@203\.0\.113\.7:25000\?/);
  assert.ok(s.calls.some(c => c.startsWith('sing-box check')));
  assert.ok(s.calls.includes('systemctl restart sing-box'));

  const stale = await s.call('POST', '/api/nodes', { relay: { ...relay, port: 25001 }, revision: nodes.data.revision });
  assert.equal(stale.status, 409);

  nodes = await s.call('GET', '/api/nodes?host=203.0.113.7');
  assert.equal(nodes.data.nodes.length, 1);
  assert.equal(nodes.data.nodes[0].target.server, 'exit.example.com');
  const dup = await s.call('POST', '/api/nodes', { relay, revision: nodes.data.revision });
  assert.equal(dup.status, 409);
  assert.match(dup.data.error, /25000/);

  // Shadowsocks 入站沒有 users[].name，名稱需由面板保存
  const ss = await s.call('POST', '/api/nodes', { relay: { ...relay, name: '', port: 25002, inbound: { type: 'shadowsocks' } }, revision: nodes.data.revision, host: '203.0.113.7' });
  assert.equal(ss.data.node.name, 'E');
  nodes = await s.call('GET', '/api/nodes?host=203.0.113.7');
  assert.deepEqual(nodes.data.nodes.map(n => n.name), ['香港', 'E']);
  assert.ok((await s.call('POST', '/api/nodes/delete', { tag: 'relay-25002', revision: nodes.data.revision })).status === 200);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(s.dir, 'panel-state.json'), 'utf8')).names, { 'relay-25000': '香港' });
  nodes = await s.call('GET', '/api/nodes?host=203.0.113.7');

  const del = await s.call('POST', '/api/nodes/delete', { tag: 'relay-25000', revision: nodes.data.revision });
  assert.equal(del.status, 200);
  const after = JSON.parse(await fs.readFile(s.configPath, 'utf8'));
  assert.deepEqual(after.inbounds, []);
  assert.deepEqual(after.route.rules, []);
  assert.deepEqual(after.outbounds, [{ type: 'direct', tag: 'direct' }]);
});

test('commented configs are listed but protected from wizard edits', async t => {
  const s = await start(t, '// keep me\n{"inbounds":[{"type":"shadowsocks","tag":"ss","listen_port":8388,"method":"aes-256-gcm","password":"p"}]}');
  await s.login();
  const nodes = await s.call('GET', '/api/nodes?host=relay.example.com');
  assert.equal(nodes.data.editable, false);
  assert.match(nodes.data.nodes[0].link, /^ss:\/\//);
  const res = await s.call('POST', '/api/nodes/delete', { tag: 'ss', revision: nodes.data.revision });
  assert.equal(res.status, 422);
  assert.match(await fs.readFile(s.configPath, 'utf8'), /keep me/);
});

test('link parsing, input validation and password change', async t => {
  const s = await start(t);
  await s.login();
  const parsed = await s.call('POST', '/api/parse-link', { link: 'trojan://pw@t.example.com:443#T' });
  assert.equal(parsed.data.summary, 'Trojan + TLS');
  assert.equal((await s.call('POST', '/api/parse-link', { link: 'nope' })).status, 400);
  assert.equal((await s.call('POST', '/api/test', { host: '-evil' })).status, 400);
  assert.equal((await s.call('POST', '/api/test', { host: 'a.example', port: 99999 })).status, 400);
  assert.equal((await s.call('POST', '/api/service', { action: 'reboot' })).status, 400);
  assert.equal((await s.call('POST', '/api/password', { password: '' })).status, 400);
  assert.equal((await s.call('POST', '/api/password', { password: 'a\nb' })).status, 400);
  assert.equal((await s.call('POST', '/api/password', { password: '1234' })).status, 200, 'short passwords are allowed');
  assert.match(await fs.readFile(path.join(s.dir, '.env'), 'utf8'), /^PANEL_PASSWORD="1234"$/m);
  assert.equal((await s.call('GET', '/api/config')).status, 401, 'sessions revoked');
  const res = await fetch(s.base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
  assert.equal(res.status, 400);
});
