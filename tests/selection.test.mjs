/* Selecting a pair has to mean something.
 *
 * The picker offered ~67 instruments and exactly one of them could ever have
 * data — the pair the broker happened to be streaming. Every other choice
 * wrote a name into settings and stopped: no symbol was created, no request
 * was fired, and both REST fallbacks kept serving their own rotations
 * (Binance six unseen pairs per cycle, Yahoo one oldest-first pick per minute
 * out of 37). The result on screen was an empty chart, a dash for the price
 * and "no data" for the signal, which is indistinguishable from a broken
 * extension.
 *
 * These tests cover the three things that had to become true: a selection
 * fetches, the pollers serve the pair being watched, and a pair that CANNOT be
 * fetched here says so in words instead of showing a blank.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { install } from './chrome-stub.mjs';

// The stub must exist before the background modules are evaluated.
install();
const store = await import('../src/background/store.js');
const select = await import('../src/background/feeds/select.js');
const binance = await import('../src/background/feeds/binance.js');
const yahoo = await import('../src/background/feeds/yahoo.js');
const { handleMessage } = await import('../src/background/api.js');

const T0 = 1_700_000_000_000; // far enough in the past to count as stale
const realFetch = globalThis.fetch;

function clearStore() {
  store.symbols.clear();
  store.setSelected(null);
  store.protectOpen([]);
  store.resetDiag();
  select.resetSelectionFeeds();
}

/** Install a fetch stub; returns the list of URLs it was called with. */
function stubFetch(handler) {
  const urls = [];
  globalThis.fetch = async (url, opts) => {
    urls.push(String(url));
    return handler(String(url), urls.length - 1, opts);
  };
  return urls;
}
const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
const klines = (n, start = 60000) =>
  Array.from({ length: n }, (_, i) => [
    String(T0 + i * 60_000), String(start + i), String(start + i + 2),
    String(start + i - 2), String(start + i + 1), '10', String(T0 + (i + 1) * 60_000),
  ]);
const chart = (n = 30, start = 1.1) => ({
  chart: {
    result: [{
      timestamp: Array.from({ length: n }, (_, i) => (T0 + i * 60_000) / 1000),
      indicators: {
        quote: [{
          open: Array.from({ length: n }, (_, i) => start + i * 0.001),
          high: Array.from({ length: n }, (_, i) => start + i * 0.001 + 0.002),
          low: Array.from({ length: n }, (_, i) => start + i * 0.001 - 0.002),
          close: Array.from({ length: n }, (_, i) => start + i * 0.001 + 0.001),
        }],
      },
    }],
  },
});
/** One response per feed, so a test can let either fallback succeed. */
const anyFeed = (bars = 80) => (u) => (/binance\.vision/.test(u) ? json(klines(bars)) : json(chart(bars)));
const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));

/* ------------------------- which feed serves a key --------------------- */

test('both fallback lists resolve from a canonical key', () => {
  assert.deepEqual(select.feedFor('BTCUSD'), { source: 'binance', pair: 'BTC/USD' });
  assert.deepEqual(select.feedFor('btc/usd'), { source: 'binance', pair: 'BTC/USD' }, 'spelling must not matter');
  assert.deepEqual(select.feedFor('NZDJPY'), { source: 'yahoo', pair: 'NZD/JPY' });
  assert.equal(select.feedFor('EURUSD_OTC'), null, 'an OTC instrument has no external feed at all');
  assert.equal(select.feedFor(null), null);
});

test('XAU/USD belongs to one feed, not two', () => {
  // Binance lists it as PAXG and Yahoo as a futures contract; buildCatalog()
  // gives it to Binance, so the picker must not resolve it to Yahoo and fetch
  // a different underlying than the one the dropdown promised.
  assert.equal(select.feedFor('XAUUSD').source, 'binance');
});

/* ----------------------------- select = fetch -------------------------- */

test('selecting a cold crypto pair fetches its whole history at once', async () => {
  clearStore();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const urls = stubFetch(async () => {
    await gate;
    return json(klines(120));
  });
  const d = select.request('BTCUSD');
  assert.equal(d.reason, 'proxy-cold');
  assert.equal(d.pending, true, 'the UI can say "fetching…" instead of "no feed"');
  assert.equal(urls.length, 1, 'the request goes out straight away');
  assert.equal(store.getSymbol('BTCUSD'), null, 'and the caller is not held hostage while it is in the air');
  release();
  await settle();
  assert.match(urls[0], /symbol=BTCUSDT/);
  assert.match(urls[0], /limit=500/, 'a seed, not the two-bar top-up');
  assert.ok(store.getSymbol('BTCUSD').tf.m1.length > 0, 'the history landed in the store');
  assert.equal(select.describe('BTCUSD').pending, false);
});

test('selecting a cold FX pair fetches it now instead of in ~37 minutes', async () => {
  clearStore();
  const urls = stubFetch(anyFeed());
  assert.equal(select.request('NZDJPY').reason, 'proxy-cold');
  await settle();
  assert.equal(urls.length, 1);
  assert.match(urls[0], /finance\.yahoo\.com/);
  assert.match(urls[0], /NZDJPY/);
  assert.ok(store.getSymbol('NZDJPY').tf.m1.length > 0);
});

test('a burst of clicks on one pair is a single request', async () => {
  clearStore();
  const urls = stubFetch(anyFeed());
  for (let i = 0; i < 5; i++) assert.equal(select.request('SOLUSD').pending, true);
  await settle();
  assert.equal(urls.length, 1, 'the in-flight guard must collapse the burst');
});

test('the UI is pushed fresh state when a selection fetch lands', async () => {
  clearStore();
  stubFetch(anyFeed(60));
  let pushed = 0;
  select.setSelectionNotifier(() => {
    pushed++;
  });
  select.request('ETHUSD');
  assert.equal(pushed, 0, 'not before the rows are actually in the store');
  await settle();
  assert.equal(pushed, 1, 'the chart fills in on its own rather than waiting for the next poll');
  select.setSelectionNotifier(null);
});

test('a failing fetch is reported, not swallowed', async () => {
  clearStore();
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  select.request('LINKUSD');
  await settle();
  assert.ok(
    store.diag.errors.some((e) => /select LINK\/USD/.test(e)),
    `a dead fetch must leave a trace, got: ${JSON.stringify(store.diag.errors)}`
  );
  assert.equal(select.describe('LINKUSD').pending, false, 'and it must not stay "fetching…" forever');
});

/* -------------------- pairs that cannot be fetched here ---------------- */

test('a pair the broker is streaming is left to the broker', async () => {
  clearStore();
  const urls = stubFetch(anyFeed());
  store.ingestTick('BTCUSD', 60000, Date.now(), 'quotex');
  const d = select.request('BTCUSD');
  assert.equal(d.reason, 'broker-live');
  assert.equal(urls.length, 0, 'a proxy must not chase a pair the site is already feeding');
  assert.match(d.text, /streaming from the site/);
});

test('a broker pair that went quiet is not refilled from a delayed proxy', async () => {
  clearStore();
  const urls = stubFetch(anyFeed());
  store.ingestTick('EURUSD', 1.1, T0, 'quotex');
  const d = select.request('EURUSD');
  assert.equal(d.reason, 'broker-idle');
  assert.equal(urls.length, 0);
  assert.match(d.text, /site/, 'the only way back is the site charting it again');
});

test('an OTC pair says out loud that no external feed exists', async () => {
  clearStore();
  const urls = stubFetch(anyFeed());
  const d = select.request('EURUSD_OTC');
  assert.equal(d.reason, 'otc-site-only');
  assert.equal(urls.length, 0);
  assert.match(d.text, /OTC/);
  assert.match(d.text, /no external feed/);
});

test('a fresh proxy pair is not re-fetched on every click', async () => {
  clearStore();
  const urls = stubFetch(anyFeed());
  store.ingestTick('BTCUSD', 60000, Date.now(), 'binance');
  assert.equal(select.request('BTCUSD').reason, 'proxy-live');
  await settle();
  assert.equal(urls.length, 0, 'Yahoo and Binance both rate-limit; a re-select is not a reason to ask again');
});

test('a stale proxy pair is refreshed when it is picked again', async () => {
  clearStore();
  const urls = stubFetch(anyFeed());
  store.ingestTick('BTCUSD', 60000, T0, 'binance');
  assert.equal(select.request('BTCUSD').reason, 'proxy-stale');
  await settle();
  assert.equal(urls.length, 1);
});

test('every verdict the picker can produce has something to say', () => {
  clearStore();
  store.ingestTick('EURUSD_OTC', 1.1, Date.now(), 'quotex');
  store.ingestTick('GBPUSD', 1.3, T0, 'quotex');
  store.ingestTick('BTCUSD', 60000, Date.now(), 'binance');
  store.ingestTick('SOLUSD', 150, T0, 'binance');
  const cases = {
    'broker-live': 'EURUSD_OTC',
    'broker-idle': 'GBPUSD',
    'proxy-live': 'BTCUSD',
    'proxy-stale': 'SOLUSD',
    'proxy-cold': 'DOGEUSD',
    'otc-site-only': 'USDJPY_OTC',
    'no-source': 'ZZZYYY',
  };
  const seen = new Set();
  for (const [reason, sym] of Object.entries(cases)) {
    const d = select.describe(sym);
    assert.equal(d.reason, reason, `${sym} should read as ${reason}, got ${d.reason}`);
    assert.ok(typeof d.text === 'string' && d.text.length > 20, `${reason} printed no explanation`);
    assert.equal(typeof d.pending, 'boolean');
    seen.add(reason);
  }
  assert.equal(seen.size, Object.keys(cases).length);
  assert.equal(select.describe(null), null);
});

/* --------------------- the pollers serve what is watched --------------- */

test('the watched pair jumps the Binance discovery queue', () => {
  clearStore();
  const pairs = binance.pairsToPoll('DOGEUSD');
  assert.equal(pairs[0], 'DOGE/USD', 'the pair on screen must not wait behind six rotating ones');
  assert.equal(new Set(pairs).size, pairs.length, 'and it must not be polled twice in one cycle');
});

test('the discovery bound still holds with a watched pair added', () => {
  clearStore();
  store.ingestTick('BTCUSD', 60000, T0, 'quotex');
  const pairs = binance.pairsToPoll('DOGEUSD');
  // One held pair + six discovery + at most one for the pair being watched.
  assert.ok(pairs.length <= 1 + 6 + 1, `${pairs.length} requests in one 30 s cycle is too many`);
  assert.equal(pairs[0], 'DOGE/USD');
  assert.equal(new Set(pairs).size, pairs.length, 'a pair in both the queue and the rotation is one request');
});

test('pairsToPoll with no selection is unchanged', () => {
  clearStore();
  const pairs = binance.pairsToPoll();
  assert.equal(pairs.length, 6, 'empty store: discovery only, still bounded');
  assert.equal(pairs.length, new Set(pairs).size);
});

test('the watched FX pair takes the next Yahoo slot, then gives it back', () => {
  clearStore();
  const last = {};
  assert.equal(yahoo.nextPair(last, 'NZDJPY'), 'NZD/JPY', 'never polled: it goes first, not in 37 minutes');
  last['NZD/JPY'] = Date.now();
  assert.notEqual(yahoo.nextPair(last, 'NZDJPY'), 'NZD/JPY', 'fresh: the rotation gets its turn back, so the ranker still warms up');
  last['NZD/JPY'] = Date.now() - (yahoo.SELECTED_REFRESH_MS + 1000);
  assert.equal(yahoo.nextPair(last, 'NZDJPY'), 'NZD/JPY', 'and it comes back once it has gone without a refresh');
});

test('nextPair ignores a selection no FX feed covers', () => {
  clearStore();
  assert.equal(yahoo.nextPair({}, 'EURUSD_OTC'), Object.keys(yahoo.FX)[0]);
  assert.equal(yahoo.nextPair({}, null), Object.keys(yahoo.FX)[0]);
});

/* ------------------------------ message surface ----------------------- */

test('symbols.select answers with the verdict and starts the fetch', async () => {
  clearStore();
  const urls = stubFetch(anyFeed(120));
  const r = await handleMessage({ cmd: 'symbols.select', sym: ' btc/usd ' }, null);
  assert.equal(r.ok, true);
  assert.equal(r.selectedSym, 'BTCUSD', 'the canonical key is what gets stored, whatever the spelling');
  assert.equal(r.selection.reason, 'proxy-cold');
  await settle();
  assert.equal(urls.length, 1, 'selecting is what fires the request now');
  assert.ok(store.getSymbol('BTCUSD').tf.m1.length > 0);
});

test('settings.patch on selectedSym fetches too, so no path is a dead end', async () => {
  clearStore();
  const urls = stubFetch(anyFeed());
  const r = await handleMessage({ cmd: 'settings.patch', patch: { selectedSym: 'ADAUSD' } }, null);
  assert.equal(r.ok, true);
  await settle();
  assert.equal(urls.length, 1);
  assert.ok(store.getSymbol('ADAUSD').tf.m1.length > 0);
});

test('state.get carries the explanation the UI prints', async () => {
  clearStore();
  stubFetch(anyFeed());
  await handleMessage({ cmd: 'symbols.select', sym: 'USDJPY_OTC' }, null);
  const s = await handleMessage({ cmd: 'state.get' }, null);
  assert.equal(s.selectedSym, 'USDJPY_OTC');
  assert.equal(s.selection.reason, 'otc-site-only');
  assert.ok(s.selection.text.length > 20, 'the panel needs words, not a code');
  assert.equal(s.symbol, null, 'and there is still no data — which is now explained rather than silent');
});

/* The heartbeat itself is not callable from a test (index.js boots on import),
 * so the wiring from the watched pair into both pollers is checked the way this
 * repo checks the other things that only break silently: by reading the source. */
test('the heartbeat hands the watched pair to both fallbacks', () => {
  const src = fs.readFileSync(new URL('../src/background/index.js', import.meta.url), 'utf8');
  assert.match(src, /pairsToPoll\(watching\)/, 'Binance is not being told what is on screen');
  assert.match(src, /nextPair\(lastYahooStamp, watching\)/, 'Yahoo is not being told what is on screen');
  assert.match(src, /setSelectionNotifier\(/, 'a landed fetch would not reach the UI until the next poll');
});

globalThis.fetch = realFetch;
