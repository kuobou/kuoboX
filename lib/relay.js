'use strict';
// 中轉節點：在既有 sing-box 設定上新增／刪除「入口 → 落地機」組合，其餘設定原樣保留。
const crypto = require('node:crypto');
const { buildOutbound, isHost, describeOutbound, manualFromOutbound } = require('./links');

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

// 面板專用出站若已沒有任何引用就刪除（使用者自訂的出站一律保留）
function pruneOutbound(cfg, out) {
  if (!out || !MANAGED_OUT.test(out)) return;
  const i = (cfg.outbounds || []).findIndex(o => o && o.tag === out);
  if (i < 0) return;
  const [removed] = cfg.outbounds.splice(i, 1);
  if (JSON.stringify(cfg).includes(JSON.stringify(out))) cfg.outbounds.splice(i, 0, removed);
}

const networkOf = inbound => (inbound.type === 'hysteria2' || inbound.type === 'tuic' ? 'udp' : inbound.type === 'shadowsocks' ? 'tcp+udp' : 'tcp');

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
  candidates.forEach(out => pruneOutbound(cfg, out));
  return { config: cfg, port: inbound.listen_port, network: networkOf(inbound) };
}

// ── 編輯中轉 ────────────────────────────────────────
const inboundList = rule => (Array.isArray(rule?.inbound) ? rule.inbound : rule?.inbound != null ? [rule.inbound] : []);
// 「專用規則」：只有 inbound 條件、直接路由到某個出站
const isDedicated = (rule, tag) => !!rule && !!rule.outbound && (!rule.action || rule.action === 'route')
  && inboundList(rule).includes(tag) && Object.keys(rule).every(k => ['inbound', 'outbound', 'action'].includes(k));

/** 精靈能辨識的入口類型；其餘視為自訂（只能改名稱、端口與落地機） */
function kindOf(inbound) {
  const tls = inbound?.tls || {};
  const single = (inbound?.users?.length || 0) <= 1;
  if (!inbound || !single) return 'other';
  if (inbound.type === 'vless' && tls.reality?.enabled && !inbound.transport) return 'vless-reality';
  if (inbound.type === 'shadowsocks' && !inbound.users?.length && !tls.enabled && !inbound.transport && inbound.method in SS_KEY_BYTES) return 'shadowsocks';
  if (inbound.type === 'vmess' && inbound.transport?.type === 'ws' && !tls.enabled) return 'vmess-ws';
  if (inbound.type === 'trojan' && tls.enabled && !tls.reality?.enabled && !inbound.transport && tls.certificate_path) return 'trojan';
  if (inbound.type === 'hysteria2' && tls.enabled && tls.certificate_path && !inbound.obfs) return 'hysteria2';
  return 'other';
}

/** 編輯表單需要的目前設定（不含私鑰與密碼） */
function relayDetail(base, tag) {
  const cfg = base || {};
  const inbound = (cfg.inbounds || []).find(i => i && i.tag === tag);
  if (!inbound) throw fail('找不到此節點，可能已被刪除；請重新整理', 404);
  if ((inbound.users?.length || 0) > 1) throw fail('此入站有多個使用者，請到「設定檔」頁面修改', 422);
  const rule = (cfg.route?.rules || []).find(r => isDedicated(r, tag));
  if (!rule) throw fail('此入站沒有專用的落地路由，請到「設定檔」頁面修改', 422);
  const ob = [...(cfg.outbounds || []), ...(cfg.endpoints || [])].find(o => o && o.tag === rule.outbound);
  const tls = inbound.tls || {};
  return {
    tag, kind: kindOf(inbound), port: inbound.listen_port || null, listen: inbound.listen || '', network: networkOf(inbound),
    userName: inbound.users?.[0]?.name || '',
    sni: tls.server_name || '', method: inbound.method || '', path: inbound.transport?.path || '',
    certificate_path: tls.certificate_path || '', key_path: tls.key_path || '',
    exit: { tag: rule.outbound, type: ob?.type || '', summary: describeOutbound(ob), server: ob?.server || '', port: ob?.server_port || null, managed: MANAGED_OUT.test(rule.outbound), manual: manualFromOutbound(ob) },
  };
}

/**
 * 編輯中轉：同協定時只修改指定欄位（UUID、密碼、金鑰與其他自訂欄位都保留，客戶端連結不變）；
 * 更換協定或要求重新產生時才建立新憑證。
 * spec = { name, port?, regenerate?, inbound?: {type?, listen?, ...}, exit?: {mode:'keep'|'link'|'manual'|'existing', ...} }
 */
function updateRelay(base, tag, spec = {}) {
  const cfg = structuredClone(base || {});
  const idx = (cfg.inbounds || []).findIndex(i => i && i.tag === tag);
  if (idx < 0) throw fail('找不到此節點，可能已被刪除；請重新整理', 404);
  const old = cfg.inbounds[idx];
  if ((old.users?.length || 0) > 1) throw fail('此入站有多個使用者，請到「設定檔」頁面修改', 422);
  const oldKind = kindOf(old);

  let port = old.listen_port;
  if (spec.port != null && spec.port !== '') {
    port = Number(spec.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('入口端口須為 1–65535 的整數');
    if (cfg.inbounds.some((i, n) => n !== idx && i && i.listen_port === port)) throw fail(`端口 ${port} 已被其他入站使用，請換一個端口`, 409);
  }
  const name = String(spec.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 48) || old.users?.[0]?.name || tag;

  const want = spec.inbound?.type;
  const listen = spec.inbound?.listen;
  let inbound;
  if (want && (want !== oldKind || spec.regenerate)) {
    inbound = makeInbound({ ...spec.inbound, listen: listen ?? old.listen }, tag, port, name);
  } else {
    inbound = structuredClone(old);
    inbound.listen_port = port;
    if (listen !== undefined) inbound.listen = listen === '::' ? '::' : '0.0.0.0';
    if (inbound.users?.[0]) inbound.users[0].name = name;
    const p = spec.inbound || {};
    if (want === 'vless-reality' && p.sni !== undefined) {
      const sni = String(p.sni || '').trim();
      if (!isHost(sni)) throw fail('REALITY 偽裝網站格式錯誤');
      inbound.tls.server_name = sni;
      inbound.tls.reality.handshake = { ...(inbound.tls.reality.handshake || {}), server: sni, server_port: inbound.tls.reality.handshake?.server_port || 443 };
    }
    if (want === 'shadowsocks' && p.method && p.method !== inbound.method) {
      // 不同加密方式的金鑰長度不同，必須重新產生密碼
      Object.assign(inbound, { method: p.method, password: makeInbound(p, tag, port, name).password });
    }
    if (want === 'vmess-ws' && p.path) {
      if (!/^\/[\w\-./~%]*$/.test(p.path)) throw fail('WebSocket 路徑須以 / 開頭且不含特殊字元');
      inbound.transport.path = p.path;
    }
    if (want === 'trojan' || want === 'hysteria2') {
      const sni = String(p.sni || '').trim();
      if (sni && !isHost(sni)) throw fail('TLS 域名格式錯誤');
      if (sni) inbound.tls.server_name = sni; else delete inbound.tls.server_name;
      Object.assign(inbound.tls, certPaths(p));
    }
  }
  cfg.inbounds[idx] = inbound;

  const exit = spec.exit;
  if (exit && exit.mode && exit.mode !== 'keep') {
    cfg.route = cfg.route || {};
    const rules = Array.isArray(cfg.route.rules) ? cfg.route.rules : [];
    let r = rules.findIndex(x => isDedicated(x, tag) && inboundList(x).length === 1);
    const previous = r >= 0 ? rules[r].outbound : null;
    let outTag;
    if (exit.mode === 'existing') {
      outTag = String(exit.tag || '');
      if (!listOutbounds(cfg).some(o => o.tag === outTag)) throw fail('找不到指定的現有出站');
    } else {
      const { outbound } = buildOutbound(exit);
      const at = previous && MANAGED_OUT.test(previous) ? cfg.outbounds.findIndex(o => o && o.tag === previous) : -1;
      if (at >= 0) {
        outTag = previous;
        cfg.outbounds[at] = { type: outbound.type, tag: outTag, ...outbound };
      } else {
        const tags = new Set([...cfg.inbounds, ...(cfg.outbounds || []), ...(cfg.endpoints || [])].map(x => x && x.tag));
        outTag = tag + '-out';
        for (let n = 2; tags.has(outTag); n++) outTag = `${tag}-out-${n}`;
        cfg.outbounds = cfg.outbounds || [];
        cfg.outbounds.push({ type: outbound.type, tag: outTag, ...outbound });
      }
    }
    if (r >= 0) rules[r] = { ...rules[r], outbound: outTag };
    else {
      // 與其他入站共用的規則：只把此入站抽出來，另建專用規則
      for (const x of rules) if (isDedicated(x, tag)) x.inbound = inboundList(x).filter(t => t !== tag);
      rules.unshift({ inbound: [tag], outbound: outTag });
    }
    cfg.route.rules = rules;
    if (previous && previous !== outTag) pruneOutbound(cfg, previous);
  }
  return { config: cfg, tag, name, port, oldPort: old.listen_port, network: networkOf(inbound), oldNetwork: networkOf(old) };
}

module.exports = { addRelay, removeInbound, updateRelay, relayDetail, kindOf, parseStrict, listOutbounds, realityKeypair, versionAtLeast, INBOUND_TYPES };
