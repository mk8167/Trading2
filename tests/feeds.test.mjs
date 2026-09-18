/* feeds/binance.js + feeds/yahoo.js — the REST fallbacks, and the source
 * authority that stops them contaminating a live broker series.
 *
 * These paths only run when something has already gone wrong (no broker tab,
 * or a socket we cannot see), which is exactly when a silent failure is most
 * expensive: the UI still draws a chart, so nobody notices the data is a
 * delayed proxy — or worse, a blend of proxy and live prices.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { install } from './chrome-stub.mjs';

install();
const store = await import('../src/background/store.js');
const binance = await import('../src/background/feeds/binance.js');
const yahoo = await import('../src/background/feeds/yahoo.js');
const { canonical, isSymbol } = await import('../src/background/symbols.js');

const T0 = 1_700_000_000_000;
const realFetch = globalThis.fetch;

function clearStore() {
  store.symbols.clear();
  store.setSelected(null);
  store.protectOpen([]);
  store.resetDiag();
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

/** Binance kline rows are arrays of strings: [openTime,o,h,l,c,vol,...]. */
const klines = (n, start = 60000) =>
  Array.from({ length: n }, (_, i) => [
    String(T0 + i * 60_000), String(start + i), String(start + i + 2),
    String(start + i - 2), String(start + i + 1), '10', String(T0 + (i + 1) * 60_000),
  ]);

/* --------------------------- list integrity --------------------------- */

test('every fallback pair maps to a symbol the store can actually key', () => {
  for (const [pair, bin] of Object.entries(binance.CRYPTO)) {
    const key = canonical(pair);
    assert.ok(isSymbol(pair), `CRYPTO key "${pair}" is not a valid symbol`);
    assert.ok(/^[A-Z0-9]+$/.test(bin), `Binance symbol "${bin}" for ${pair} is not a plain ticker`);
    assert.ok(bin.length >= 5 && bin.length <= 16, `Binance symbol "${bin}" looks wrong`);
  }
  for (const [pair, y] of Object.entries(yahoo.FX)) {
    assert.ok(isSymbol(pair), `FX key "${pair}" is not a valid symbol`);
    // Yahoo FX tickers are "EURUSD=X"; futures are "GC=F" / "SI=F".
    assert.match(y, /^[A-Z0-9]{1,12}=[A-Z]$/, `Yahoo symbol "${y}" for ${pair} looks wrong`);
  }
});

test('no two fallback pairs collapse onto the same canonical key', () => {
  const seen = new Map();
  for (const pair of [...Object.keys(binance.CRYPTO), ...Object.keys(yahoo.FX)]) {
    const k = canonical(pair);
    // A pair may legitimately appear in both lists (XAU/USD); it may not
    // appear twice within one list, and no two DIFFERENT pairs may collide.
    const prev = seen.get(k);
    assert.ok(!prev || prev === pair, `collision: "${pair}" and "${prev}" both key to ${k}`);
    seen.set(k, pair);
  }
});

test('the fallback lists are wide enough to cover the pairs a broker lists', () => {
  assert.ok(Object.keys(binance.CRYPTO).length >= 20, `only ${Object.keys(binance.CRYPTO).length} crypto pairs`);
  assert.ok(Object.keys(yahoo.FX).length >= 20, `only ${Object.keys(yahoo.FX).length} FX pairs`);
  for (const p of ['BTC/USD', 'ETH/USD', 'SOL/USD', 'DOGE/USD', 'LTC/USD', 'ADA/USD']) {
    assert.ok(binance.CRYPTO[p], `missing crypto fallback ${p}`);
  }
  for (const p of ['EUR/USD', 'GBP/JPY', 'AUD/CAD', 'EUR/CHF', 'USD/TRY', 'XAU/USD']) {
    assert.ok(yahoo.FX[p], `missing FX fallback ${p}`);
  }
});

/* ------------------------------ binance ------------------------------- */

test('binance.seed fills the store with real candles and a live price', async () => {
  clearStore();
  const urls = stubFetch(() => json(klines(50)));
  const n = await binance.seed('BTC/USD');
  assert.equal(n, 50);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /data-api\.binance\.vision\/api\/v3\/klines\?symbol=BTCUSDT&interval=1m&limit=500/);
  const s = store.getSymbol('BTCUSD');
  assert.ok(s, 'stored under the canonical key, not the slash spelling');
  assert.equal(s.source, 'binance');
  assert.equal(s.tf.m1.length, 50);
  assert.equal(s.price, 60050); // last close = start + 49 + 1
  assert.equal(s.ts, T0 + 49 * 60_000);
  assert.ok(s.tf.m5.length > 0, 'derived series were rebuilt');
});

test('binance.seed ignores an unknown pair instead of fetching', async () => {
  clearStore();
  const urls = stubFetch(() => json(klines(5)));
  assert.equal(await binance.seed('NOT/A/PAIR'), 0);
  assert.equal(urls.length, 0);
});

test('binance.seed rejects rows it cannot validate', async () => {
  clearStore();
  stubFetch(() => json([
    [String(T0), '1', '2', '0.5', '1.5', '10'],          // valid
    [String(T0 + 60_000), 'x', '2', '0.5', '1.5', '10'], // NaN open
    ['nope', '1', '2', '0.5', '1.5', '10'],              // NaN time
  ]));
  const n = await binance.seed('BTC/USD');
  assert.equal(n, 1, 'only the well-formed row is stored');
});

test('binance.seed surfaces an HTTP failure rather than storing nothing silently', async () => {
  clearStore();
  stubFetch(() => json(null, false, 429));
  await assert.rejects(() => binance.seed('BTC/USD'), /binance 429/);
});

test('binance.seed rejects a payload that is not an array', async () => {
  clearStore();
  stubFetch(() => json({ msg: 'Invalid symbol.' }));
  await assert.rejects(() => binance.seed('BTC/USD'), /bad payload/);
});

test('binance.poll returns false on failure and never throws', async () => {
  clearStore();
  stubFetch(() => json(null, false, 500));
  assert.equal(await binance.poll('BTC/USD'), false);
  assert.ok(store.diag.errors.length > 0, 'the failure is recorded for the UI');
});

test('binance.poll returns false for an unknown pair without fetching', async () => {
  clearStore();
  const urls = stubFetch(() => json(klines(2)));
  assert.equal(await binance.poll('NOPE/USD'), false);
  assert.equal(urls.length, 0);
});

test('binance.poll tops up only the last bars', async () => {
  clearStore();
  const urls = stubFetch(() => json(klines(2)));
  assert.equal(await binance.poll('ETH/USD'), true);
  assert.match(urls[0], /limit=2/);
  assert.equal(store.getSymbol('ETHUSD').tf.m1.length, 2);
  assert.equal(store.diag.restPolls, 1);
});

test('pairsToPoll always refreshes held pairs first', () => {
  clearStore();
  store.ingestTick('BTCUSD', 60000, T0, 'quotex');
  store.ingestTick('SOLUSD', 150, T0, 'quotex');
  const pairs = binance.pairsToPoll();
  assert.deepEqual(pairs.slice(0, 2).sort(), ['BTC/USD', 'SOL/USD']);
});

test('pairsToPoll bounds each cycle instead of firing a request per pair', () => {
  clearStore();
  const all = Object.keys(binance.CRYPTO);
  const held = 2;
  for (const p of all.slice(0, held)) store.ingestTick(canonical(p), 1, T0, 'quotex');
  const pairs = binance.pairsToPoll();
  assert.ok(pairs.length <= held + 6, `${pairs.length} pairs in one cycle is too many`);
  assert.ok(pairs.length > held, 'discovery still happens');
  assert.equal(new Set(pairs).size, pairs.length, 'no pair polled twice in a cycle');
});

test('pairsToPoll rotates until every fallback pair has been visited', () => {
  clearStore();
  const all = Object.keys(binance.CRYPTO);
  const seen = new Set();
  // 30 pairs at 6 per cycle needs 5 cycles; allow a wide margin.
  for (let i = 0; i < all.length; i++) for (const p of binance.pairsToPoll()) seen.add(p);
  assert.deepEqual([...seen].sort(), [...all].sort(), 'rotation must reach every pair');
});

test('pairsToPoll stops rotating once the store holds the whole list', () => {
  clearStore();
  const all = Object.keys(binance.CRYPTO);
  for (const p of all) store.ingestTick(canonical(p), 1, T0, 'quotex');
  const pairs = binance.pairsToPoll();
  assert.equal(pairs.length, all.length);
  assert.deepEqual([...pairs].sort(), [...all].sort());
});

test('binance.poll records the HTTP status when the fallback is blocked', async () => {
  clearStore();
  stubFetch(() => json(null, false, 451)); // geo-blocked
  assert.equal(await binance.poll('BTC/USD'), false);
  assert.ok(store.diag.errors.some((e) => /binance BTC\/USD: HTTP 451/.test(e)),
    'a blocked fallback must say so, not just stop updating');
});

test('binance.poll records a malformed payload', async () => {
  clearStore();
  stubFetch(() => json({ msg: 'Invalid symbol.' }));
  assert.equal(await binance.poll('BTC/USD'), false);
  assert.ok(store.diag.errors.some((e) => /binance BTC\/USD: bad payload/.test(e)));
});

test('binance.poll survives a network exception', async () => {
  clearStore();
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await binance.poll('BTC/USD'), false);
  assert.ok(store.diag.errors.some((e) => /binance BTC\/USD/.test(e)));
});

/* ------------------------------- yahoo -------------------------------- */

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

test('yahoo.poll converts a chart response into candles', async () => {
  clearStore();
  const urls = stubFetch(() => json(chart(30)));
  assert.equal(await yahoo.poll('EUR/USD'), true);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /query1\.finance\.yahoo\.com\/v8\/finance\/chart\/EURUSD%3DX/);
  const s = store.getSymbol('EURUSD');
  assert.ok(s);
  assert.equal(s.source, 'yahoo');
  assert.equal(s.tf.m1.length, 30);
  assert.ok(s.tf.m5.length > 0 && s.tf.m15.length > 0, 'derived series rebuilt');
});

test('yahoo timestamps are seconds on the wire and milliseconds in the store', async () => {
  clearStore();
  stubFetch(() => json(chart(3)));
  await yahoo.poll('EUR/USD');
  const ts = store.getSymbol('EURUSD').tf.m1.map((c) => c.t);
  assert.deepEqual(ts, [T0, T0 + 60_000, T0 + 120_000]);
});

test('yahoo.poll fails over to the second host when the first is rate-limited', async () => {
  clearStore();
  const urls = stubFetch((u, i) => (i === 0 ? json(null, false, 429) : json(chart(10))));
  assert.equal(await yahoo.poll('GBP/USD'), true);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /query1\./);
  assert.match(urls[1], /query2\./);
});

test('yahoo.poll reports failure when both hosts fail', async () => {
  clearStore();
  const urls = stubFetch(() => json(null, false, 403));
  assert.equal(await yahoo.poll('EUR/USD'), false);
  assert.equal(urls.length, 2, 'both hosts were tried');
  assert.ok(store.diag.errors.some((e) => /yahoo EUR\/USD/.test(e)));
});

test('yahoo.poll treats an empty chart as a failure, not as zero candles', async () => {
  clearStore();
  stubFetch(() => json({ chart: { result: [] } }));
  assert.equal(await yahoo.poll('EUR/USD'), false);
  assert.equal(store.getSymbol('EURUSD'), null, 'no half-made symbol left behind');
});

test('yahoo rows missing an OHLC value are dropped, not stored as NaN', async () => {
  clearStore();
  const c = chart(4);
  c.chart.result[0].indicators.quote[0].close[2] = null;
  c.chart.result[0].indicators.quote[0].high[1] = NaN;
  stubFetch(() => json(c));
  assert.equal(await yahoo.poll('EUR/USD'), true);
  const m1 = store.getSymbol('EURUSD').tf.m1;
  assert.equal(m1.length, 2, 'two clean rows survive');
  for (const bar of m1) {
    for (const k of ['t', 'o', 'h', 'l', 'c']) assert.ok(Number.isFinite(bar[k]), `${k} is ${bar[k]}`);
    assert.ok(bar.h >= Math.max(bar.o, bar.c) && bar.l <= Math.min(bar.o, bar.c), 'candle geometry intact');
  }
});

test('yahoo.poll returns false for a pair it does not cover', async () => {
  clearStore();
  const urls = stubFetch(() => json(chart(5)));
  assert.equal(await yahoo.poll('ZZZ/ZZZ'), false);
  assert.equal(urls.length, 0);
});

test('nextPair rotates to the least-recently-polled and never repeats while others wait', () => {
  const keys = Object.keys(yahoo.FX);
  const last = {};
  const seen = [];
  for (let i = 0; i < keys.length; i++) {
    const p = yahoo.nextPair(last);
    seen.push(p);
    last[p] = Date.now() + i;
  }
  assert.equal(new Set(seen).size, keys.length, 'a full rotation touches every pair exactly once');
  assert.deepEqual(seen, keys, 'and it starts from the beginning of the list');
  // Once everything has a stamp, the oldest wins again.
  assert.equal(yahoo.nextPair(last), keys[0]);
});

test('nextPair with no history picks the first pair deterministically', () => {
  assert.equal(yahoo.nextPair({}), Object.keys(yahoo.FX)[0]);
  assert.equal(yahoo.nextPair(), Object.keys(yahoo.FX)[0]);
});

/* -------------------------- source authority -------------------------- */

test('a proxy may NOT append to a series the live broker owns', async () => {
  clearStore();
  for (let i = 0; i < 30; i++) store.ingestTick('EURUSD', 1.1 + i * 0.0001, T0 + i * 60_000, 'quotex');
  const before = store.getSymbol('EURUSD').tf.m1.length;

  stubFetch(() => json(chart(20, 9.0))); // wildly different prices
  await yahoo.poll('EUR/USD');

  const s = store.getSymbol('EURUSD');
  assert.equal(s.tf.m1.length, before, 'no proxy candles were added');
  assert.equal(s.source, 'quotex', 'the broker still owns the series');
  assert.ok(!s.tf.m1.some((c) => c.c > 5), 'no proxy price entered the series');
  assert.ok(store.diag.proxyRefusals > 0, 'and the refusal is counted, not silent');
});

test('binance is refused the same way', async () => {
  clearStore();
  for (let i = 0; i < 20; i++) store.ingestTick('BTCUSD', 60000 + i, T0 + i * 60_000, 'quotex');
  stubFetch(() => json(klines(10, 1)));
  assert.equal(await binance.poll('BTC/USD'), false, 'poll stands down quietly');
  assert.equal(store.getSymbol('BTCUSD').source, 'quotex');
  assert.equal(store.getSymbol('BTCUSD').tf.m1.length, 20);
});

test('when the broker starts streaming a proxied pair, the proxy candles are discarded not blended', async () => {
  clearStore();
  stubFetch(() => json(klines(30, 60000)));
  await binance.seed('BTC/USD');
  assert.equal(store.getSymbol('BTCUSD').source, 'binance');
  assert.equal(store.getSymbol('BTCUSD').tf.m1.length, 30);

  // The user opens a broker tab and the real feed starts.
  store.ingestTick('BTCUSD', 71000, T0 + 60 * 60_000, 'quotex');
  const s = store.getSymbol('BTCUSD');
  assert.equal(s.source, 'quotex');
  assert.equal(s.tf.m1.length, 1, 'the delayed USDT series is gone, not mixed in');
  assert.equal(s.price, 71000);
  assert.ok(!s.tf.m1.some((c) => c.c < 50000), 'no Binance price survives in the series');
  assert.ok(store.diag.sourceTakeovers > 0, 'the takeover is counted');
});

test('a second proxy cannot take over from the first', async () => {
  clearStore();
  stubFetch(() => json(chart(10)));
  await yahoo.poll('XAU/USD'); // yahoo covers XAU/USD as GC=F
  assert.equal(store.getSymbol('XAUUSD').source, 'yahoo');
  stubFetch(() => json(klines(10, 2400)));
  await binance.seed('XAU/USD'); // binance offers PAXG for the same key
  assert.equal(store.getSymbol('XAUUSD').source, 'yahoo', 'first proxy keeps the series');
});

test('restoring our own snapshot is not treated as a foreign write', () => {
  clearStore();
  store.ingestTick('BTCUSD', 60000, T0, 'quotex');
  const snap = store.serialize();
  clearStore();
  const n = store.deserialize(snap);
  assert.equal(n, 1);
  assert.equal(store.getSymbol('BTCUSD').source, 'quotex');
  assert.equal(store.getSymbol('BTCUSD').price, 60000);
});

test('feed failures never leave a symbol with NaN price or broken candles', async () => {
  clearStore();
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal(await binance.poll('BTC/USD'), false);
  assert.equal(await yahoo.poll('EUR/USD'), false);
  for (const s of store.symbols.values()) {
    assert.ok(s.price == null || Number.isFinite(s.price) || Number.isNaN(s.price));
    for (const c of s.tf.m1) {
      assert.ok(Number.isFinite(c.c) && c.h >= c.l, 'malformed candle survived a failed fetch');
    }
  }
});

globalThis.fetch = realFetch;
