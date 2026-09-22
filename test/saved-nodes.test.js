const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { savedNodes, publicKey, parseConfig } = require('../lib/saved-nodes');

test('each saved REALITY node derives its own public key without exposing private keys', () => {
  const pairs = [crypto.generateKeyPairSync('x25519'), crypto.generateKeyPairSync('x25519')];
  const config = { inbounds: pairs.map((pair, i) => ({ type: 'vless', tag: 'relay-' + i, listen_port: 20000 + i, users: [{ uuid: 'user-' + i, flow: 'xtls-rprx-vision' }], tls: { enabled: true, server_name: 'example.com', reality: { enabled: true, private_key: pair.privateKey.export({ format: 'jwk' }).d, short_id: ['abcd'] } } })) };
  const nodes = savedNodes(JSON.stringify(config), '2001:db8::1');
  for (let i = 0; i < 2; i++) {
    const url = new URL(nodes[i].link);
    assert.equal(url.searchParams.get('pbk'), pairs[i].publicKey.export({ format: 'jwk' }).x);
    assert.equal(url.searchParams.get('sid'), 'abcd');
    assert.equal(url.hostname, '[2001:db8::1]');
    assert.equal(url.searchParams.get('flow'), 'xtls-rprx-vision');
    assert.ok(!JSON.stringify(nodes).includes(config.inbounds[i].tls.reality.private_key));
  }
  assert.deepEqual(savedNodes(JSON.stringify(config), '2001:db8::1'), nodes);
});
test('comments and URLs are parsed without modifying saved content', () => {
  const text = '// saved config\n{"inbounds":[], /* note */ "url":"https://example.org/a//b", "note":"escaped\\\"//text"}';
  assert.equal(parseConfig(text).url, 'https://example.org/a//b');
  assert.deepEqual(savedNodes(text, 'example.org'), []);
});
test('multiple Trojan users retain escaped credentials and TLS settings', () => {
  const nodes = savedNodes(JSON.stringify({ inbounds: [{ type: 'trojan', tag: 'saved', listen_port: 443, users: [{ password: 'a@b:#', name: 'one' }, { password: 'two' }], tls: { enabled: true, server_name: 'tls.example.org' } }] }), 'example.org');
  assert.equal(nodes.length, 2);
  const url = new URL(nodes[0].link);
  assert.equal(decodeURIComponent(url.username), 'a@b:#');
  assert.equal(url.searchParams.get('security'), 'tls');
  assert.equal(url.searchParams.get('sni'), 'tls.example.org');
});
test('saved VMess websocket link preserves unicode name and transport', () => {
  const [node] = savedNodes(JSON.stringify({ inbounds: [{ type: 'vmess', tag: '中轉', listen_port: 1234, users: [{ uuid: 'abc' }], transport: { type: 'ws', path: '/relay' } }] }), 'example.org');
  const link = JSON.parse(Buffer.from(node.link.slice(8), 'base64').toString());
  assert.equal(link.ps, '中轉'); assert.equal(link.path, '/relay'); assert.equal(link.id, 'abc');
});
test('unsupported transports remain visible without misleading import links', () => {
  const [node] = savedNodes(JSON.stringify({ inbounds: [{ type: 'vless', tag: 'advanced', listen_port: 443, transport: { type: 'quic' }, users: [{ uuid: 'abc' }] }] }), 'example.org');
  assert.equal(node.name, 'advanced'); assert.equal(node.link, ''); assert.ok(node.error);
});
test('gRPC inbound exports serviceName and relay target is resolved from route rules', () => {
  const config = {
    inbounds: [{ type: 'vless', tag: 'g', listen_port: 443, transport: { type: 'grpc', service_name: 'svc' }, users: [{ uuid: 'abc' }] }, { type: 'mixed', tag: 'local', listen_port: 1080 }],
    outbounds: [{ type: 'vless', tag: 'g-out', server: 'exit.example.org', server_port: 8443, uuid: 'x', tls: { enabled: true } }],
    route: { rules: [{ inbound: ['g'], outbound: 'g-out' }, { inbound: ['local'], domain: ['a.com'], outbound: 'g-out' }] },
  };
  const [grpc, mixed] = savedNodes(JSON.stringify(config), 'example.org');
  assert.equal(new URL(grpc.link).searchParams.get('serviceName'), 'svc');
  assert.deepEqual(grpc.target, { tag: 'g-out', type: 'vless', server: 'exit.example.org', port: 8443, summary: 'VLESS + TLS' });
  assert.equal(mixed.target, null, 'conditional rules are not a dedicated relay target');
  assert.ok(mixed.error);
});
test('rejects malformed host and private key', () => {
  assert.throws(() => savedNodes('{}', 'https://example.org/path'));
  assert.throws(() => publicKey('bad'));
});
