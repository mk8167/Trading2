/* Service-worker startup.
 *
 * MV3 kills the worker whenever it likes, so boot() is not a once-in-a-session
 * event — it is what happens every time the user looks at the panel after a
 * pause. These tests rebuild that moment from a persisted snapshot and check
 * the things that only go wrong on a restart: the watched pair being evicted
 * while state is still loading, open trades losing their protection, a stale
 * signal cache that nothing ever prunes, and a fallback feed firing a request
 * for every pair it knows instead of the ones in use.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { install, alarms, reset as resetChrome } from './chrome-stub.mjs';

const { listeners } = install();
const store = await import('../src/background/store.js');
const settings = await import('../src/background/settings.js');
const ledger = await import('../src/background/ledger.js');
const engine = await import('../src/background/engine.js');
const binanceFeed = await import('../src/background/feeds/binance.js');

const T0 = 1_700_000_000_000;
const WATCHED = 'EURUSD_OTC';
const SNAPSHOT_KEY = 'market.snapshot.v6';

/* Build the state a worker would have left behind, then wipe it so that
 * restoration is something we can actually observe. */
for (let i = 0; i < 80; i++) store.ingestTick(WATCHED, 1.1 + i * 0.0001, T0 + i * 60_000, 'quotex');
store.refreshDerived(WATCHED);
store.ingestTick('BTCUSD', 60000, T0, 'quotex');
store.ingestTick('STALEUSD', 5, T0, 'quotex');

// Seed the engine's signal cache with a symbol the store is about to forget.
// peek() deliberately does NOT warm the settings cache — load() would, and
// then boot() would never read the selectedSym we are about to write.
engine.evaluate('STALEUSD', settings.peek());
assert.ok(engine.currentSignal('STALEUSD'), 'fixture: the stale signal must exist before boot');
store.symbols.delete('STALEUSD');

const snapshot = store.serialize();
// An unmistakable sentinel: if boot never re-saves, this is what stays in
// storage, and the "fresh snapshot" assertion below would pass for nothing.
snapshot.at = 1;
const openTrade = ledger.openTrade({
  sym: 'GBPUSD', dir: 'up', entry: 1.27, stake: 5, payout: 85, tf: 'm1',
  expiryMinutes: 60, signals: [], score: 5, confidence: 70, source: 'quotex',
});
const journalState = { trades: ledger.trades.slice(), events: ledger.events.slice() };

store.symbols.clear();
store.setSelected(null);
store.resetDiag();
ledger.reset();
resetChrome();

await chrome.storage.session.set({ [SNAPSHOT_KEY]: snapshot });
await chrome.storage.local.set({ settings: { selectedSym: WATCHED, feeds: { binance: true, yahoo: true } } });
await chrome.storage.local.set({ 'journal.v6': journalState });

/* Offline: every fallback fetch fails, but we still count the attempts so we
 * can see how many the worker decided to make. */
const fetched = [];
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  return { ok: false, status: 503, json: async () => null };
};

const { mock } = await import('node:test');
mock.timers.enable({ apis: ['setInterval'] });

await import('../src/background/index.js'); // boot() runs on import

/** Let boot()'s await chain (and the tick it starts) finish. */
const settle = async (ms = 60) => new Promise((r) => setTimeout(r, ms));
await settle();

test('the restart alarm is registered so a killed worker comes back', () => {
  assert.ok(alarms.has('qs-heartbeat'), 'chrome.alarms must re-wake the worker');
  assert.equal(alarms.get('qs-heartbeat').periodInMinutes, 0.5);
});

test('the snapshot is restored rather than starting from an empty chart', () => {
  assert.ok(store.symbols.size >= 2, `only ${store.symbols.size} symbols survived the restart`);
  const s = store.getSymbol(WATCHED);
  assert.ok(s, 'the watched pair came back');
  assert.ok(s.tf.m1.length > 0, 'with its candle history, not just its name');
  assert.equal(s.source, 'quotex', 'and it is still broker-owned');
});

test('the watched pair is selected after the restart', () => {
  assert.equal(store.selected, WATCHED, 'boot must restore the selection');
  assert.ok(store.isProtected(WATCHED), 'and protect it from eviction while state rebuilds');
});

test('open trades are reloaded and their symbols protected', () => {
  assert.equal(ledger.trades.length, 1, 'the journal survived the restart');
  assert.equal(ledger.trades[0].id, openTrade.id);
  assert.equal(ledger.trades[0].result, null, 'still open');
  assert.ok(store.isProtected('GBPUSD'), 'an open trade must never be evicted or pruned stale');
});

test('derived timeframes are rebuilt, not restored half-empty', () => {
  const s = store.getSymbol(WATCHED);
  store.refreshDerived(WATCHED);
  assert.ok(s.tf.m5.length > 0, 'm5 was rebuilt from m1');
  assert.ok(s.tf.m15.length > 0, 'm15 was rebuilt from m1');
});

test('a signal cached for a forgotten symbol is pruned during housekeeping', () => {
  // engine.prune() existed for a long time without anything calling it, so the
  // cache grew for the whole life of the worker. Boot runs housekeeping on the
  // first tick; this is how we know it still does.
  assert.equal(engine.currentSignal('STALEUSD'), null, 'the pruned symbol must leave the cache');
  assert.ok(engine.currentSignal(WATCHED) !== undefined, 'symbols still in the store keep their cache');
});

test('the first tick saves a fresh snapshot', async () => {
  const got = await chrome.storage.session.get(SNAPSHOT_KEY);
  const snap = got?.[SNAPSHOT_KEY];
  assert.ok(snap, 'a snapshot is in session storage');
  assert.equal(snap.v, 8, 'current snapshot version (v8 carries the broker candles)');
  assert.ok(snap.at > 1, 'boot actually rewrote it, this is not the fixture we planted');
  assert.ok(snap.symbols[WATCHED], 'and the watched pair is in it');
  assert.ok(Array.isArray(snap.symbols[WATCHED].m1), 'with its candles');
  assert.ok(!store.diag.errors.some((e) => /snapshot/.test(e)), 'saving did not error');
});

test('the fallback feeds are attempted, and fail cleanly while offline', () => {
  assert.ok(fetched.length > 0, 'the tick did try the fallback feeds');
  assert.ok(store.diag.errors.length > 0, 'and recorded why they failed');
  for (const s of store.symbols.values()) {
    assert.equal(s.source, 'quotex', 'a failed proxy fetch must not take ownership of anything');
  }
});

test('crypto polling is bounded instead of one request per known pair', () => {
  const binanceCalls = fetched.filter((u) => /binance\.vision/.test(u));
  const all = Object.keys(binanceFeed.CRYPTO).length;
  assert.ok(binanceCalls.length < all, `${binanceCalls.length} of ${all} pairs polled at once is the old behaviour`);
  assert.ok(binanceCalls.length <= 8, `${binanceCalls.length} concurrent REST calls per 30s is too many`);
});

test('the FX proxy polls one pair per cycle, rotating', () => {
  const yahooCalls = fetched.filter((u) => /finance\.yahoo\.com/.test(u));
  // Two hosts are tried per pair when the first fails.
  assert.ok(yahooCalls.length <= 2, `expected one pair (two host attempts), saw ${yahooCalls.length} calls`);
});

test('a broker-owned series is never handed to a proxy on restart', () => {
  assert.equal(store.diag.proxyRefusals >= 0, true);
  const btc = store.getSymbol('BTCUSD');
  assert.equal(btc.source, 'quotex', 'BTC/USD stayed broker-owned through a failing proxy poll');
});

test('broadcast survives having no tabs and no listeners', async () => {
  const { broadcast } = await import('../src/background/index.js');
  await assert.doesNotReject(() => broadcast({ type: 'state', ok: true }));
});

test('a second boot is a no-op rather than a second heartbeat', async () => {
  const before = fetched.length;
  const { broadcast } = await import('../src/background/index.js');
  assert.equal(typeof broadcast, 'function');
  await settle(20);
  // No second boot() means no second alarm registration storm and no second
  // burst of fallback requests beyond the normal heartbeat cadence.
  assert.ok(fetched.length - before <= 8, 're-importing must not re-run boot');
});

mock.timers.reset();

/* ------------------------- following the site ------------------------ */

/* The broker sends candles for the chart the user has open, so a history block
 * names the pair AND the timeframe the page is showing. Until this existed, the
 * extension kept its own pair and its own timeframe — which is exactly how the
 * site and the side panel ended up displaying two different charts. */

const historyFrame = (sym, tfMs, n = 10) => {
  const rows = Array.from({ length: n }, (_, i) => {
    const t = Math.floor((Date.now() - 20 * 60_000) / 60_000) * 60 + i * (tfMs / 1000);
    return [t, 1.2 + i * 0.001, 1.201 + i * 0.001, 1.199 + i * 0.001, 1.2005 + i * 0.001];
  });
  return {
    text: `42["history",{"s":"${sym}","data":${JSON.stringify(rows)}}]`,
    binary: false,
    url: 'wss://example.test/socket.io/',
  };
};

const deliver = (msg) => new Promise((res) => listeners.message[0](msg, { tab: { id: 7 } }, res));

test('history for another pair moves the extension onto the site\'s chart', async () => {
  const r = await deliver({ cmd: 'feed.batch', frames: [historyFrame('GBPJPY_otc', 300_000)] });
  assert.equal(r.history, 10, 'the block was stored');
  await settle();
  const s = await settings.load();
  assert.equal(s.selectedSym, 'GBPJPY_OTC', 'the pair is now the one the site charted');
  assert.equal(s.tf, 'm5', 'and so is the timeframe');
  assert.equal(store.selected, 'GBPJPY_OTC', 'the store is protecting what we are watching');
  assert.ok(store.isProtected('GBPJPY_OTC'));
});

test('with follow-the-site off, the user\'s own choice is not overridden', async () => {
  await settings.patch({ syncSite: false });
  const before = (await settings.load()).selectedSym;
  await deliver({ cmd: 'feed.batch', frames: [historyFrame('AUDCAD_otc', 900_000)] });
  await settle();
  const s = await settings.load();
  assert.equal(s.selectedSym, before, 'the extension stays where the user put it');
  assert.equal(s.tf, 'm5', 'and on the timeframe they had');
  await settings.patch({ syncSite: true });
});
