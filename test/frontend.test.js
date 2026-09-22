const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

function context(base = {}) {
  const elements = new Map();
  const defaults = { 'cfg-in-proto': 'vless-reality', 'cfg-privkey': 'private-key', 'cfg-exit-proto': 'vless' };
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { value: defaults[id] || '', checked: false, addEventListener() {} });
    return elements.get(id);
  }, querySelectorAll: () => [1] };
  const store = { getItem: () => '', removeItem() {} };
  const c = vm.createContext({ document, localStorage: store, sessionStorage: store, console });
  vm.runInContext(script, c);
  vm.runInContext(`configFormLoaded = true; originalConfig = ${JSON.stringify(base)};`, c);
  c.toast = msg => { c.lastToast = msg; };
  c.getPortsData = () => [{ port: 20000, uuid: 'uuid', shortid: 'abcd', exitIp: 'exit.example.com', exitPort: 443, exitUUID: 'secret', outProto: 'vless', useTLS: true }];
  c.getExitPortsData = () => [];
  return { c, elements };
}
test('generated relay has matching outbound, route and certificate verification', async () => {
  const { c, elements } = context();
  assert.equal(await c.generateConfig(), true);
  const cfg = JSON.parse(elements.get('cfg-output').value);
  assert.equal(cfg.inbounds.length, 1);
  assert.equal(cfg.route.rules[0].outbound, cfg.outbounds[0].tag);
  assert.equal(cfg.outbounds[0].tls.insecure, undefined);
  assert.equal(cfg.outbounds[0].tls.server_name, 'exit.example.com');
});
test('missing exit credentials blocks generation instead of direct fallback', async () => {
  const { c } = context();
  const get = c.getPortsData;
  c.getPortsData = () => [{ ...get()[0], exitUUID: '' }];
  assert.equal(await c.generateConfig(), false);
});
test('arbitrary existing settings and routes survive new node creation', async () => {
  const base = { dns: { servers: [{ type: 'local', tag: 'dns' }] }, experimental: { cache_file: { enabled: true } }, inbounds: [{ type: 'hysteria2', tag: 'advanced', listen_port: 8443 }], outbounds: [{ type: 'selector', tag: 'choice', outbounds: ['direct'] }], route: { final: 'choice', rules: [{ domain_suffix: ['example.org'], outbound: 'choice' }] } };
  const { c, elements } = context(base);
  assert.equal(await c.generateConfig(), true);
  const cfg = JSON.parse(elements.get('cfg-output').value);
  assert.deepEqual(cfg.dns, base.dns);
  assert.deepEqual(cfg.experimental, base.experimental);
  assert.deepEqual(cfg.inbounds[0], base.inbounds[0]);
  assert.equal(cfg.route.final, 'choice');
  assert.deepEqual(cfg.route.rules[1], base.route.rules[0]);
});
test('existing ports cannot be overwritten by the simplified form', async () => {
  const { c } = context({ inbounds: [{ tag: 'custom', listen_port: 20000 }] });
  assert.equal(await c.generateConfig(), false);
});
test('implicit existing route defaults are not replaced by direct routing', async () => {
  const { c, elements } = context({ outbounds: [{ type: 'socks', tag: 'original-default', server: 'example.org', server_port: 1080 }] });
  assert.equal(await c.generateConfig(), true);
  const cfg = JSON.parse(elements.get('cfg-output').value);
  assert.equal(cfg.route.final, undefined);
  assert.equal(cfg.route.auto_detect_interface, undefined);
  assert.equal(cfg.log, undefined);
  assert.equal(cfg.outbounds[0].tag, 'original-default');
});
test('duplicate relay and exit ports are blocked', async () => {
  const { c } = context();
  c.document.querySelectorAll = () => [1, 2];
  c.getExitPortsData = () => [{ port: 20000, uuid: 'uuid' }];
  assert.equal(await c.generateConfig(), false);
});
