import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, breakEvenWinRate, gate, lossStreak, winStreak, DEFAULT_OPTS } from '../src/background/strategy.js';
import { series, flatSeries } from './helpers.mjs';
import { aggregate } from '../src/background/candles.js';

// `price` is the live tick, so it must come from the last CLOSED bar;
// using the forming bar would let an in-progress spike skew the maths.
const withTf = (m1, price) => ({
  m1,
  m5: aggregate(m1, 300_000),
  m15: aggregate(m1, 900_000),
  price: price ?? m1[m1.length - 2].c,
  payout: 86,
});

test('waits instead of guessing while history is short', () => {
  const r = analyze(withTf(series({ n: 10 })));
  assert.equal(r.dir, 'wait');
  assert.ok(/Warming up/.test(r.summary));
});

test('a rising market produces an UP call, a falling one a DOWN call', () => {
  const up = analyze(withTf(series({ n: 240, drift: 0.05, amp: 0.1, noise: 0.01, seed: 5 })));
  const down = analyze(withTf(series({ n: 240, drift: -0.05, amp: 0.1, noise: 0.01, seed: 5 }).map((c, i) => ({ ...c }))));
  assert.equal(up.dir, 'up', `expected up, got ${up.dir}: ${up.summary}`);
  assert.ok(up.score >= DEFAULT_OPTS.minScore);
  assert.ok(up.confidence > 0 && up.confidence <= 100);
  assert.equal(down.dir, 'down', `expected down, got ${down.dir}: ${down.summary}`);
});

test('a flat market produces no call rather than a coin flip', () => {
  const r = analyze(withTf(flatSeries({ n: 240, amp: 0.25 })));
  assert.ok(['none', 'wait'].includes(r.dir), `expected none, got ${r.dir}: ${r.summary}`);
});

test('context always carries the numbers behind the call', () => {
  const r = analyze(withTf(series({ n: 240 })));
  assert.ok(r.ctx);
  for (const k of ['price', 'atr', 'volatility', 'rsi', 'structure', 'ema21', 'upVotes', 'downVotes', 'mtf']) {
    assert.ok(k in r.ctx, `ctx missing ${k}`);
  }
  assert.ok(r.ctx.atr > 0);
  assert.ok(['up', 'down', 'range', 'warming'].includes(r.ctx.structure));
});

test('signals are sorted strongest first and all carry a direction', () => {
  const r = analyze(withTf(series({ n: 240, drift: 0.05 })));
  if (r.signals.length > 1) {
    for (let i = 1; i < r.signals.length; i++) {
      assert.ok(r.signals[i - 1].weight >= r.signals[i].weight);
    }
  }
  for (const s of r.signals) assert.ok(s.weight > 0 && s.name);
});

test('a payout below the floor vetoes the trade outright', () => {
  const data = withTf(series({ n: 240, drift: 0.05 }));
  data.payout = 40;
  const r = analyze(data, { minPayout: 70 });
  assert.equal(r.dir, 'veto');
  assert.ok(r.vetoes.some((v) => /Payout/.test(v)));
});

test('an absurd volatility spike vetoes the trade', () => {
  const m1 = series({ n: 240, drift: 0.05 }).map((c, i) =>
    i > 200 ? { ...c, h: c.h + 5, l: c.l - 5, c: c.c + (i % 2 ? 4 : -4) } : c
  );
  const r = analyze(withTf(m1), { maxVolatility: 0.001 });
  assert.equal(r.dir, 'veto');
  assert.ok(r.vetoes.some((v) => /Volatility/.test(v)));
});

test('the forming candle is never used to decide a signal', () => {
  const base = series({ n: 240, drift: 0.05, seed: 9 });
  const clean = analyze(withTf(base));
  // Replace the still-forming bar with an absurd one. Every CLOSED bar is
  // identical, so the decision must be byte-for-byte the same.
  const forming = base[base.length - 1];
  const wild = [...base.slice(0, -1), { t: forming.t, o: forming.c, h: 999, l: 0.01, c: 500 }];
  const after = analyze(withTf(wild));
  assert.equal(clean.dir, after.dir);
  assert.equal(clean.score, after.score);
  assert.equal(clean.confidence, after.confidence);
});

test('preview includes the forming bar, the decision never does', () => {
  const m1 = series({ n: 120, drift: 0.02, seed: 13 });
  const closed = analyze(withTf(m1), {});
  const prev = analyze(withTf(m1), { preview: true });
  assert.equal(closed.ctx.candles, m1.length - 1, 'decision must drop the forming bar');
  assert.equal(prev.ctx.candles, m1.length, 'preview must include the forming bar');
});


test('break-even win rate maths is right', () => {
  assert.ok(Math.abs(breakEvenWinRate(100) - 0.5) < 1e-9);
  assert.ok(Math.abs(breakEvenWinRate(86) - 0.5376) < 0.001);
  assert.ok(breakEvenWinRate(70) > breakEvenWinRate(90), 'lower payout needs a higher win rate');
});

test('gate blocks a fresh signal while one of the same direction is cooling down', () => {
  const sig = { dir: 'up', score: 5, vetoes: [] };
  const now = 1_700_000_000_000;
  const trades = [{ dir: 'up', openedAt: now - 60_000, result: 'win' }];
  const g = gate({ signal: sig, trades, payout: 86, now, opts: { cooldownMs: 180_000 } });
  assert.equal(g.ok, false);
  assert.match(g.reason, /Cooldown/);
  const later = gate({ signal: sig, trades, payout: 86, now: now + 200_000, opts: { cooldownMs: 180_000 } });
  assert.equal(later.ok, true);
});

test('gate stops trading when the rolling win rate falls under break-even', () => {
  const now = 1_700_000_000_000;
  const trades = [];
  for (let i = 0; i < 20; i++) {
    trades.push({ dir: i % 2 ? 'up' : 'down', openedAt: now - (20 - i) * 300_000, result: i < 6 ? 'win' : 'loss' });
  }
  const g = gate({ signal: { dir: 'up', score: 6, vetoes: [] }, trades, payout: 86, now, opts: { gateLookback: 20, gateMargin: 0.03, cooldownMs: 0 } });
  assert.equal(g.ok, false);
  assert.match(g.reason, /GATE/);
});

test('gate blocks after a long losing streak even if the average is fine', () => {
  const now = 1_700_000_000_000;
  const trades = [
    ...Array.from({ length: 14 }, (_, i) => ({ dir: 'up', openedAt: now - (20 - i) * 300_000, result: 'win' })),
    ...Array.from({ length: 5 }, (_, i) => ({ dir: 'up', openedAt: now - (5 - i) * 300_000, result: 'loss' })),
  ];
  const g = gate({ signal: { dir: 'up', score: 6, vetoes: [] }, trades, payout: 86, now, opts: { maxLossStreak: 5, cooldownMs: 0 } });
  assert.equal(g.ok, false);
  assert.match(g.reason, /losses in a row/);
});

test('gate refuses non-directional signals', () => {
  assert.equal(gate({ signal: { dir: 'none', score: 0, vetoes: [] }, trades: [], payout: 86 }).ok, false);
  assert.equal(gate({ signal: null, trades: [], payout: 86 }).ok, false);
  const vetoed = gate({ signal: { dir: 'veto', score: 4, vetoes: ['Payout too low'] }, trades: [], payout: 86 });
  assert.equal(vetoed.ok, false);
  assert.match(vetoed.reason, /Vetoed/);
});

test('streak counters', () => {
  const t = (r) => ({ result: r });
  assert.equal(lossStreak([t('win'), t('loss'), t('loss')]), 2);
  assert.equal(lossStreak([t('loss'), t('win')]), 0);
  assert.equal(winStreak([t('loss'), t('win'), t('win')]), 2);
  assert.equal(lossStreak([]), 0);
});

/* ------------------ asset-class awareness (v6.1) --------------------- */

test('a closed market is refused, whatever the chart looks like', () => {
  const data = { ...withTf(series({ n: 240, drift: 0.05, amp: 0.1, noise: 0.01, seed: 5 })), assetClass: 'forex', marketOpen: false };
  const r = analyze(data);
  assert.equal(r.dir, 'veto');
  assert.ok(r.vetoes.some((v) => /closed for the weekend/i.test(v)), r.vetoes.join('|'));
});

test('the same chart IS tradeable when the market is open', () => {
  const open = analyze({ ...withTf(series({ n: 240, drift: 0.05, amp: 0.1, noise: 0.01, seed: 5 })), assetClass: 'forex', marketOpen: true });
  assert.notEqual(open.dir, 'veto');
});

test('crypto and OTC are never refused for weekend closure', () => {
  const m1 = series({ n: 240, drift: 0.05, amp: 0.1, noise: 0.01, seed: 5 });
  for (const cls of ['crypto', 'synthetic']) {
    const r = analyze({ ...withTf(m1), assetClass: cls, marketOpen: true });
    assert.ok(!r.vetoes.some((v) => /weekend/i.test(v)), `${cls} should not be weekend-vetoed`);
  }
});

test('respectMarketHours:false disables the closure veto', () => {
  const r = analyze({ ...withTf(series({ n: 240, drift: 0.05, amp: 0.1, noise: 0.01, seed: 5 })), assetClass: 'forex', marketOpen: false }, { respectMarketHours: false });
  assert.ok(!r.vetoes.some((v) => /weekend/i.test(v)));
});

test('an explicit volatility override still wins over the class band', () => {
  // The class band for crypto is wide, but an explicit 0.001 cap must apply.
  const r = analyze({ ...withTf(series({ n: 240, drift: 0.05, amp: 4, noise: 1.5, seed: 9 })), assetClass: 'crypto' }, { maxVolatility: 0.001, useClassBands: false });
  assert.equal(r.dir, 'veto');
  assert.ok(r.vetoes.some((v) => /Volatility/.test(v)));
});

test('the veto message names the class whose band was applied', () => {
  const r = analyze({ ...withTf(series({ n: 240, drift: 0.05, amp: 4, noise: 1.5, seed: 9 })), assetClass: 'crypto' }, { useClassBands: true });
  const v = r.vetoes.find((x) => /Volatility/.test(x));
  if (v) assert.match(v, /crypto/);
});

test('useClassBands:false falls back to the configured numbers', () => {
  const m1 = series({ n: 240, drift: 0.05, amp: 0.1, noise: 0.01, seed: 5 });
  const auto = analyze({ ...withTf(m1), assetClass: 'crypto' }, { useClassBands: true });
  const manual = analyze({ ...withTf(m1), assetClass: 'crypto' }, { useClassBands: false, maxVolatility: 0.0001 });
  assert.equal(manual.dir, 'veto', 'an absurdly tight manual cap must veto');
  assert.notEqual(auto.dir, undefined);
});

test('ctx reports the class and the band actually used', () => {
  const r = analyze({ ...withTf(series({ n: 240, drift: 0.05, amp: 0.1, noise: 0.01, seed: 5 })), assetClass: 'crypto', marketOpen: true });
  assert.equal(r.ctx.assetClass, 'crypto');
  assert.equal(r.ctx.band.max, 0.03);
  assert.equal(r.ctx.marketOpen, true);
});

test('no asset class at all behaves exactly as it did before', () => {
  // Backwards compatibility: an unknown instrument uses the legacy numbers,
  // so upgrading cannot silently change signals on data we cannot classify.
  const m1 = series({ n: 240, drift: 0.05, amp: 0.1, noise: 0.01, seed: 5 });
  const withClass = analyze({ ...withTf(m1), assetClass: 'unknown' });
  const without = analyze(withTf(m1));
  assert.equal(withClass.dir, without.dir);
  assert.equal(withClass.score, without.score);
  assert.deepEqual(withClass.ctx.band, { min: 0.0002, max: 0.02 });
});
