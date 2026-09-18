/* recommend.js — pair selection has to be justifiable, not vibes.
 *
 * Every "never recommend X" case here is a way the old build lost money
 * quietly: a frozen forex chart on Saturday, a 60% payout pair whose
 * break-even is unreachable, a pair that went 2-for-2 and looked like an
 * edge.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  recommend,
  wilsonLowerBound,
  historyBySymbol,
  WEIGHTS,
  MIN_HISTORY,
} from '../src/background/recommend.js';
import { breakEvenWinRate } from '../src/background/strategy.js';

const SAT = Date.UTC(2026, 8, 19, 12, 0, 0); // Saturday: forex closed, crypto open
const WED = Date.UTC(2026, 8, 16, 12, 0, 0); // Wednesday: everything open

/** A symbol row shaped like store.listSymbols() produces. */
function row(over = {}) {
  return {
    sym: 'EURUSD_OTC',
    pretty: 'EUR/USD OTC',
    assetClass: 'synthetic',
    otc: true,
    source: 'quotex',
    price: 1.0965,
    ts: Date.now(),
    payout: 92,
    ticks: 5000,
    bars: 240,
    stale: false,
    selected: false,
    ...over,
  };
}

const sig = (dir, confidence = 80, score = 5, volatility = 0.002) =>
  dir ? { dir, confidence, score, vetoes: [], ctx: { volatility } } : null;

const decided = (sym, result, n) =>
  Array.from({ length: n }, (_, i) => ({ sym, result, id: `${sym}-${result}-${i}`, stake: 1, payout: 86 }));

/* --------------------------- the statistics --------------------------- */

test('wilsonLowerBound is 0 for an empty sample, never NaN', () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.equal(wilsonLowerBound(5, 0), 0);
  assert.equal(wilsonLowerBound(0, -1), 0);
  assert.equal(wilsonLowerBound(NaN, NaN), 0);
});

test('wilsonLowerBound never exceeds the raw win rate', () => {
  for (const [w, n] of [[1, 1], [2, 2], [10, 10], [7, 10], [30, 40], [0, 10], [100, 100]]) {
    const lb = wilsonLowerBound(w, n);
    assert.ok(lb <= w / n + 1e-9, `${w}/${n}: lb ${lb} > raw ${w / n}`);
    assert.ok(lb >= 0 && lb <= 1, `${w}/${n}: out of range ${lb}`);
  }
});

test('two wins out of two is NOT treated as an edge — that is the whole point', () => {
  const lucky = wilsonLowerBound(2, 2);
  const proven = wilsonLowerBound(30, 40);
  assert.ok(lucky < 1, 'a perfect short run must be discounted');
  assert.ok(proven > lucky, `proven ${proven} should beat lucky ${lucky}`);
  assert.ok(lucky < 0.85, `2/2 lower bound should be well under 85%, got ${lucky}`);
});

test('more evidence at the same rate raises confidence', () => {
  const small = wilsonLowerBound(6, 10);
  const large = wilsonLowerBound(60, 100);
  assert.ok(large > small, `${large} should exceed ${small}`);
});

test('historyBySymbol ignores ties and voids — they decided nothing', () => {
  const h = historyBySymbol([
    ...decided('EURUSD_OTC', 'win', 3),
    ...decided('EURUSD_OTC', 'loss', 1),
    { sym: 'EURUSD_OTC', result: 'tie', stake: 1 },
    { sym: 'EURUSD_OTC', result: 'void', stake: 1 },
    { sym: 'EURUSD_OTC', result: null, stake: 1 },
  ]);
  assert.equal(h.get('EURUSD_OTC').n, 4, 'only the four decided trades count');
  assert.equal(h.get('EURUSD_OTC').wins, 3);
});

/* ---------------------------- hard filters ---------------------------- */

test('never recommends a pair with no live data', () => {
  const r = recommend([row({ stale: true })], [], { now: WED });
  assert.equal(r.best, null);
  assert.equal(r.ineligible.length, 1);
  assert.match(r.ineligible[0].reasons[0], /stale/i);
});

test('never recommends a pair still warming up (fewer than 40 closed bars)', () => {
  const r = recommend([row({ bars: 12 })], [], { now: WED });
  assert.equal(r.best, null);
  assert.match(r.ineligible[0].reasons[0], /12\/40/);
});

test('never recommends a forex pair on a Saturday — the chart is frozen', () => {
  const fx = row({ sym: 'EURUSD', pretty: 'EUR/USD', assetClass: 'forex', otc: false });
  const r = recommend([fx], [], { now: SAT });
  assert.equal(r.best, null);
  assert.match(r.ineligible[0].reasons[0], /closed for the weekend/i);
});

test('DOES recommend a crypto pair on a Saturday — crypto never closes', () => {
  const crypto = row({ sym: 'BTCUSD', pretty: 'BTC/USD', assetClass: 'crypto', otc: false, payout: 78 });
  const r = recommend([crypto], [], { now: SAT, signalOf: () => sig('up') });
  assert.ok(r.best, 'crypto must be tradeable at the weekend');
  assert.equal(r.best.sym, 'BTCUSD');
});

test('DOES recommend an OTC pair on a Saturday — the platform synthesises it 24/7', () => {
  const r = recommend([row()], [], { now: SAT, signalOf: () => sig('up') });
  assert.ok(r.best);
  assert.equal(r.best.assetClass, 'synthetic');
});

test('never recommends a payout below the floor — the maths cannot work', () => {
  const r = recommend([row({ payout: 60 })], [], { now: WED, settings: { strategy: { minPayout: 70 } } });
  assert.equal(r.best, null);
  const why = r.ineligible[0].reasons[0];
  assert.match(why, /60%/);
  assert.match(why, /break-even/);
});

test('the stated break-even in the rejection really is the break-even for that payout', () => {
  const r = recommend([row({ payout: 60 })], [], { now: WED, settings: { strategy: { minPayout: 70 } } });
  const be = breakEvenWinRate(60);
  assert.ok(be > 0.6, `60% payout needs ${(be * 100).toFixed(1)}% wins`);
  assert.match(r.ineligible[0].reasons[0], new RegExp((be * 100).toFixed(1)));
});

test('never recommends a pair that already has an open trade', () => {
  const r = recommend([row()], [], { now: WED, openSymbols: ['EURUSD_OTC'], signalOf: () => sig('up') });
  assert.equal(r.best, null);
  assert.match(r.ineligible[0].reasons[0], /already open/i);
});

/* ------------------------------- ranking ------------------------------ */

test('a live directional signal outranks the same pair with no signal', () => {
  const rows = [
    row({ sym: 'AAA_USD', pretty: 'AAA/USD', assetClass: 'forex', otc: false }),
    row({ sym: 'BBBUSD', pretty: 'BBB/USD', assetClass: 'forex', otc: false }),
  ];
  const r = recommend(rows, [], {
    now: WED,
    signalOf: (s) => (s === 'BBBUSD' ? sig('up', 90, 6) : sig(null)),
  });
  assert.equal(r.best.sym, 'BBBUSD');
  assert.ok(r.best.score > r.ranked[1].score);
});

test('higher confidence scores higher, all else equal', () => {
  const rows = [
    row({ sym: 'LOWUSD', assetClass: 'forex', otc: false }),
    row({ sym: 'HIGHUSD', assetClass: 'forex', otc: false }),
  ];
  const conf = { LOWUSD: 30, HIGHUSD: 95 };
  const r = recommend(rows, [], {
    now: WED,
    signalOf: (s) => sig('up', conf[s], 5),
  });
  assert.equal(r.best.sym, 'HIGHUSD');
});

test('a proven edge outranks a lucky streak of the same raw win rate', () => {
  const rows = [
    row({ sym: 'LUCKY', pretty: 'LUCKY', assetClass: 'synthetic' }),
    row({ sym: 'PROVEN', pretty: 'PROVEN', assetClass: 'synthetic' }),
  ];
  // Both are 100% raw. One has two trades, one has fifty.
  const trades = [...decided('LUCKY', 'win', 2), ...decided('PROVEN', 'win', 50)];
  const r = recommend(rows, trades, { now: WED, signalOf: () => sig('up', 70, 4) });
  assert.equal(r.best.sym, 'PROVEN');
  assert.ok(r.best.historyLowerBound > r.ranked[1].historyLowerBound);
});

test('history below the minimum sample earns no points and says so', () => {
  const r = recommend([row()], decided('EURUSD_OTC', 'win', 3), { now: WED, signalOf: () => sig('up') });
  assert.equal(r.best.parts.history, 0);
  assert.ok(r.best.reasons.some((x) => new RegExp(`too few to judge \\(<${MIN_HISTORY}\\)`).test(x)));
});

test('a pair whose history is below break-even gets no history points', () => {
  // 20% wins against an 86% payout (break-even 53.8%) is a proven loser.
  const trades = [...decided('EURUSD_OTC', 'win', 8), ...decided('EURUSD_OTC', 'loss', 32)];
  const r = recommend([row({ payout: 86 })], trades, { now: WED, signalOf: () => sig('up') });
  assert.equal(r.best.parts.history, 0);
  assert.ok(r.best.reasons.some((x) => /No proven edge yet/.test(x)));
});

test('scores are bounded 0..100 and the weights sum to 100', () => {
  assert.equal(WEIGHTS.signal + WEIGHTS.history + WEIGHTS.quality + WEIGHTS.volatility, 100);
  const trades = [...decided('EURUSD_OTC', 'win', 40)];
  const r = recommend([row({ payout: 95 })], trades, { now: WED, signalOf: () => sig('up', 100, 12, 0.002) });
  const b = r.best;
  assert.ok(b.score >= 0 && b.score <= 100, `score ${b.score} out of range`);
  for (const k of Object.keys(WEIGHTS)) {
    assert.ok(b.parts[k] >= 0 && b.parts[k] <= WEIGHTS[k] + 1e-9, `${k}=${b.parts[k]} exceeds its weight`);
  }
  const sum = Object.values(b.parts).reduce((a, x) => a + x, 0);
  assert.ok(Math.abs(sum - b.score) < 0.05, `parts sum ${sum} != score ${b.score}`);
});

test('every recommendation explains itself', () => {
  const r = recommend([row()], [], { now: WED, signalOf: () => sig('down', 60, 4) });
  assert.ok(Array.isArray(r.best.reasons) && r.best.reasons.length >= 3);
  for (const x of r.best.reasons) assert.ok(typeof x === 'string' && x.length > 5);
  assert.ok(r.best.reasons.some((s) => /DOWN signal/.test(s)));
  assert.ok(r.best.reasons.some((s) => /Data:/.test(s)));
});

test('every rejection explains itself too', () => {
  const bad = [row({ sym: 'A', stale: true }), row({ sym: 'B', bars: 5 }), row({ sym: 'C', payout: 10 })];
  const r = recommend(bad, [], { now: WED });
  assert.equal(r.ranked.length, 0);
  for (const x of r.ineligible) {
    assert.ok(x.reasons.length >= 1, `${x.sym} was rejected with no reason`);
    assert.equal(x.eligible, false);
  }
});

test('ranking is deterministic — same inputs, same order, every run', () => {
  const rows = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map((s, i) =>
    row({ sym: s, pretty: s, assetClass: 'synthetic', payout: 80 + i })
  );
  const opts = { now: WED, signalOf: (s) => sig(s < 'CCC' ? 'up' : 'down', 50 + s.charCodeAt(0) % 40, 4) };
  const a = recommend(rows, [], opts);
  const b = recommend(rows, [], opts);
  assert.deepEqual(a.ranked.map((x) => x.sym), b.ranked.map((x) => x.sym));
  assert.deepEqual(a.ranked.map((x) => x.score), b.ranked.map((x) => x.score));
});

test('ties are broken by symbol so the order never depends on map iteration', () => {
  const rows = [row({ sym: 'ZZZ' }), row({ sym: 'AAA' })];
  const r = recommend(rows, [], { now: WED, signalOf: () => null });
  assert.deepEqual(r.ranked.map((x) => x.sym), ['AAA', 'ZZZ']);
});

test('best is always the first ranked entry, and null when nothing qualifies', () => {
  const ok = recommend([row()], [], { now: WED, signalOf: () => sig('up') });
  assert.deepEqual(ok.best, ok.ranked[0]);
  const none = recommend([], [], { now: WED });
  assert.equal(none.best, null);
  assert.deepEqual(none.ranked, []);
});

test('empty and hostile input cannot throw', () => {
  assert.equal(recommend([], [], {}).best, null);
  assert.equal(recommend(null, null, {}).best, null);
  assert.equal(recommend([null, undefined, {}], [], {}).best, null);
  assert.equal(recommend([row()], null, { now: WED }).best !== undefined, true);
});

test('the payout it reports is the one actually used for break-even', () => {
  const r = recommend([row({ payout: 74 })], [], {
    now: WED,
    payoutOf: () => ({ payout: 74, origin: 'live' }),
    signalOf: () => sig('up'),
  });
  assert.equal(r.best.payout, 74);
  assert.equal(r.best.payoutOrigin, 'live');
  assert.equal(r.best.breakEven, Math.round(breakEvenWinRate(74) * 10000) / 10000);
});
