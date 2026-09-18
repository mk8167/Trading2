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

/* ---------------------------- the pair picker -------------------------- */

/* The picker listed ~67 instruments and exactly one of them could have data.
 * Nothing on screen distinguished a streaming pair from one that was quiet,
 * from one that would be fetched on selection, from one no external feed can
 * ever serve — so picking a dead pair produced an empty chart and the only
 * available reading was "the extension stopped working". These check the
 * markers and the explanatory line actually render. */

/** A catalog covering all four situations the markers have to tell apart. */
function pickerPayload(over = {}) {
  return payload({
    catalog: {
      quotex: ['EURUSD_OTC', 'GBPUSD', 'USDJPY_OTC'],
      crypto: ['BTCUSD'],
      fx: ['NZDJPY'],
    },
    symbols: [
      { sym: 'EURUSD_OTC', pretty: 'EUR/USD OTC', source: 'quotex', otc: true, stale: false, bars: 60 },
      { sym: 'GBPUSD', pretty: 'GBP/USD', source: 'quotex', otc: false, stale: true, bars: 40 },
    ],
    ...over,
  });
}

test('the picker marks each pair with what its feed can actually do', () => {
  render(pickerPayload(), 'chart');
  const html = get('pair').innerHTML;
  assert.match(html, /● EUR\/USD OTC/, 'streaming now');
  assert.match(html, /○ GBP\/USD/, 'has candles but the feed went quiet');
  assert.match(html, /⚠ USD\/JPY OTC/, 'only the site can ever feed this one');
  assert.match(html, /↓ BTC\/USD/, 'no data yet, but picking it starts a fetch');
  assert.match(html, /↓ NZD\/JPY/, 'same for the FX proxy list');
  assert.match(html, /title="[^"]*only the site can feed/, 'and hovering says why');
});

test('the line under the picker explains a pair that cannot be fed here', () => {
  render(
    pickerPayload({
      symbol: null,
      selection: {
        sym: 'USDJPY_OTC', reason: 'otc-site-only', pending: false,
        text: 'USD/JPY OTC is broker-generated (OTC), so no external feed exists for it. Only the site can stream this pair — open its chart there.',
      },
    }),
    'chart'
  );
  assert.match(get('pairNote').innerHTML, /broker-generated/, 'says what the pair is');
  assert.match(get('pairNote').innerHTML, /Only the site can stream/, 'and what to do about it');
  assert.match(get('pairNote').className, /warn/);
});

test('a fetch in flight reads as fetching, not as no feed', () => {
  render(
    pickerPayload({
      symbol: null,
      selection: { sym: 'BTCUSD', reason: 'proxy-cold', pending: true, text: 'BTC/USD has no data yet; fetching its history from binance…' },
    }),
    'chart'
  );
  assert.match(get('conn').textContent, /fetching/, 'the header must not claim the feed is dead');
  assert.doesNotMatch(get('conn').textContent, /no feed/);
  assert.match(get('pairNote').className, /wait/);
  assert.match(get('pairNote').innerHTML, /fetching its history/);
});

test('a healthy live pair gets a plain note, not a warning', () => {
  render(
    pickerPayload({
      selection: {
        sym: 'EURUSD_OTC', reason: 'broker-live', pending: false,
        text: "EUR/USD OTC is streaming from the site right now — this is the broker's own live feed.",
      },
    }),
    'chart'
  );
  assert.match(get('pairNote').className, /ok/);
  assert.doesNotMatch(get('pairNote').innerHTML, /⚠/);
  assert.doesNotMatch(get('conn').textContent, /no feed/);
});

test('a payload with no selection verdict renders nothing and throws nothing', () => {
  const d = pickerPayload();
  delete d.selection;
  assert.doesNotThrow(() => render(d, 'chart'));
  assert.equal(get('pairNote').innerHTML, '');
  assert.match(get('pairNote').className, /^pairnote$/);
});

test('the picker still works when the catalog arrives in the old shape', () => {
  // The fixture this file has always used ships `catalog: []`; a worker that
  // predates the object shape must not blank the picker or throw.
  assert.doesNotThrow(() => render(payload(), 'chart'));
});

/* ------------- the page that produced the bug report --------------------- */

/*
 * What the panel actually said next to a live broker chart: "yahoo feed",
 * "candle sync ✗", "0s to close", and a green "✓ LIVE — ticks every frame on
 * 33 instrument(s)" banner, on a page where not one broker frame had ever
 * arrived. Every one of those lines was true of the REST proxies and false
 * about what the user was looking at, which is worse than saying nothing.
 */

/** Candles whose newest bar is still forming at the fixture's `now`, so the
 *  countdown has something real to count down to. */
const NOW = T0 + 60 * 60_000;
const liveBars = (n = 60) =>
  Array.from({ length: n }, (_, i) => ({
    t: NOW - 20_000 - (n - 1 - i) * 60_000,
    o: 1.1 + i * 1e-5, h: 1.1004 + i * 1e-5, l: 1.0996 + i * 1e-5, c: 1.1002 + i * 1e-5,
  }));

test('the feed banner cannot call a proxy-only page LIVE', () => {
  render(payload({
    symbols: [{ sym: 'GBPUSD', pretty: 'GBP/USD', assetClass: 'forex', otc: false, source: 'yahoo', price: 1.3, ts: T0, payout: 65, ticks: 0, bars: 120, stale: false, selected: true }],
    diag: { frames: 0, ticks: 0, brokerTicks: 0, sockets: 0, brokerRows: 0, restPolls: 383, pairs: 1, lastFrameAge: null, uptime: 60_000, errors: [], samples: [], methods: {} },
  }), 'feed');
  const line = get('fdiag-line').innerHTML;

  assert.doesNotMatch(line, /✓ LIVE/, 'a delayed proxy is not a live feed');
  assert.match(line, /NOT LIVE/, 'the page has to say so plainly');
  assert.match(line, /REST proxy, not the broker/, 'and say what it is instead');
  assert.match(line, /Grant &amp; install/, 'and name the one fix that applies: the hook is not on this domain');
  assert.match(get('fdiag').innerHTML, /Broker ticks/, 'the Feed tab shows the broker-only counter');
});

test('broker ticks alone switch the banner back to LIVE', () => {
  render(payload({
    symbols: [
      { sym: 'AAPL', pretty: 'Apple', assetClass: 'stock', otc: false, source: 'quotex', price: 200, ts: T0, payout: 68, ticks: 900, bars: 60, stale: false, selected: true },
      { sym: 'BTCUSD', pretty: 'BTC/USD', assetClass: 'crypto', otc: false, source: 'binance', price: 60000, ts: T0, payout: 80, ticks: 12, bars: 120, stale: false },
    ],
    diag: { frames: 40, ticks: 912, brokerTicks: 900, sockets: 2, brokerRows: 60, pairs: 2, restPolls: 3, lastFrameAge: 900, uptime: 60_000, errors: [], samples: [], methods: {} },
  }), 'feed');
  const line = get('fdiag-line').innerHTML;

  assert.match(line, /✓ LIVE — broker ticks on 1 instrument/);
  assert.match(line, /1 more on REST proxies/, 'both populations are reported, not just the flattering one');
});

test('a delayed proxy does not get a countdown clock', () => {
  const cs = liveBars(60);
  render(payload({
    sync: {
      source: 'yahoo', aligned: false, tickAgeSec: 900, barsFrom: 'ticks', bars: 60,
      delayed: true, dataAgeSec: 900, signalTf: 'm1', followSite: true, formingOpen: cs.at(-1).t, expectedOpen: cs.at(-1).t + 60_000,
    },
    candles: { m1: cs, m5: bars(12), m15: bars(4) },
    secondsToClose: 21,
  }), 'chart');

  const readout = get('readout').textContent;
  assert.match(readout, /axis UTC/, 'the axis timezone is stated, because the site draws UTC');

  const sync = get('preview').innerHTML;
  assert.match(sync, /delayed yahoo copy/);
  assert.match(sync, /~15m behind the site/, 'the actual delay is named');
  assert.match(sync, /countdown above run on the proxy.s clock/, 'and the countdown is disowned');
  assert.doesNotMatch(sync, /seconds to close/);

  assert.match(get('clock').textContent, /delayed proxy clock/, 'the header clock stops counting down to a close that already happened');
});

test('a live broker series keeps its ordinary sync line and countdown', () => {
  const cs = liveBars(60);
  render(payload({
    sync: {
      source: 'quotex', aligned: true, tickAgeSec: 2, barsFrom: 'broker', bars: 60,
      delayed: false, dataAgeSec: 0, signalTf: 'm1', followSite: true,
    },
    candles: { m1: cs, m5: bars(12), m15: bars(4) },
    secondsToClose: 21,
  }), 'chart');

  const sync = get('preview').innerHTML;
  assert.match(sync, /candle sync ✓/);
  assert.doesNotMatch(sync, /delayed/);
  assert.match(get('clock').textContent, /s to close/);
});

/* --------------- installing the hook on a domain we cannot see ----------- */

/*
 * The screenshot case again, from the other end: the fix for a page whose hook
 * was never injected is Settings → "Grant & install". Chrome will not report a
 * tab's address to an extension that has no access to it, so the first click
 * comes back empty — and the old copy answered that with "Enter a full origin,
 * e.g. https://example.com", which describes neither the problem nor the fix.
 * After the grant the page also has to be reloaded, because the bridge runs at
 * document_start and the page in front of the user is already loaded.
 */

test('granting a domain Chrome will not name says why, then finishes the job', async () => {
  const reloaded = [];
  chrome.permissions = { request: async () => true };
  chrome.tabs = {
    query: async (q) => (q.url ? [{ id: 7 }, { id: 9 }] : [{ id: 7 }, { id: 9, url: undefined }]),
    reload: async (id) => reloaded.push(id),
  };

  get('sOrigin').value = '';
  get('sGrant').emit('click');
  await new Promise((r) => setTimeout(r, 5));
  const first = get('grantOut').textContent;
  assert.match(first, /withholds this page's address|Type the site address/);
  assert.doesNotMatch(first, /^Enter a full origin, e\.g\./, 'a dead end is not an explanation');

  nextResponse = { ok: true, pattern: 'https://broker.example/*' };
  get('sOrigin').value = 'https://broker.example';
  get('sGrant').emit('click');
  await new Promise((r) => setTimeout(r, 5));

  assert.deepEqual(reloaded, [7, 9], 'every open tab on that domain is reloaded so the hook actually runs');
  assert.match(get('grantOut').textContent, /reloaded 2 tabs/);
  nextResponse = { ok: false };
});


test('a dead feed tells the two possible causes apart', async () => {
  const dead = {
    symbols: [],
    diag: { frames: 0, ticks: 0, brokerTicks: 0, sockets: 0, brokerRows: 0, pairs: 0, restPolls: 383, lastFrameAge: null, uptime: 60_000, errors: [], samples: [], methods: {} },
  };
  // The verdict uses the address cached by the previous render and refreshes
  // it in the background, so it takes a couple of cycles to settle — which is
  // fine in the panel, where a push arrives every second.
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const renderFeed = async () => {
    for (let i = 0; i < 3; i++) {
      render(payload(dead), 'feed');
      await settle();
    }
  };

  // Case A — Chrome will not name the page: the extension has no access there.
  chrome.tabs = { query: async () => [{ id: 3 }], reload: async () => {} };
  await renderFeed();
  const noAccess = get('fdiag-line').innerHTML;
  assert.match(noAccess, /will not even show this extension the page address/);
  assert.match(noAccess, /grant it in Options → Site access/);

  // Case B — Chrome names the page, so the hook IS installed there; granting it
  // again would be advice that cannot change anything.
  chrome.tabs = { query: async () => [{ id: 3, url: 'https://broker.example/trade' }], reload: async () => {} };
  await renderFeed();
  const hasAccess = get('fdiag-line').innerHTML;
  assert.match(hasAccess, /DOES have access to https:\/\/broker\.example/);
  assert.match(hasAccess, /Web Worker|reload it/);
  assert.doesNotMatch(hasAccess, /grant it in Options/, 'it is already granted — that is not the problem here');
});

test('a live proxy is not called "delayed" — only a slow one is', () => {
  // Binance's crypto feed is current; Yahoo's is a quarter of an hour behind.
  // Both are "not the broker's feed", but only one of them is late, and the
  // countdown warning has to match which.
  const cs = liveBars(60);
  render(payload({
    sync: {
      source: 'binance', aligned: true, tickAgeSec: 4, barsFrom: 'ticks', bars: 60,
      delayed: true, dataAgeSec: 20, signalTf: 'm1', followSite: true,
    },
    candles: { m1: cs, m5: liveBars(12), m15: liveBars(4) },
    secondsToClose: 41,
  }), 'chart');

  const sync = get('preview').innerHTML;
  assert.match(sync, /binance proxy — this is not the broker's own feed/);
  assert.doesNotMatch(sync, /~\d+m behind/, 'a 20-second-old bar is not "behind"');
  assert.doesNotMatch(sync, /delayed/);
  assert.match(get('clock').textContent, /delayed proxy clock/, 'the countdown is still not the site clock');
});
