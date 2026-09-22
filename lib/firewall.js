'use strict';
// 盡力而為的主機防火牆放行：ufw → firewalld → iptables（僅在存在拒絕規則時）。
// 雲端安全組（AWS、GCP、Oracle 等）無法由主機設定，需在供應商後台開放。

function protocols(network) {
  return network === 'tcp+udp' ? ['tcp', 'udp'] : [network === 'udp' ? 'udp' : 'tcp'];
}

async function detect(run) {
  const ufw = await run('ufw', ['status']);
  if (ufw.ok && /Status:\s*active/i.test(ufw.stdout)) return 'ufw';
  const fwd = await run('firewall-cmd', ['--state']);
  if (fwd.ok && fwd.stdout.trim() === 'running') return 'firewalld';
  const ipt = await run('iptables', ['-S', 'INPUT']);
  if (ipt.ok && /(^-P INPUT DROP)|(-j (REJECT|DROP)\b)/m.test(ipt.stdout)) return 'iptables';
  return null;
}

async function changePort(run, port, network, open) {
  const kind = await detect(run);
  if (!kind) return { kind: null, ok: true };
  let ok = true;
  for (const proto of protocols(network)) {
    const spec = `${port}/${proto}`;
    let r;
    if (kind === 'ufw') r = await run('ufw', open ? ['allow', spec] : ['delete', 'allow', spec]);
    else if (kind === 'firewalld') {
      r = await run('firewall-cmd', ['--permanent', open ? '--add-port' : '--remove-port', spec]);
      if (r.ok) r = await run('firewall-cmd', [open ? '--add-port' : '--remove-port', spec]);
    } else {
      const rule = ['INPUT', '-p', proto, '--dport', String(port), '-j', 'ACCEPT'];
      const exists = (await run('iptables', ['-C', ...rule])).ok;
      if (open && !exists) r = await run('iptables', ['-I', ...rule]);
      else if (!open && exists) r = await run('iptables', ['-D', ...rule]);
      else r = { ok: true };
    }
    ok = ok && r.ok;
  }
  if (kind === 'iptables') await run('netfilter-persistent', ['save']);
  return { kind, ok };
}

module.exports = {
  openPort: (run, port, network) => changePort(run, port, network, true),
  closePort: (run, port, network) => changePort(run, port, network, false),
};
