const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLink, outboundFrom, buildOutbound, describeOutbound } = require('../lib/links');

const PBK = 'Z3JdVvO2i9k0jH4Uu9m0hbfQ2qL3dC8tE8x9d6kQeFw';
const out = link => outboundFrom(parseLink(link));

test('VLESS REALITY vision link becomes a uTLS REALITY outbound', () => {
  const ob = out(`vless://0f8e2c1a-1111-2222-3333-444455556666@exit.example.com:443?type=tcp&security=reality&sni=www.apple.com&pbk=${PBK}&sid=a1b2&fp=safari&flow=xtls-rprx-vision#HK`);
  assert.deepEqual(ob, {
    type: 'vless', server: 'exit.example.com', server_port: 443, uuid: '0f8e2c1a-1111-2222-3333-444455556666', flow: 'xtls-rprx-vision',
    tls: { enabled: true, server_name: 'www.apple.com', utls: { enabled: true, fingerprint: 'safari' }, reality: { enabled: true, public_key: PBK, short_id: 'a1b2' } },
  });
  assert.equal(describeOutbound(ob), 'VLESS + REALITY');
});

test('VLESS over WebSocket keeps path, Host and early data', () => {
  const ob = out('vless://id@[2001:db8::1]:8443?type=ws&security=tls&path=%2Fws%3Fed%3D2048&host=cdn.example.com&allowInsecure=1');
  assert.equal(ob.server, '2001:db8::1');
  assert.deepEqual(ob.transport, { type: 'ws', path: '/ws', max_early_data: 2048, early_data_header_name: 'Sec-WebSocket-Protocol', headers: { Host: 'cdn.example.com' } });
  assert.deepEqual(ob.tls, { enabled: true, server_name: 'cdn.example.com', insecure: true });
  assert.equal(ob.flow, undefined);
});

test('Trojan defaults to TLS and decodes special characters in the password', () => {
  const ob = out('trojan://p%40ss%3Aword@t.example.com:443?sni=t.example.com#x');
  assert.equal(ob.password, 'p@ss:word');
  assert.deepEqual(ob.tls, { enabled: true, server_name: 't.example.com' });
});

test('VMess base64 JSON link is parsed including gRPC', () => {
  const body = Buffer.from(JSON.stringify({ v: '2', ps: '日本', add: 'jp.example.com', port: '443', id: 'uuid-1', aid: '0', net: 'grpc', path: 'svc', tls: 'tls', sni: 'jp.example.com' })).toString('base64');
  const p = parseLink('vmess://' + body);
  assert.equal(p.name, '日本');
  const ob = outboundFrom(p);
  assert.deepEqual(ob.transport, { type: 'grpc', service_name: 'svc' });
  assert.equal(ob.security, 'auto');
  assert.equal(ob.tls.server_name, 'jp.example.com');
});

test('Shadowsocks SIP002, plain 2022 and legacy formats', () => {
  const sip = out('ss://' + Buffer.from('aes-256-gcm:secret').toString('base64url') + '@1.2.3.4:8388#a');
  assert.deepEqual(sip, { type: 'shadowsocks', server: '1.2.3.4', server_port: 8388, method: 'aes-256-gcm', password: 'secret' });
  const plain = out('ss://2022-blake3-aes-128-gcm:' + encodeURIComponent('abc+/=') + '@[::1]:9000');
  assert.equal(plain.password, 'abc+/=');
  assert.equal(plain.server, '::1');
  const legacy = out('ss://' + Buffer.from('chacha20-ietf-poly1305:pw@host.example:443').toString('base64') + '#n');
  assert.equal(legacy.server, 'host.example');
  assert.equal(legacy.method, 'chacha20-ietf-poly1305');
  const plugin = out('ss://' + Buffer.from('aes-128-gcm:pw').toString('base64url') + '@h.example:80/?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dx.com');
  assert.equal(plugin.plugin, 'obfs-local');
  assert.equal(plugin.plugin_opts, 'obfs=http;obfs-host=x.com');
});

test('Hysteria2 and TUIC always enable TLS', () => {
  const hy = out('hy2://pass@hy.example.com:8443/?sni=hy.example.com&insecure=1&obfs=salamander&obfs-password=ob#h');
  assert.deepEqual(hy, { type: 'hysteria2', server: 'hy.example.com', server_port: 8443, password: 'pass', obfs: { type: 'salamander', password: 'ob' }, tls: { enabled: true, server_name: 'hy.example.com', insecure: true } });
  const tuic = out('tuic://uuid:pw@t.example.com:443?congestion_control=bbr&alpn=h3');
  assert.equal(tuic.congestion_control, 'bbr');
  assert.deepEqual(tuic.tls, { enabled: true, alpn: ['h3'] });
});

test('unsupported or broken links give clear errors', () => {
  assert.throws(() => parseLink('example.com:443'), /無法辨識/);
  assert.throws(() => parseLink('https://example.com/sub'), /訂閱/);
  assert.throws(() => parseLink('wireguard://x@h:1'), /不支援的協定/);
  assert.throws(() => out('vless://id@h.example:443?type=xhttp&security=tls'), /不支援 xhttp/);
  assert.throws(() => out('vless://id@h.example:443?security=reality'), /pbk/);
  assert.throws(() => out('vless://@h.example:443'), /UUID/);
  assert.throws(() => out('ss://' + Buffer.from('rc4:pw').toString('base64') + '@h.example:1'), /加密/);
  assert.throws(() => out('vless://id@bad_host!:443'), /連結格式錯誤|地址/);
  assert.throws(() => out('vless://id@h.example:0'), /端口/);
});

test('manual fields build the same outbound as a link', () => {
  const { outbound } = buildOutbound({ mode: 'manual', protocol: 'vless', server: 'exit.example.com', port: '443', credential: 'uid', security: 'reality', sni: 'www.apple.com', pbk: PBK, sid: 'ab', flow: true, network: 'tcp' });
  assert.equal(outbound.flow, 'xtls-rprx-vision');
  assert.equal(outbound.tls.reality.public_key, PBK);
  const socks = buildOutbound({ mode: 'manual', protocol: 'socks', server: '10.0.0.2', port: 1080, credential: 'u:p' }).outbound;
  assert.deepEqual(socks, { type: 'socks', server: '10.0.0.2', server_port: 1080, version: '5', username: 'u', password: 'p' });
});
