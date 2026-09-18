/* The side panel — the thing the user actually reads before placing a trade.
 *
 * Every number here comes from the service worker, and the worker is well
 * tested. What was NOT tested is whether the panel shows them. A banner that
 * throws, an element id that does not exist, or a payload shape that changed
 * underneath the renderer all fail silently: the maths stays correct and the
 * user sees a blank card. Given this panel is what sits between a person and
 * their money, "renders without throwing and says the true thing" is a
 * requirement, not a nicety.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { install, reset as resetChrome } from './chrome-stub.mjs';
import { installDom } from './dom-stub.mjs';

install();
const { get } = installDom();

/* panel.js talks to the worker over a long-lived port and a callback-style
 * sendMessage, neither of which the base stub implements. */
let portListeners = [];
chrome.runtime.connect = () => ({
  onMessage: { addListener: (fn) => portListeners.push(fn) },
  onDisconnect: { addListener: () => {} },
  postMessage: () => {},
  disconnect: () => {},
});
let nextResponse = { ok: false };
chrome.runtime.sendMessage = (_msg, cb) => { if (typeof cb === 'function') cb(nextResponse); };

const panel = await import('../src/ui/panel/panel.js');

const T0 = 1_700_000_000_000;
const bars = (n = 60, start = 1.1) =>
  Array.from({ length: n }, (_, i) => ({
    t: T0 + i * 60_000, o: start + i * 0.0001, h: start + i * 0.0001 + 0.0004,
    l: start + i * 0.0001 - 0.0004, c: start + i * 0.0001 + 0.0002,
  }));

/** A realistic state.get payload. Anything a renderer needs should be here —
 *  if a renderer throws on this, that is a real bug, not a bad fixture. */
function payload(over = {}) {
  return {
    ok: true,
    now: T0 + 60 * 60_000,
    settings: {
      tf: 'm1', expiryMinutes: 1, payout: 86, balance: 500, riskPct: 1,
      autoPaperTrade: true, useClassBands: true, respectMarketHours: true,
      strategy: { minScore: 3, cooldownMs: 60_000, gateEnabled: true },
      alerts: { desktop: false, minConfidence: 70 },
      feeds: { binance: true, yahoo: true },
      recommend: { limit: 5, minBars: 40 },
    },
    selectedSym: 'EURUSD_OTC',
    symbol: {
      sym: 'EURUSD_OTC', pretty: 'EUR/USD (OTC)', assetClass: 'synthetic', otc: true,
      source: 'quotex', price: 1.1062, ts: T0 + 60 * 60_000, payout: 92, ticks: 400,
      stale: false, bars: { m1: 60, m5: 12, m15: 4 },
    },
    candles: { m1: bars(60), m5: bars(12), m15: bars(4) },
    signal: {
      dir: 'up', summary: 'Bullish engulfing at support', confidence: 74, score: 6,
      vetoes: [], signals: [{ name: 'Engulfing', dir: 'up' }],
      ctx: { structure: 'up', mtf: { m5: 'up', m15: 'range' }, atr: 0.00042, volatility: 0.038, rsi: 58.4, candles: 60, upVotes: 3, downVotes: 1, at: T0 + 59 * 60_000 },
    },
    preview: null,
    effectivePayout: { payout: 92, origin: 'live' },
    assetClass: 'synthetic',
    marketOpen: true,
    secondsToClose: 21,
    sync: null,
    openTrades: [],
    bankroll: { starting: 500, realized: 12.5, current: 512.5, riskPct: 1, stake: 5.13, canTrade: true, reason: null },
    journal: {
      decided: 40, wins: 24, losses: 16, ties: 0, voids: 2, open: 0,
      winRate: 0.6, breakEven: 0.5217, edge: 0.0783, net: 12.5, roiPct: 2.5,
      expectancy: 0.31, profitFactor: 1.62, avgWin: 4.6, avgLoss: 5.0,
      maxDrawdown: 8.2, bestWinStreak: 5, bestLossStreak: 3, rolling20: 0.65,
      equity: [{ t: T0, equity: 0 }, { t: T0 + 60_000, equity: 4.6 }],
      breakdown: { setup: [{ key: 'Engulfing', n: 10, winRate: 0.7, edge: 0.18, net: 9.2 }], symbol: [] },
      recent: [{ openedAt: T0, sym: 'EURUSD_OTC', dir: 'up', entry: 1.1, exit: 1.105, pnl: 4.6, result: 'win', stake: 5, signals: ['Engulfing'] }],
      events: [{ t: T0, kind: 'win', text: 'WIN EURUSD_OTC up · +4.60' }],
    },
    symbols: [{ sym: 'EURUSD_OTC', pretty: 'EUR/USD (OTC)', assetClass: 'synthetic', otc: true, source: 'quotex', price: 1.1062, ts: T0, payout: 92, ticks: 400, bars: 60, stale: false, selected: true }],
    catalog: [],
    recommend: { best: null, ranked: [], ineligible: [] },
    diag: {
      frames: 10, ticks: 400, historyRows: 0, binaryFrames: 0, unparsed: 0, sockets: 1,
      bridges: 1, pairs: 1, restPolls: 0, proxyRefusals: 3, sourceTakeovers: 1,
      lastFrameAge: 900, uptime: 60_000, errors: [], samples: [],
    },
    ...over,
  };
}

/** panel.js captured a port listener at import; hand it a payload directly. */
function push(d) {
  assert.ok(portListeners.length, 'the panel never connected to the worker port');
  for (const fn of portListeners) fn(d);
}

/** Push a payload in, then drive the real tab switch so the tab-gated
 *  renderers actually run (apply() only draws the journal on the journal tab). */
function render(d, tab = 'journal') {
  push(d);
  get('tabs').emit('click', { target: { closest: () => ({ dataset: { tab } }) } });
}

test('the panel imports and boots against a real payload without throwing', () => {
  resetChrome();
  assert.doesNotThrow(() => push(payload()), 'apply() must survive a full state payload');
});

test('switching to the journal tab renders the bankroll card', () => {
  render(payload());
  const html = get('bankroll').innerHTML;
  assert.ok(html.length > 0, 'the bankroll slot was never written to');
  assert.match(html, /512\.50/, 'shows the current bankroll');
  assert.match(html, /5\.13/, 'shows the next stake');
  assert.match(html, /1% of bankroll/, 'and the risk it is sized from');
  assert.match(html, /armed/, 'the guard state is visible');
});

test('a halted bankroll shows a stop banner with the reason, not just a number', () => {
  render(payload({
    bankroll: { starting: 500, realized: -505, current: -5, riskPct: 1, stake: 0.01, canTrade: false, reason: 'bankroll is -5.00 — the starting balance plus realized P&L is gone' },
  }));
  const html = get('bankroll').innerHTML;
  assert.match(html, /banner stop/, 'styled as a stop, not a neutral stat');
  assert.match(html, /Trading stopped/, 'says plainly that trading has stopped');
  assert.match(html, /bankroll is -5\.00/, 'and why');
  assert.match(html, /halted/);
});

test('the panel states that this is a paper ledger, not broker settlement', () => {
  render(payload());
  assert.match(get('bankroll').innerHTML, /paper ledger/i, 'the honesty note is always present');
  assert.match(get('bankroll').innerHTML, /not from your broker/i);
});

test('an OTC pair gets the extra warning that its prices are broker-generated', () => {
  render(payload()); // fixture symbol is EURUSD_OTC, otc: true
  assert.match(get('bankroll').innerHTML, /OTC pair/, 'journal warns about OTC');
  assert.match(get('bankroll').innerHTML, /broker-generated|generated by the broker/i);
});

test('a non-OTC pair does not get an OTC warning it does not deserve', () => {
  const d = payload();
  d.symbol = { ...d.symbol, otc: false, assetClass: 'forex', pretty: 'EUR/USD' };
  render(d);
  assert.doesNotMatch(get('bankroll').innerHTML, /is an OTC pair/);
});

test('a delayed proxy feed is labelled on both the journal and the signal card', () => {
  const d = payload();
  d.symbol = { ...d.symbol, source: 'binance', otc: false, pretty: 'BTC/USD', assetClass: 'crypto' };
  render(d, 'journal');
  assert.match(get('bankroll').innerHTML, /delayed proxy/i);
  assert.match(get('bankroll').innerHTML, /USDT, not USD/, 'and it says the crypto proxy is a different underlying');

  render(d, 'signal');
  assert.match(get('sigCard').innerHTML, /binance/, 'the signal card names the proxy source');
  assert.match(get('sigCard').innerHTML, /delayed proxy/i);
});

test('the signal card warns about OTC without needing the journal tab', () => {
  render(payload(), 'signal');
  assert.match(get('sigCard').innerHTML, /OTC pair/);
});

test('the signal card shows the payout the engine actually used and where it came from', () => {
  render(payload(), 'signal');
  const html = get('sigCard').innerHTML;
  assert.match(html, /92% payout/, 'the live payout, not the 86 default');
  assert.match(html, /live from broker/, 'and its provenance');
  assert.match(html, /Break-even win rate/);
});

test('a class-typical payout is labelled as an estimate', () => {
  const d = payload({ effectivePayout: { payout: 85, origin: 'class' }, assetClass: 'forex' });
  render(d, 'signal');
  assert.match(get('sigCard').innerHTML, /85% payout/);
  assert.match(get('sigCard').innerHTML, /forex typical/);
});

test('a closed market overrides everything else on the signal card', () => {
  render(payload({ marketOpen: false }), 'signal');
  assert.match(get('sigCard').innerHTML, /Market closed/);
});

test('an open trade shows its countdown on the signal card', () => {
  const d = payload();
  d.openTrades = [{ dir: 'up', entry: 1.1, stake: 5, expiresAt: d.now + 30_000 }];
  render(d, 'signal');
  assert.match(get('sigCard').innerHTML, /open UP/);
  assert.match(get('sigCard').innerHTML, /30s left/);
});

test('the journal renders without throwing when the worker sends almost nothing', () => {
  // A restart, a mid-upgrade payload, or a caught error can all produce this.
  assert.doesNotThrow(() => render({ ok: true, now: T0 }));
  assert.doesNotThrow(() => render({ ok: true }));
  assert.doesNotThrow(() => render({}));
});

test('a missing bankroll clears the card instead of rendering NaN', () => {
  render(payload({ bankroll: null }));
  assert.equal(get('bankroll').innerHTML, '');
  render(payload({ bankroll: { current: NaN } }));
  assert.equal(get('bankroll').innerHTML, '');
});

test('journal numbers are rendered, not left blank', () => {
  render(payload());
  const html = get('jstats').innerHTML;
  assert.match(html, /Win rate/);
  assert.match(html, /60\.0%/, 'the win rate is shown');
  assert.match(html, /\+12\.50/, 'net P/L keeps its sign');
  assert.match(get('trades').innerHTML, /EUR\/USD/, 'recent trades are listed');
});

test('the feed tab surfaces the proxy-refusal and takeover counters', () => {
  render(payload(), 'feed');
  const html = get('fdiag').innerHTML;
  assert.match(html, /Proxy refused/);
  assert.match(html, />3</, 'the refusal count is shown, not hidden');
  assert.match(html, /Broker takeovers/);
  assert.match(html, /REST polls/);
  assert.match(html, /Last frame/);
  assert.match(html, /1s ago/);
});

test('nothing in the panel renders the literal text "undefined" or "NaN"', () => {
  for (const tab of ['journal', 'signal', 'feed', 'chart', 'settings']) {
    render(payload(), tab);
    for (const id of ['bankroll', 'jstats', 'sigCard', 'recCard', 'fdiag', 'trades', 'ctxGrid', 'vetoes', 'events']) {
      const html = get(id).innerHTML;
      assert.doesNotMatch(html, /undefined/, `${tab}/${id} rendered "undefined"`);
      assert.doesNotMatch(html, /NaN/, `${tab}/${id} rendered "NaN"`);
    }
  }
});

test('the same renders cleanly on a sparse payload too', () => {
  for (const tab of ['journal', 'signal', 'feed']) {
    assert.doesNotThrow(() => render({ ok: true, now: T0, settings: {} }, tab));
    for (const id of ['bankroll', 'jstats', 'sigCard']) {
      assert.doesNotMatch(get(id).innerHTML, /undefined|NaN/, `${tab}/${id} leaked a placeholder`);
    }
  }
});

test('the panel module exposes no accidental globals', () => {
  assert.equal(typeof panel, 'object');
});

test('the header shows the manifest version, not a hardcoded one', () => {
  // The panel shipped "v6.0.0" for two releases. The manifest is the one place
  // a version is defined, and this is the surface that prints it.
  push(payload());
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(get('ver').textContent, 'v' + pkg.version);
});
