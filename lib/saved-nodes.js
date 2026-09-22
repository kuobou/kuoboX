const crypto = require('node:crypto');
const net = require('node:net');

function parseConfig(text) {
  // Strip comments only outside JSON strings, preserving URLs and escaped quotes.
  const clean = text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, part => part.startsWith('"') ? part : ' ');
  return JSON.parse(clean || '{}');
}

function publicKey(privateKey) {
  const raw = Buffer.from(privateKey || '', 'base64url');
  if (raw.length !== 32) throw new Error('REALITY 私鑰格式錯誤');
  const key = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]), format: 'der', type: 'pkcs8' });
  return crypto.createPublicKey(key).export({ format: 'jwk' }).x;
}

function savedNodes(content, host) {
  if (typeof host !== 'string' || !(net.isIP(host) || /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))) throw new Error('請填入有效的公網 IP 或域名');
  const config = parseConfig(content);
  const authority = net.isIP(host) === 6 ? `[${host}]` : host;
  return (config.inbounds || []).flatMap(inbound => {
    const users = inbound.users?.length ? inbound.users : [inbound];
    return users.map((user, index) => {
      const name = (inbound.tag || inbound.type) + (users.length > 1 ? ` / ${user.name || index + 1}` : '');
      const node = { name, type: inbound.type, port: inbound.listen_port, listen: inbound.listen || '', link: '', error: '' };
      try {
        if (!inbound.listen_port) throw new Error('此入站沒有可匯出的監聽端口');
        if (inbound.transport && inbound.transport.type !== 'ws') throw new Error('此傳輸方式請從完整設定手動匯入');
        if (inbound.tls?.enabled && (inbound.tls.ech?.enabled || inbound.tls.client_authentication)) throw new Error('進階 TLS 設定請手動匯入');
        const tls = inbound.tls || {};
        const reality = tls.enabled && tls.reality?.enabled;
        const params = new URLSearchParams({ type: inbound.transport?.type || 'tcp', security: reality ? 'reality' : tls.enabled ? 'tls' : 'none' });
        if (tls.server_name) params.set('sni', tls.server_name);
        if (tls.alpn?.length) params.set('alpn', tls.alpn.join(','));
        if (inbound.transport?.type === 'ws') {
          if (inbound.transport.max_early_data) throw new Error('WebSocket early data 請手動匯入');
          params.set('path', inbound.transport.path || '/');
          if (inbound.transport.headers?.Host) params.set('host', inbound.transport.headers.Host);
        }
        if (reality) {
          params.set('pbk', publicKey(tls.reality.private_key));
          params.set('sid', tls.reality.short_id?.[0] || '');
          params.set('fp', 'chrome');
        }
        const target = `${authority}:${inbound.listen_port}`;
        if (inbound.type === 'vless' || inbound.type === 'trojan') {
          const credential = inbound.type === 'vless' ? user.uuid : user.password;
          if (!credential) throw new Error('缺少使用者認證資料');
          if (inbound.type === 'vless') { params.set('encryption', 'none'); if (user.flow) params.set('flow', user.flow); }
          node.link = `${inbound.type}://${encodeURIComponent(credential)}@${target}?${params}#${encodeURIComponent(name)}`;
        } else if (inbound.type === 'vmess') {
          if (reality) throw new Error('此 VMess TLS 設定請手動匯入');
          if (!user.uuid) throw new Error('缺少 UUID');
          node.link = 'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: name, add: host, port: String(inbound.listen_port), id: user.uuid, aid: user.alterId || 0, net: inbound.transport?.type || 'tcp', type: 'none', host: inbound.transport?.headers?.Host || '', path: inbound.transport?.path || '', tls: tls.enabled ? 'tls' : '', sni: tls.server_name || '', alpn: (tls.alpn || []).join(',') })).toString('base64');
        } else if (inbound.type === 'shadowsocks') {
          if (inbound.users?.length || !inbound.password || !inbound.method || tls.enabled || inbound.transport) throw new Error('此 Shadowsocks 設定請手動匯入');
          node.link = `ss://${Buffer.from(inbound.method + ':' + inbound.password).toString('base64url')}@${target}#${encodeURIComponent(name)}`;
        } else throw new Error('此協定請使用完整設定匯入客戶端');
      } catch (e) { node.error = e.message; }
      return node;
    });
  });
}
module.exports = { savedNodes, publicKey, parseConfig };
