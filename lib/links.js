'use strict';
// 解析落地機分享連結（或手動欄位）並轉換為 sing-box 出站物件。
const net = require('node:net');

const HOST_RE = /^(?=.{1,253}$)[a-zA-Z0-9_](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/;
const SS_METHODS = [
  '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305',
  'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305', 'none',
];
const FINGERPRINTS = ['chrome', 'firefox', 'edge', 'safari', '360', 'qq', 'ios', 'android', 'random', 'randomized'];
const LABELS = { vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan', shadowsocks: 'Shadowsocks', hysteria2: 'Hysteria2', tuic: 'TUIC', socks: 'SOCKS5' };

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const isHost = host => typeof host === 'string' && (net.isIP(host) > 0 || HOST_RE.test(host));
const truthy = v => v === '1' || v === 'true' || v === true;

function decodeBase64(text) {
  const clean = String(text).trim().replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw fail('Base64 內容格式錯誤');
  return Buffer.from(clean + '='.repeat((4 - clean.length % 4) % 4), 'base64').toString('utf8');
}

function safeDecode(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

function splitHostPort(text) {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(text) || /^([^:]+):(\d+)$/.exec(text);
  if (!m) throw fail('連結缺少主機或端口');
  return { server: m[1], port: Number(m[2]) };
}

function fromUrl(link) {
  let url;
  try { url = new URL(link); } catch { throw fail('連結格式錯誤'); }
  const q = Object.fromEntries(url.searchParams);
  const user = safeDecode(url.username);
  const pass = safeDecode(url.password);
  return {
    q,
    server: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port ? Number(url.port) : 443,
    user, pass,
    credential: url.password ? `${user}:${pass}` : user,
    name: safeDecode(url.hash.slice(1)),
  };
}

function common(q) {
  return {
    sni: q.sni || q.peer || q.servername || '',
    fp: q.fp || '',
    alpn: q.alpn ? q.alpn.split(',').map(s => s.trim()).filter(Boolean) : [],
    insecure: truthy(q.allowInsecure) || truthy(q.insecure) || truthy(q.allow_insecure) || truthy(q.skip_cert_verify),
    network: (q.type || q.net || 'tcp').toLowerCase(),
    headerType: q.headerType || '',
    path: q.path || '',
    host: q.host || '',
    serviceName: q.serviceName || q.service_name || '',
  };
}

function parseVmess(body) {
  let j;
  try { j = JSON.parse(decodeBase64(body)); } catch { throw fail('VMess 連結內容無法解析'); }
  const network = String(j.net || 'tcp').toLowerCase();
  return {
    protocol: 'vmess', name: j.ps || '', server: String(j.add || ''), port: Number(j.port),
    uuid: j.id, alterId: Number(j.aid) || 0, cipher: j.scy || 'auto',
    security: j.tls === 'tls' ? 'tls' : 'none', sni: j.sni || '', fp: j.fp || '',
    alpn: j.alpn ? String(j.alpn).split(',').filter(Boolean) : [], insecure: truthy(j.allowInsecure) || truthy(j.skip_cert_verify),
    network: network === 'h2' ? 'http' : network, headerType: j.type === 'http' ? 'http' : '',
    path: j.path || '', host: j.host || '', serviceName: network === 'grpc' ? j.path || '' : '',
  };
}

function parseShadowsocks(body) {
  let rest = body, name = '', query = '';
  const hash = rest.indexOf('#');
  if (hash >= 0) { name = safeDecode(rest.slice(hash + 1)); rest = rest.slice(0, hash); }
  const qm = rest.indexOf('?');
  if (qm >= 0) { query = rest.slice(qm + 1); rest = rest.slice(0, qm); }
  rest = rest.replace(/\/$/, '');
  let userinfo, hostport;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    userinfo = safeDecode(rest.slice(0, at));
    hostport = rest.slice(at + 1);
    if (!userinfo.includes(':')) userinfo = decodeBase64(userinfo);
  } else {
    const plain = decodeBase64(rest);
    const i = plain.lastIndexOf('@');
    if (i < 0) throw fail('Shadowsocks 連結格式錯誤');
    userinfo = plain.slice(0, i); hostport = plain.slice(i + 1);
  }
  const colon = userinfo.indexOf(':');
  if (colon < 0) throw fail('Shadowsocks 連結缺少加密方式或密碼');
  const p = { protocol: 'shadowsocks', name, method: userinfo.slice(0, colon).toLowerCase(), password: userinfo.slice(colon + 1), ...splitHostPort(hostport) };
  const plugin = new URLSearchParams(query).get('plugin');
  if (plugin) {
    const [pluginName, ...opts] = plugin.split(';');
    p.plugin = pluginName === 'simple-obfs' ? 'obfs-local' : pluginName;
    p.pluginOpts = opts.join(';');
  }
  return p;
}

/** 將分享連結解析為中介參數物件 */
function parseLink(input) {
  const link = String(input || '').trim();
  const m = /^([a-z0-9]+):\/\//i.exec(link);
  if (!m) throw fail('無法辨識的連結，請貼上 vless:// vmess:// trojan:// ss:// hy2:// tuic:// 開頭的分享連結');
  const scheme = m[1].toLowerCase();
  const body = link.slice(m[0].length);
  if (scheme === 'vmess') return parseVmess(body);
  if (scheme === 'ss') return parseShadowsocks(body);
  const u = fromUrl(link);
  const c = common(u.q);
  const base = { name: u.name, server: u.server, port: u.port };
  switch (scheme) {
    case 'vless':
      return { ...base, ...c, protocol: 'vless', uuid: u.user, flow: u.q.flow || '', security: (u.q.security || 'none').toLowerCase(), pbk: u.q.pbk || '', sid: u.q.sid || '' };
    case 'trojan':
      return { ...base, ...c, protocol: 'trojan', password: u.credential, security: (u.q.security || 'tls').toLowerCase(), pbk: u.q.pbk || '', sid: u.q.sid || '' };
    case 'hysteria2': case 'hy2':
      return { ...base, ...c, protocol: 'hysteria2', password: u.credential, obfs: u.q.obfs || '', obfsPassword: u.q['obfs-password'] || u.q.obfs_password || '' };
    case 'tuic':
      return { ...base, ...c, protocol: 'tuic', uuid: u.user, password: u.pass, congestion: u.q.congestion_control || u.q.congestion || '', udpRelayMode: u.q.udp_relay_mode || '' };
    case 'socks': case 'socks5':
      return { ...base, protocol: 'socks', username: u.user, password: u.pass };
    case 'http': case 'https':
      throw fail('這是網址，不是節點分享連結；若是訂閱網址，請在客戶端開啟後複製其中一條節點連結');
    default:
      throw fail(`不支援的協定：${scheme}`);
  }
}

function tlsOf(p, force) {
  const security = force ? 'tls' : p.security;
  if (security !== 'tls' && security !== 'reality') return undefined;
  const tls = { enabled: true };
  const sni = p.sni || (['ws', 'httpupgrade', 'http'].includes(p.network) && p.host && !p.host.includes(',') ? p.host : '');
  if (sni) {
    if (!isHost(sni)) throw fail('SNI 格式錯誤');
    tls.server_name = sni;
  }
  if (p.insecure) tls.insecure = true;
  if (p.alpn?.length) tls.alpn = p.alpn;
  const fp = FINGERPRINTS.includes(p.fp) ? p.fp : 'chrome';
  if (security === 'reality') {
    if (!/^[A-Za-z0-9_-]{43}$/.test(p.pbk || '')) throw fail('REALITY 連結缺少有效的公鑰（pbk）');
    if (p.sid && !/^[0-9a-fA-F]{0,16}$/.test(p.sid)) throw fail('REALITY short id 格式錯誤');
    tls.utls = { enabled: true, fingerprint: fp };
    tls.reality = { enabled: true, public_key: p.pbk, short_id: p.sid || '' };
  } else if (p.fp && p.fp !== 'none') {
    tls.utls = { enabled: true, fingerprint: fp };
  }
  return tls;
}

function transportOf(p) {
  switch (p.network || 'tcp') {
    case 'tcp': case 'raw':
      if (p.headerType === 'http') throw fail('sing-box 不支援 TCP HTTP 偽裝，請改用其他傳輸');
      return undefined;
    case 'ws': {
      const t = { type: 'ws', path: p.path || '/' };
      const ed = /[?&]ed=(\d+)/.exec(t.path);
      if (ed) {
        t.path = t.path.replace(/[?&]ed=\d+/, '').replace(/\?$/, '') || '/';
        t.max_early_data = Number(ed[1]);
        t.early_data_header_name = 'Sec-WebSocket-Protocol';
      }
      if (p.host) t.headers = { Host: p.host };
      return t;
    }
    case 'grpc': return { type: 'grpc', service_name: p.serviceName || p.path || '' };
    case 'httpupgrade': {
      const t = { type: 'httpupgrade', path: p.path || '/' };
      if (p.host) t.host = p.host;
      return t;
    }
    case 'http': case 'h2': {
      const t = { type: 'http' };
      if (p.host) t.host = p.host.split(',').map(s => s.trim()).filter(Boolean);
      if (p.path) t.path = p.path;
      return t;
    }
    default: throw fail(`sing-box 不支援 ${p.network} 傳輸（例如 xhttp／kcp），請更換落地機設定`);
  }
}

const clean = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== ''));

/** 中介參數 → sing-box 出站（不含 tag） */
function outboundFrom(p) {
  if (!p || typeof p !== 'object') throw fail('缺少落地機資料');
  const server = String(p.server || '').trim().replace(/^\[|\]$/g, '');
  const port = Number(p.port);
  if (!isHost(server)) throw fail('落地機地址格式錯誤');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('落地機端口須為 1–65535');
  const base = { type: p.protocol, server, server_port: port };
  const need = (value, label) => { if (!value || typeof value !== 'string') throw fail(`缺少${label}`); return value; };
  switch (p.protocol) {
    case 'vless': {
      const transport = transportOf(p);
      const flow = p.flow && !transport ? p.flow : undefined;
      if (flow && flow !== 'xtls-rprx-vision') throw fail(`不支援的 flow：${flow}`);
      return clean({ ...base, uuid: need(p.uuid, ' UUID'), flow, tls: tlsOf(p), transport });
    }
    case 'vmess':
      return clean({ ...base, uuid: need(p.uuid, ' UUID'), security: p.cipher || 'auto', alter_id: Number(p.alterId) || 0, tls: tlsOf(p), transport: transportOf(p) });
    case 'trojan':
      return clean({ ...base, password: need(p.password, '密碼'), tls: tlsOf(p), transport: transportOf(p) });
    case 'shadowsocks': {
      if (!SS_METHODS.includes(p.method)) throw fail(`不支援的 Shadowsocks 加密：${p.method || '（空白）'}`);
      if (p.plugin && !['obfs-local', 'v2ray-plugin'].includes(p.plugin)) throw fail(`不支援的 Shadowsocks 插件：${p.plugin}`);
      return clean({ ...base, method: p.method, password: need(p.password, '密碼'), plugin: p.plugin || undefined, plugin_opts: p.plugin ? p.pluginOpts : undefined });
    }
    case 'hysteria2':
      return clean({ ...base, password: need(p.password, '密碼'), obfs: p.obfs === 'salamander' ? { type: 'salamander', password: need(p.obfsPassword, ' obfs 密碼') } : undefined, tls: tlsOf(p, true) });
    case 'tuic': {
      const tls = tlsOf({ ...p, alpn: p.alpn?.length ? p.alpn : ['h3'] }, true);
      const congestion = ['cubic', 'new_reno', 'bbr'].includes(p.congestion) ? p.congestion : undefined;
      return clean({ ...base, uuid: need(p.uuid, ' UUID'), password: need(p.password, '密碼'), congestion_control: congestion, udp_relay_mode: ['native', 'quic'].includes(p.udpRelayMode) ? p.udpRelayMode : undefined, tls });
    }
    case 'socks':
      return clean({ ...base, version: '5', username: p.username || undefined, password: p.password || undefined });
    default:
      throw fail('不支援的落地協定');
  }
}

/** 手動欄位 → 中介參數 */
function fromManual(m) {
  const protocol = String(m.protocol || '');
  const credential = String(m.credential || '').trim();
  const p = {
    protocol, server: String(m.server || '').trim(), port: Number(m.port),
    security: m.security || 'none', sni: String(m.sni || '').trim(), insecure: !!m.insecure,
    network: m.network || 'tcp', path: String(m.path || '').trim(), host: String(m.host || '').trim(),
    serviceName: String(m.path || '').trim(), pbk: String(m.pbk || '').trim(), sid: String(m.sid || '').trim(),
    fp: m.security === 'reality' ? 'chrome' : '', flow: m.flow ? 'xtls-rprx-vision' : '',
  };
  const i = credential.indexOf(':');
  if (protocol === 'vless' || protocol === 'vmess') p.uuid = credential;
  else if (protocol === 'tuic') { p.uuid = i < 0 ? credential : credential.slice(0, i); p.password = i < 0 ? '' : credential.slice(i + 1); }
  else if (protocol === 'socks') { p.username = i < 0 ? credential : credential.slice(0, i); p.password = i < 0 ? '' : credential.slice(i + 1); }
  else p.password = credential;
  if (protocol === 'shadowsocks') p.method = m.method;
  return p;
}

/** sing-box 出站 → 手動欄位（編輯時預填；不支援的出站回傳 null） */
function manualFromOutbound(ob) {
  if (!ob || !['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2', 'tuic', 'socks'].includes(ob.type)) return null;
  const tls = ob.tls || {};
  const tr = ob.transport || {};
  const credential = {
    vless: ob.uuid, vmess: ob.uuid,
    tuic: ob.uuid && `${ob.uuid}:${ob.password || ''}`,
    socks: ob.username ? `${ob.username}:${ob.password || ''}` : '',
  }[ob.type] ?? ob.password;
  return {
    protocol: ob.type, server: ob.server || '', port: ob.server_port || '', credential: credential || '', method: ob.method || '',
    security: tls.reality?.enabled ? 'reality' : tls.enabled ? 'tls' : 'none',
    sni: tls.server_name || '', insecure: !!tls.insecure, pbk: tls.reality?.public_key || '', sid: tls.reality?.short_id || '',
    network: ['ws', 'grpc', 'httpupgrade'].includes(tr.type) ? tr.type : 'tcp',
    path: tr.type === 'grpc' ? tr.service_name || '' : tr.path || '', host: tr.headers?.Host || tr.host || '', flow: !!ob.flow,
  };
}

function buildOutbound(exit) {
  if (!exit || typeof exit !== 'object') throw fail('缺少落地機資料');
  const p = exit.mode === 'manual' ? fromManual(exit) : parseLink(exit.link);
  return { outbound: outboundFrom(p), name: p.name || '' };
}

function describeOutbound(ob) {
  if (!ob) return '';
  const label = LABELS[ob.type] || ob.type;
  const parts = [label];
  if (ob.tls?.reality?.enabled) parts.push('REALITY');
  else if (ob.tls?.enabled && !['hysteria2', 'tuic'].includes(ob.type)) parts.push('TLS');
  if (ob.transport?.type) parts.push(ob.transport.type.toUpperCase());
  return parts.join(' + ');
}

module.exports = { parseLink, outboundFrom, fromManual, manualFromOutbound, buildOutbound, describeOutbound, isHost, SS_METHODS, LABELS };
