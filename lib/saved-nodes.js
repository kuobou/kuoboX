'use strict';
// 從正式設定推導每個入站的客戶端匯入連結，以及它被路由到哪個落地出站。
const crypto = require('node:crypto');
const net = require('node:net');
const { isHost, describeOutbound } = require('./links');

function parseConfig(text) {
  // Strip comments only outside JSON strings, preserving URLs and escaped quotes.
  const clean = String(text || '').replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, part => part.startsWith('"') ? part : ' ');
  return JSON.parse(clean.trim() || '{}');
}

function publicKey(privateKey) {
  const raw = Buffer.from(privateKey || '', 'base64url');
  if (raw.length !== 32) throw new Error('REALITY 私鑰格式錯誤');
  const key = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]), format: 'der', type: 'pkcs8' });
  return crypto.createPublicKey(key).export({ format: 'jwk' }).x;
}

// 路由到此入站的第一條規則所指向的出站
function targetOf(config, tag) {
  const rule = (config.route?.rules || []).find(r => {
    if (!r || !r.outbound || (r.action && r.action !== 'route')) return false;
    const list = Array.isArray(r.inbound) ? r.inbound : r.inbound ? [r.inbound] : [];
    return list.includes(tag) && Object.keys(r).every(k => ['inbound', 'outbound', 'action'].includes(k));
  });
  if (!rule) return null;
  const ob = [...(config.outbounds || []), ...(config.endpoints || [])].find(o => o && o.tag === rule.outbound);
  return { tag: rule.outbound, type: ob?.type || '', server: ob?.server || '', port: ob?.server_port || null, summary: describeOutbound(ob) };
}

const selfSigned = tls => /kuobox-cert/.test(tls?.certificate_path || '');

function linkFor(inbound, user, name, authority, host) {
  const tls = inbound.tls || {};
  const reality = tls.enabled && tls.reality?.enabled;
  const target = `${authority}:${inbound.listen_port}`;
  const tag = '#' + encodeURIComponent(name);
  if (inbound.transport && !['ws', 'httpupgrade', 'grpc'].includes(inbound.transport.type)) throw new Error('此傳輸方式請從設定檔手動匯入');
  if (tls.enabled && (tls.ech?.enabled || tls.client_authentication)) throw new Error('進階 TLS 設定請手動匯入');
  const params = new URLSearchParams({ type: inbound.transport?.type || 'tcp', security: reality ? 'reality' : tls.enabled ? 'tls' : 'none' });
  if (tls.server_name) params.set('sni', tls.server_name);
  if (tls.alpn?.length) params.set('alpn', tls.alpn.join(','));
  if (tls.enabled && !reality && selfSigned(tls)) params.set('allowInsecure', '1');
  const tr = inbound.transport;
  if (tr?.type === 'ws' || tr?.type === 'httpupgrade') {
    if (tr.max_early_data) throw new Error('WebSocket early data 請手動匯入');
    params.set('path', tr.path || '/');
    const h = tr.headers?.Host || tr.host;
    if (h) params.set('host', h);
  }
  if (tr?.type === 'grpc') params.set('serviceName', tr.service_name || '');
  if (reality) {
    params.set('pbk', publicKey(tls.reality.private_key));
    params.set('sid', tls.reality.short_id?.[0] || '');
    params.set('fp', 'chrome');
  }
  switch (inbound.type) {
    case 'vless': {
      if (!user.uuid) throw new Error('缺少 UUID');
      params.set('encryption', 'none');
      if (user.flow) params.set('flow', user.flow);
      return `vless://${encodeURIComponent(user.uuid)}@${target}?${params}${tag}`;
    }
    case 'trojan':
      if (!user.password) throw new Error('缺少密碼');
      return `trojan://${encodeURIComponent(user.password)}@${target}?${params}${tag}`;
    case 'vmess':
      if (reality) throw new Error('此 VMess 設定請手動匯入');
      if (!user.uuid) throw new Error('缺少 UUID');
      return 'vmess://' + Buffer.from(JSON.stringify({
        v: '2', ps: name, add: host, port: String(inbound.listen_port), id: user.uuid, aid: user.alterId || 0, scy: 'auto',
        net: tr?.type || 'tcp', type: 'none', host: tr?.headers?.Host || tr?.host || '', path: tr?.type === 'grpc' ? tr.service_name || '' : tr?.path || '',
        tls: tls.enabled ? 'tls' : '', sni: tls.server_name || '', alpn: (tls.alpn || []).join(','), ...(tls.enabled && selfSigned(tls) ? { allowInsecure: '1' } : {}),
      })).toString('base64');
    case 'shadowsocks': {
      if (inbound.users?.length || !inbound.password || !inbound.method || tls.enabled || tr) throw new Error('此 Shadowsocks 設定請手動匯入');
      // SIP002：2022 系列使用百分比編碼，其餘使用 Base64URL
      const info = inbound.method.startsWith('2022-')
        ? `${encodeURIComponent(inbound.method)}:${encodeURIComponent(inbound.password)}`
        : Buffer.from(`${inbound.method}:${inbound.password}`).toString('base64url');
      return `ss://${info}@${target}${tag}`;
    }
    case 'hysteria2': {
      if (!user.password) throw new Error('缺少密碼');
      const q = new URLSearchParams();
      if (tls.server_name) q.set('sni', tls.server_name);
      if (selfSigned(tls)) q.set('insecure', '1');
      if (inbound.obfs?.type === 'salamander') { q.set('obfs', 'salamander'); q.set('obfs-password', inbound.obfs.password || ''); }
      const qs = q.toString();
      return `hysteria2://${encodeURIComponent(user.password)}@${target}/${qs ? '?' + qs : ''}${tag}`;
    }
    case 'tuic': {
      if (!user.uuid || !user.password) throw new Error('缺少 UUID 或密碼');
      const q = new URLSearchParams({ congestion_control: inbound.congestion_control || 'cubic', alpn: (tls.alpn || ['h3']).join(',') });
      if (tls.server_name) q.set('sni', tls.server_name);
      if (selfSigned(tls)) q.set('allow_insecure', '1');
      return `tuic://${encodeURIComponent(user.uuid)}:${encodeURIComponent(user.password)}@${target}?${q}${tag}`;
    }
    default:
      throw new Error('此協定請使用設定檔匯入客戶端');
  }
}

// names：面板另存的 tag → 顯示名稱（sing-box 不允許在設定中加入自訂欄位）
function savedNodes(content, host, names = {}) {
  if (!isHost(host)) throw new Error('請填入有效的公網 IP 或域名');
  const config = parseConfig(content);
  const authority = net.isIP(host) === 6 ? `[${host}]` : host;
  return (config.inbounds || []).filter(Boolean).flatMap(inbound => {
    const users = inbound.users?.length ? inbound.users : [inbound];
    const target = inbound.tag ? targetOf(config, inbound.tag) : null;
    const saved = users.length === 1 && inbound.tag && Object.hasOwn(names, inbound.tag) ? String(names[inbound.tag]) : '';
    return users.map((user, index) => {
      const base = saved || user.name || inbound.tag || inbound.type;
      const name = users.length > 1 && !user.name ? `${base} / ${index + 1}` : base;
      const node = { tag: inbound.tag || '', name, type: inbound.type, entry: describeOutbound(inbound), port: inbound.listen_port || null, listen: inbound.listen || '', target, link: '', error: '', multi: users.length > 1 };
      try {
        if (!inbound.listen_port) throw new Error('此入站沒有監聽端口');
        node.link = linkFor(inbound, user, name, authority, host);
      } catch (e) { node.error = e.message; }
      return node;
    });
  });
}

module.exports = { savedNodes, publicKey, parseConfig, targetOf };
