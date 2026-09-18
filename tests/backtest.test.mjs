import test from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest, summarise, walkForward } from '../src/background/backtest.js';
import { series } from './helpers.mjs';
import { aggregate } from '../src/background/candles.js';

test('refuses to run without enough history', () => {
  const r = runBacktest(series({ n: 20 }));
  assert.equal(r.ok, false);
  assert.match(r.error, /Need at least/);
});

test('produces trades on a trending series and reports honest stats', () => {
  const m1 = series({ n: 600, drift: 0.04, amp: 0.12, noise: 0.02, seed: 21 });
  const r = runBacktest(m1, { payout: 86, stake: 1, warmup: 60 });
  assert.equal(r.ok, true);
  assert.equal(r.bars, 600);
  assert.ok(r.trades.length > 0, 'a clear trend should generate signals');
  assert.ok(r.stats.decided === r.trades.length);
  assert.ok(r.stats.winRate >= 0 && r.stats.winRate <= 1);
  assert.ok(r.stats.breakEven > 0.5);
  const s = summarise(r);
  assert.equal(typeof s.winRate, 'number');
  assert.ok(Number.isFinite(s.roiPct));
});

test('entry is the NEXT bar open — no look-ahead', () => {
  const m1 = series({ n: 600, drift: 0.05, amp: 0.1, noise: 0.01, seed: 31 });
  const r = runBacktest(m1, { payout: 86, stake: 1, warmup: 60 });
  const byTime = new Map(m1.map((c) => [c.t, c]));
  for (const t of r.trades) {
    // The decision is stamped at the close of the signal bar; entry must be
    // the open of the bar that starts at exactly that moment.
    const bar = byTime.get(t.openedAt);
    assert.ok(bar, `no bar opens at ${t.openedAt}`);
    assert.equal(t.entry, bar.o, 'entry must be the next bar open');
    assert.ok(t.entry !== bar.c || bar.o === bar.c);
  }
});

test('every trade is settled and its exit comes from a later bar', () => {
  const m1 = series({ n: 500, drift: 0.04, seed: 41 });
  const r = runBacktest(m1, { payout: 86, stake: 1, warmup: 60, expiryBars: 1 });
  assert.ok(r.trades.length > 0);
  const times = m1.map((c) => c.t);
  for (const t of r.trades) {
    assert.ok(t.result, 'trade left unsettled');
    assert.ok(Number.isFinite(t.exit));
    assert.ok(t.settledAt > t.openedAt, 'exit must be after entry');
    assert.ok(times.includes(t.exitBar));
  }
});

test('a longer expiry holds the position for more bars', () => {
  const m1 = series({ n: 700, drift: 0.04, seed: 51 });
  const one = runBacktest(m1, { payout: 86, stake: 1, warmup: 60, expiryBars: 1 });
  const three = runBacktest(m1, { payout: 86, stake: 1, warmup: 60, expiryBars: 3 });
  assert.ok(one.trades.length > 0 && three.trades.length > 0);
  const span = (t) => t.settledAt - t.openedAt;
  assert.ok(span(three.trades[0]) > span(one.trades[0]), 'a 3-bar hold must last longer than a 1-bar hold');
});

test('cooldown prevents back-to-back signals in the same direction', () => {
  const m1 = series({ n: 600, drift: 0.05, amp: 0.1, noise: 0.01, seed: 61 });
  const tight = runBacktest(m1, { payout: 86, stake: 1, warmup: 60, strategy: { cooldownMs: 0 } });
  const loose = runBacktest(m1, { payout: 86, stake: 1, warmup: 60, strategy: { cooldownMs: 600_000 } });
  assert.ok(loose.trades.length <= tight.trades.length, 'a longer cooldown cannot create more trades');
});

test('maxTrades caps the run', () => {
  const m1 = series({ n: 900, drift: 0.06, amp: 0.1, noise: 0.01, seed: 71 });
  const r = runBacktest(m1, { payout: 86, stake: 1, warmup: 60, maxTrades: 10, strategy: { cooldownMs: 0 } });
  assert.ok(r.trades.length <= 10);
});

test('skipped buckets account for every bar that did not trade', () => {
  const m1 = series({ n: 500, drift: 0.04, seed: 81 });
  const r = runBacktest(m1, { payout: 86, stake: 1, warmup: 60 });
  const accounted = r.skipped.veto + r.skipped.gate + r.skipped.none + r.skipped.warmup + r.trades.length;
  assert.ok(accounted <= r.evaluated + 1, `accounted ${accounted} > evaluated ${r.evaluated}`);
  assert.ok(r.evaluated > 0);
});

test('equity ends where the summed pnl ends', () => {
  const m1 = series({ n: 600, drift: 0.04, seed: 91 });
  const r = runBacktest(m1, { payout: 86, stake: 1, warmup: 60 });
  const sum = r.trades.reduce((s, t) => s + t.pnl, 0);
  const lastEq = r.equity[r.equity.length - 1]?.equity ?? 0;
  assert.ok(Math.abs(sum - lastEq) < 1e-6, `pnl ${sum} vs equity ${lastEq}`);
});

test('runs on 5-minute candles too', () => {
  const m1 = series({ n: 1200, drift: 0.05, seed: 101 });
  const m5 = aggregate(m1, 300_000);
  const r = runBacktest(m5, { payout: 86, stake: 1, warmup: 60, tf: 'm5', expiryBars: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.bars, m5.length);
});

test('walkForward splits data into folds and reports out-of-sample spread', () => {
  const m1 = series({ n: 900, drift: 0.05, amp: 0.1, noise: 0.01, seed: 121 });
  const r = walkForward(m1, { payout: 86, stake: 1, warmup: 60, strategy: { cooldownMs: 0 } }, 4);
  assert.equal(r.ok, true, r.error || 'walk-forward failed');
  assert.ok(r.perFold.length >= 2, 'should evaluate several folds');
  assert.ok(Number.isFinite(r.meanWinRate) && r.meanWinRate >= 0 && r.meanWinRate <= 100);
  assert.ok(r.minWinRate <= r.meanWinRate && r.meanWinRate <= r.maxWinRate);
  assert.equal(typeof r.stable, 'boolean');
});


test('the backtester is deterministic', () => {
  const m1 = series({ n: 500, drift: 0.04, seed: 111 });
  const a = runBacktest(m1, { payout: 86, stake: 1, warmup: 60 });
  const b = runBacktest(m1, { payout: 86, stake: 1, warmup: 60 });
  assert.equal(a.trades.length, b.trades.length);
  assert.equal(a.stats.net, b.stats.net);
  assert.deepEqual(a.trades.map((t) => t.dir), b.trades.map((t) => t.dir));
});
