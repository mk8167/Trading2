/* ------------------------------------------------------------------
 * panel.js — side-panel dashboard.
 *
 * The service worker owns all state and maths; this file only renders.
 * Updates arrive over a long-lived port so the UI stays in sync without
 * the panel having to poll, and every renderer is idempotent so a missed
 * frame can never leave stale numbers on screen.
 * ----------------------------------------------------------------*/

import { CandleChart } from '../chart.js';
import { ema, adx } from '../../background/indicators.js';
import { formatPrice, TF_MS } from '../../background/candles.js';
import { breakEvenWinRate } from '../../background/strategy.js';
import { pretty as prettySym } from '../../background/symbols.js';

const $ = (id) => document.getElementById(id);
const state = { data: null, tab: 'chart' };

/* ------------------------------ plumbing ---------------------------- */

let port = null;

function connect() {
  try {
    port = chrome.runtime.connect({ name: 'qsync' });
    port.onMessage.addListener((msg) => {
      if (msg && msg.ok) apply(msg);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      setConn('reconnecting…', 'idle');
      setTimeout(connect, 1500);
    });
  } catch (e) {
    setTimeout(connect, 1500);
  }
}

function send(cmd, payload = {}) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ cmd, ...payload }, (res) => {
        void chrome.runtime.lastError;
        resolve(res || { ok: false });
      });
    } catch (e) {
      resolve({ ok: false, err: String(e) });
    }
  });
}

function setConn(text, cls = '') {
  const c = $('conn');
  c.textContent = '● ' + text;
  c.className = 'conn ' + cls;
}

/* -------------------------------- tabs ------------------------------- */

$('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  state.tab = btn.dataset.tab;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === btn);
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.id === 'tab-' + state.tab);
  if (state.data) apply(state.data, true);
});

/* -------------------------------- chart ------------------------------ */

const chart = new CandleChart($('chart'), {
  visible: 90,
  onHover: (h) => {
    const tip = $('tip');
    if (!h) {
      tip.textContent = '';
      return;
    }
    const d = new Date(h.t);
    const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    tip.textContent = `${hh}  O ${formatPrice(h.o)}  H ${formatPrice(h.h)}  L ${formatPrice(h.l)}  C ${formatPrice(h.c)}`;
  },
});

function drawChart(d) {
  const tf = d.settings?.tf === 'm15' ? 'm15' : d.settings?.tf === 'm5' ? 'm5' : 'm1';
  const cs = d.candles?.[tf] || [];
  const closes = cs.map((c) => c.c);
  const overlays = [];
  const palette = ['#f5c33b', '#4ea1ff', '#c084fc'];
  (d.settings?.chart?.ema || [9, 21]).forEach((n, i) => {
    overlays.push({ name: `EMA${n}`, color: palette[i % palette.length], values: ema(closes, n) });
  });
  const markers = (d.journal?.recent || [])
    .filter((t) => t.sym === d.selectedSym)
    .map((t) => ({ t: t.openedAt, dir: t.dir }));
  chart.setData({
    candles: cs,
    overlays,
    levels: (d.signal?.ctx?.levels || []).map((l) => ({ price: l.price, kind: l.kind })),
    markers,
  });
}

function drawEquity(points) {
  const cv = $('equity');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 300;
  const h = 120;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!points || points.length < 2) {
    g.fillStyle = '#5d6d7f';
    g.font = '11px "Segoe UI", system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('no settled trades yet', w / 2, h / 2);
    return;
  }
  const vals = points.map((p) => p.equity);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const x = (i) => (i / (points.length - 1)) * (w - 8) + 4;
  const y = (v) => h - 6 - ((v - lo) / span) * (h - 14);

  g.strokeStyle = '#1d2937';
  g.beginPath();
  g.moveTo(0, y(0));
  g.lineTo(w, y(0));
  g.stroke();

  const last = vals[vals.length - 1];
  g.strokeStyle = last >= 0 ? '#2fbf71' : '#e04b5b';
  g.lineWidth = 1.6;
  g.beginPath();
  points.forEach((p, i) => (i ? g.lineTo(x(i), y(p.equity)) : g.moveTo(x(i), y(p.equity))));
  g.stroke();
  g.lineWidth = 1;

  g.fillStyle = '#7c8ca0';
  g.font = '10px "Segoe UI", system-ui, sans-serif';
  g.textAlign = 'left';
  g.fillText(`${hi >= 0 ? '+' : ''}${hi.toFixed(2)}`, 4, 11);
  g.textAlign = 'right';
  g.fillText(`${lo.toFixed(2)}`, w - 4, h - 4);
}

/* ------------------------------ rendering ---------------------------- */

const DIR_LABEL = {
  up: '▲ CALL / UP',
  down: '▼ PUT / DOWN',
  veto: '⛔ BLOCKED',
  none: '— NO EDGE',
  wait: '⏳ WARMING UP',
};

function apply(d, force = false) {
  state.data = d;
  const prev = state.renderedSym;
  state.renderedSym = d.selectedSym;

  renderHeader(d);
  renderSignal(d);
  if (state.tab === 'chart' || force || prev !== d.selectedSym) renderChartTab(d);
  if (state.tab === 'signal') renderSignalTab(d);
  if (state.tab === 'journal') renderJournal(d);
  if (state.tab === 'feed') renderFeed(d);
  if (state.tab === 'settings') renderSettings(d);
}

function renderHeader(d) {
  const sym = d.symbol;
  const stale = !sym || sym.stale;
  const src = sym?.source;
  setConn(
    !sym ? 'no feed' : stale ? 'idle' : src === 'quotex' ? 'quotex live' : src === 'binance' ? 'binance' : 'fx proxy',
    !sym || stale ? (sym ? 'idle' : 'dead') : 'live'
  );
  fillPairs(d);
  const tf = $('tf');
  if (tf.value !== (d.settings?.tf || 'm1')) tf.value = d.settings?.tf || 'm1';
  const ex = $('expiry');
  const exv = String(d.settings?.expiryMinutes || 1);
  if (ex.value !== exv) ex.value = exv;
}

function fillPairs(d) {
  const sel = $('pair');
  const cat = d.catalog || {};
  const live = (d.symbols || []).filter((s) => !s.stale).map((s) => s.sym);
  const known = new Set([...(cat.quotex || []), ...(cat.crypto || []), ...(cat.fx || [])]);
  const groups = [
    ['Quotex live', cat.quotex || []],
    ['Crypto (Binance)', cat.crypto || []],
    ['FX proxy (Yahoo, delayed)', cat.fx || []],
  ];
  const html = groups
    .filter(([, list]) => list.length)
    .map(([label, list]) => `<optgroup label="${esc(label)}">${list
      .map((s) => `<option value="${esc(s)}">${esc(pretty(s))}${live.includes(s) ? ' ·' : ''}</option>`)
      .join('')}</optgroup>`)
    .join('');
  if (sel.dataset.sig !== html) {
    sel.innerHTML = html;
    sel.dataset.sig = html;
  }
  if (d.selectedSym && !known.has(d.selectedSym) && !sel.querySelector(`option[value="${CSS.escape(d.selectedSym)}"]`)) {
    sel.insertAdjacentHTML('afterbegin', `<option value="${esc(d.selectedSym)}">${esc(pretty(d.selectedSym))}</option>`);
  }
  if (sel.value !== d.selectedSym) sel.value = d.selectedSym || '';
}

function renderSignal(d) {
  const box = $('signal');
  const sig = d.signal || { dir: 'wait', summary: 'no data', confidence: 0 };
  box.className = 'signal ' + (['up', 'down', 'veto'].includes(sig.dir) ? sig.dir : '');
  $('sigDir').textContent = DIR_LABEL[sig.dir] || '—';
  $('sigWhy').textContent = sig.summary || '';
  $('confBar').style.width = Math.min(100, sig.confidence || 0) + '%';
  $('confBar').style.background = sig.dir === 'up' ? '#2fbf71' : sig.dir === 'down' ? '#e04b5b' : '#f5c33b';
  $('price').textContent = d.symbol?.price ? formatPrice(d.symbol.price) : '—';

  const tf = d.settings?.tf || 'm1';
  const cs = d.candles?.[tf] || [];
  const lastBar = cs[cs.length - 1];
  const ms = TF_MS[tf] || TF_MS.m1;
  const rem = lastBar ? Math.max(0, Math.ceil((lastBar.t + ms - d.now) / 1000)) : 0;
  $('clock').textContent = rem > 0 ? `${rem}s to close` : 'closing…';
}

function renderChartTab(d) {
  drawChart(d);
  const tf = d.settings?.tf === 'm15' ? 'm15' : d.settings?.tf === 'm5' ? 'm5' : 'm1';
  const cs = d.candles?.[tf] || [];
  const closes = cs.map((c) => c.c);
  const ctx = d.signal?.ctx;

  $('readout').textContent = cs.length
    ? `${cs.length} bars · ${pretty(d.selectedSym)} · ${d.symbol?.source || '?'} feed · ${
        d.symbol?.stale ? 'STALE' : 'live'
      }`
    : 'no bars yet';

  // Forming preview (early warning) + candle-sync health.
  const pv = d.preview;
  let pvHtml = '';
  if (pv && (pv.dir === 'up' || pv.dir === 'down')) {
    pvHtml = `<div class="i ${pv.dir === 'up' ? 'ok' : ''}">⚡ FORMING ${pv.dir === 'up' ? 'UP' : 'DOWN'} · conf ${
      pv.confidence
    } — <b>confirm at close</b> (${d.secondsToClose ?? '—'}s). This is a preview, not the trade call.</div>`;
  } else if (pv) {
    pvHtml = `<div class="i">forming: ${esc(pv.summary || 'no edge yet')} · ${d.secondsToClose ?? '—'}s to close</div>`;
  }
  const sy = d.sync;
  let syncHtml = '';
  if (sy) {
    syncHtml = sy.aligned
      ? `<div class="i ok">candle sync ✓ — ${esc(sy.source)} feed, bar aligned to the minute</div>`
      : `<div class="i">candle sync ✗ — ${esc(sy.source)} feed${sy.tickAgeSec != null ? `, last tick ${sy.tickAgeSec}s ago` : ''}${
          sy.aligned === false ? ', bar NOT on the minute boundary' : ''
        }. If this is a proxy feed, it will not match the broker chart.</div>`;
  }
  $('preview').innerHTML = pvHtml + syncHtml;

  const A = ctx?.atr;
  const price = d.symbol?.price;
  $('indis').innerHTML = kv([
    ['Price', price ? formatPrice(price) : '—'],
    ['ATR(14)', A ? A.toFixed(5) : '—'],
    ['ATR %', ctx?.volatility != null ? (ctx.volatility * 100).toFixed(3) + '%' : '—', ctx?.volatility > 0.02 ? 'warn' : ''],
    ['RSI(14)', ctx?.rsi != null ? ctx.rsi.toFixed(1) : '—', ctx?.rsi > 70 ? 'dn' : ctx?.rsi < 30 ? 'up' : ''],
    ['Stoch %K', ctx?.stochK != null ? ctx.stochK.toFixed(0) : '—'],
    ['MACD hist', ctx?.macdHist != null ? ctx.macdHist.toExponential(1) : '—', (ctx?.macdHist || 0) > 0 ? 'up' : 'dn'],
    ['EMA21', ctx?.ema21 ? formatPrice(ctx.ema21) : '—'],
    ['EMA50', ctx?.ema50 ? formatPrice(ctx.ema50) : '—'],
    ['%B', ctx?.bollPctB != null ? ctx.bollPctB.toFixed(2) : '—'],
    ['Structure', ctx?.structure || '—', ctx?.structure === 'up' ? 'up' : ctx?.structure === 'down' ? 'dn' : ''],
    ['5m bias', ctx?.mtf?.m5 || '—', ctx?.mtf?.m5 === 'up' ? 'up' : ctx?.mtf?.m5 === 'down' ? 'dn' : ''],
    ['15m bias', ctx?.mtf?.m15 || '—', ctx?.mtf?.m15 === 'up' ? 'up' : ctx?.mtf?.m15 === 'down' ? 'dn' : ''],
    ['Votes ▲', ctx?.upVotes ?? '—', 'up'],
    ['Votes ▼', ctx?.downVotes ?? '—', 'dn'],
    ['ADX(14)', adxLast(cs)],
    ['Payout', Number.isFinite(d.symbol?.payout) ? d.symbol.payout + '%' : (d.settings?.payout || '—')],
  ]);

  const votes = d.signal?.signals || [];
  $('votes').innerHTML = votes.length
    ? votes
        .map(
          (v) => `<div class="vote ${v.dir}"><span class="dir">${v.dir === 'up' ? '▲' : '▼'}</span>
            <span class="nm">${esc(v.name)}</span><span class="wt">+${v.weight}</span></div>`
        )
        .join('')
    : '<div class="muted">No rule fired on the last closed candle.</div>';
}

function adxLast(cs) {
  if (!cs || cs.length < 20) return '—';
  const v = adx(cs.slice(-120), 14).adx;
  for (let i = v.length - 1; i >= 0; i--) if (v[i] != null) return v[i].toFixed(0);
  return '—';
}

/* --------------------- "which pair should I trade" -------------------- */

function renderRecommend(d) {
  const box = $('recCard');
  if (!box) return;
  const rec = d.recommend || {};
  const best = rec.best;
  const rest = (rec.ranked || []).slice(1, 6);

  if (!best) {
    const why = (rec.ineligible || []).slice(0, 3).map((x) => `<div class="sub">· ${esc(x.pretty || x.sym)} — ${esc(x.reasons[0] || 'not tradeable')}</div>`).join('');
    box.innerHTML = `
      <div class="big" style="color:#f5c33b">⏳ NOTHING WORTH TRADING</div>
      <div class="sub">No instrument currently passes the filters: live data, 40+ closed candles, an open market, and a payout above its break-even floor.</div>
      ${why}
    `;
    return;
  }

  const row = (x, isBest) => `
    <div class="sub" style="margin-top:${isBest ? 8 : 4}px;${isBest ? '' : 'opacity:.8'}">
      ${isBest ? '<b>' : ''}${esc(x.pretty || x.sym)}${isBest ? '</b>' : ''}
      <span style="opacity:.65">${esc(x.assetClass)}${x.otc ? ' · OTC' : ''}</span>
      — <b>${x.score}</b>/100
      ${x.dir === 'up' || x.dir === 'down' ? `<span style="color:${x.dir === 'up' ? '#2fbf71' : '#e04b5b'}">${x.dir.toUpperCase()} ${x.confidence}%</span>` : '<span style="opacity:.6">no signal</span>'}
      · payout ${x.payout}% · be ${(x.breakEven * 100).toFixed(1)}%
      ${x.historyN ? `· ${x.historyN} traded (${(x.historyWinRate * 100).toFixed(0)}% win, lb ${(x.historyLowerBound * 100).toFixed(0)}%)` : ''}
    </div>`;

  box.innerHTML = `
    <div class="big" style="color:#4aa3ff">🎯 BEST PAIR RIGHT NOW</div>
    ${row(best, true)}
    <div class="sub" style="margin-top:6px;opacity:.85">${(best.reasons || []).map(esc).join('<br>')}</div>
    ${rest.length ? `<h3 style="margin-top:10px">Also tradeable</h3>${rest.map((x) => row(x, false)).join('')}` : ''}
    <div class="row-btns" style="margin-top:9px">
      <button class="btn" id="recSwitch">Switch to ${esc(best.pretty || best.sym)}</button>
    </div>
  `;
  const btn = $('recSwitch');
  if (btn) btn.onclick = () => send('symbols.select', { sym: best.sym });
}

function renderSignalTab(d) {
  renderRecommend(d);
  const sig = d.signal || { dir: 'wait', summary: 'no data' };
  const open = (d.openTrades || [])[0];
  // The payout the engine actually used, not a guess: a wrong number here
  // means a wrong break-even, which means a wrong judgement about the edge.
  const payout = Number.isFinite(d.effectivePayout?.payout)
    ? d.effectivePayout.payout
    : Number.isFinite(d.symbol?.payout) ? d.symbol.payout : d.settings?.payout || 86;
  const payoutNote = d.effectivePayout?.origin === 'live' ? 'live from broker'
    : d.effectivePayout?.origin === 'class' ? `${d.assetClass || 'class'} typical`
    : 'your default';
  const be = breakEvenWinRate(payout);
  $('sigCard').innerHTML = `
    <div class="big" style="color:${sig.dir === 'up' ? '#2fbf71' : sig.dir === 'down' ? '#e04b5b' : '#f5c33b'}">${DIR_LABEL[sig.dir] || '—'}</div>
    <div class="sub">${esc(sig.summary || '')}</div>
    <div class="sub" style="margin-top:7px">
      Confidence <b>${sig.confidence ?? 0}%</b> · net score <b>${sig.score ?? 0}</b> ·
      votes ${sig.ctx?.upVotes ?? 0}▲ / ${sig.ctx?.downVotes ?? 0}▼
    </div>
    <div class="sub" style="margin-top:4px">
      Break-even win rate at ${payout}% payout <span style="opacity:.65">(${esc(payoutNote)})</span>: <b>${(be * 100).toFixed(1)}%</b>
    </div>
    ${d.marketOpen === false ? '<div class="sub" style="margin-top:6px;color:#e04b5b">⛔ Market closed — no signals are trustworthy right now</div>' : ''}
    ${open ? `<div class="sub" style="margin-top:7px;color:#f5c33b">🎫 open ${open.dir.toUpperCase()} @ ${formatPrice(open.entry)} · $${open.stake} · ${Math.max(0, Math.ceil((open.expiresAt - d.now) / 1000))}s left</div>` : ''}
  `;

  $('ctxGrid').innerHTML = kv([
    ['Structure', sig.ctx?.structure || '—'],
    ['5m', sig.ctx?.mtf?.m5 || '—'],
    ['15m', sig.ctx?.mtf?.m15 || '—'],
    ['ATR', sig.ctx?.atr ? sig.ctx.atr.toFixed(5) : '—'],
    ['Volatility', sig.ctx?.volatility != null ? (sig.ctx.volatility * 100).toFixed(3) + '%' : '—'],
    ['RSI', sig.ctx?.rsi != null ? sig.ctx.rsi.toFixed(1) : '—'],
    ['Candles used', sig.ctx?.candles ?? '—'],
    ['Bar close', sig.ctx?.at ? new Date(sig.ctx.at).toLocaleTimeString() : '—'],
  ]);

  const vetoes = sig.vetoes || [];
  $('vetoes').innerHTML = vetoes.length
    ? vetoes.map((v) => `<div class="i">⛔ ${esc(v)}</div>`).join('')
    : '<div class="i ok">✓ No veto active — the risk filters are clear.</div>';

  const ev = d.journal?.events || [];
  $('events').innerHTML = ev.length
    ? ev.map((e) => `<div class="e ${e.kind}"><span class="t">${clock(e.t)}</span>${esc(e.text)}</div>`).join('')
    : '<div class="muted">Nothing yet. Signals appear here the moment a candle closes.</div>';
}

function renderJournal(d) {
  const j = d.journal || {};
  const pctv = (v) => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '—');
  const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'neu');
  $('jstats').innerHTML = [
    ['Trades', j.decided ?? 0, `${j.wins ?? 0}W / ${j.losses ?? 0}L`],
    ['Win rate', pctv(j.winRate), `break-even ${pctv(j.breakEven)}`],
    ['Edge', j.edge != null ? `${j.edge >= 0 ? '+' : ''}${(j.edge * 100).toFixed(1)}pp` : '—', j.edge > 0 ? 'positive' : 'negative', cls(j.edge)],
    ['Net P/L', j.net != null ? `${j.net >= 0 ? '+' : ''}${j.net.toFixed(2)}` : '—', `ROI ${j.roiPct ?? 0}%`, cls(j.net)],
    ['Expectancy', j.expectancy != null ? j.expectancy.toFixed(3) : '—', 'per trade', cls(j.expectancy)],
    ['Profit factor', Number.isFinite(j.profitFactor) ? j.profitFactor.toFixed(2) : '—', `win ${(j.avgWin ?? 0).toFixed(2)} / loss ${(j.avgLoss ?? 0).toFixed(2)}`],
    ['Max drawdown', (j.maxDrawdown ?? 0).toFixed(2), 'peak to trough'],
    ['Streaks', `${j.bestWinStreak ?? 0}W / ${j.bestLossStreak ?? 0}L`, 'best runs'],
    ['Open', j.open ?? 0, 'unsettled'],
  ]
    .map(([k, v, s, c]) => `<div class="stat"><div class="k">${k}</div><div class="v ${c || ''}">${v}</div><div class="s">${s || ''}</div></div>`)
    .join('');

  drawEquity(j.equity || []);
  $('bySetup').innerHTML = breakdownTable(j.breakdown?.setup, 'Setup');
  $('bySym').innerHTML = breakdownTable(j.breakdown?.symbol, 'Instrument', pretty);

  const rows = (j.recent || []).slice(0, 25);
  $('trades').innerHTML = rows.length
    ? `<tr><th>Time</th><th>Pair</th><th>Dir</th><th>Entry</th><th>Exit</th><th>P/L</th><th>Setup</th></tr>` +
      rows
        .map(
          (t) => `<tr>
            <td>${clock(t.openedAt)}</td>
            <td>${esc(pretty(t.sym))}</td>
            <td class="${t.dir === 'up' ? 'pos' : 'neg'}">${t.dir === 'up' ? '▲' : '▼'}</td>
            <td>${formatPrice(t.entry)}</td>
            <td>${t.exit ? formatPrice(t.exit) : '—'}</td>
            <td class="${cls(t.pnl)}">${t.result === 'tie' ? 'push' : `${t.pnl >= 0 ? '+' : ''}${(t.pnl ?? 0).toFixed(2)}`}</td>
            <td class="neu">${esc((t.signals || [])[0] || '—')}</td>
          </tr>`
        )
        .join('')
    : '<tr><td class="muted">No trades recorded yet.</td></tr>';
}

function breakdownTable(rows, label, fmtFn = (x) => x) {
  if (!rows || !rows.length) return `<tr><td class="muted">No data yet.</td></tr>`;
  return (
    `<tr><th>${label}</th><th>N</th><th>Win%</th><th>Edge</th><th>Net</th></tr>` +
    rows
      .map(
        (r) => `<tr><td>${esc(fmtFn(r.key))}</td><td>${r.n}</td>
          <td class="${r.edge > 0 ? 'pos' : 'neg'}">${(r.winRate * 100).toFixed(0)}%</td>
          <td class="${r.edge > 0 ? 'pos' : 'neg'}">${(r.edge * 100).toFixed(1)}pp</td>
          <td class="${r.net > 0 ? 'pos' : 'neg'}">${r.net.toFixed(2)}</td></tr>`
      )
      .join('')
  );
}

function renderFeed(d) {
  const g = d.diag || {};
  $('fdiag').innerHTML = [
    ['Sockets seen', g.sockets ?? 0, 'WebSocket opens on this page'],
    ['Frames', g.frames ?? 0, 'websocket payloads'],
    ['Ticks', g.ticks ?? 0, 'parsed prices'],
    ['History rows', g.historyRows ?? 0, 'candles seeded'],
    ['Binary frames', g.binaryFrames ?? 0, 'non-text'],
    ['Unparsed', g.unparsed ?? 0, 'see Protocol Lab'],
    ['Instruments', g.pairs ?? 0, 'in memory'],
    ['Last frame', g.lastFrameAge != null ? (g.lastFrameAge / 1000).toFixed(0) + 's ago' : 'never'],
  ]
    .map(([k, v, s]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`)
    .join('');

  // One-line "why is/isn't this live" diagnosis.
  const live = (d.symbols || []).some((s) => !s.stale);
  const verdict = live
    ? `✓ LIVE — ticks every frame on ${(d.symbols || []).filter((s) => !s.stale).length} instrument(s).`
    : (g.ticks > 0)
      ? 'Feed is connected; waiting for enough closed candles.'
      : (g.frames > 0)
        ? 'Frames arrive but are not decoded — open the Protocol Lab below to see the payload shape.'
        : (g.sockets > 0)
          ? 'A WebSocket opened but its frames are not visible — the socket may live in a Web Worker.'
          : 'No WebSocket seen on this page. If this is a mirror domain, grant it in Options → Site access and reload.';
  $('fdiag-line').innerHTML = `<div class="i ${live ? 'ok' : ''}">${esc(verdict)}</div>`;

  const pairs = d.symbols || [];
  $('pairs').innerHTML = pairs.length
    ? `<tr><th>Instrument</th><th>Source</th><th>Price</th><th>Bars</th><th>Ticks</th><th>State</th></tr>` +
      pairs
        .map(
          (p) => `<tr><td>${esc(pretty(p.sym))}</td><td>${esc(p.source)}</td>
            <td>${p.price ? formatPrice(p.price) : '—'}</td><td>${p.bars}</td><td>${p.ticks}</td>
            <td class="${p.stale ? 'neg' : 'pos'}">${p.stale ? 'idle' : 'live'}</td></tr>`
        )
        .join('')
    : '<tr><td class="muted">Nothing detected yet — open a broker chart tab.</td></tr>';

  const samples = g.samples || [];
  $('samples').innerHTML = samples.length
    ? samples
        .map(
          (s) => `<div class="e"><span class="t">${clock(s.at)}</span>len ${s.len}${s.looksBinary ? ' · binary' : ''}${
            s.looksJson ? ' · json-ish' : ''
          }<br><code>${esc(s.text)}</code></div>`
        )
        .join('')
    : '<div class="muted">Nothing unparsed — every frame so far decoded cleanly.</div>';

  const errs = g.errors || [];
  $('errors').innerHTML = errs.length
    ? errs.map((e) => `<div class="e loss"><code>${esc(e)}</code></div>`).join('')
    : '<div class="muted">No errors.</div>';
}

let settingsLoaded = false;
function renderSettings(d) {
  const s = d.settings;
  if (!s) return;
  if (!settingsLoaded || state.tab === 'settings') {
    set('sBal', s.balance); set('sRisk', s.riskPct); set('sPay', s.payout);
    set('sMinScore', s.strategy.minScore); set('sMinPay', s.strategy.minPayout);
    set('sCd', Math.round(s.strategy.cooldownMs / 1000)); set('sMaxVol', s.strategy.maxVolatility);
    set('sGateN', s.strategy.gateLookback); set('sStreak', s.strategy.maxLossStreak);
    chk('sAuto', s.autoPaperTrade); chk('sDesk', s.alerts.desktop); chk('sSound', s.alerts.sound);
    chk('sMtf', s.strategy.useMtf); chk('sPat', s.strategy.usePatterns); chk('sLvl', s.strategy.useLevels);
    chk('sGate', s.strategy.gateEnabled); chk('sBinance', s.feeds.binance); chk('sYahoo', s.feeds.yahoo);
    settingsLoaded = true;
  }
}

const set = (id, v) => { if ($(id) && document.activeElement !== $(id)) $(id).value = v ?? ''; };
const chk = (id, v) => { if ($(id) && document.activeElement !== $(id)) $(id).checked = !!v; };

/* ------------------------------- helpers ----------------------------- */

function kv(pairs) {
  return pairs
    .map(([k, v, c]) => `<div class="kv"><div class="k">${esc(k)}</div><div class="v ${c || ''}">${esc(String(v))}</div></div>`)
    .join('');
}

/* One formatter for the whole extension: symbols.js. The local copy split a
 * name only when it was exactly six characters, so every crypto pair
 * (BTCUSDT, 1000SHIBUSDT) was printed as one unreadable blob. */
const pretty = prettySym;

function clock(t) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------- controls ---------------------------- */

$('pair').addEventListener('change', (e) => send('symbols.select', { sym: e.target.value }));
$('tf').addEventListener('change', (e) => send('settings.patch', { patch: { tf: e.target.value } }));
$('expiry').addEventListener('change', (e) =>
  send('settings.patch', { patch: { expiryMinutes: Number(e.target.value) || 1 } })
);

$('sSave').addEventListener('click', async () => {
  const patch = {
    balance: Number($('sBal').value) || 100,
    riskPct: Number($('sRisk').value) || 1,
    payout: Number($('sPay').value) || 86,
    autoPaperTrade: $('sAuto').checked,
    alerts: { desktop: $('sDesk').checked, sound: $('sSound').checked },
    feeds: { binance: $('sBinance').checked, yahoo: $('sYahoo').checked },
    strategy: {
      minScore: Number($('sMinScore').value) || 3,
      minPayout: Number($('sMinPay').value) || 0,
      cooldownMs: (Number($('sCd').value) || 0) * 1000,
      maxVolatility: Number($('sMaxVol').value) || 0.02,
      gateLookback: Number($('sGateN').value) || 20,
      maxLossStreak: Number($('sStreak').value) || 0,
      useMtf: $('sMtf').checked,
      usePatterns: $('sPat').checked,
      useLevels: $('sLvl').checked,
      gateEnabled: $('sGate').checked,
    },
  };
  const r = await send('settings.patch', { patch });
  $('sSave').textContent = r.ok ? '✓ Saved' : 'Save failed';
  setTimeout(() => ($('sSave').textContent = 'Save settings'), 1400);
});

$('sReset').addEventListener('click', async () => {
  if (!confirm('Reset every setting back to defaults?')) return;
  await send('settings.reset');
  settingsLoaded = false;
});

$('sOpenOpts').addEventListener('click', () => chrome.runtime.openOptionsPage?.());

$('sGrant').addEventListener('click', async () => {
  let origin = $('sOrigin').value.trim();
  const out = $('grantOut');
  try {
    if (!origin) {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      origin = tab?.url ? new URL(tab.url).origin : '';
    }
    if (!/^https?:\/\/[^/]+$/.test(origin)) {
      out.textContent = 'Enter a full origin, e.g. https://example.com';
      return;
    }
    out.textContent = 'Requesting permission…';
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) {
      out.textContent = 'Permission declined.';
      return;
    }
    const r = await send('scripts.register', { origin });
    out.textContent = r.ok ? `Installed on ${r.pattern}. Reload that tab to start the feed.` : `Failed: ${r.err}`;
  } catch (e) {
    out.textContent = `Failed: ${e.message || e}`;
  }
});

$('jreset').addEventListener('click', async () => {
  if (!confirm('Delete the whole paper-trading journal?')) return;
  await send('journal.reset');
});

$('csv').addEventListener('click', async () => {
  const r = await send('journal.csv');
  if (!r.ok || !r.csv) return;
  const url = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `qsync-journal-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

$('clrSamples').addEventListener('click', () => send('feed.clearSamples'));
$('rstDiag').addEventListener('click', () => send('diag.reset'));

$('btRun').addEventListener('click', async () => {
  const btn = $('btRun');
  btn.disabled = true;
  btn.textContent = 'Running…';
  const r = await send('backtest.run', {
    tf: $('btTf').value,
    expiryBars: Number($('btBars').value) || 1,
    payout: Number($('btPay').value) || 86,
    stake: Number($('btStake').value) || 1,
  });
  btn.disabled = false;
  btn.textContent = 'Run backtest';
  const out = $('btOut');
  if (!r.ok) {
    out.innerHTML = `<div class="i">${esc(r.err || 'backtest failed')}</div>`;
    return;
  }
  const s = r.summary;
  out.innerHTML = `
    <div class="statgrid">
      ${[['Bars', r.bars, 'analysed'], ['Trades', s.trades, 'taken'],
         ['Win rate', s.winRate + '%', `break-even ${s.breakEven}%`],
         ['Edge', `${s.edge >= 0 ? '+' : ''}${s.edge}pp`, s.edge > 0 ? 'positive' : 'negative'],
         ['Net', s.net.toFixed(2), `ROI ${s.roiPct}%`],
         ['Profit factor', s.profitFactor ?? '—', 'gross win / loss'],
         ['Expectancy', s.expectancy, 'per trade'],
         ['Max DD', s.maxDrawdown, 'drawdown']]
        .map(([k, v, sub]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`)
        .join('')}
    </div>
    <p class="muted" style="margin-top:8px">
      Skipped — no signal: ${r.skipped.none}, vetoed: ${r.skipped.veto}, gated: ${r.skipped.gate}, warming: ${r.skipped.warmup}.
      This is in-sample on the candles currently in memory (${r.bars} bars), so treat it as a sanity check, not an edge.
    </p>
    <table class="tbl"><tr><th>Time</th><th>Dir</th><th>Entry</th><th>Exit</th><th>Result</th><th>P/L</th><th>Setup</th></tr>
      ${r.trades.slice(-30).reverse().map((t) => `<tr>
        <td>${clock(t.openedAt)}</td>
        <td class="${t.dir === 'up' ? 'pos' : 'neg'}">${t.dir === 'up' ? '▲' : '▼'}</td>
        <td>${formatPrice(t.entry)}</td><td>${formatPrice(t.exit)}</td>
        <td class="${t.result === 'win' ? 'pos' : 'neg'}">${t.result}</td>
        <td class="${t.pnl >= 0 ? 'pos' : 'neg'}">${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}</td>
        <td class="neu">${esc((t.signals || [])[0] || '—')}</td></tr>`).join('')}
    </table>`;
});

$('btWalk').addEventListener('click', async () => {
  const btn = $('btWalk');
  btn.disabled = true;
  btn.textContent = 'Running…';
  const r = await send('backtest.walk', {
    tf: $('btTf').value,
    expiryBars: Number($('btBars').value) || 1,
    payout: Number($('btPay').value) || 86,
    stake: Number($('btStake').value) || 1,
  });
  btn.disabled = false;
  btn.textContent = 'Walk-forward (honest accuracy)';
  const out = $('btWalkOut');
  if (!r.ok) {
    out.innerHTML = `<div class="i">${esc(r.error || 'walk-forward failed')}</div>`;
    return;
  }
  out.innerHTML = `
    <div class="statgrid">
      ${[
        ['Folds', r.folds, 'out-of-sample windows'],
        ['Mean win', r.meanWinRate + '%', 'across folds'],
        ['Best / worst', `${r.maxWinRate}% / ${r.minWinRate}%`, 'spread'],
        ['Mean edge', `${r.meanEdge > 0 ? '+' : ''}${r.meanEdge}pp`, 'per fold'],
        ['Positive folds', `${r.positiveFolds}/${r.folds}`, 'edge above 0'],
      ]
        .map(([k, v, s]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`)
        .join('')}
    </div>
    <table class="tbl" style="margin-top:8px"><tr><th>Fold</th><th>Bars</th><th>Trades</th><th>Win%</th><th>Edge</th><th>Net</th></tr>
      ${r.perFold
        .map(
          (f) => `<tr><td>${f.fold}</td><td>${f.bars}</td><td>${f.n}</td>
            <td class="${f.edge > 0 ? 'pos' : 'neg'}">${f.winRate}%</td>
            <td class="${f.edge > 0 ? 'pos' : 'neg'}">${f.edge > 0 ? '+' : ''}${f.edge}pp</td>
            <td class="${f.net > 0 ? 'pos' : 'neg'}">${f.net}</td></tr>`
        )
        .join('')}
    </table>
    <p class="muted" style="margin-top:8px">${
      r.stable
        ? 'Edge shows up in most folds — more likely real than a lucky window, but still historical. Keep paper-trading before going live.'
        : 'Edge is NOT consistent across folds — a single good backtest here would be luck. Do not trade this live.'
    }</p>`;
});

/* -------------------------------- boot ------------------------------- */

connect();
send('state.get').then((r) => r?.ok && apply(r));
window.addEventListener('resize', () => state.data && drawChart(state.data));
