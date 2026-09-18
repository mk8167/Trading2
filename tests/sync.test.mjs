/* sync.js + the store's timeframe routing — "the chart on screen is the chart
 * the broker sent".
 *
 * This is the failure these tests exist for: the broker sends candles for the
 * chart the user has open. If that chart is on 5 minutes, every block that
 * arrives IS 5-minute data — and it used to be filed into the 1-minute series,
 * because nothing in the data path ever asked. Every indicator, every
 * aggregate, the chart and the strategy's "last closed bar" were then computed
 * from a series that was not what it claimed to be, so the extension's chart
 * could never match the site's.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { install } from './chrome-stub.mjs';

install();
const sync = await import('../src/background/sync.js');
const candles = await import('../src/background/candles.js');
const store = await import('../src/background/store.js');
const feeds = await import('../src/background/feeds/quotex.js');

const SYM = 'EURUSD_OTC';
const M1 = 60_000;
const T0 = 1_700_000_000_000;

/** A block of candles at `tfMs` spacing, deliberately OHLC-shaped. */
const block = (n, tfMs, { start = 100, t0 = T0 } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    t: t0 + i * tfMs,
    o: start + i,
    h: start + i + 1,
    l: start + i - 1,
    c: start + i + 0.5,
  }));

function freshStore() {
  store.symbols.clear();
  store.setSelected(null);
  store.protectOpen([]);
  store.resetDiag();
}

/* ------------------------------ detectTf ----------------------------- */

test('the timeframe of a block is measured from its own spacing', () => {
  assert.equal(sync.detectTf(block(12, M1)), 'm1');
  assert.equal(sync.detectTf(block(12, 300_000)), 'm5');
  assert.equal(sync.detectTf(block(12, 900_000)), 'm15');
});

test('a block too short or too irregular to call is not called', () => {
  assert.equal(sync.detectTf(block(3, 300_000)), null, 'three bars is not a sample');
  // Alternating 1m and 5m gaps: a mixed series, which is exactly what must not
  // be labelled confidently.
  const mixed = block(11, M1).map((c, i) => ({ ...c, t: T0 + Math.floor(i / 2) * 300_000 + (i % 2) * 60_000 }));
  assert.equal(sync.detectTf(mixed), null);
});

test('m30 is not offered as a display timeframe, so it is not reported as one', () => {
  assert.equal(sync.detectTf(block(12, 1_800_000)), null);
});

/* ----------------------------- decideFollow -------------------------- */

test('the extension follows the pair and timeframe the site just charted', () => {
  const now = T0;
  const want = sync.decideFollow({
    site: { sym: 'GBPUSD_OTC', tf: 'm5', at: now },
    selected: SYM,
    tf: 'm1',
    now,
  });
  assert.deepEqual(want, { sym: 'GBPUSD_OTC', tf: 'm5' });
});

test('nothing to do when the site is already what we are showing', () => {
  const now = T0;
  assert.equal(
    sync.decideFollow({ site: { sym: SYM, tf: 'm5', at: now }, selected: SYM, tf: 'm5', now }),
    null
  );
});

test('follow-the-site can be switched off, and a stale chart is ignored', () => {
  const now = T0;
  assert.equal(
    sync.decideFollow({ site: { sym: 'GBPUSD_OTC', tf: 'm5', at: now }, selected: SYM, tf: 'm1', enabled: false, now }),
    null,
    'syncSite=false must leave the user where they put themselves'
  );
  assert.equal(
    sync.decideFollow({ site: { sym: 'GBPUSD_OTC', tf: 'm5', at: now - 10 * 60_000 }, selected: SYM, tf: 'm1', now }),
    null,
    'a ten-minute-old chart is not what the user is looking at now'
  );
});

test('a burst of history frames cannot make the selection jump every frame', () => {
  const now = T0;
  const args = { site: { sym: 'GBPUSD_OTC', tf: 'm5', at: now }, selected: SYM, tf: 'm1', now };
  assert.ok(sync.decideFollow({ ...args, lastFollowAt: now - 10_000 }), 'a while ago is fine');
  assert.equal(sync.decideFollow({ ...args, lastFollowAt: now - 500 }), null, 'inside the floor it is not');
});

test('the pair can follow even when the timeframe cannot be displayed', () => {
  const now = T0;
  // A 30m chart on the site: follow the pair, but leave the timeframe alone —
  // the panel has no 30m option, so switching to it would leave a blank chart.
  assert.deepEqual(
    sync.decideFollow({ site: { sym: 'GBPUSD_OTC', tf: 'm30', at: now }, selected: SYM, tf: 'm1', now }),
    { sym: 'GBPUSD_OTC' }
  );
});

/* --------------------------- splitCoarseRuns ------------------------- */

test('a genuine m1 series with gaps is left completely alone', () => {
  const m1 = block(10, M1);
  // A weekend-sized hole in the middle, which is normal and must not be read
  // as "these are 15-minute candles".
  m1[5].t += 6 * 60 * 60 * 1000;
  const { m1: kept, coarse } = sync.splitCoarseRuns(m1);
  assert.equal(kept.length, 10);
  assert.equal(coarse.m5.length + coarse.m15.length, 0);
});

test('a run of 5- and 15-minute bars inside m1 is moved to its real timeframe', () => {
  const withRun = [...block(4, M1), ...block(6, 300_000, { t0: T0 + 120 * M1 })];
  const { m1, coarse } = sync.splitCoarseRuns(withRun);
  assert.equal(coarse.m5.length, 6, 'the 5-minute run is identified');
  assert.equal(m1.length, 4, 'and the real m1 bars stay in m1');
  assert.equal(coarse.m15.length, 0);

  const withQuarter = [...block(4, M1), ...block(5, 900_000, { t0: T0 + 120 * M1 })];
  assert.equal(sync.splitCoarseRuns(withQuarter).coarse.m15.length, 5);
});

/* ------------------------- the store's data path --------------------- */

test('a 5-minute history block never lands in the m1 series', () => {
  freshStore();
  const n = store.ingestHistory(SYM, block(12, 300_000));
  const s = store.getSymbol(SYM);
  assert.equal(n, 12);
  assert.equal(s.tf.m1.length, 0, 'm1 must stay empty: these are not m1 bars');
  assert.equal(s.broker.m5.length, 12, 'they are stored as what they are');
  assert.equal(s.brokerLastTf, 'm5');
  assert.equal(s.historyRows, 12);
  assert.equal(store.diag.historyBlocks, 1);
  assert.ok(store.diag.brokerRows >= 12);
});

test("the broker's own candles are what the 5m series shows", () => {
  freshStore();
  store.ingestHistory(SYM, block(12, 300_000));
  store.refreshDerived(SYM);
  const s = store.getSymbol(SYM);
  assert.equal(s.tf.m5.length, 12);
  assert.equal(s.tf.m5[0].c, 100.5, "the broker's close, not one we aggregated");
});

test('ticks still build m1, and the broker series still wins on top of it', () => {
  freshStore();
  store.ingestHistory(SYM, block(12, 300_000));
  const s = store.getSymbol(SYM);
  const last = s.broker.m5[11].t;

  // A tick inside the last broker bucket: the broker's candle is the truth,
  // so the series must not grow an extra "aggregated" bar for that bucket.
  store.ingestTick(SYM, 999, last + 30_000);
  store.refreshDerived(SYM);
  assert.equal(s.tf.m1.length, 1, 'the tick built an m1 bar');
  assert.equal(s.tf.m5.length, 12, 'and the broker series is unchanged');

  // A tick two buckets later: the chart must still reach "now", so the newer
  // bucket is appended after the broker's candles.
  store.ingestTick(SYM, 1000, last + 2 * 300_000 + 30_000);
  store.refreshDerived(SYM);
  assert.equal(s.tf.m5.length, 13);
  assert.ok(s.tf.m5[12].t > last, 'appended in order, not inserted backwards');
});

test('history that arrives newest-first is stored oldest-first, not dropped', () => {
  freshStore();
  const n = store.ingestHistory(SYM, block(12, 300_000).reverse());
  const s = store.getSymbol(SYM);
  assert.equal(n, 12, 'upsertCandle refuses to rewrite history, so order matters');
  assert.equal(s.broker.m5.length, 12);
  assert.ok(s.broker.m5[1].t > s.broker.m5[0].t, 'the series is ascending');
});

test('a 1-minute block still goes to m1, exactly as before', () => {
  freshStore();
  const n = store.ingestHistory(SYM, block(12, M1));
  const s = store.getSymbol(SYM);
  assert.equal(n, 12);
  assert.equal(s.tf.m1.length, 12);
  assert.equal(Object.keys(s.broker).length, 0, 'no broker series for m1');
});

/* --------------------------- snapshots ------------------------------- */

test('broker candles survive a worker restart', () => {
  freshStore();
  store.ingestHistory(SYM, block(12, 300_000));
  const snap = store.serialize();
  assert.equal(snap.v, 8, 'snapshot version carries the new field');
  assert.equal(snap.symbols[SYM].broker.m5.length, 12);

  freshStore();
  const n = store.deserialize(snap);
  const s = store.getSymbol(SYM);
  assert.equal(n, 1);
  assert.equal(s.broker.m5.length, 12, 'restored');
  store.refreshDerived(SYM);
  assert.equal(s.tf.m5.length, 12);
});

test('a series polluted by an older build is healed on restore', () => {
  freshStore();
  // Exactly what v6.2.0 left behind: the broker's 5-minute candles sitting in
  // m1, where every indicator would compute on them as if they were 1-minute.
  const polluted = {
    v: 7,
    at: T0,
    symbols: {
      [SYM]: {
        source: 'quotex',
        price: 105.5,
        ts: T0 + 11 * 300_000,
        m1: candles.compact(block(12, 300_000)),
      },
    },
  };
  store.deserialize(polluted);
  const s = store.getSymbol(SYM);
  assert.equal(s.tf.m1.length, 0, 'the fake 1-minute bars are gone from m1');
  assert.equal(s.broker.m5.length, 12, 'and are where they belong');
  assert.ok(store.diag.repaired >= 12, 'the repair is counted, not silent');
});

/* ------------------------ the feed's hook ---------------------------- */

test('a history frame tells the service worker which chart the site is showing', () => {
  freshStore();
  const seen = [];
  feeds.setSiteChartHandler((site) => seen.push(site));
  const rows = block(10, 300_000).map((c) => [Math.round(c.t / 1000), c.o, c.h, c.l, c.c]);
  const r = feeds.handleBatch([
    {
      text: `42["history",{"s":"${SYM}","data":${JSON.stringify(rows)}}]`,
      binary: false,
      url: 'wss://example.test/socket.io/',
    },
  ]);
  assert.equal(r.history, 10);
  assert.equal(seen.length, 1, 'one history block, one notification');
  assert.equal(seen[0].sym, SYM);
  assert.equal(seen[0].tf, 'm5');
  assert.equal(seen[0].rows, 10);
  feeds.setSiteChartHandler(null);
  assert.equal(store.diag.methods['json-walk'] >= 1, true, 'the extraction path is recorded');
});

test('a block whose spacing makes no sense is kept out, not filed as m1', () => {
  freshStore();
  // Five 5-minute candles followed by four 1-minute bars: not a timeframe.
  const mixed = [...block(5, 300_000), ...block(4, M1, { t0: T0 + 3_000_000 })];
  assert.equal(sync.detectTf(mixed), null);
  assert.equal(store.ingestHistory(SYM, mixed), 0);
  const s = store.getSymbol(SYM);
  assert.equal(s.tf.m1.length, 0, 'nothing was filed as 1-minute data');
  assert.equal(Object.keys(s.broker).length, 0);
  assert.equal(store.diag.oddBlocks, 1, 'and it is counted rather than swallowed');
});

test('a sparse 1-minute block is still stored as 1-minute data', () => {
  freshStore();
  // Real m1 candles with bars missing — a weekend, or a quiet pair. The median
  // gap is 60s, so this is m1 data and throwing it away would be wrong.
  const sparse = block(10, M1).filter((_, i) => i !== 4 && i !== 7);
  assert.equal(sync.detectTf(sparse), null, 'too irregular for a confident timeframe call');
  assert.equal(sync.minuteSpaced(sparse), true, 'but plainly minute-spaced all the same');
  assert.equal(store.ingestHistory(SYM, sparse), 8);
  assert.equal(store.getSymbol(SYM).tf.m1.length, 8);
});
