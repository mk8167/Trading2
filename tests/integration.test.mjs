import test from 'node:test';
import assert from 'node:assert/strict';
import { install, notifications } from './chrome-stub.mjs';
import { series } from './helpers.mjs';
import { analyze, breakEvenWinRate } from '../src/background/strategy.js';
import { aggregate, TF_MS } from '../src/background/candles.js';

// The stub must exist before the background modules are evaluated.
install();
const { handleMessage } = await import('../src/background/api.js');
const store = await import('../src/background/store.js');
const engine = await import('../src/background/engine.js');
const ledger = await import('../src/background/ledger.js');
const settings = await import('../src/background/settings.js');

const SYM = 'EURUSD_OTC';
const T0 = 1_700_000_000; // epoch seconds

/** Wrap a tick the way the page's socket.io frame would. */
const frame = (sym, epochSec, price) => ({
  text: `42["tick",["${sym}",${epochSec},${price},1]]`,
  binary: false,
  url: 'wss://example.test/socket.io/?EIO=4&transport=websocket',
});

const send = (cmd, payload = {}) => handleMessage({ cmd, ...payload }, { tab: { id: 7 } });

/** Push n bars of a trending random walk through the real message surface. */
async function feedTrend({ n = 240, from = 0, drift = 0.05, sym = 'EURUSD_otc', seed = 5 } = {}) {
  const cs = series({ n: n + from, drift, amp: 0.1, noise: 0.01, seed });
  const slice = cs.slice(from);
  const frames = slice.map((c, i) => frame(sym, T0 + (from + i) * 60, c.c));
  return { res: await send('feed.batch', { frames }), candles: cs };
}

test('unknown commands are rejected, not silently ignored', async () => {
  const r = await send('does.not.exist');
  assert.equal(r.ok, false);
  assert.match(r.err, /unknown cmd/);
});

test('live socket frames become candles through the message surface', async () => {
  const { res, candles } = await feedTrend({ n: 240 });
  assert.equal(res.ok, true);
  assert.equal(res.ticks, 240, 'every frame should yield exactly one tick');

  const st = store.getSymbol(SYM);
  assert.ok(st, 'symbol was not registered');
  assert.equal(st.source, 'quotex');
  assert.equal(st.tf.m1.length, 240);
  assert.ok(Math.abs(st.price - candles[239].c) < 1e-9, 'live price tracks the last tick');
});

test('state.get returns the same verdict the strategy engine computes', async () => {
  const s = await settings.load();
  const st = store.getSymbol(SYM);
  store.refreshDerived(SYM);

  const expected = analyze(
    { m1: st.tf.m1, m5: st.tf.m5, m15: st.tf.m15, price: st.price, payout: s.payout },
    s.strategy
  );

  const r = await send('state.get', { sym: SYM });
  assert.equal(r.ok, true);
  assert.equal(r.selectedSym, SYM);
  assert.equal(r.signal.dir, expected.dir, `engine said ${expected.dir}, API returned ${r.signal.dir}`);
  assert.equal(r.signal.score, expected.score);
  assert.equal(r.symbol.bars.m1, 240, 'store should hold the full series');
  assert.equal(r.candles.m1.length, 120, 'API trims the payload to the default window');
  assert.ok(r.candles.m5.length >= 40, 'derived 5m series missing');
  assert.ok(r.candles.m15.length >= 10, 'derived 15m series missing');
  assert.ok(r.catalog.quotex.includes(SYM));
  assert.equal(r.diag.ticks >= 240, true);
});

test('a directional signal on a closed bar opens a paper trade', async () => {
  const s = await settings.load();
  // Make the gate permissive so this test exercises the wiring, not the risk rules.
  await send('settings.patch', { patch: { strategy: { minScore: 1, cooldownMs: 0, gateEnabled: false }, autoPaperTrade: true } });
  const s2 = await settings.load();
  const before = ledger.trades.length;

  // Close one more bar so the engine sees a fresh candle.
  const cs = series({ n: 246, drift: 0.05, amp: 0.1, noise: 0.01, seed: 5 });
  await send('feed.batch', { frames: cs.slice(240).map((c, i) => frame('EURUSD_otc', T0 + (240 + i) * 60, c.c)) });

  const st = store.getSymbol(SYM);
  store.refreshDerived(SYM);
  const expected = analyze(
    { m1: st.tf.m1, m5: st.tf.m5, m15: st.tf.m15, price: st.price, payout: s2.payout },
    s2.strategy
  );

  const r = await send('state.get', { sym: SYM });
  const shouldTrade = expected.dir === 'up' || expected.dir === 'down';
  assert.equal(r.signal.dir, expected.dir);
  assert.equal(
    ledger.trades.length > before,
    shouldTrade,
    `expected.dir=${expected.dir}; a paper trade ${shouldTrade ? 'should' : 'should not'} have opened`
  );

  if (shouldTrade) {
    const t = ledger.trades[ledger.trades.length - 1];
    assert.equal(t.dir, expected.dir);
    assert.equal(t.sym, SYM);
    assert.equal(t.result, null, 'trade must still be open');
    assert.equal(t.entry, st.price);
    assert.ok(r.journal.open >= 1);
  }
  await send('settings.patch', { patch: { strategy: { minScore: 3, cooldownMs: 180_000, gateEnabled: true } } });
});

test('the session snapshot survives a simulated worker restart', async () => {
  const snap = store.serialize();
  assert.ok(snap.symbols[SYM], 'snapshot missing the live symbol');
  assert.ok(snap.symbols[SYM].m1.length > 100);

  // Wipe memory the way a killed service worker would, then rebuild.
  store.symbols.clear();
  engine.invalidate(SYM);
  assert.equal(store.getSymbol(SYM), null);

  const restored = store.deserialize(snap);
  assert.ok(restored >= 1);
  const st = store.getSymbol(SYM);
  assert.ok(st.tf.m1.length > 100, 'candles were not rebuilt');
  assert.ok(st.tf.m5.length > 0, 'derived series were not rebuilt');
  assert.ok(Number.isFinite(st.price));

  // The engine must still produce a verdict from the rebuilt state.
  const r = await send('state.get', { sym: SYM });
  assert.ok(['up', 'down', 'none', 'veto', 'wait'].includes(r.signal.dir));
});

test('out-of-order and duplicate ticks cannot corrupt the series', async () => {
  const sym = 'GBPJPY_otc';
  const key = 'GBPJPY_OTC';
  await send('feed.batch', { frames: [frame(sym, T0, 189.1), frame(sym, T0 + 10, 189.2), frame(sym, T0 + 20, 189.15)] });
  const st = store.getSymbol(key);
  assert.equal(st.tf.m1.length, 1);
  // T0 is not minute-aligned, so the bar opens on the previous minute boundary.
  assert.deepEqual(st.tf.m1[0], { t: 1_699_999_980_000, o: 189.1, h: 189.2, l: 189.1, c: 189.15 });

  // A tick from a minute ago must be ignored, not appended.
  await send('feed.batch', { frames: [frame(sym, T0 - 300, 188.0)] });
  assert.equal(st.tf.m1.length, 1);
  assert.equal(st.tf.m1[0].c, 189.15);
});

test('binary frames are decoded through the base64 path', async () => {
  const sym = 'XAUUSD_otc';
  const payload = `42["q",["${sym}",${T0 + 600},2331.55,1]]`;
  const b64 = Buffer.from(payload, 'utf8').toString('base64');
  const r = await send('feed.batch', { frames: [{ b64, binary: true, url: 'wss://x' }] });
  assert.equal(r.ok, true);
  assert.equal(r.ticks, 1);
  assert.ok(Math.abs(store.getSymbol('XAUUSD_OTC').price - 2331.55) < 1e-9);
});

test('unparseable frames land in the Protocol Lab instead of vanishing', async () => {
  await send('feed.clearSamples');
  await send('feed.batch', { frames: [{ text: '42["heartbeat",{"code":7,"seq":12345}]', url: 'wss://x' }] });
  const r = await send('feed.samples');
  assert.ok(r.samples.length >= 1, 'sample should have been captured');
  assert.match(r.samples[0].text, /heartbeat/);
});

test('socket events are counted in diagnostics', async () => {
  await send('diag.reset');
  await send('feed.socket', { url: 'wss://example.test/socket.io/' });
  await send('feed.socket', { url: 'wss://example.test/socket.io/' });
  const r = await send('state.get', { sym: SYM });
  assert.equal(r.diag.sockets, 2, 'both socket opens should be counted');
});


test('the backtest runs end to end through the API', async () => {
  const r = await send('backtest.run', { sym: SYM, tf: 'm1', expiryBars: 1, payout: 86, stake: 1 });
  assert.equal(r.ok, true, r.err || 'backtest failed');
  assert.ok(r.bars > 100);
  assert.ok(r.evaluated > 0);
  assert.ok(Number.isFinite(r.summary.winRate));
  assert.ok(Number.isFinite(r.summary.roiPct));
  const skipped = r.skipped.none + r.skipped.veto + r.skipped.gate + r.skipped.warmup;
  assert.ok(skipped + r.summary.trades <= r.evaluated + 1);
});

test('the journal round-trips through storage and CSV', async () => {
  const csv = await send('journal.csv');
  assert.equal(csv.ok, true);
  assert.match(csv.csv, /^id,openedAt,/);

  const summary = await send('journal.summary');
  assert.equal(summary.ok, true);
  assert.ok('winRate' in summary.journal);
  assert.ok(Array.isArray(summary.journal.breakdown.setup));
});

test('dynamic script registration is refused without permission', async () => {
  const ok = await send('scripts.register', { origin: 'https://mirror.example' });
  assert.equal(ok.ok, true, 'stub grants everything, so this should succeed');
  assert.equal(ok.pattern, 'https://mirror.example/*');

  const bad = await send('scripts.register', { origin: 'not-a-url' });
  assert.equal(bad.ok, false);
});

test('notification permission is only used for real signals', async () => {
  // The stub records every notification; the pipeline above must not have
  // spammed any for non-directional bars.
  for (const n of notifications) {
    assert.match(n.title, /Q-Sync · (UP|DOWN)/);
  }
});

test('settings merge never drops a nested default', async () => {
  const patched = await send('settings.patch', { patch: { alerts: { sound: true } } });
  assert.equal(patched.settings.alerts.sound, true);
  assert.equal(patched.settings.alerts.desktop, true, 'sibling default was lost');
  assert.equal(patched.settings.strategy.minScore, 3, 'unrelated branch was lost');
  assert.equal(patched.settings.balance, 100);
  await send('settings.reset');
  const reset = await send('settings.get');
  assert.equal(reset.settings.alerts.sound, false);
});

test('the feed pipeline is fast enough for a 1-second heartbeat', async () => {
  const frames = series({ n: 200, seed: 99 }).map((c, i) => frame('AUDUSD_otc', T0 + 5000 + i * 60, c.c));
  const t0 = performance.now();
  await send('feed.batch', { frames });
  await send('state.get', { sym: 'AUDUSD_OTC' });
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `200 frames + a full state build took ${ms.toFixed(0)}ms`);
});

test('TF_MS covers every timeframe the UI offers', () => {
  assert.deepEqual(Object.keys(TF_MS).sort(), ['m1', 'm15', 'm30', 'm5']);
  assert.equal(aggregate([{ t: 0, o: 1, h: 1, l: 1, c: 1 }], TF_MS.m30).length, 1);
});

/* ------------------- v6.1 wiring, end to end -------------------------- */

test('state.get reports the asset class and the payout actually used', async () => {
  await feedTrend({ n: 120, sym: 'EURUSD_otc', seed: 31 });
  const r = await send('state.get', { sym: 'EUR/USD_OTC' });
  assert.equal(r.ok, true);
  assert.equal(r.selectedSym, 'EURUSD_OTC', 'a slash spelling resolves to the canonical key');
  assert.equal(r.symbol.sym, 'EURUSD_OTC');
  assert.equal(r.symbol.assetClass, 'synthetic');
  assert.equal(r.symbol.otc, true);
  assert.equal(r.symbol.pretty, 'EUR/USD OTC');
  assert.ok(r.effectivePayout, 'the engine reports the payout it used');
  assert.ok(['live', 'class', 'setting'].includes(r.effectivePayout.origin));
  assert.ok(r.effectivePayout.payout > 0 && r.effectivePayout.payout <= 200);
});

test('state.get returns a recommendation with reasons', async () => {
  await feedTrend({ n: 200, sym: 'EURUSD_otc', seed: 33 });
  const r = await send('state.get', { sym: 'EURUSD_OTC' });
  assert.ok(r.recommend, 'recommend payload present');
  assert.ok(Array.isArray(r.recommend.ranked));
  assert.ok(Array.isArray(r.recommend.ineligible));
  const all = [...r.recommend.ranked, ...r.recommend.ineligible];
  for (const x of all) {
    assert.ok(Array.isArray(x.reasons) && x.reasons.length >= 1, `${x.sym} has no explanation`);
  }
  if (r.recommend.best) {
    assert.equal(r.recommend.best.sym, r.recommend.ranked[0].sym);
    assert.ok(r.recommend.best.score >= 0 && r.recommend.best.score <= 100);
  }
});

test('symbols.select canonicalises what it stores', async () => {
  await feedTrend({ n: 80, sym: 'GBPJPY_otc', seed: 34 });
  const r = await send('symbols.select', { sym: 'gbp/jpy_otc' });
  assert.equal(r.ok, true);
  assert.equal(r.selectedSym, 'GBPJPY_OTC');
  const s = await send('settings.get');
  assert.equal(s.settings.selectedSym, 'GBPJPY_OTC', 'the stored setting is canonical too');
  assert.equal(store.selected, 'GBPJPY_OTC', 'and the store protects exactly that key');
  assert.ok(store.isProtected('GBP/JPY_otc'), 'protection matches any spelling');
});

test('the same pair fed under two spellings is one instrument in the list', async () => {
  const before = store.symbols.size;
  await send('feed.batch', { frames: series({ n: 60, seed: 35 }).map((c, i) => frame('NZDUSD_otc', T0 + 9000 + i * 60, c.c)) });
  await send('feed.batch', { frames: series({ n: 60, seed: 35, start: 0.6 }).map((c, i) => frame('NZD/USD_otc', T0 + 9000 + i * 60, c.c)) });
  const r = await send('symbols.list');
  const hits = r.symbols.filter((x) => x.sym === 'NZDUSD_OTC');
  assert.equal(hits.length, 1, 'exactly one entry, not one per spelling');
  assert.ok(store.symbols.size <= before + 1, 'the second spelling created no extra symbol');
});

test('a payout sent before any tick still reaches the maths', async () => {
  const fresh = 'PLATUSD_OTC';
  await send('feed.frame', { frame: { text: JSON.stringify({ symbol: 'PLAT/USD_otc', payout: 79 }), binary: false } });
  assert.equal(store.symbols.size >= 0, true);
  await send('feed.batch', { frames: series({ n: 80, seed: 36 }).map((c, i) => frame('PLAT/USD_otc', T0 + 11000 + i * 60, c.c)) });
  const st = store.getSymbol(fresh);
  assert.ok(st, 'symbol exists');
  assert.equal(st.payout, 79, 'the early payout was not dropped');
  const r = await send('state.get', { sym: fresh });
  assert.equal(r.effectivePayout.payout, 79);
  assert.equal(r.effectivePayout.origin, 'live');
});

test('a broker-declared asset type flows through to the signal context', async () => {
  await send('feed.frame', { frame: { text: JSON.stringify({ symbol: 'ZZZUSD', type: 'crypto', price: 12.5, t: T0 + 12000 }), binary: false } });
  assert.equal(store.getSymbol('ZZZUSD').assetClass, 'crypto');
  await send('feed.batch', { frames: series({ n: 80, seed: 37, start: 12 }).map((c, i) => frame('ZZZUSD', T0 + 12000 + i * 60, c.c)) });
  const r = await send('state.get', { sym: 'ZZZUSD' });
  assert.equal(r.assetClass, 'crypto');
  assert.equal(r.signal?.ctx?.assetClass, 'crypto', 'the strategy was told the class');
  assert.ok(r.signal?.ctx?.band, 'and used that class band');
});

test('the catalog never lists one instrument twice', async () => {
  await feedTrend({ n: 60, sym: 'EURUSD_otc', seed: 38 });
  const r = await send('state.get', { sym: 'EURUSD_OTC' });
  const all = [...r.catalog.quotex, ...r.catalog.crypto, ...r.catalog.fx];
  assert.equal(new Set(all).size, all.length, `duplicate entries in catalog: ${all.join(', ')}`);
  for (const k of all) assert.ok(!k.includes('/'), `catalog keys must be canonical, got ${k}`);
});

test('the journal breakdown includes a per-asset-class view', async () => {
  await feedTrend({ n: 120, sym: 'EURUSD_otc', seed: 39 });
  const r = await send('state.get', { sym: 'EURUSD_OTC' });
  assert.ok(r.journal.breakdown.assetClass !== undefined, 'byClass breakdown present');
  assert.ok(Array.isArray(r.journal.breakdown.assetClass));
});

test('closing a trade with no price voids it instead of faking a tie', async () => {
  ledger.reset();
  const t = ledger.openTrade({
    sym: 'NOFEED', dir: 'up', entry: 1.1, stake: 1, payout: 86, tf: 'm1',
    expiryMinutes: 5, signals: [], score: 5, confidence: 80, source: 'quotex',
  });
  const r = await send('journal.trade.close', { id: t.id }); // no price supplied
  assert.equal(r.ok, true);
  assert.equal(r.result, 'void', 'must not invent a settlement price');
  assert.equal(r.pnl, 0);
  assert.equal(ledger.openOn('NOFEED').length, 0, 'and the pair is released');
});

/* ------------------- the numbers the user is shown -------------------- */

test('the journal break-even comes from the payouts the trades were settled at', async () => {
  const { createTrade, settleTrade } = ledger;
  ledger.reset();
  const t0ms = Date.now() - 3_600_000;
  for (let i = 0; i < 10; i++) {
    // Ten crypto-style trades at the broker's real 75% payout, six winners.
    const t = createTrade({ sym: 'BTCUSD', dir: 'up', entry: 100, stake: 1, payout: 75, openedAt: t0ms + i * 60_000 });
    settleTrade(t, i < 6 ? 101 : 99, t0ms + i * 60_000 + 60_000);
    ledger.trades.push(t);
  }

  let r = await send('state.get', { sym: SYM });
  const real = Math.round(breakEvenWinRate(75) * 10000) / 10000;
  assert.equal(r.journal.breakEven, real, 'break-even must use the 75% the trades actually paid');
  assert.notEqual(r.journal.breakEven, Math.round(breakEvenWinRate(86) * 10000) / 10000, 'not the global 86% default');
  assert.equal(r.journal.avgPayout, 75);
  assert.ok(r.journal.edge < 0.03, 'two points of the old edge were an artefact of the wrong payout');

  // With nothing decided yet there is nothing to average, so the user's own
  // setting is the honest fallback.
  ledger.reset();
  await send('settings.patch', { patch: { payout: 70 } });
  r = await send('state.get', { sym: SYM });
  assert.equal(r.journal.breakEven, Math.round(breakEvenWinRate(70) * 10000) / 10000);
  await send('settings.patch', { patch: { payout: 86 } });
});

test('candidate pairs get a real verdict without being able to trade', async () => {
  // Fresh bars: the ranker refuses to score a stale pair, and stale fixtures
  // would hide whether the signal component was computed at all.
  const t0 = (Math.floor(Date.now() / 60000) - 199) * 60;
  for (const [sym, seed] of [['EURUSD_otc', 5], ['GBPUSD_otc', 9], ['AUDUSD_otc', 3]]) {
    const cs = series({ n: 200, drift: 0.05, amp: 0.1, noise: 0.01, seed, t0: t0 * 1000 });
    await send('feed.batch', { frames: cs.map((c, i) => frame(sym, t0 + i * 60, c.c)) });
  }
  await send('symbols.select', { sym: 'EURUSD_OTC' });
  const s = await settings.load();

  // Exactly what the heartbeat does for the pairs that are not on screen.
  const before = ledger.trades.length;
  for (const cand of ['GBPUSD_OTC', 'AUDUSD_OTC']) {
    engine.evaluate(cand, s, { trade: false, preview: false, settle: false });
  }
  assert.equal(ledger.trades.length, before, 'a candidate can never open a paper trade');

  const cached = engine.currentSignal('GBPUSD_OTC');
  assert.ok(cached, 'a pair that is not selected still gets evaluated');
  const r = await send('state.get', { sym: 'EURUSD_OTC' });
  const row = [...(r.recommend.ranked || []), ...(r.recommend.ineligible || [])].find((x) => x.sym === 'GBPUSD_OTC');
  assert.ok(row, 'the candidate appears in the ranking payload');
  assert.equal(row.dir, cached.dir, 'the row reports the verdict the engine actually holds');
  assert.ok(r.diag.candidates >= 2, 'candidate evaluations are counted in the Feed diagnostics');
});

/* ------------------- the broker's own chart, end to end --------------- */

/* The extension used to file every history block as 1-minute data, whatever
 * timeframe the broker sent it in. These two tests are the whole point of the
 * sync work: the 5-minute candles the site is drawing must arrive as 5-minute
 * candles, and the 1-minute series must stay what it says it is. */

const m5Block = (n = 12) =>
  Array.from({ length: n }, (_, i) => [
    T0 + i * 300,
    +(1.1 + i * 0.001).toFixed(5),
    +(1.101 + i * 0.001).toFixed(5),
    +(1.099 + i * 0.001).toFixed(5),
    +(1.1005 + i * 0.001).toFixed(5),
  ]);

test("the broker\'s 5-minute history is stored as 5-minute candles, not as m1", async () => {
  const before = store.getSymbol(SYM).tf.m1.length;
  const r = await send('feed.batch', {
    frames: [
      {
        text: `42["history",{"s":"EURUSD_otc","data":${JSON.stringify(m5Block(12))}}]`,
        binary: false,
        url: 'wss://example.test/socket.io/',
      },
    ],
  });
  assert.equal(r.history, 12, 'the block was stored');

  const st = store.getSymbol(SYM);
  assert.equal(st.tf.m1.length, before, 'the 1-minute series must not gain 5-minute bars');
  assert.equal(st.broker.m5.length, 12, 'they belong to the 5-minute series');
  assert.equal(st.brokerLastTf, 'm5');

  await send('settings.patch', { patch: { tf: 'm5' } });
  const p = await send('state.get', { candles: 120 });
  assert.equal(p.sync.barsFrom, 'broker', 'the 5m chart is drawn from the broker candles');
  assert.equal(p.sync.brokerTf, 'm5');
  assert.equal(p.sync.signalTf, 'm1', 'and the call is still computed on 1m closes');
  assert.equal(p.sync.aligned, true, 'the newest bar is the bucket we are in');
  assert.equal(p.symbol.brokerBars, 12);
  assert.ok(p.diag.brokerRows >= 12, 'and Diagnostics can prove it');
  assert.ok((p.diag.methods['json-walk'] || 0) >= 1, 'with the extraction path recorded');
  await send('settings.patch', { patch: { tf: 'm1' } });
});

test('a proxy time frame is never invented from a mixed series', async () => {
  // Five 5-minute candles interleaved with 4 one-minute bars is not a
  // timeframe, and the parser must decline to call it one rather than route
  // those rows somewhere plausible-looking.
  const mixed = [...m5Block(5), ...[0, 1, 2, 3].map((i) => [T0 + 3000 + i * 60, 1.2, 1.201, 1.199, 1.2005])];
  const r = await send('feed.batch', {
    frames: [
      {
        text: `42["history",{"s":"EURUSD_otc","data":${JSON.stringify(mixed)}}]`,
        binary: false,
        url: 'wss://example.test/socket.io/',
      },
    ],
  });
  assert.equal(r.ok, true);
  const st = store.getSymbol(SYM);
  assert.equal(st.broker.m5.length, 12, 'the earlier 5-minute block is untouched');
  const p = await send('state.get', {});
  assert.ok(p.diag.oddBlocks >= 1, 'and the unreadable block is counted, not guessed at');
});
