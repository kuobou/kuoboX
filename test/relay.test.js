const { test } = require('node:test');
const assert = require('node:assert/strict');
const { addRelay, removeInbound, parseStrict } = require('../lib/relay');
const { savedNodes, publicKey } = require('../lib/saved-nodes');

const EXIT = { mode: 'link', link: 'trojan://secret@exit.example.com:443?sni=exit.example.com#Tokyo' };

test('fresh config gets a minimal working relay', () => {
  const r = addRelay({}, { port: 24000, inbound: { type: 'vless-reality', sni: 'www.apple.com' }, exit: EXIT }, { version: '1.12.4' });
  const cfg = r.config;
  assert.equal(r.tag, 'relay-24000');
  assert.equal(cfg.inbounds[0].users[0].name, 'Tokyo');
  assert.equal(cfg.inbounds[0].tls.reality.handshake.server, 'www.apple.com');
  assert.match(cfg.inbounds[0].tls.reality.short_id[0], /^[0-9a-f]{16}$/);
  assert.deepEqual(cfg.route.rules[0], { inbound: ['relay-24000'], outbound: 'relay-24000-out' });
  assert.equal(cfg.outbounds.find(o => o.tag === 'relay-24000-out').server, 'exit.example.com');
  assert.equal(cfg.route.final, 'direct');
  assert.equal(cfg.route.default_domain_resolver, 'local');
  assert.deepEqual(cfg.dns, { servers: [{ type: 'local', tag: 'local' }] });
  // 推導出的公鑰必須與私鑰相符，客戶端連結才會可用
  const [node] = savedNodes(JSON.stringify(cfg), '203.0.113.5');
  assert.equal(new URL(node.link).searchParams.get('pbk'), publicKey(cfg.inbounds[0].tls.reality.private_key));
  assert.equal(node.target.server, 'exit.example.com');
  assert.equal(node.target.summary, 'Trojan + TLS');
});

test('older cores do not get 1.12-only DNS fields', () => {
  const { config } = addRelay({}, { inbound: { type: 'shadowsocks' }, exit: EXIT }, { version: '1.10.7' });
  assert.equal(config.dns, undefined);
  assert.equal(config.route.default_domain_resolver, undefined);
  assert.ok(config.inbounds[0].listen_port >= 20000);
  assert.equal(Buffer.from(config.inbounds[0].password, 'base64').length, 16);
});

test('existing config, routes and unknown fields are preserved; new rule goes first', () => {
  const base = { log: { level: 'info' }, dns: { servers: [{ tag: 'x', address: 'local' }] }, experimental: { cache_file: { enabled: true } }, inbounds: [{ type: 'mixed', tag: 'm', listen_port: 1080 }], outbounds: [{ type: 'selector', tag: 'sel', outbounds: ['direct'] }, { type: 'direct', tag: 'direct' }], route: { final: 'sel', rules: [{ domain_suffix: ['cn'], outbound: 'direct' }] } };
  const { config } = addRelay(base, { port: 30000, inbound: { type: 'vmess-ws' }, exit: EXIT });
  assert.deepEqual(config.log, base.log);
  assert.deepEqual(config.dns, base.dns);
  assert.deepEqual(config.experimental, base.experimental);
  assert.deepEqual(config.inbounds[0], base.inbounds[0]);
  assert.equal(config.route.final, 'sel');
  assert.deepEqual(config.route.rules[1], base.route.rules[0]);
  assert.equal(config.outbounds.length, 3);
  assert.match(config.inbounds[1].transport.path, /^\/[0-9a-f]{12}$/);
  assert.deepEqual(base.inbounds.length, 1, 'input must not be mutated');
});

test('existing outbound can be reused instead of a link', () => {
  const base = { outbounds: [{ type: 'urltest', tag: 'auto', outbounds: ['a', 'b'] }] };
  const { config } = addRelay(base, { port: 30001, inbound: { type: 'shadowsocks' }, exit: { mode: 'existing', tag: 'auto' } });
  assert.equal(config.outbounds.length, 1);
  assert.equal(config.route.rules[0].outbound, 'auto');
  assert.throws(() => addRelay(base, { inbound: { type: 'shadowsocks' }, exit: { mode: 'existing', tag: 'nope' } }), /找不到/);
});

test('port conflicts, bad specs and certificate requirements are rejected', () => {
  const base = { inbounds: [{ type: 'mixed', tag: 'm', listen_port: 1080 }] };
  assert.throws(() => addRelay(base, { port: 1080, inbound: { type: 'shadowsocks' }, exit: EXIT }), { status: 409 });
  assert.throws(() => addRelay(base, { port: 70000, inbound: { type: 'shadowsocks' }, exit: EXIT }), /1–65535/);
  assert.throws(() => addRelay(base, { inbound: { type: 'nope' }, exit: EXIT }), /入口協定/);
  assert.throws(() => addRelay(base, { inbound: { type: 'trojan' }, exit: EXIT }), /憑證/);
  assert.throws(() => addRelay({ inbounds: {} }, { inbound: { type: 'shadowsocks' }, exit: EXIT }), { status: 422 });
  const ok = addRelay(base, { inbound: { type: 'hysteria2', certificate_path: '/etc/sing-box/kuobox-cert/cert.pem', key_path: '/etc/sing-box/kuobox-cert/key.pem' }, exit: EXIT });
  assert.equal(ok.network, 'udp');
  const node = savedNodes(JSON.stringify(ok.config), 'relay.example.com').find(n => n.type === 'hysteria2');
  assert.match(node.link, /^hysteria2:\/\/[0-9a-f]{32}@relay\.example\.com:\d+\/\?insecure=1#Tokyo$/);
});

test('removing a relay drops its inbound, dedicated rule and orphaned outbound only', () => {
  const base = { outbounds: [{ type: 'direct', tag: 'direct' }], route: { rules: [{ inbound: ['m', 'other'], outbound: 'direct' }] }, inbounds: [{ type: 'mixed', tag: 'm', listen_port: 1 }] };
  const added = addRelay(base, { port: 40000, inbound: { type: 'shadowsocks' }, exit: EXIT }).config;
  const r = removeInbound(added, 'relay-40000');
  assert.deepEqual(r.config, base);
  assert.equal(r.port, 40000);
  assert.equal(r.network, 'tcp+udp');

  // 共用規則只移除該 inbound，不會讓規則變成全域規則
  const shared = removeInbound(base, 'm').config;
  assert.deepEqual(shared.route.rules, [{ inbound: ['other'], outbound: 'direct' }]);
  const only = removeInbound({ inbounds: [{ tag: 'x' }], route: { rules: [{ inbound: 'x', domain: ['a.com'], outbound: 'direct' }] } }, 'x').config;
  assert.deepEqual(only.route.rules, []);

  // 仍被其他規則引用的出站不刪除
  const twice = { ...added, route: { ...added.route, rules: [...added.route.rules, { domain: ['b.com'], outbound: 'relay-40000-out' }] } };
  assert.ok(removeInbound(twice, 'relay-40000').config.outbounds.some(o => o.tag === 'relay-40000-out'));
  assert.throws(() => removeInbound(base, 'missing'), { status: 404 });
});

test('strict parsing refuses commented configs so comments are never lost', () => {
  assert.deepEqual(parseStrict(''), {});
  assert.throws(() => parseStrict('// c\n{}'), { status: 422 });
  assert.throws(() => parseStrict('[]'), { status: 422 });
});
