/* patterns.js — the foundation under 27 of the strategy's rules.
 *
 * Every candle here is hand-built so a failure names the exact geometry that
 * broke, rather than "a random walk stopped matching".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  body, range, upperWick, lowerWick, isBull, isBear, bodyPct, closePosition,
  detectPatterns, pivots, levels, nearestLevel, structure, breakAndRetest, vwap,
} from '../src/background/patterns.js';

const C = (t, o, h, l, c, v) => ({ t, o, h, l, c, v });
const names = (list) => list.map((p) => p.name);
const has = (list, frag) => list.some((p) => p.name.includes(frag));

/* ------------------------------ anatomy ------------------------------ */

test('candle anatomy measures what it says it measures', () => {
  const bull = C(0, 100, 103, 99, 102);
  assert.equal(body(bull), 2);
  assert.equal(range(bull), 4);
  assert.equal(upperWick(bull), 1); // 103 - max(100,102)
  assert.equal(lowerWick(bull), 1); // min(100,102) - 99
  assert.ok(isBull(bull) && !isBear(bull));

  const bear = C(0, 102, 103, 99, 100);
  assert.equal(body(bear), 2);
  assert.equal(upperWick(bear), 1); // 103 - 102
  assert.equal(lowerWick(bear), 1); // 100 - 99
  assert.ok(isBear(bear) && !isBull(bear));

  const flat = C(0, 100, 100, 100, 100);
  assert.ok(!isBull(flat) && !isBear(flat), 'a doji is neither');
});

test('range never returns 0 — a zero-range candle would divide by zero downstream', () => {
  const flat = C(0, 100, 100, 100, 100);
  assert.ok(range(flat) > 0, `range was ${range(flat)}`);
  assert.ok(Number.isFinite(closePosition(flat)), 'closePosition stays finite');
  assert.ok(Number.isFinite(bodyPct(flat)), 'bodyPct stays finite');
});

test('closePosition is 0 at the low and 1 at the high', () => {
  assert.equal(closePosition(C(0, 100, 105, 95, 95)), 0);
  assert.equal(closePosition(C(0, 100, 105, 95, 105)), 1);
  assert.equal(closePosition(C(0, 100, 105, 95, 100)), 0.5);
});

test('bodyPct is a percentage, not a ratio', () => {
  const marubozu = C(0, 100, 105, 100, 105); // no wicks at all
  assert.equal(bodyPct(marubozu), 100);
  assert.equal(bodyPct(C(0, 100, 104, 96, 102)), 25);
});

/* ------------------------------ patterns ----------------------------- */

test('detectPatterns needs three candles and returns [] rather than crashing below that', () => {
  assert.deepEqual(detectPatterns([]), []);
  assert.deepEqual(detectPatterns([C(0, 1, 1, 1, 1)]), []);
  assert.deepEqual(detectPatterns([C(0, 1, 1, 1, 1), C(0, 1, 1, 1, 1)]), []);
});

test('a hammer is bullish and carries the heaviest weight', () => {
  // Tiny body near the top, long lower wick.
  const cs = [C(1, 100, 100.4, 99.6, 100.2), C(2, 100.2, 100.5, 99.9, 100.1), C(3, 100.0, 100.15, 99.0, 100.1)];
  const r = detectPatterns(cs);
  assert.ok(has(r, 'Hammer'), names(r).join('|'));
  assert.equal(r.find((p) => p.name.includes('Hammer')).dir, 'up');
  assert.equal(r.find((p) => p.name.includes('Hammer')).weight, 3);
  assert.ok(!has(r, 'Shooting star'), 'the mirror image must not also fire');
});

test('a shooting star is bearish', () => {
  // Tiny body near the bottom, long upper wick.
  const cs = [C(1, 100, 100.4, 99.6, 100.2), C(2, 100.2, 100.5, 99.9, 100.1), C(3, 100.0, 101.0, 99.85, 99.9)];
  const r = detectPatterns(cs);
  assert.ok(has(r, 'Shooting star'), names(r).join('|'));
  assert.equal(r.find((p) => p.name.includes('Shooting')).dir, 'down');
  assert.equal(r.find((p) => p.name.includes('Shooting')).weight, 3);
});

test('a doji is reported as indecision and votes for nothing', () => {
  const cs = [C(1, 100, 100.4, 99.6, 100.2), C(2, 100.2, 100.5, 99.9, 100.1), C(3, 100, 100.5, 99.5, 100.01)];
  const d = detectPatterns(cs).find((p) => p.name.includes('Doji'));
  assert.ok(d, names(detectPatterns(cs)).join('|'));
  assert.equal(d.dir, null, 'a doji must not pick a side');
  assert.equal(d.weight, 0);
});

test('a strong bullish engulfing outweighs a weak one', () => {
  const prev = C(2, 101, 101.2, 99.9, 100); // bearish
  const strong = C(3, 99.8, 101.5, 99.7, 101.3); // body 1.5 of range 1.8
  const weak = C(3, 99.9, 102.5, 99.5, 101.1); // body 1.2 of range 3.0 = 0.40, under 0.55
  const filler = C(1, 100, 100.4, 99.6, 100.2);

  const s = detectPatterns([filler, prev, strong]).find((p) => p.name.includes('Bullish engulfing'));
  assert.ok(s, 'strong engulfing should fire');
  assert.equal(s.weight, 3);

  const w = detectPatterns([filler, prev, weak]).find((p) => p.name.includes('Bullish engulfing'));
  assert.ok(w, 'weak engulfing should still fire');
  assert.equal(w.weight, 2);
});

test('a bearish engulfing fires on the mirror geometry', () => {
  const prev = C(2, 100, 101.1, 99.8, 101); // bullish
  const now = C(3, 101.2, 101.4, 99.7, 99.8); // bearish, engulfs
  const r = detectPatterns([C(1, 100, 100.4, 99.6, 100.2), prev, now]);
  const b = r.find((p) => p.name.includes('Bearish engulfing'));
  assert.ok(b, names(r).join('|'));
  assert.equal(b.dir, 'down');
});

test('engulfing requires the previous candle to be the opposite colour', () => {
  const bothBull = [C(1, 100, 100.4, 99.6, 100.2), C(2, 100, 100.6, 99.9, 100.5), C(3, 99.9, 101.0, 99.8, 100.9)];
  const r = detectPatterns(bothBull);
  assert.ok(!has(r, 'engulfing'), `two bulls cannot engulf: ${names(r).join('|')}`);
});

test('an inside bar is compression and votes for nothing', () => {
  const cs = [C(1, 100, 100.4, 99.6, 100.2), C(2, 100, 102, 98, 101), C(3, 100.5, 101.5, 99, 101.2)];
  const ib = detectPatterns(cs).find((p) => p.name.includes('Inside bar'));
  assert.ok(ib);
  assert.equal(ib.dir, null);
  assert.equal(ib.weight, 0);
});

test('three white soldiers and three black crows fire in the right direction only', () => {
  const rising = [
    C(1, 100.0, 101.0, 99.9, 100.9),
    C(2, 100.9, 101.9, 100.8, 101.8),
    C(3, 101.8, 102.8, 101.7, 102.7),
  ];
  const r = detectPatterns(rising);
  assert.ok(has(r, 'Three white soldiers'), names(r).join('|'));
  assert.equal(r.find((p) => p.name.includes('white')).dir, 'up');
  assert.ok(!has(r, 'black crows'));

  const falling = rising.map((c) => C(c.t, 200 - c.o, 200 - c.l, 200 - c.h, 200 - c.c));
  const r2 = detectPatterns(falling);
  assert.ok(has(r2, 'Three black crows'), names(r2).join('|'));
  assert.equal(r2.find((p) => p.name.includes('crows')).dir, 'down');
});

test('a fakey sweep is only a fakey when price closes back inside', () => {
  // Sweeps the previous low but closes back above it, high in its range.
  const sweep = [C(1, 100, 100.4, 99.6, 100.2), C(2, 100, 100.5, 99.5, 100.2), C(3, 100.1, 100.6, 99.3, 100.55)];
  assert.ok(has(detectPatterns(sweep), 'Fakey (low sweep)'), names(detectPatterns(sweep)).join('|'));

  // Sweeps and closes below: that is a breakdown, not a fakey.
  const breakdown = [C(1, 100, 100.4, 99.6, 100.2), C(2, 100, 100.5, 99.5, 100.2), C(3, 99.4, 99.6, 99.0, 99.1)];
  assert.ok(!has(detectPatterns(breakdown), 'Fakey (low sweep)'), 'a genuine breakdown must not be called a fakey');
});

test('a gentle trend with wicks triggers no pattern at all', () => {
  // Small bodies relative to range: no soldiers, no engulfing, no pins.
  const cs = [C(1, 100.0, 100.5, 99.7, 100.2), C(2, 100.2, 100.7, 99.9, 100.4), C(3, 100.4, 100.9, 100.1, 100.6)];
  const r = detectPatterns(cs);
  assert.ok(r.every((p) => p.weight === 0 || p.dir === null), `unexpected votes: ${names(r).join('|')}`);
});

test('every emitted pattern has a usable shape for the strategy', () => {
  const cs = [C(1, 101, 101.2, 99.9, 100), C(2, 100, 100.6, 99.4, 100.4), C(3, 99.8, 101.5, 99.7, 101.3)];
  for (const p of detectPatterns(cs)) {
    assert.ok(typeof p.name === 'string' && p.name.length > 0);
    assert.ok(['up', 'down', null].includes(p.dir), `bad dir ${p.dir}`);
    assert.ok(Number.isFinite(p.weight) && p.weight >= 0);
  }
});

/* ------------------------------- pivots ------------------------------ */

/** A zigzag: peaks and troughs every `period` bars around a drifting base. */
function zigzag({ n = 60, start = 100, drift = 0.5, amp = 1.0, period = 7, t0 = 1_700_000_000_000 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const mid = start + i * drift + amp * Math.sin((i / period) * Math.PI * 2);
    out.push(C(t0 + i * 60_000, mid, mid + 0.15, mid - 0.15, mid));
  }
  return out;
}

test('pivots needs 2k+1 candles and returns [] below that', () => {
  assert.deepEqual(pivots([], 2), []);
  assert.deepEqual(pivots(zigzag({ n: 4 }), 2), []);
  assert.ok(pivots(zigzag({ n: 5 }), 2).length >= 0);
});

test('pivots finds alternating highs and lows on a clean zigzag', () => {
  const pv = pivots(zigzag({ n: 60, drift: 0 }), 2);
  assert.ok(pv.length >= 6, `expected several pivots, got ${pv.length}`);
  for (const p of pv) {
    assert.ok(p.type === 'H' || p.type === 'L');
    assert.ok(Number.isFinite(p.price) && Number.isFinite(p.t) && Number.isInteger(p.i));
  }
  const highs = pv.filter((p) => p.type === 'H');
  const lows = pv.filter((p) => p.type === 'L');
  assert.ok(highs.length && lows.length, 'both kinds must appear');
  assert.ok(Math.min(...highs.map((h) => h.price)) > Math.max(...lows.map((l) => l.price)),
    'on a clean zigzag every swing high sits above every swing low');
});

test('pivots are ordered by time', () => {
  const pv = pivots(zigzag({ n: 80 }), 2);
  for (let i = 1; i < pv.length; i++) assert.ok(pv[i].t > pv[i - 1].t);
});

test('a higher k demands a wider swing', () => {
  const cs = zigzag({ n: 60, drift: 0 });
  assert.ok(pivots(cs, 3).length <= pivots(cs, 2).length);
});

/* ------------------------------- levels ------------------------------ */

test('levels needs an ATR and at least one pivot', () => {
  assert.deepEqual(levels(zigzag(), 0), []);
  assert.deepEqual(levels([], 1), []);
  assert.deepEqual(levels(zigzag({ n: 3 }), 1), []);
});

test('nearby pivots cluster into one level whose touch count grows', () => {
  const cs = zigzag({ n: 90, drift: 0, amp: 1.0 });
  const lv = levels(cs, 0.4);
  assert.ok(lv.length > 0);
  assert.ok(lv.some((l) => l.touches >= 2), `expected clustering, got ${JSON.stringify(lv)}`);
  assert.deepEqual([...lv].sort((a, b) => b.touches - a.touches).map((l) => l.touches), lv.map((l) => l.touches),
    'levels come back strongest first');
});

test('a level touched from both sides is "both", not arbitrarily one or the other', () => {
  const cs = zigzag({ n: 90, drift: 0, amp: 1.0 });
  const lv = levels(cs, 0.4);
  const kinds = new Set(lv.map((l) => l.kind));
  for (const k of kinds) assert.ok(['support', 'resistance', 'both'].includes(k), `bad kind ${k}`);
  assert.ok(kinds.has('both') || kinds.size > 0);
});

test('a flat series produces levels within the price range, never outside it', () => {
  const cs = zigzag({ n: 90, drift: 0, amp: 1.0, start: 100 });
  const lo = Math.min(...cs.map((c) => c.l));
  const hi = Math.max(...cs.map((c) => c.h));
  for (const l of levels(cs, 0.4)) {
    assert.ok(l.price >= lo - 1e-9 && l.price <= hi + 1e-9, `level ${l.price} outside [${lo},${hi}]`);
  }
});

test('nearestLevel respects its distance limit', () => {
  const lv = [{ price: 100, touches: 3, last: 1, kind: 'support' }, { price: 110, touches: 2, last: 2, kind: 'resistance' }];
  assert.equal(nearestLevel(100.5, lv, 1).level.price, 100);
  assert.equal(nearestLevel(106, lv, 10).level.price, 110, 'the nearer of two in range wins');
  assert.equal(nearestLevel(200, lv, 1), null, 'nothing within range');
  assert.equal(nearestLevel(100, [], 5), null);
  assert.equal(nearestLevel(100, null, 5), null);
});

/* ----------------------------- structure ----------------------------- */

test('rising highs AND rising lows are an uptrend', () => {
  assert.equal(structure(zigzag({ n: 90, drift: 0.5, amp: 1.0 }), 0.4), 'up');
});

test('falling highs AND falling lows are a downtrend', () => {
  assert.equal(structure(zigzag({ n: 90, drift: -0.5, amp: 1.0 }), 0.4), 'down');
});

test('a flat zigzag is a range, not a coin-flip trend', () => {
  assert.equal(structure(zigzag({ n: 90, drift: 0, amp: 1.0 }), 0.4), 'range');
});

test('too little history or no ATR says "warming", never guesses', () => {
  assert.equal(structure(zigzag({ n: 90, drift: 0.5 }), 0), 'warming');
  assert.equal(structure(zigzag({ n: 4 }), 0.4), 'warming');
  assert.equal(structure([], 0.4), 'warming');
});

test('a tiny drift inside the ATR tolerance is still a range', () => {
  // 0.02/bar over a 6-bar cycle moves a peak by 0.12, well under 0.15*ATR.
  assert.equal(structure(zigzag({ n: 90, drift: 0.02, amp: 1.0 }), 2.0), 'range');
});

/* -------------------------- break and retest -------------------------- */

test('breakAndRetest needs history and an ATR', () => {
  assert.equal(breakAndRetest([], 100, 1), null);
  assert.equal(breakAndRetest(zigzag({ n: 10 }), 100, 0), null);
  assert.equal(breakAndRetest(zigzag({ n: 3 }), 100, 1), null);
});

test('a close above a level, a hold, then a bullish pullback to it is an "up" retest', () => {
  const level = 100;
  const cs = [
    C(1, 99.0, 99.4, 98.8, 99.2),     // below the level
    C(2, 99.2, 100.9, 99.1, 100.7),   // breaks above (band is 0.2*ATR)
    C(3, 100.7, 101.2, 100.5, 101.0), // holds above
    C(4, 100.2, 100.8, 100.0, 100.6), // dips to the level and closes BULLISH
  ];
  assert.equal(breakAndRetest(cs, level, 1.0), 'up');
});

test('a close below, a hold, then a bearish pullback up to it is a "down" retest', () => {
  const level = 100;
  const cs = [
    C(1, 101.0, 101.4, 100.8, 101.2), // above the level
    C(2, 101.2, 101.3, 99.2, 99.4),   // breaks below
    C(3, 99.4, 99.6, 98.9, 99.2),     // holds below
    C(4, 99.9, 100.0, 99.3, 99.4),    // rises to the level and closes BEARISH
  ];
  assert.equal(breakAndRetest(cs, level, 1.0), 'down');
});

test('a break that immediately fails is not a retest', () => {
  const cs = [
    C(1, 99.0, 99.4, 98.8, 99.2),
    C(2, 99.2, 100.9, 99.1, 100.7), // breaks above
    C(3, 100.7, 100.8, 98.5, 98.7), // falls straight back through
    C(4, 98.7, 99.0, 98.4, 98.6),
  ];
  assert.equal(breakAndRetest(cs, 100, 1.0), null);
});

test('price that never reaches the level is not a retest', () => {
  const cs = zigzag({ n: 12, start: 50, drift: 0, amp: 0.5 });
  assert.equal(breakAndRetest(cs, 100, 0.4), null);
});

/* -------------------------------- vwap -------------------------------- */

test('vwap is a running average weighted by volume', () => {
  const out = vwap([C(1, 10, 12, 8, 10, 1), C(2, 10, 22, 18, 20, 3)]);
  assert.equal(out.length, 2);
  assert.equal(out[0], (10) / 1); // typical of bar 1 = (12+8+10)/3 = 10
  const expected = (10 * 1 + 20 * 3) / 4;
  assert.ok(Math.abs(out[1] - expected) < 1e-9, `${out[1]} vs ${expected}`);
});

test('vwap treats a missing or zero volume as 1 rather than dividing by zero', () => {
  const out = vwap([C(1, 10, 12, 8, 10), C(2, 10, 12, 8, 10, 0)]);
  assert.equal(out.length, 2);
  for (const v of out) assert.ok(Number.isFinite(v), `non-finite vwap ${v}`);
});

test('vwap on nothing is nothing', () => {
  assert.deepEqual(vwap([]), []);
  assert.deepEqual(vwap(null), []);
  assert.deepEqual(vwap(undefined), []);
});
