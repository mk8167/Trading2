/* ------------------------------------------------------------------
 * hud.js — ISOLATED-world content script.
 *
 * Two jobs:
 *   1. Relay the MAIN-world bridge's frames to the service worker, in
 *      batches, so a chatty socket does not flood the message channel.
 *   2. Draw the floating heads-up display. Everything lives inside a
 *      shadow root, so the host page's CSS can never break the layout and
 *      ours can never leak into the page.
 * ----------------------------------------------------------------*/
(() => {
  if (window.__QSYNC_HUD_V6__) return;
  window.__QSYNC_HUD_V6__ = true;

  const NS = '__qsync_v6';
  const FLUSH_MS = 400;
  const MAX_BATCH = 60;

  /* --------------------------- frame relay -------------------------- */

  const queue = [];
  let flushTimer = null;

  function flush() {
    flushTimer = null;
    if (!queue.length) return;
    const frames = queue.splice(0, queue.length);
    try {
      chrome.runtime.sendMessage({ cmd: 'feed.batch', frames }, () => void chrome.runtime.lastError);
    } catch (e) {
      /* extension reloaded — the queue is disposable */
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d[NS] !== 1) return;
    if (d.kind === 'frame') {
      // The bridge relays both halves of the conversation. Only the server's
      // half is market data: the page's own outbound frames (subscriptions,
      // auth, a history request that happens to look like a tick row) used to
      // be queued here as if they had arrived from the broker.
      if (d.dir === 'out') return;
      queue.push({ text: d.text, b64: d.b64, binary: !!d.binary, url: d.url });
      if (queue.length >= MAX_BATCH) flush();
      else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
    } else if (d.kind === 'hello') {
      try {
        chrome.runtime.sendMessage({ cmd: 'feed.ping', url: d.href }, () => void chrome.runtime.lastError);
      } catch (e) {}
    } else if (d.kind === 'socket') {
      try {
        chrome.runtime.sendMessage({ cmd: 'feed.socket', url: d.url }, () => void chrome.runtime.lastError);
      } catch (e) {}
    }
  });

  /* ------------------------------ UI -------------------------------- */

  let host = null;
  let root = null;
  let el = {};
  let state = null;
  let visible = true;
  let compact = false;
  let side = 'right';

  const DIR_STYLE = {
    up: { bg: 'linear-gradient(135deg,#0c3a20,#0a2417)', fg: '#3ddc84', label: '▲ CALL / UP' },
    down: { bg: 'linear-gradient(135deg,#3d1013,#26090b)', fg: '#ff5c6c', label: '▼ PUT / DOWN' },
    veto: { bg: 'linear-gradient(135deg,#3a2f0c,#241d07)', fg: '#f5c33b', label: '⛔ BLOCKED' },
    none: { bg: 'linear-gradient(135deg,#1b2430,#131a23)', fg: '#8ea0b5', label: '— NO EDGE' },
    wait: { bg: 'linear-gradient(135deg,#1b2430,#131a23)', fg: '#8ea0b5', label: '⏳ WARMING UP' },
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .panel {
      position: fixed; top: 14px; width: 296px; z-index: 2147483647;
      background: rgba(11,17,24,.96); border: 1px solid #223040; border-radius: 14px;
      color: #e7eef6; font: 12px/1.45 "Segoe UI", system-ui, -apple-system, sans-serif;
      box-shadow: 0 18px 48px rgba(0,0,0,.6); backdrop-filter: blur(10px);
      user-select: none; overflow: hidden;
    }
    .panel.left { left: 14px; } .panel.right { right: 14px; }
    .bar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; cursor: grab;
           background: linear-gradient(180deg,#131d28,#0e161f); border-bottom: 1px solid #1d2937; }
    .bar:active { cursor: grabbing; }
    .logo { font-weight: 700; font-size: 12px; letter-spacing: .3px; flex: 1; white-space: nowrap; }
    .logo b { color: #4ea1ff; }
    .ico { cursor: pointer; color: #7c8ca0; font-size: 13px; padding: 0 3px; line-height: 1; }
    .ico:hover { color: #fff; }
    .body { padding: 10px; }
    .src { display: flex; justify-content: space-between; align-items: center; font-size: 10px;
           color: #7c8ca0; margin-bottom: 8px; }
    .badge { padding: 1px 6px; border-radius: 20px; font-weight: 700; font-size: 9.5px; letter-spacing: .4px; }
    .live { background: #0d3320; color: #3ddc84; } .idle { background: #33260d; color: #f5c33b; }
    .dead { background: #331010; color: #ff5c6c; }
    .sig { border-radius: 11px; padding: 12px 10px; text-align: center; margin-bottom: 8px;
           border: 1px solid rgba(255,255,255,.06); transition: background .25s; }
    .sig .d { font-size: 19px; font-weight: 800; letter-spacing: .8px; display: block; }
    .sig .w { font-size: 10px; color: #a8b7c8; margin-top: 3px; display: block; min-height: 13px;
              overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meter { height: 6px; border-radius: 4px; background: #0a0f15; overflow: hidden; margin-top: 8px; }
    .meter i { display: block; height: 100%; width: 0; background: currentColor; transition: width .3s; }
    .row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .clock { font-variant-numeric: tabular-nums; font-weight: 700; color: #4ea1ff; min-width: 42px; font-size: 13px; }
    .bar2 { flex: 1; height: 8px; background: #0a0f15; border-radius: 4px; overflow: hidden; display: flex; }
    .bar2 i { height: 100%; } .up2 { background: #3ddc84; } .dn2 { background: #ff5c6c; flex: 1; }
    .price { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
    .price b { font-size: 17px; font-variant-numeric: tabular-nums; letter-spacing: .3px; }
    .price span { font-size: 10px; color: #7c8ca0; }
    canvas { width: 100%; height: 62px; background: #080d13; border-radius: 9px; display: block; margin-bottom: 8px; }
    .stats { display: flex; justify-content: space-between; font-size: 10px; color: #7c8ca0; margin-bottom: 8px; }
    .stats b { color: #cfe0f0; }
    .btn { display: block; width: 100%; padding: 7px; border: 1px solid #26374a; border-radius: 8px;
           background: #14202c; color: #bcd2e8; font: 600 11px "Segoe UI", system-ui, sans-serif;
           cursor: pointer; text-align: center; }
    .btn:hover { background: #1b2b3a; color: #fff; }
    .ticket { font-size: 10.5px; color: #f5c33b; margin-bottom: 8px; min-height: 14px; }
    .collapsed .body { display: none; }
    .hidden { display: none !important; }
    .warn { font-size: 10px; color: #7c8ca0; text-align: center; padding: 14px 6px; }
  `;

  const HTML = `
    <div class="panel right" part="panel">
      <div class="bar" id="bar">
        <span class="logo">⚡ <b>Q-Sync</b> Pro</span>
        <span class="ico" id="flip" title="Move panel">⇄</span>
        <span class="ico" id="fold" title="Collapse">–</span>
        <span class="ico" id="shut" title="Hide HUD">✕</span>
      </div>
      <div class="body" id="body">
        <div class="src"><span id="pair">—</span><span class="badge idle" id="srcb">NO FEED</span></div>
        <div class="sig" id="sig"><span class="d" id="sigd">⏳</span><span class="w" id="sigw">waiting for data…</span>
          <div class="meter"><i id="conf"></i></div></div>
        <div class="row"><span class="clock" id="clk">--</span>
          <div class="bar2"><i class="up2" id="mup" style="width:0%"></i><i class="dn2"></i></div>
          <span style="font-size:10px;color:#7c8ca0;min-width:34px;text-align:right" id="confv">—</span></div>
        <div class="price"><b id="px">—</b><span id="meta"></span></div>
        <canvas id="spark"></canvas>
        <div class="ticket" id="ticket"></div>
        <div class="stats"><span>W/L <b id="wl">—</b></span><span>Edge <b id="edge">—</b></span><span>Exp <b id="exp">—</b></span></div>
        <div class="btn" id="dash">Open dashboard ⧉</div>
      </div>
      <div class="warn hidden" id="warn"></div>
    </div>`;

  function build() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'qsync-hud-host';
    host.style.cssText = 'all:initial;position:static;z-index:2147483647';
    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    const wrap = document.createElement('div');
    wrap.innerHTML = HTML;
    root.appendChild(wrap.firstElementChild);

    el = {};
    for (const id of ['panel', 'bar', 'body', 'pair', 'srcb', 'sig', 'sigd', 'sigw', 'conf', 'clk', 'mup', 'confv',
      'px', 'meta', 'spark', 'ticket', 'wl', 'edge', 'exp', 'dash', 'warn', 'flip', 'fold', 'shut']) {
      el[id] = root.getElementById(id) || root.querySelector('.panel');
    }
    el.panel = root.querySelector('.panel');

    el.dash.addEventListener('click', () => {
      chrome.runtime.sendMessage({ cmd: 'feed.ping' }, () => void chrome.runtime.lastError);
      chrome.runtime.sendMessage({ cmd: 'ui.openPanel' }, () => void chrome.runtime.lastError);
    });
    el.shut.addEventListener('click', () => setVisible(false));
    el.fold.addEventListener('click', () => {
      setCompact(!compact);
      chrome.runtime.sendMessage({ cmd: 'settings.patch', patch: { hud: { compact } } }, () => void chrome.runtime.lastError);
    });
    el.flip.addEventListener('click', () => {
      side = side === 'right' ? 'left' : 'right';
      applySide();
      chrome.runtime.sendMessage({ cmd: 'settings.patch', patch: { hud: { side } } }, () => void chrome.runtime.lastError);
    });
    makeDraggable(el.bar, el.panel);
    (document.body || document.documentElement).appendChild(host);
  }

  function applySide() {
    if (!el.panel) return;
    el.panel.classList.toggle('left', side === 'left');
    el.panel.classList.toggle('right', side === 'right');
  }

  /* settings.hud.compact was persisted and then never read, so a collapsed HUD
   * came back expanded on every page load. */
  function setCompact(on) {
    compact = !!on;
    if (!el.panel) return;
    el.panel.classList.toggle('collapsed', compact);
    if (el.fold) el.fold.textContent = compact ? '+' : '–';
  }

  function setVisible(v) {
    visible = v;
    if (host) host.style.display = v ? '' : 'none';
    chrome.runtime.sendMessage({ cmd: 'settings.patch', patch: { hud: { enabled: v } } }, () => void chrome.runtime.lastError);
  }

  function makeDraggable(handle, panel) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('ico')) return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      panel.style.right = 'auto';
      panel.classList.remove('left', 'right');
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      panel.style.left = Math.max(4, Math.min(window.innerWidth - 120, ox + e.clientX - sx)) + 'px';
      panel.style.top = Math.max(4, Math.min(window.innerHeight - 60, oy + e.clientY - sy)) + 'px';
    });
    handle.addEventListener('pointerup', () => (dragging = false));
    handle.addEventListener('pointercancel', () => (dragging = false));
  }

  /* ---------------------------- rendering ---------------------------- */

  const fmt = (p) => {
    if (!Number.isFinite(p)) return '—';
    const a = Math.abs(p);
    return p.toFixed(a >= 1000 ? 2 : a >= 100 ? 3 : a >= 10 ? 4 : 5);
  };
  /* Mirrors symbols.js. This file runs as a classic content script, not a
   * module, so it cannot import the shared formatter; the quote table has to
   * be duplicated here. Longest match first, so BTCUSDT splits as
   * BTC/USDT and not BTCU/SDT, and names of any length work instead of only
   * the six-character forex case. */
  const QUOTES = ['USDT', 'USDC', 'BUSD', 'TUSD', 'FDUSD', 'DAI', 'USD', 'EUR', 'GBP',
    'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK', 'TRY', 'ZAR', 'MXN', 'SGD', 'HKD',
    'PLN', 'BTC', 'ETH', 'BNB', 'SOL', 'XRP'];
  const pretty = (s) => {
    if (!s) return '—';
    const raw = String(s).trim();
    const u = raw.toUpperCase().replace(/[\s/\-.]/g, '');
    const otc = u.endsWith('_OTC');
    const core = otc ? u.slice(0, -4) : u;
    let nice = core;
    for (const q of QUOTES) {
      if (core.length > q.length + 1 && core.endsWith(q)) {
        nice = core.slice(0, -q.length) + '/' + q;
        break;
      }
    }
    return nice + (otc ? ' · OTC' : '');
  };

  function drawSpark(cs) {
    const cv = el.spark;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 260;
    const h = 62;
    if (cv.width !== Math.round(w * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!cs || cs.length < 2) return;

    let lo = Infinity, hi = -Infinity;
    for (const c of cs) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; }
    const span = hi - lo || 1;
    const bw = w / cs.length;
    const y = (v) => h - 3 - ((v - lo) / span) * (h - 8);

    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      const x = i * bw + bw / 2;
      const upc = c.c >= c.o;
      g.strokeStyle = upc ? '#2fbf71' : '#e04b5b';
      g.fillStyle = g.strokeStyle;
      g.beginPath();
      g.moveTo(x, y(c.h)); g.lineTo(x, y(c.l)); g.stroke();
      const top = y(Math.max(c.o, c.c));
      const bot = y(Math.min(c.o, c.c));
      g.fillRect(x - bw * 0.3, top, Math.max(1, bw * 0.6), Math.max(1, bot - top));
    }
    // last price marker
    const lastY = y(cs[cs.length - 1].c);
    g.strokeStyle = 'rgba(78,161,255,.85)';
    g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(0, lastY); g.lineTo(w, lastY); g.stroke();
    g.setLineDash([]);
  }

  /* ------------------------- signal alert tone -------------------------
   * "Play a sound on signal" in Settings wrote settings.alerts.sound and then
   * nothing on any surface ever read it — a checkbox that did nothing.
   * Notifications are already handled by the worker; sound has to happen in a
   * page (a service worker cannot play audio without an offscreen document),
   * so the HUD plays a short two-tone blip. AudioContext is created lazily and
   * the call is a no-op wherever it is unavailable or still suspended by the
   * autoplay policy — a missing beep must never break the widget.
   * ------------------------------------------------------------------- */
  let audio = null;
  function blip(dir) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      audio = audio || new Ctx();
      if (audio.state === 'suspended' && audio.resume) audio.resume().catch(() => {});
      const t0 = audio.currentTime;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(dir === 'up' ? 880 : 440, t0);
      osc.frequency.setValueAtTime(dir === 'up' ? 1174 : 330, t0 + 0.09);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start(t0);
      osc.stop(t0 + 0.24);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Identity of the signal currently on screen — one blip per closed bar. */
  let alertKey = null;

  function maybeAlert(s, sig) {
    const key = `${sig.ctx?.at ?? '?'}:${sig.dir}`;
    const first = alertKey === null;
    if (key === alertKey) return;
    alertKey = key;
    // Nothing on the first render: the widget just appeared, the bar did not.
    if (first) return;
    if (sig.dir !== 'up' && sig.dir !== 'down') return;
    if (!s.settings?.alerts?.sound) return;
    blip(sig.dir);
  }

  function render() {
    if (!root || !state) return;
    const s = state;
    const sym = s.symbol || null;

    if (!sym || !sym.price) {
      el.panel.classList.add('collapsed');
      el.warn.classList.remove('hidden');
      el.body.classList.add('hidden');
      const g = s.diag || {};
      // A pair-level explanation beats "give it a minute" once the hook itself
      // is clearly working: waiting is exactly the wrong advice for an OTC pair
      // or one the broker owns but has stopped streaming, because no amount of
      // waiting will produce data this extension is allowed to fetch.
      const sel = s.selection;
      const pairNote =
        sel && sel.text && sel.reason !== 'broker-live' && sel.reason !== 'proxy-live'
          ? (sel.pending ? '⏳ ' : '') + sel.text
          : null;
      if (g.sockets > 0 && pairNote) el.warn.textContent = pairNote;
      else if (g.ticks > 0) el.warn.textContent = 'Feed live — pair has no closed candles yet. Give it a minute.';
      else if (g.frames > 0) el.warn.textContent = 'Frames arriving but not decoded — dashboard → Feed → Protocol Lab shows the shape.';
      else if (g.sockets > 0) el.warn.textContent = 'A socket opened but its frames are not visible here (likely a Web Worker).';
      else el.warn.textContent = 'No socket seen on this page. On a mirror domain? Options → Site access → grant it, then reload.';
      return;
    }
    el.warn.classList.add('hidden');
    el.body.classList.remove('hidden');

    el.pair.textContent = pretty(sym.sym) + ' · ' + (s.settings?.tf || 'm1');
    const srcLabel = sym.source === 'quotex' ? 'QUOTEX LIVE' : sym.source === 'binance' ? 'BINANCE' : 'FX PROXY';
    el.srcb.textContent = sym.stale ? 'IDLE' : srcLabel;
    el.srcb.className = 'badge ' + (sym.stale ? 'dead' : sym.source === 'quotex' ? 'live' : 'idle');

    const sig = s.signal || { dir: 'wait', summary: 'no data' };
    maybeAlert(s, sig);
    const st = DIR_STYLE[sig.dir] || DIR_STYLE.wait;
    el.sig.style.background = st.bg;
    el.sigd.textContent = st.label;
    el.sigd.style.color = st.fg;
    el.sigw.textContent = sig.summary || '';
    const pv = s.preview;
    const lead = 12; // show the forming hint during the last 12s of the bar
    if (pv && (pv.dir === 'up' || pv.dir === 'down') && sig.dir !== 'up' && sig.dir !== 'down' &&
        (s.secondsToClose == null || s.secondsToClose <= lead)) {
      el.sigw.textContent = `⚡ forming ${pv.dir.toUpperCase()} · conf ${pv.confidence} — confirm at close (${s.secondsToClose ?? '—'}s)`;
      el.sigw.style.color = pv.dir === 'up' ? '#3ddc84' : '#ff5c6c';
    } else {
      el.sigw.style.color = '#a8b7c8';
    }
    el.conf.style.width = Math.min(100, sig.confidence || 0) + '%';
    el.conf.style.color = st.fg;
    el.confv.textContent = sig.confidence ? 'conf ' + sig.confidence : '—';
    el.mup.style.width = Math.min(100, ((sig.ctx?.upVotes || 0) / Math.max(1, (sig.ctx?.upVotes || 0) + (sig.ctx?.downVotes || 0))) * 100) + '%';

    el.px.textContent = fmt(sym.price);
    const payout = Number.isFinite(sym.payout) ? sym.payout : s.settings?.payout;

    // settings.hud.showChart was written by the schema and read by nobody.
    if (el.spark) el.spark.style.display = s.settings?.hud?.showChart === false ? 'none' : '';

    // The header prints the selected timeframe, so the bar and the countdown
    // have to come from that same series — showing "m15" over 1-minute candles
    // and a 60-second clock is a caption that contradicts the chart.
    const TF_MS = { m1: 60_000, m5: 300_000, m15: 900_000 };
    const tf = TF_MS[s.settings?.tf] ? s.settings.tf : 'm1';
    const ms = TF_MS[tf];
    const cs = s.candles?.[tf] || [];
    const lastBar = cs[cs.length - 1];
    const rem = lastBar ? Math.max(0, Math.ceil((lastBar.t + ms - s.now) / 1000)) : 0;
    el.clk.textContent = rem > 0 ? rem + 's' : 'close';

    // Say where the candles on screen came from. "site m5" means these are the
    // broker's own candles for the chart the user has open — the only way the
    // two charts can be compared honestly. They must be the series this widget
    // just drew, which is why this line is here and not next to the price.
    const fromSite = s.sync?.barsFrom === 'broker';
    el.meta.textContent =
      'pay ' + (payout ? payout + '%' : '?') + ' · ' + cs.length + (fromSite ? ` bars · site ${tf}` : ' bars');

    const open = (s.openTrades || [])[0];
    el.ticket.textContent = open
      ? `🎫 ${open.dir.toUpperCase()} @ ${fmt(open.entry)} · $${open.stake} · ${Math.max(0, Math.ceil((open.expiresAt - s.now) / 1000))}s`
      : '';

    const j = s.journal || {};
    el.wl.textContent = j.decided ? `${j.wins}/${j.losses} · ${(j.winRate * 100).toFixed(0)}%` : '—';
    el.edge.textContent = j.decided ? `${j.edge >= 0 ? '+' : ''}${(j.edge * 100).toFixed(1)}pp` : '—';
    el.exp.textContent = j.decided ? `${j.expectancy >= 0 ? '+' : ''}${j.expectancy}` : '—';

    if (s.settings?.hud?.showChart !== false) drawSpark(cs.slice(-70));
  }

  /* ------------------------------ loop ------------------------------- */

  function poll() {
    if (!visible || !host) return;
    try {
      chrome.runtime.sendMessage({ cmd: 'state.get' }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) return;
        state = res;
        if (res.settings?.hud) {
          side = res.settings.hud.side || side;
          applySide();
        }
        render();
      });
    } catch (e) {}
  }

  /* The service worker pushes "feed.new" the moment a batch of market frames
   * has been ingested, so the widget redraws on arrival instead of waiting for
   * the next poll. The floor keeps a chatty socket (many batches per second)
   * from re-rendering on every one of them. */
  let lastPollAt = 0;
  const POLL_FLOOR_MS = 200;
  function pollSoon() {
    const wait = Math.max(0, POLL_FLOOR_MS - (Date.now() - lastPollAt));
    if (wait > 0) {
      if (!soonTimer) soonTimer = setTimeout(() => { soonTimer = null; pollSoon(); }, wait);
      return;
    }
    lastPollAt = Date.now();
    poll();
  }
  let soonTimer = null;

  chrome.runtime.onMessage.addListener((m, sender, send) => {
    if (!m) return;
    if (m.cmd === 'hud.toggle') {
      if (!host) build();
      setVisible(!visible);
      send?.({ ok: 1 });
    } else if (m.cmd === 'hud.show') {
      if (!host) build();
      setVisible(true);
      send?.({ ok: 1 });
    } else if (m.cmd === 'feed.new') {
      pollSoon();
    }
  });

  chrome.runtime.sendMessage({ cmd: 'settings.get' }, (res) => {
    if (chrome.runtime.lastError) return;
    const hud = res?.settings?.hud;
    side = hud?.side || 'right';
    if (hud && hud.enabled === false) {
      // Track the real state, otherwise the first hud.toggle would hide a
      // widget that was never shown instead of revealing it.
      visible = false;
      return;
    }
    build();
    applySide();
    setCompact(!!hud?.compact);
    poll();
  });

  setInterval(poll, 1000);
})();
