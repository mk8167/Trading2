import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TF_MS, bucketOf, upsertCandle, makeSeries, pushTick, aggregate, deriveAll,
  compact, expand, normaliseTs, formatPrice, secondsToClose, isCandle,
} from '../src/background/candles.js';

const MIN = 1_699_999_980_000; // an exact multiple of 60_000

test('bucketOf floors to the bar open time', () => {
  assert.equal(bucketOf(MIN + 30_000, TF_MS.m1), MIN);
  assert.equal(bucketOf(MIN, TF_MS.m1), MIN);
  assert.equal(bucketOf(61_000, TF_MS.m1), 60_000);
  assert.equal(bucketOf(301_000, TF_MS.m5), 300_000);
});

test('normaliseTs upgrades epoch seconds to milliseconds', () => {
  assert.equal(normaliseTs(1_700_000_000), 1_700_000_000_000);
  assert.equal(normaliseTs(1_700_000_000_000), 1_700_000_000_000);
});

test('upsertCandle updates the live bar and appends newer bars', () => {
  const arr = [];
  assert.equal(upsertCandle(arr, { t: 60_000, o: 1, h: 2, l: 0.5, c: 1.5 }), true);
  assert.equal(upsertCandle(arr, { t: 60_000, o: 9, h: 3, l: 0.2, c: 1.2 }), true);
  assert.deepEqual(arr[0], { t: 60_000, o: 1, h: 3, l: 0.2, c: 1.2 });
  upsertCandle(arr, { t: 120_000, o: 1.2, h: 1.4, l: 1.1, c: 1.3 });
  assert.equal(arr.length, 2);
  // older data must never rewrite history
  assert.equal(upsertCandle(arr, { t: 0, o: 5, h: 5, l: 5, c: 5 }), false);
  assert.equal(arr.length, 2);
});

test('upsertCandle rejects malformed candles', () => {
  const arr = [];
  assert.equal(upsertCandle(arr, { t: 1, o: NaN, h: 1, l: 1, c: 1 }), false);
  assert.equal(upsertCandle(arr, null), false);
  assert.equal(isCandle({ t: 1, o: 1, h: 1, l: 1, c: 1 }), true);
});

test('pushTick aggregates ticks into one-minute bars', () => {
  const s = makeSeries(TF_MS.m1);
  const base = MIN;
  pushTick(s, 1.1, base + 1000);
  pushTick(s, 1.3, base + 20_000);
  pushTick(s, 1.0, base + 40_000);
  assert.equal(s.length, 1);
  assert.deepEqual(s[0], { t: base, o: 1.1, h: 1.3, l: 1.0, c: 1.0 });
  pushTick(s, 1.2, base + 61_000);
  assert.equal(s.length, 2);
  assert.equal(s[1].t, base + 60_000);
});

test('pushTick ignores junk prices', () => {
  const s = makeSeries(TF_MS.m1);
  assert.equal(pushTick(s, NaN), false);
  assert.equal(pushTick(s, 0), false);
  assert.equal(pushTick(s, -1), false);
  assert.equal(s.length, 0);
});

test('aggregate rebuilds 5m bars from 1m bars without losing high/low', () => {
  const m1 = [];
  const base = 0;
  const prices = [1, 3, 2, 5, 4, 6, 1, 2, 3, 4];
  prices.forEach((p, i) => m1.push({ t: base + i * 60_000, o: p, h: p + 0.5, l: p - 0.5, c: p }));
  const m5 = aggregate(m1, TF_MS.m5);
  assert.equal(m5.length, 2);
  assert.equal(m5[0].o, 1);
  assert.equal(m5[0].h, 5.5);
  assert.equal(m5[0].l, 0.5);
  assert.equal(m5[0].c, 4);
  assert.equal(m5[1].o, 6);
});

test('deriveAll produces every timeframe from m1', () => {
  const m1 = [];
  for (let i = 0; i < 60; i++) m1.push({ t: i * 60_000, o: 1, h: 2, l: 0.5, c: 1.5 });
  const all = deriveAll(m1);
  assert.equal(all.m1.length, 60);
  assert.equal(all.m5.length, 12);
  assert.equal(all.m15.length, 4);
  assert.equal(all.m30.length, 2);
});

test('compact/expand round-trips without precision loss at 8dp', () => {
  const src = [{ t: 1_700_000_000_000, o: 1.123456789, h: 1.2, l: 1.1, c: 1.15 }];
  const back = expand(compact(src));
  assert.equal(back.length, 1);
  assert.equal(back[0].o, 1.12345679);
  assert.equal(back[0].t, src[0].t);
});

test('formatPrice picks decimals by magnitude', () => {
  assert.equal(formatPrice(65432.1), '65432.10');
  assert.equal(formatPrice(1.08432), '1.08432');
  assert.equal(formatPrice(NaN), '—');
});

test('secondsToClose counts down inside the current bar', () => {
  assert.equal(secondsToClose('m1', MIN + 30_000), 30); // 30s into a minute
  assert.equal(secondsToClose('m1', MIN), 60); // right at the open
  assert.equal(secondsToClose('m5', 300_000 + 30_000), 270);
});
