import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sma, ema, rsi, atr, trueRange, macd, bollinger, stochastic, adx,
  slope, highest, lowest, changePct, last, prev,
} from '../src/background/indicators.js';
import { series } from './helpers.mjs';

const ramp = Array.from({ length: 10 }, (_, i) => i + 1); // 1..10

test('sma is null until the window fills, then correct', () => {
  const out = sma(ramp, 3);
  assert.equal(out.length, 10);
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  assert.equal(out[2], 2); // (1+2+3)/3
  assert.equal(out[9], 9); // (8+9+10)/3
});

test('ema converges to the level of a constant series', () => {
  const out = ema(new Array(200).fill(5), 21);
  assert.ok(Math.abs(out[199] - 5) < 1e-9);
});

test('ema rises monotonically on a rising series', () => {
  const out = ema(ramp, 3);
  for (let i = 3; i < out.length; i++) assert.ok(out[i] > out[i - 1]);
});

test('rsi is ~100 for a pure uptrend and ~0 for a pure downtrend', () => {
  const up = rsi(ramp, 5);
  const down = rsi([...ramp].reverse(), 5);
  assert.ok(up[9] > 99, `up rsi was ${up[9]}`);
  assert.ok(down[9] < 1, `down rsi was ${down[9]}`);
});

test('rsi stays inside 0..100 on noisy data', () => {
  const out = rsi(series({ n: 300 }).map((c) => c.c), 14);
  for (const v of out) if (v != null) assert.ok(v >= 0 && v <= 100);
});

test('rsi returns nulls when there is not enough history', () => {
  assert.deepEqual(rsi([1, 2, 3], 14), [null, null, null]);
});

test('atr is positive and matches a hand-computed true range', () => {
  const candles = [
    { t: 0, o: 10, h: 11, l: 9, c: 10.5 },
    { t: 1, o: 10.5, h: 12, l: 10, c: 11.5 },
    { t: 2, o: 11.5, h: 11.8, l: 10.2, c: 10.4 },
  ];
  const tr = trueRange(candles);
  assert.equal(tr[0], 2); // h-l
  assert.equal(tr[1], 2); // max(1, |12-10.5|, |10-10.5|) = 2
  assert.ok(Math.abs(tr[2] - 1.6) < 1e-9); // max(h-l=1.6, |11.8-11.5|=0.3, |10.2-11.5|=1.3)
  const a = atr(candles, 2);
  assert.ok(a[2] > 0);
});

test('macd arrays stay index-aligned with the input', () => {
  const v = series({ n: 120 }).map((c) => c.c);
  const m = macd(v);
  assert.equal(m.macd.length, v.length);
  assert.equal(m.signal.length, v.length);
  assert.equal(m.hist.length, v.length);
  const i = v.length - 1;
  assert.ok(Math.abs(m.hist[i] - (m.macd[i] - m.signal[i])) < 1e-9);
});

test('bollinger bands bracket the price and pctB is sane', () => {
  const v = series({ n: 120 }).map((c) => c.c);
  const b = bollinger(v, 20, 2);
  const i = v.length - 1;
  assert.ok(b.upper[i] > b.mid[i] && b.mid[i] > b.lower[i]);
  assert.ok(b.pctB[i] >= -1 && b.pctB[i] <= 2);
  assert.equal(b.upper[5], null, 'window not filled yet');
});

test('stochastic %K stays in 0..100', () => {
  const cs = series({ n: 120 });
  const s = stochastic(cs, 14, 3);
  for (const v of s.k) if (v != null) assert.ok(v >= 0 && v <= 100);
  assert.equal(s.k.length, cs.length);
});

test('adx is 0..100 and stronger on a clean trend than on noise', () => {
  const trend = adx(series({ n: 200, drift: 0.2, amp: 0.02, noise: 0.01 }), 14);
  const noise = adx(series({ n: 200, drift: 0, amp: 0.5, noise: 0.2, seed: 3 }), 14);
  const t = last(trend.adx);
  const n2 = last(noise.adx);
  assert.ok(t >= 0 && t <= 100, `adx ${t}`);
  assert.ok(t > n2, `trend adx ${t} should exceed noise adx ${n2}`);
});

test('slope is positive on a rising line and negative on a falling one', () => {
  assert.ok(slope([1, 2, 3, 4, 5], 5) > 0.99);
  assert.ok(slope([5, 4, 3, 2, 1], 5) < -0.99);
  assert.equal(slope([1, 2], 5), 0, 'not enough data');
});

test('highest/lowest/changePct', () => {
  assert.equal(highest([1, 5, 3], 3), 5);
  assert.equal(lowest([1, 5, 3], 3), 1);
  assert.equal(changePct([100, 110], 1), 10);
  assert.equal(highest([], 3), null);
});

test('last/prev skip null padding', () => {
  assert.equal(last([null, 1, 2, null]), 2);
  assert.equal(prev([1, 2, 3], 1), 2);
  assert.equal(prev([1, 2, 3], 2), 1);
  assert.equal(last([]), null);
});

test('indicators are fast enough for a 1s heartbeat', () => {
  const cs = series({ n: 600 });
  const closes = cs.map((c) => c.c);
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) {
    ema(closes, 21);
    rsi(closes, 14);
    atr(cs, 14);
    macd(closes);
    bollinger(closes, 20, 2);
    stochastic(cs, 14, 3);
    adx(cs, 14);
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `20 full passes over 600 candles took ${ms.toFixed(0)}ms`);
});
