'use strict';
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const PAGES = ['overview', 'relays', 'config', 'logs', 'settings'];
  const TOKEN_KEY = 'kuobox_token';
  const HOST_KEY = 'kuobox_host';

  const store = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
  };
  const session = {
    get() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } },
    set(v) { try { v ? sessionStorage.setItem(TOKEN_KEY, v) : sessionStorage.removeItem(TOKEN_KEY); } catch {} },
  };

  const state = {
    token: session.get(),
    page: null,
    host: '',
    publicIP: '',
    nodes: [], outbounds: [], editable: true, revision: null, nodesLoaded: false,
    overview: null,
    editorRevision: null, editorLoaded: false, editorDirty: false,
    logLines: 100, logs: '',
    timers: [],
  };

  // ── 小工具 ──────────────────────────────────────────
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) node.append(c.nodeType ? c : String(c));
    return node;
  }
  function icon(id, cls) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    if (cls) svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '#' + id);
    svg.append(use);
    return svg;
  }

  function fmtBytes(b) {
    if (!Number.isFinite(b)) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0;
    while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; }
    return (i === 0 ? b.toFixed(0) : b.toFixed(b >= 100 ? 0 : b >= 10 ? 1 : 2)) + ' ' + u[i];
  }
  function fmtBits(bps) {
    if (!Number.isFinite(bps)) return '—';
    const u = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
    let i = 0;
    while (bps >= 1000 && i < u.length - 1) { bps /= 1000; i++; }
    return (i === 0 ? bps.toFixed(0) : bps.toFixed(bps >= 100 ? 0 : 1)) + ' ' + u[i];
  }
  function fmtDuration(sec) {
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    if (d) return `${d} 天 ${h} 小時`;
    if (h) return `${h} 小時 ${m} 分`;
    return `${m} 分鐘`;
  }
  const pct = (a, b) => (b > 0 ? Math.round(100 * a / b) : 0);

  let toastTimer;
  function toast(msg, type) {
    const t = $('#toast');
    const cls = 'toast' + (type === 'err' ? ' err' : '');
    t.textContent = msg;
    t.className = cls + ' show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = cls; }, type === 'err' ? 4500 : 2400);
  }

  function ask({ title, message = '', ok = '確定', cancel = '取消', destructive = false }) {
    return new Promise(resolve => {
      const box = $('#alert'), okBtn = $('#alert-ok'), cancelBtn = $('#alert-cancel');
      $('#alert-title').textContent = title;
      $('#alert-msg').textContent = message;
      okBtn.textContent = ok;
      okBtn.classList.toggle('destructive', destructive);
      cancelBtn.hidden = cancel === null;
      cancelBtn.textContent = cancel || '';
      box.hidden = false;
      okBtn.focus();
      const done = value => {
        box.hidden = true;
        okBtn.onclick = cancelBtn.onclick = null;
        document.removeEventListener('keydown', onKey, true);
        resolve(value);
      };
      const onKey = e => {
        if (e.key === 'Escape') { e.stopPropagation(); done(false); }
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
      };
      okBtn.onclick = () => done(true);
      cancelBtn.onclick = () => done(false);
      document.addEventListener('keydown', onKey, true);
    });
  }
  const inform = (title, message) => ask({ title, message, ok: '好', cancel: null });

  async function withBusy(btn, fn) {
    if (!btn) return fn();
    if (btn.classList.contains('loading')) return;
    const wasDisabled = btn.disabled;
    btn.classList.add('loading');
    btn.disabled = true;
    try { return await fn(); }
    finally { btn.classList.remove('loading'); btn.disabled = wasDisabled; }
  }

  async function copy(text, msg = '已複製') {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else throw new Error('fallback');
    } catch {
      const ta = el('textarea', { style: 'position:fixed;top:0;left:0;opacity:0', readonly: true });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try { document.execCommand('copy'); } finally { ta.remove(); }
    }
    toast(msg);
  }

  async function api(method, path, body, timeout = 20000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(path, {
        method, cache: 'no-store', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-token': state.token },
        body: body ? JSON.stringify(body) : undefined,
      });
      let data = {};
      try { data = await res.json(); } catch {}
      if (res.status === 401 && path !== '/api/login') {
        signOut('登入已過期，請重新登入');
        throw Object.assign(new Error('登入已過期'), { status: 401 });
      }
      if (!res.ok) throw Object.assign(new Error(data.error || `請求失敗（${res.status}）`), { status: res.status });
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('請求逾時，請檢查網路');
      if (e instanceof TypeError) throw new Error('無法連線到面板');
      throw e;
    } finally { clearTimeout(timer); }
  }

  // ── 登入 ────────────────────────────────────────────
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('#login-pw');
    $('#login-err').textContent = '';
    await withBusy($('#login-btn'), async () => {
      try {
        const d = await api('POST', '/api/login', { password: input.value });
        state.token = d.token;
        session.set(d.token);
        input.value = '';
        enterApp();
      } catch (err) {
        $('#login-err').textContent = err.message;
        input.select();
      }
    });
  });

  function enterApp() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    show(location.hash.slice(1));
    refreshOverview();
    pollTraffic();
    startPolling();
    getPublicIP();
  }

  function signOut(message) {
    state.token = '';
    session.set('');
    stopPolling();
    closeOverlays();
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#login-err').textContent = message || '';
    $('#login-pw').focus();
  }

  function startPolling() {
    stopPolling();
    state.timers.push(setInterval(() => { if (!document.hidden) pollTraffic(); }, 2000));
    state.timers.push(setInterval(() => { if (!document.hidden) refreshOverview(); }, 5000));
    state.timers.push(setInterval(() => { if (!document.hidden && state.page === 'logs' && $('#log-auto').checked) loadLogs(true); }, 3000));
  }
  function stopPolling() { state.timers.forEach(clearInterval); state.timers = []; }

  // ── 導覽 ────────────────────────────────────────────
  const onEnter = {
    overview: () => { refreshOverview(); requestAnimationFrame(drawChart); },
    relays: () => loadNodes(),
    config: () => { if (!state.editorLoaded) loadEditor(); },
    logs: () => loadLogs(),
    settings: () => renderSettings(),
  };
  function show(page) {
    if (!PAGES.includes(page)) page = 'overview';
    if (location.hash !== '#' + page) history.replaceState(null, '', '#' + page);
    state.page = page;
    $$('.page').forEach(p => { p.hidden = p.dataset.page !== page; });
    $$('[data-nav]').forEach(a => {
      const on = a.dataset.nav === page;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    window.scrollTo(0, 0);
    onEnter[page]();
  }
  window.addEventListener('hashchange', () => { if (state.token) show(location.hash.slice(1)); });

  // ── 概覽 ────────────────────────────────────────────
  const STATUS_TEXT = { active: '運行中', inactive: '已停止', failed: '啟動失敗', activating: '啟動中', deactivating: '停止中', unknown: '未知' };

  function setStatus(running, text) {
    const chip = $('#status-chip');
    chip.querySelector('.dot').className = 'dot' + (running === true ? ' on' : running === false ? ' off' : '');
    chip.querySelector('span').textContent = text;
  }

  function meter(id, value) {
    const bar = $('#mt-' + id);
    bar.style.width = Math.max(0, Math.min(100, value)) + '%';
    bar.className = value >= 90 ? 'crit' : value >= 75 ? 'warn' : '';
  }

  async function refreshOverview() {
    try {
      const d = await api('GET', '/api/overview');
      state.overview = d;
      renderOverview(d);
    } catch (e) {
      if (e.status !== 401) setStatus(null, '面板無回應');
    }
  }

  function renderOverview(d) {
    const s = d.service;
    const text = STATUS_TEXT[s.status] || s.status;
    setStatus(s.running, 'sing-box ' + text);
    const hero = $('#hero');
    hero.classList.toggle('on', s.running);
    hero.classList.toggle('off', !s.running);
    $('#hero-title').textContent = s.running ? 'sing-box 運行中' : `sing-box ${text}`;
    $('#hero-sub').textContent = s.version ? `核心版本 ${s.version}` : '未偵測到 sing-box 核心';
    const reason = $('#hero-reason');
    reason.hidden = s.running || !s.reason;
    reason.textContent = s.reason || '';
    const toggle = $('#btn-toggle');
    toggle.textContent = s.running ? '停止' : '啟動';
    toggle.dataset.arg = s.running ? 'stop' : 'start';

    const sys = d.sys;
    $('#st-cpu').textContent = sys.cpu == null ? '—' : Math.round(sys.cpu) + '%';
    $('#st-cpu-foot').textContent = `${sys.cores} 核心`;
    meter('cpu', sys.cpu || 0);
    const memPct = pct(sys.mem.used, sys.mem.total);
    $('#st-mem').textContent = memPct + '%';
    $('#st-mem-foot').textContent = `${fmtBytes(sys.mem.used)} / ${fmtBytes(sys.mem.total)}`;
    meter('mem', memPct);
    if (sys.disk) {
      const diskPct = pct(sys.disk.used, sys.disk.total);
      $('#st-disk').textContent = diskPct + '%';
      $('#st-disk-foot').textContent = `${fmtBytes(sys.disk.used)} / ${fmtBytes(sys.disk.total)}`;
      meter('disk', diskPct);
    }
    $('#st-up').textContent = fmtDuration(sys.uptime);
    $('#st-load').textContent = '負載 ' + sys.load.map(x => x.toFixed(2)).join('  ');
    $('#ov-host').textContent = sys.hostname + (state.publicIP ? ' · ' + state.publicIP : '');
    if (state.page === 'settings') renderSettings();
  }

  // ── 流量圖 ──────────────────────────────────────────
  const CHART_POINTS = 60;
  const chart = { rx: new Array(CHART_POINTS).fill(0), tx: new Array(CHART_POINTS).fill(0), last: null };

  async function pollTraffic() {
    let d;
    try { d = await api('GET', '/api/traffic'); } catch { return; }
    const last = chart.last;
    if (last && last.iface === d.iface && d.timestamp > last.time && d.rx >= last.rx && d.tx >= last.tx) {
      const secs = (d.timestamp - last.time) / 1000;
      const rx = (d.rx - last.rx) / secs, tx = (d.tx - last.tx) / secs;
      chart.rx.push(rx); chart.rx.shift();
      chart.tx.push(tx); chart.tx.shift();
      $('#tr-rx').textContent = fmtBits(rx * 8);
      $('#tr-tx').textContent = fmtBits(tx * 8);
      drawChart();
    }
    chart.last = { rx: d.rx, tx: d.tx, time: d.timestamp, iface: d.iface };
    $('#tr-iface').textContent = '網卡 ' + d.iface;
    $('#tr-total-rx').textContent = fmtBytes(d.rx);
    $('#tr-total-tx').textContent = fmtBytes(d.tx);
  }

  function niceMax(v) {
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp;
    return 10 * exp;
  }

  function drawChart() {
    const c = $('#chart');
    if (!c || state.page !== 'overview') return;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const pad = { t: 8, r: 2, b: 20, l: 70 };
    const cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;
    const maxBits = niceMax(Math.max(...chart.rx, ...chart.tx, 1250) * 8);
    const max = maxBits / 8;
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 3; i++) {
      const y = Math.round(pad.t + ch * i / 3) + .5;
      ctx.strokeStyle = i === 3 ? '#e3e3e8' : '#f0f0f3';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillStyle = '#86868b';
      ctx.textAlign = 'right';
      ctx.fillText(fmtBits(maxBits * (1 - i / 3)), pad.l - 10, y);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('2 分鐘前', pad.l, h - 4);
    ctx.textAlign = 'right';
    ctx.fillText('現在', w - pad.r, h - 4);

    const series = (data, color, fill) => {
      const pts = data.map((v, i) => [pad.l + cw * i / (CHART_POINTS - 1), pad.t + ch - Math.min(1, v / max) * ch]);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        const mx = (x0 + x1) / 2;
        ctx.bezierCurveTo(mx, y0, mx, y1, x1, y1);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.lineTo(pad.l + cw, pad.t + ch);
      ctx.lineTo(pad.l, pad.t + ch);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, pad.t, 0, pad.t + ch);
      g.addColorStop(0, fill);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fill();
    };
    series(chart.tx, '#34c759', 'rgba(52,199,89,.16)');
    series(chart.rx, '#0071e3', 'rgba(0,113,227,.16)');
  }
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawChart, 100); });

  // ── 公網 IP 與連結地址 ─────────────────────────────
  async function getPublicIP() {
    if (state.publicIP) return state.publicIP;
    try { state.publicIP = (await api('GET', '/api/publicip')).ip || ''; } catch {}
    if (state.overview) $('#ov-host').textContent = state.overview.sys.hostname + (state.publicIP ? ' · ' + state.publicIP : '');
    $('#info-ip').textContent = state.publicIP || '偵測失敗';
    return state.publicIP;
  }

  async function resolveHost() {
    if (state.host) return state.host;
    const saved = store.get(HOST_KEY);
    const page = location.hostname.replace(/^\[|\]$/g, '');
    const isDomain = page && !/^[\d.]+$/.test(page) && !page.includes(':') && page !== 'localhost';
    state.host = saved || (isDomain ? page : '') || await getPublicIP() || page;
    return state.host;
  }

  // ── 中轉節點列表 ────────────────────────────────────
  const BADGE = { vless: 'VL', shadowsocks: 'SS', hysteria2: 'HY2', vmess: 'VM', trojan: 'TJ', tuic: 'TU' };

  async function loadNodes(silent) {
    const list = $('#node-list');
    if (!state.nodesLoaded && !silent) list.replaceChildren(el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }));
    await resolveHost();
    $('#host-input').value = state.host;
    try {
      const d = await api('GET', '/api/nodes?host=' + encodeURIComponent(state.host));
      Object.assign(state, { nodes: d.nodes, outbounds: d.outbounds, editable: d.editable, revision: d.revision, nodesLoaded: true });
      renderNodes();
    } catch (e) {
      if (e.status === 401) return;
      state.nodesLoaded = false;
      list.replaceChildren(el('div', { class: 'banner warn', text: e.message }));
    }
    updateRelaySummary();
  }

  function updateRelaySummary() {
    const relays = state.nodes.filter(n => n.target);
    $('#ov-relay-count').textContent = state.nodesLoaded ? (relays.length ? `${relays.length} 條中轉運作中` : '還沒有中轉') : '中轉節點';
    $('#ov-relay-sub').textContent = relays.length
      ? relays.slice(0, 3).map(n => n.name).join('、') + (relays.length > 3 ? ` 等 ${relays.length} 條` : '')
      : '貼上落地機連結，一分鐘完成中轉。';
  }

  function renderNodes() {
    const list = $('#node-list');
    const banner = $('#nodes-banner');
    banner.hidden = state.editable;
    banner.className = 'banner warn';
    banner.textContent = '設定檔含有註解，精靈無法在不遺失註解的情況下修改。新增或刪除節點請到「設定檔」頁面。';
    if (!state.nodes.length) {
      list.replaceChildren(el('div', { class: 'empty' },
        el('div', { class: 'empty-art' }, icon('i-relay')),
        el('h2', { text: '還沒有中轉節點' }),
        el('p', { text: '準備好落地機的分享連結（vless://、ss://、hy2://…），貼上後選擇入口協定，就能產生給客戶端的新連結。' }),
        el('button', { class: 'btn btn-primary', 'data-action': 'new-relay' }, icon('i-plus', 'ico'), '新增第一條中轉')));
      return;
    }
    list.replaceChildren(...state.nodes.map(renderNode));
  }

  function renderNode(n) {
    const t = n.target;
    const route = el('div', { class: 'node-route' },
      el('span', { class: 'pill', text: n.entry || n.type }),
      icon('i-arrow', 'arrow'),
      t ? el('span', { class: 'pill', title: t.tag, text: (t.summary || t.type || t.tag) + (t.server ? ` · ${t.server}:${t.port}` : t.tag && !t.summary ? '' : ` · ${t.tag}`) })
        : el('span', { class: 'pill none', text: '依預設路由' }));
    const actions = el('div', { class: 'node-actions' });
    if (n.link) {
      actions.append(
        el('button', { class: 'icon-btn', title: '複製連結', 'aria-label': '複製連結', onclick: () => copy(n.link, `已複製「${n.name}」連結`) }, icon('i-copy')),
        el('button', { class: 'icon-btn', title: 'QR Code', 'aria-label': 'QR Code', onclick: () => showQR(n.name, n.link) }, icon('i-qr')));
    }
    if (state.editable && n.tag) {
      actions.append(el('button', { class: 'icon-btn danger', title: '刪除', 'aria-label': '刪除', onclick: e => deleteNode(n, e.currentTarget) }, icon('i-trash')));
    }
    const card = el('article', { class: 'node' },
      el('div', { class: 'node-badge b-' + (BADGE[n.type] ? n.type : 'other'), text: BADGE[n.type] || String(n.type || '?').slice(0, 3).toUpperCase() }),
      el('div', { class: 'node-name', title: n.name }, n.name, el('small', { text: n.port ? `:${n.port}` : '' })),
      actions,
      route);
    if (n.error) card.append(el('div', { class: 'node-note', text: n.error }));
    return card;
  }

  async function deleteNode(n, btn) {
    const ok = await ask({
      title: `刪除「${n.name}」？`,
      message: (n.multi ? '此入站包含多個使用者，將整個刪除。\n' : '') + '會移除入口、專用路由與不再使用的落地出站，並重新啟動 sing-box。',
      ok: '刪除', destructive: true,
    });
    if (!ok) return;
    await withBusy(btn, async () => {
      try {
        await api('POST', '/api/nodes/delete', { tag: n.tag, revision: state.revision }, 120000);
        toast('已刪除');
        invalidateEditor();
      } catch (e) { toast(e.message, 'err'); }
      await loadNodes(true);
      refreshOverview();
    });
  }

  $('#host-input').addEventListener('change', e => {
    state.host = e.target.value.trim().replace(/^\[|\]$/g, '');
    store.set(HOST_KEY, state.host);
    loadNodes(true);
  });

  function showQR(name, link) {
    $('#qr-title').textContent = name;
    const ok = window.KQR && window.KQR.draw($('#qr-canvas'), link);
    if (!ok) { toast('連結太長，無法產生 QR Code，請使用複製', 'err'); return; }
    $('#qr-modal').dataset.link = link;
    $('#qr-modal').hidden = false;
  }

  // ── 新增中轉精靈 ────────────────────────────────────
  const wz = { step: 1, mode: 'link', parsed: null, parseSeq: 0, parseTimer: null, inType: 'vless-reality', result: null, previewSeq: 0 };

  function radioValue(groupId) {
    const on = $(`#${groupId} [aria-checked="true"]`);
    return on ? on.dataset.value : '';
  }
  function setRadio(groupId, value) {
    $$(`#${groupId} [role="radio"]`).forEach(b => b.setAttribute('aria-checked', String(b.dataset.value === value)));
  }

  async function openWizard() {
    if (!state.nodesLoaded) await loadNodes(true);
    if (!state.nodesLoaded) { toast('無法讀取目前設定', 'err'); return; }
    if (!state.editable) { toast('設定檔含註解，請在「設定檔」頁面手動新增', 'err'); return; }
    Object.assign(wz, { step: 1, parsed: null, result: null });
    $('#exit-link').value = '';
    $$('#wizard .exit-pane input, #wizard .exit-pane textarea').forEach(i => { if (i.type === 'checkbox') i.checked = false; else i.value = ''; });
    $('#in-name').value = '';
    $('#in-name').placeholder = '例如 香港-01';
    $('#in-port').value = '';
    $('#in-path').value = '';
    $('#in-v6').checked = false;
    $('#preview-wrap').open = false;
    $('#wz-test-result').textContent = '';
    setMode('link');
    setRadio('in-type', 'vless-reality');
    wz.inType = 'vless-reality';
    syncInbound();
    syncManual();
    const sel = $('#exit-existing');
    sel.replaceChildren(...state.outbounds.map(o => el('option', { value: o.tag, text: `${o.tag}（${o.type}${o.server ? ' · ' + o.server + ':' + o.port : ''}）` })));
    if (!state.outbounds.length) sel.append(el('option', { value: '', text: '設定中沒有可用的出站' }));
    renderParsed();
    $('#wizard').hidden = false;
    setStep(1);
    setTimeout(() => $('#exit-link').focus(), 50);
  }

  function closeWizard() {
    $('#wizard').hidden = true;
    if (wz.result) { loadNodes(true); refreshOverview(); }
  }

  function setStep(step) {
    wz.step = step;
    $$('#wizard .wz-step').forEach(s => { s.hidden = Number(s.dataset.step) !== step; });
    $$('#wz-steps i').forEach((d, i) => d.classList.toggle('on', i === step - 1));
    $('#wz-back').hidden = step !== 2;
    $('#wz-title').textContent = step === 3 ? '完成' : '新增中轉';
    const next = $('#wz-next');
    next.textContent = step === 1 ? '下一步' : step === 2 ? '建立中轉' : '完成';
    $('#wz-hint').textContent = step === 2 ? '建立後會重新啟動 sing-box（約 2 秒）' : '';
    $('.sheet-body').scrollTop = 0;
    updateNext();
  }

  function updateNext() {
    const next = $('#wz-next');
    if (wz.step === 1) {
      next.disabled = wz.mode === 'link' ? !(wz.parsed && wz.parsed.ok) : wz.mode === 'existing' ? !$('#exit-existing').value : false;
    } else next.disabled = false;
  }

  function setMode(mode) {
    wz.mode = mode;
    setRadio('exit-mode', mode);
    $$('#wizard .exit-pane').forEach(p => { p.hidden = p.dataset.pane !== mode; });
    wz.parsed = null;
    if (mode === 'link' && $('#exit-link').value.trim()) parseLinkNow();
    renderParsed();
    updateNext();
  }

  function exitSpec() {
    if (wz.mode === 'link') return { mode: 'link', link: $('#exit-link').value.trim() };
    if (wz.mode === 'existing') return { mode: 'existing', tag: $('#exit-existing').value };
    return {
      mode: 'manual', protocol: $('#m-protocol').value, server: $('#m-server').value.trim(), port: $('#m-port').value.trim(),
      credential: $('#m-cred').value.trim(), method: $('#m-method').value, security: manualSecurity(), network: $('#m-network').value,
      sni: $('#m-sni').value.trim(), path: $('#m-path').value.trim(), host: $('#m-host').value.trim(),
      pbk: $('#m-pbk').value.trim(), sid: $('#m-sid').value.trim(), flow: $('#m-flow').checked, insecure: $('#m-insecure').checked,
    };
  }

  async function parseLinkNow() {
    const link = $('#exit-link').value.trim();
    const seq = ++wz.parseSeq;
    if (!link) { wz.parsed = null; renderParsed(); updateNext(); return; }
    try {
      const d = await api('POST', '/api/parse-link', { mode: 'link', link });
      if (seq !== wz.parseSeq) return;
      wz.parsed = { ok: true, ...d };
      if (!$('#in-name').value && d.name) $('#in-name').placeholder = d.name;
    } catch (e) {
      if (seq !== wz.parseSeq) return;
      wz.parsed = { ok: false, error: e.message };
    }
    renderParsed();
    updateNext();
  }

  function renderParsed() {
    const box = $('#exit-parsed');
    const p = wz.parsed;
    if (!p) { box.hidden = true; return; }
    box.hidden = false;
    box.className = 'parsed' + (p.ok ? '' : ' err');
    if (p.ok) {
      const ob = p.outbound;
      box.replaceChildren(icon('i-check'), el('div', {},
        el('b', { text: p.name ? `${p.name} · ${p.summary}` : p.summary }),
        el('span', { class: 'mono', text: `${ob.server}:${ob.server_port}` })));
    } else box.replaceChildren(el('div', { text: p.error }));
  }

  function manualSecurity() {
    const proto = $('#m-protocol').value;
    if (proto === 'hysteria2' || proto === 'tuic') return 'tls';
    if (!['vless', 'vmess', 'trojan'].includes(proto)) return 'none';
    return $('#m-security').value;
  }

  function syncManual() {
    const proto = $('#m-protocol').value;
    const secSel = $('#m-security');
    const realityOpt = secSel.querySelector('[data-only="vless"]');
    realityOpt.hidden = proto !== 'vless';
    if (proto !== 'vless' && secSel.value === 'reality') secSel.value = 'tls';
    if (proto === 'trojan' && secSel.dataset.proto !== 'trojan') secSel.value = 'tls';
    secSel.dataset.proto = proto;
    const sec = manualSecurity();
    const net = ['vless', 'vmess', 'trojan'].includes(proto) ? $('#m-network').value : '';
    const tokens = new Set([proto]);
    if (sec === 'tls' || sec === 'reality') tokens.add('tls');
    if (sec === 'tls') tokens.add('tlsonly');
    if (sec === 'reality') tokens.add('reality');
    if (net) tokens.add(net);
    if (proto === 'vless' && net === 'tcp' && sec !== 'none') tokens.add('vless-tcp');
    $$('#wizard [data-show]').forEach(n => { n.hidden = !n.dataset.show.split(' ').some(t => tokens.has(t)); });
    $('#m-cred-label').textContent = { vless: 'UUID', vmess: 'UUID', tuic: 'UUID:密碼', socks: '帳號:密碼（選填）' }[proto] || '密碼';
    $('#m-path-label').textContent = net === 'grpc' ? 'Service Name' : '路徑';
  }

  function syncInbound() {
    const type = wz.inType;
    $$('#wizard [data-in]').forEach(n => { n.hidden = !n.dataset.in.split(' ').includes(type); });
    $('#in-sni-custom-wrap').hidden = type !== 'vless-reality' || $('#in-sni').value !== '__custom';
  }

  function relaySpec() {
    const type = wz.inType;
    const inbound = { type, listen: $('#in-v6').checked ? '::' : '0.0.0.0' };
    if (type === 'vless-reality') inbound.sni = $('#in-sni').value === '__custom' ? $('#in-sni-custom').value.trim() : $('#in-sni').value;
    if (type === 'shadowsocks') inbound.method = $('#in-method').value;
    if (type === 'vmess-ws') inbound.path = $('#in-path').value.trim();
    if (type === 'trojan' || type === 'hysteria2') {
      inbound.sni = $('#in-tls-sni').value.trim();
      inbound.certificate_path = $('#in-cert').value.trim();
      inbound.key_path = $('#in-key').value.trim();
    }
    const port = $('#in-port').value.trim();
    // 名稱留空時由伺服器沿用落地機連結的名稱
    return { name: $('#in-name').value.trim(), port: port || null, inbound, exit: exitSpec() };
  }

  async function wizardNext(btn) {
    if (wz.step === 1) {
      if (wz.mode === 'link' && !(wz.parsed && wz.parsed.ok)) { await parseLinkNow(); if (!wz.parsed || !wz.parsed.ok) return; }
      if (wz.mode === 'manual') {
        await withBusy(btn, async () => {
          try {
            const d = await api('POST', '/api/parse-link', exitSpec());
            wz.parsed = { ok: true, ...d };
          } catch (e) { wz.parsed = { ok: false, error: e.message }; }
        });
        renderParsed();
        if (!wz.parsed.ok) return;
      }
      if (wz.mode === 'existing' && !$('#exit-existing').value) return;
      setStep(2);
      return;
    }
    if (wz.step === 2) {
      await withBusy(btn, async () => {
        try {
          const d = await api('POST', '/api/nodes', { relay: relaySpec(), revision: state.revision, host: state.host }, 120000);
          state.revision = d.revision;
          wz.result = d;
          invalidateEditor();
          renderDone(d);
          setStep(3);
        } catch (e) {
          if (e.status === 409 && /變更/.test(e.message)) await loadNodes(true);
          await inform('無法建立中轉', e.message);
        }
      });
      return;
    }
    closeWizard();
  }

  function renderDone(d) {
    const n = d.node;
    const protoText = d.network === 'tcp+udp' ? 'TCP 與 UDP' : d.network.toUpperCase();
    $('#done-sub').textContent = n ? `${n.name} · ${n.entry} · 端口 ${d.port}` : `端口 ${d.port}`;
    $('#done-link').value = n?.link || '';
    const canvas = $('#done-qr');
    canvas.parentElement.hidden = !(n?.link && window.KQR && window.KQR.draw(canvas, n.link));
    $('#done-link').parentElement.hidden = !n?.link;
    const fw = d.firewall || {};
    const box = $('#done-fw');
    const cloud = `若 VPS 供應商有安全組／防火牆（例如 AWS、GCP、Oracle、阿里雲），請在後台開放 ${protoText} ${d.port}。`;
    if (fw.kind && fw.ok) { box.className = 'banner ok'; box.textContent = `已自動在 ${fw.kind} 放行 ${protoText} ${d.port}。${cloud}`; }
    else if (fw.kind) { box.className = 'banner warn'; box.textContent = `自動放行 ${fw.kind} 失敗，請手動開放 ${protoText} ${d.port}。${cloud}`; }
    else { box.className = 'banner'; box.textContent = cloud; }
    if (!n?.link && n?.error) { box.className = 'banner warn'; box.textContent = n.error + '。' + box.textContent; }
  }

  async function loadPreview() {
    const code = $('#preview-code');
    const seq = ++wz.previewSeq;
    code.textContent = '產生中…';
    try {
      const d = await api('POST', '/api/nodes', { relay: relaySpec(), revision: state.revision, dryRun: true });
      if (seq === wz.previewSeq) code.textContent = d.config;
    } catch (e) { if (seq === wz.previewSeq) code.textContent = e.message; }
  }

  async function testExit(btn) {
    const out = $('#wz-test-result');
    let target = null;
    if (wz.mode === 'existing') {
      const o = state.outbounds.find(x => x.tag === $('#exit-existing').value);
      if (o && o.server) target = { server: o.server, port: o.port, type: o.type };
    } else {
      if (wz.mode === 'manual' || !(wz.parsed && wz.parsed.ok)) {
        try { wz.parsed = { ok: true, ...(await api('POST', '/api/parse-link', exitSpec())) }; }
        catch (e) { wz.parsed = { ok: false, error: e.message }; }
        renderParsed(); updateNext();
      }
      if (wz.parsed && wz.parsed.ok) target = { server: wz.parsed.outbound.server, port: wz.parsed.outbound.server_port, type: wz.parsed.outbound.type };
    }
    if (!target) { out.textContent = '沒有可測試的地址'; out.className = 'small warn-text'; return; }
    const udp = ['hysteria2', 'tuic'].includes(target.type);
    out.className = 'small muted';
    out.textContent = '測試中…';
    await withBusy(btn, async () => {
      try {
        const d = await api('POST', '/api/test', { host: target.server, port: udp ? '' : target.port }, 30000);
        const ping = d.ping.ok ? `Ping ${d.ping.avg != null ? d.ping.avg.toFixed(0) + ' ms' : '通'}` : 'Ping 無回應';
        if (udp) { out.textContent = `${ping}（UDP 協定無法以 TCP 測試端口）`; out.className = 'small ' + (d.ping.ok ? 'ok-text' : 'warn-text'); }
        else if (d.tcp.ok) { out.textContent = `✓ 端口可連線 ${d.tcp.ms} ms · ${ping}`; out.className = 'small ok-text'; }
        else { out.textContent = `✕ 端口無法連線（${d.tcp.error || '失敗'}）· ${ping}`; out.className = 'small bad-text'; }
      } catch (e) { out.textContent = e.message; out.className = 'small bad-text'; }
    });
  }

  $('#exit-link').addEventListener('input', () => {
    clearTimeout(wz.parseTimer);
    wz.parsed = null;
    updateNext();
    wz.parseTimer = setTimeout(parseLinkNow, 350);
  });
  $('#exit-link').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#wz-next').click(); } });
  ['#m-protocol', '#m-security', '#m-network'].forEach(s => $(s).addEventListener('change', syncManual));
  $$('#wizard .exit-pane[data-pane="manual"] input').forEach(i => i.addEventListener('input', () => { if (wz.parsed) { wz.parsed = null; renderParsed(); } }));
  $('#exit-existing').addEventListener('change', updateNext);
  $('#in-sni').addEventListener('change', syncInbound);
  $('#preview-wrap').addEventListener('toggle', e => { if (e.target.open) loadPreview(); });

  // ── 設定檔 ──────────────────────────────────────────
  const editor = $('#editor');
  function setDirty(dirty) { state.editorDirty = dirty; $('#cfg-dirty').hidden = !dirty; }
  function invalidateEditor() { if (!state.editorDirty) state.editorLoaded = false; }

  async function loadEditor() {
    try {
      const d = await api('GET', '/api/config');
      editor.value = d.config;
      editor.placeholder = d.config.trim() ? '' : '目前沒有設定檔。建議先到「中轉節點」用精靈建立，或直接貼上完整的 sing-box 設定。';
      state.editorRevision = d.revision;
      state.editorLoaded = true;
      $('#cfg-path').textContent = d.path;
      setDirty(false);
    } catch (e) { if (e.status !== 401) toast(e.message, 'err'); }
  }

  editor.addEventListener('input', () => setDirty(true));
  editor.addEventListener('keydown', e => {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: end } = editor;
      editor.setRangeText('  ', s, end, 'end');
      setDirty(true);
    }
  });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && state.page === 'config' && !$('#app').hidden) {
      e.preventDefault();
      saveEditor($('[data-action="config-save"]'));
    }
    if (e.key === 'Escape') {
      if (!$('#qr-modal').hidden) $('#qr-modal').hidden = true;
      else if (!$('#wizard').hidden && !$('#wz-next').classList.contains('loading')) closeWizard();
    }
  });
  window.addEventListener('beforeunload', e => { if (state.editorDirty) { e.preventDefault(); e.returnValue = ''; } });

  async function saveEditor(btn) {
    const config = editor.value;
    if (!config.trim()) { toast('設定不得為空', 'err'); return; }
    if (!await ask({ title: '儲存並套用設定？', message: '會先由 sing-box 驗證，接著重新啟動服務；啟動失敗會自動還原。', ok: '套用' })) return;
    await withBusy(btn, async () => {
      try {
        const d = await api('POST', '/api/config', { config, revision: state.editorRevision }, 120000);
        state.editorRevision = d.revision;
        setDirty(false);
        state.nodesLoaded = false;
        toast('已套用，sing-box 已重新啟動');
        refreshOverview();
      } catch (e) { await inform('套用失敗', e.message); }
    });
  }

  // ── 日誌 ────────────────────────────────────────────
  async function loadLogs(silent) {
    try {
      state.logs = (await api('GET', '/api/logs?lines=' + state.logLines)).logs;
      renderLogs();
    } catch (e) {
      if (!silent && e.status !== 401) {
        state.logs = '';
        $('#log-view').replaceChildren(el('div', { class: 'log-empty', text: e.message }));
      }
    }
  }

  function renderLogs() {
    const view = $('#log-view');
    const stick = view.scrollHeight - view.scrollTop - view.clientHeight < 60 || !view.childElementCount;
    const q = $('#log-filter').value.trim().toLowerCase();
    const lines = state.logs.split('\n').filter(l => l && (!q || l.toLowerCase().includes(q)));
    if (!lines.length) { view.replaceChildren(el('div', { class: 'log-empty', text: q ? '沒有符合的日誌' : '目前沒有日誌' })); return; }
    const frag = document.createDocumentFragment();
    for (const line of lines) {
      const m = /^\d{4}-\d\d-\d\dT(\d\d:\d\d:\d\d)\S*\s+\S+\s+(.*)$/.exec(line);
      const msg = m ? m[2] : line;
      const cls = /\b(error|fatal|panic)\b/i.test(msg) ? ' err' : /\bwarn(ing)?\b/i.test(msg) ? ' warn' : '';
      frag.append(el('div', { class: 'log-line' + cls }, m ? el('span', { class: 't', text: m[1] }) : null, msg));
    }
    view.replaceChildren(frag);
    if (stick) view.scrollTop = view.scrollHeight;
  }
  $('#log-filter').addEventListener('input', renderLogs);

  // ── 設定頁 ──────────────────────────────────────────
  function renderSettings() {
    const d = state.overview;
    if (d) {
      $('#info-panel').textContent = d.panel.version;
      $('#info-core').textContent = d.service.version || '未偵測到';
      $('#info-host').textContent = d.sys.hostname;
    }
    $('#info-ip').textContent = state.publicIP || '—';
  }

  $('#test-form').addEventListener('submit', async e => {
    e.preventDefault();
    const box = $('#test-result');
    const host = $('#test-host').value.trim();
    if (!host) { toast('請輸入地址', 'err'); return; }
    await withBusy(e.submitter || $('#test-form button'), async () => {
      box.hidden = false;
      box.replaceChildren(el('span', { class: 'muted', text: '測試中…' }));
      try {
        const d = await api('POST', '/api/test', { host, port: $('#test-port').value.trim() }, 30000);
        const items = [el('span', {}, 'ICMP ', d.ping.ok
          ? el('span', { class: 'ok-text', text: d.ping.avg != null ? d.ping.avg.toFixed(1) + ' ms' : '可達' })
          : el('span', { class: 'warn-text', text: '無回應（可能被封鎖）' }))];
        if (d.tcp) items.push(el('span', {}, `TCP ${d.tcp.port} `, d.tcp.ok
          ? el('span', { class: 'ok-text', text: `可連線 ${d.tcp.ms} ms` })
          : el('span', { class: 'bad-text', text: d.tcp.error || '無法連線' })));
        box.replaceChildren(...items);
      } catch (err) { box.replaceChildren(el('span', { class: 'bad-text', text: err.message })); }
    });
  });

  $('#pw-form').addEventListener('submit', async e => {
    e.preventDefault();
    const pw = $('#pw-new').value, again = $('#pw-confirm').value;
    if (pw.length < 12) { toast('密碼至少需要 12 個字元', 'err'); return; }
    if (pw !== again) { toast('兩次輸入的密碼不一致', 'err'); return; }
    await withBusy(e.submitter, async () => {
      try {
        await api('POST', '/api/password', { password: pw });
        $('#pw-new').value = $('#pw-confirm').value = '';
        signOut('密碼已更新，請使用新密碼登入');
      } catch (err) { toast(err.message, 'err'); }
    });
  });

  function closeOverlays() { $$('.overlay').forEach(o => { o.hidden = true; }); }

  // ── 事件委派 ────────────────────────────────────────
  const actions = {
    'new-relay': () => openWizard(),
    'reload-nodes': btn => withBusy(btn, () => loadNodes(true)),
    service: btn => serviceAction(btn, btn.dataset.arg),
    'service-toggle': btn => serviceAction(btn, btn.dataset.arg || 'stop'),
    'wz-close': () => closeWizard(),
    'wz-back': () => setStep(1),
    'wz-next': btn => wizardNext(btn),
    'wz-test': btn => testExit(btn),
    'random-port': () => {
      const used = new Set(state.nodes.map(n => n.port));
      let p;
      do { p = 20000 + Math.floor(Math.random() * 40000); } while (used.has(p));
      $('#in-port').value = p;
    },
    'gen-cert': btn => withBusy(btn, async () => {
      try {
        const d = await api('POST', '/api/cert', { domain: $('#in-tls-sni').value.trim() || 'www.bing.com' }, 30000);
        $('#in-cert').value = d.certificate_path;
        $('#in-key').value = d.key_path;
        toast('已產生自簽憑證');
      } catch (e) { toast(e.message, 'err'); }
    }),
    'done-copy': () => copy($('#done-link').value, '已複製節點連結'),
    'qr-close': () => { $('#qr-modal').hidden = true; },
    'qr-copy': () => copy($('#qr-modal').dataset.link || '', '已複製節點連結'),
    'config-reload': async () => {
      if (state.editorDirty && !await ask({ title: '放棄未儲存的變更？', ok: '放棄', destructive: true })) return;
      await loadEditor();
      toast('已重新讀取');
    },
    'config-format': () => {
      try { editor.value = JSON.stringify(JSON.parse(editor.value), null, 2) + '\n'; setDirty(true); }
      catch { toast('含註解或格式錯誤的設定無法自動格式化', 'err'); }
    },
    'config-check': btn => withBusy(btn, async () => {
      try { await api('POST', '/api/config/check', { config: editor.value }, 60000); toast('✓ 設定有效'); }
      catch (e) { await inform('驗證未通過', e.message); }
    }),
    'config-backup': async btn => {
      if (state.editorDirty && !await ask({ title: '以上一版覆蓋編輯器內容？', message: '目前未儲存的變更會遺失。', ok: '載入', destructive: true })) return;
      await withBusy(btn, async () => {
        try {
          editor.value = (await api('GET', '/api/config/backup')).config;
          setDirty(true);
          toast('已載入上一版，確認後按「儲存並套用」');
        } catch (e) { toast(e.message, 'err'); }
      });
    },
    'config-save': btn => saveEditor(btn),
    'logs-reload': btn => withBusy(btn, () => loadLogs()),
    logout: async () => {
      try { await api('POST', '/api/logout'); } catch {}
      signOut('');
    },
  };

  async function serviceAction(btn, action) {
    const names = { start: '啟動', stop: '停止', restart: '重新啟動' };
    if (action === 'stop' && !await ask({ title: '停止 sing-box？', message: '所有中轉連線都會中斷，直到再次啟動。', ok: '停止', destructive: true })) return;
    await withBusy(btn, async () => {
      try {
        await api('POST', '/api/service', { action }, 60000);
        toast(`已${names[action]}`);
      } catch (e) { await inform(`${names[action]}失敗`, e.message); }
      await refreshOverview();
    });
  }

  document.addEventListener('click', e => {
    const radio = e.target.closest('[role="radio"]');
    if (radio) {
      const group = radio.parentElement;
      $$('[role="radio"]', group).forEach(b => b.setAttribute('aria-checked', String(b === radio)));
      if (group.id === 'exit-mode') setMode(radio.dataset.value);
      if (group.id === 'in-type') { wz.inType = radio.dataset.value; syncInbound(); if ($('#preview-wrap').open) loadPreview(); }
      if (group.id === 'log-lines') { state.logLines = Number(radio.dataset.value); loadLogs(); }
      return;
    }
    const target = e.target.closest('[data-action]');
    if (target && actions[target.dataset.action]) { e.preventDefault(); actions[target.dataset.action](target, e); return; }
    if (e.target.classList.contains('overlay') && e.target.id === 'qr-modal') e.target.hidden = true;
  });

  // ── 啟動 ────────────────────────────────────────────
  try { localStorage.removeItem('relay_token'); sessionStorage.removeItem('relay_token'); } catch {}
  if (state.token) enterApp();
  else $('#login-pw').focus();
})();
