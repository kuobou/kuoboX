'use strict';
// 中轉節點：在既有 sing-box 設定上新增／刪除「入口 → 落地機」組合，其餘設定原樣保留。
const crypto = require('node:crypto');
const { buildOutbound, isHost } = require('./links');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

const INBOUND_TYPES = {
  'vless-reality': { network: 'tcp', label: 'VLESS + REALITY' },
  shadowsocks: { network: 'tcp+udp', label: 'Shadowsocks' },
  'vmess-ws': { network: 'tcp', label: 'VMess + WebSocket' },
  trojan: { network: 'tcp', label: 'Trojan' },
  hysteria2: { network: 'udp', label: 'Hysteria2' },
};
const SS_KEY_BYTES = { '2022-blake3-aes-128-gcm': 16, '2022-blake3-aes-256-gcm': 32, '2022-blake3-chacha20-poly1305': 32, 'aes-128-gcm': 0, 'aes-256-gcm': 0, 'chacha20-ietf-poly1305': 0 };
const MANAGED_OUT = /^(relay-\d+(?:-\d+)?-out|to-exit-\d+)$/;

function realityKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  return { private_key: privateKey.export({ format: 'jwk' }).d, public_key: publicKey.export({ format: 'jwk' }).x };
}

/** 嚴格解析：含註解的設定不能經表單改寫，否則註解會遺失 */
function parseStrict(text) {
  if (!text || !text.trim()) return {};
  let value;
  try { value = JSON.parse(text); } catch { throw fail('設定檔含註解或非標準 JSON，表單無法安全修改；請到「設定檔」頁面編輯', 422); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('設定檔根節點必須是物件', 422);
  return value;
}

function versionAtLeast(version, major, minor) {
  const m = /(\d+)\.(\d+)/.exec(version || '');
  return !!m && (Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor));
}

function listOutbounds(cfg) {
  const items = [...(cfg.outbounds || []), ...(cfg.endpoints || [])];
  return items.filter(o => o && o.tag && !['block', 'dns'].includes(o.type))
    .map(o => ({ tag: o.tag, type: o.type, server: o.server || '', port: o.server_port || null }));
}

function certPaths(spec) {
  const cert = String(spec.certificate_path || '').trim();
  const key = String(spec.key_path || '').trim();
  if (!cert.startsWith('/') || !key.startsWith('/') || /[\r\n\0]/.test(cert + key)) throw fail('此協定需要 TLS 憑證：請填入憑證與私鑰的絕對路徑，或點「產生自簽憑證」');
  return { certificate_path: cert, key_path: key };
}

function makeInbound(spec, tag, port, name) {
  const listen = spec.listen === '::' ? '::' : '0.0.0.0';
  const head = { tag, listen, listen_port: port };
  switch (spec.type) {
    case 'vless-reality': {
      const sni = String(spec.sni || 'www.apple.com').trim();
      if (!isHost(sni)) throw fail('REALITY 偽裝網站格式錯誤');
      const keys = realityKeypair();
      return {
        type: 'vless', ...head,
        users: [{ name, uuid: crypto.randomUUID(), flow: 'xtls-rprx-vision' }],
        tls: { enabled: true, server_name: sni, reality: { enabled: true, handshake: { server: sni, server_port: 443 }, private_key: keys.private_key, short_id: [crypto.randomBytes(8).toString('hex')] } },
      };
    }
    case 'shadowsocks': {
      const method = spec.method || '2022-blake3-aes-128-gcm';
      if (!(method in SS_KEY_BYTES)) throw fail('不支援的 Shadowsocks 加密方式');
      const bytes = SS_KEY_BYTES[method];
      return { type: 'shadowsocks', ...head, method, password: bytes ? crypto.randomBytes(bytes).toString('base64') : crypto.randomBytes(18).toString('base64url') };
    }
    case 'vmess-ws': {
      const path = String(spec.path || '/' + crypto.randomBytes(6).toString('hex')).trim();
      if (!/^\/[\w\-./~%]*$/.test(path)) throw fail('WebSocket 路徑須以 / 開頭且不含特殊字元');
      return { type: 'vmess', ...head, users: [{ name, uuid: crypto.randomUUID(), alterId: 0 }], transport: { type: 'ws', path } };
    }
    case 'trojan': {
      const sni = String(spec.sni || '').trim();
      if (sni && !isHost(sni)) throw fail('TLS 域名格式錯誤');
      return { type: 'trojan', ...head, users: [{ name, password: crypto.randomBytes(16).toString('hex') }], tls: { enabled: true, ...(sni ? { server_name: sni } : {}), ...certPaths(spec) } };
    }
    case 'hysteria2': {
      const sni = String(spec.sni || '').trim();
      if (sni && !isHost(sni)) throw fail('TLS 域名格式錯誤');
      return { type: 'hysteria2', ...head, users: [{ name, password: crypto.randomBytes(16).toString('hex') }], tls: { enabled: true, ...(sni ? { server_name: sni } : {}), alpn: ['h3'], ...certPaths(spec) } };
    }
    default: throw fail('請選擇入口協定');
  }
}

/**
 * 新增中轉：入口入站 + 專用出站 + 置頂路由規則。
 * spec = { name, port?, inbound: {type,...}, exit: {mode:'link'|'manual'|'existing', ...} }
 */
function addRelay(base, spec, env = {}) {
  if (!spec || typeof spec !== 'object') throw fail('缺少中轉設定');
  const cfg = structuredClone(base || {});
  const fresh = Object.keys(cfg).length === 0;
  for (const key of ['inbounds', 'outbounds']) {
    if (cfg[key] != null && !Array.isArray(cfg[key])) throw fail(`設定中的 ${key} 不是陣列，請先修正設定檔`, 422);
    cfg[key] = cfg[key] || [];
  }
  if (cfg.route != null && (typeof cfg.route !== 'object' || Array.isArray(cfg.route))) throw fail('設定中的 route 格式錯誤', 422);
  const used = new Set(cfg.inbounds.map(i => i && i.listen_port).filter(Boolean));
  let port = spec.port === '' || spec.port == null ? null : Number(spec.port);
  if (port === null) {
    for (let i = 0; i < 100 && (port === null || used.has(port)); i++) port = 20000 + crypto.randomInt(40000);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('入口端口須為 1–65535 的整數');
  if (used.has(port)) throw fail(`端口 ${port} 已被其他入站使用，請換一個端口`, 409);

  const tags = new Set([...cfg.inbounds, ...cfg.outbounds, ...(cfg.endpoints || [])].map(x => x && x.tag).filter(Boolean));
  let tag = `relay-${port}`;
  for (let n = 2; tags.has(tag) || tags.has(tag + '-out'); n++) tag = `relay-${port}-${n}`;

  const exit = spec.exit || {};
  let outTag, outbound = null, exitName = '';
  if (exit.mode === 'existing') {
    outTag = String(exit.tag || '');
    if (!listOutbounds(cfg).some(o => o.tag === outTag)) throw fail('找不到指定的現有出站');
  } else {
    ({ outbound, name: exitName } = buildOutbound(exit));
    outTag = tag + '-out';
  }
  const name = String(spec.name || exitName || tag).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 48) || tag;
  const inbound = makeInbound(spec.inbound || {}, tag, port, name);

  if (fresh) {
    cfg.log = { level: 'warn', timestamp: true };
    if (versionAtLeast(env.version, 1, 12)) cfg.dns = { servers: [{ type: 'local', tag: 'local' }] };
    cfg.outbounds.push({ type: 'direct', tag: 'direct' });
  }
  cfg.inbounds.push(inbound);
  if (outbound) cfg.outbounds.push({ type: outbound.type, tag: outTag, ...outbound });
  cfg.route = cfg.route || {};
  if (cfg.route.rules != null && !Array.isArray(cfg.route.rules)) throw fail('設定中的 route.rules 不是陣列', 422);
  cfg.route.rules = [{ inbound: [tag], outbound: outTag }, ...(cfg.route.rules || [])];
  if (fresh) {
    cfg.route.final = 'direct';
    if (cfg.dns) cfg.route.default_domain_resolver = 'local';
  }
  return { config: cfg, tag, port, name, network: INBOUND_TYPES[spec.inbound.type].network };
}

function stripInbound(rules, tag) {
  if (!Array.isArray(rules)) return { rules, dropped: [] };
  const dropped = [];
  const kept = rules.filter(rule => {
    if (!rule || rule.inbound == null) return true;
    const list = (Array.isArray(rule.inbound) ? rule.inbound : [rule.inbound]).filter(t => t !== tag);
    if (list.length === (Array.isArray(rule.inbound) ? rule.inbound.length : 1)) return true;
    // 移除後沒有 inbound 條件的規則會變成全域規則，必須整條刪除
    if (!list.length) { dropped.push(rule); return false; }
    rule.inbound = list;
    return true;
  });
  return { rules: kept, dropped };
}

/** 刪除入站、只屬於它的規則，以及不再被引用的面板專用出站 */
function removeInbound(base, tag) {
  const cfg = structuredClone(base || {});
  const index = (cfg.inbounds || []).findIndex(i => i && i.tag === tag);
  if (index < 0) throw fail('找不到此節點，可能已被刪除；請重新整理', 404);
  const [inbound] = cfg.inbounds.splice(index, 1);
  const candidates = new Set();
  if (cfg.route) {
    const r = stripInbound(cfg.route.rules, tag);
    cfg.route.rules = r.rules;
    r.dropped.forEach(rule => rule.outbound && candidates.add(rule.outbound));
  }
  if (cfg.dns) cfg.dns.rules = stripInbound(cfg.dns.rules, tag).rules;
  candidates.add(tag + '-out');
  for (const out of candidates) {
    if (!MANAGED_OUT.test(out)) continue;
    const i = (cfg.outbounds || []).findIndex(o => o && o.tag === out);
    if (i < 0) continue;
    const [removed] = cfg.outbounds.splice(i, 1);
    if (JSON.stringify(cfg).includes(JSON.stringify(out))) cfg.outbounds.splice(i, 0, removed);
  }
  const network = inbound.type === 'hysteria2' || inbound.type === 'tuic' ? 'udp' : inbound.type === 'shadowsocks' ? 'tcp+udp' : 'tcp';
  return { config: cfg, port: inbound.listen_port, network };
}

module.exports = { addRelay, removeInbound, parseStrict, listOutbounds, realityKeypair, versionAtLeast, INBOUND_TYPES };
