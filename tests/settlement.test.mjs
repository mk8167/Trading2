/* Expiry-accurate settlement.
 *
 * A binary option pays on the price AT expiry. Every test here exists because
 * the naive alternative — "settle at whatever the latest price is when the
 * heartbeat next runs" — is silently wrong in exactly the situation where it
 * matters: MV3 kills idle service workers, so the pass that settles your trade
 * can run minutes after it expired, by which time the market has moved. That
 * does not throw, does not look odd in the journal, and quietly converts real
 * wins into recorded losses (and the reverse), corrupting every statistic the
 * recommender learns from.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { install, reset as resetChrome } from './chrome-stub.mjs';

install();
const ledger = await import('../src/background/ledger.js');
const { priceAtExpiry, SETTLE_LAG_TOLERANCE_MS, SETTLE_GRACE_MS } = ledger;

const M1 = 60_000;
const EXPIRY = 1_700_000_100_000; // a minute-aligned expiry, as brokers quote them

/** A completed 1m bar; its close is the price at `t + M1`. */
const bar = (t, c) => ({ t, o: c, h: c + 0.001, l: c - 0.001, c });

async function fresh() {
  resetChrome();
  await ledger.load();
  ledger.reset();
}

/** A 1-minute CALL struck at `entry`, expiring at EXPIRY. */
function call(entry, over = {}) {
  const t = ledger.openTrade({
    sym: 'EURUSD', dir: 'up', entry, stake: 10, payout: 85, tf: 'm1',
    expiryMinutes: 1, signals: [], score: 5, confidence: 80, source: 'quotex', ...over,
  });
  t.expiresAt = EXPIRY;
  t.openedAt = EXPIRY - M1;
  return t;
}

/* ------------------------- priceAtExpiry: choosing ------------------------- */

test('the bar that closed exactly at expiry beats a live price a second later', () => {
  const m1 = [bar(EXPIRY - 2 * M1, 1.0990), bar(EXPIRY - M1, 1.1050)];
  const got = priceAtExpiry(m1, EXPIRY, 1.1080, EXPIRY + 1000, EXPIRY + 1000);
  assert.equal(got.price, 1.1050, 'the expiry close, not the next tick');
  assert.equal(got.basis, 'bar');
  assert.equal(got.lagMs, 0);
});

test('a prompt settlement with no bar at expiry still uses the live price', () => {
  // Only older bars exist; the live tick is 1s from expiry, the bar is 90s away.
  const m1 = [bar(EXPIRY - 3 * M1, 1.0900)];
  const got = priceAtExpiry(m1, EXPIRY, 1.1080, EXPIRY + 1000, EXPIRY + 1000);
  assert.equal(got.price, 1.1080);
  assert.equal(got.basis, 'live');
  assert.equal(got.lagMs, 1000);
});

test('a bar still forming is never treated as a close', () => {
  const forming = bar(EXPIRY, 1.2345); // started at expiry, closes a minute later
  const got = priceAtExpiry([forming], EXPIRY, null, null, EXPIRY + 1000);
  assert.equal(got, null, 'an unfinished bar has no close to settle against');
});

test('after a long worker sleep the expiry bar wins over the current price', () => {
  const m1 = [bar(EXPIRY - M1, 1.1050), bar(EXPIRY, 1.1000)];
  const now = EXPIRY + 3 * M1; // worker was dead for three minutes
  const got = priceAtExpiry(m1, EXPIRY, 0.9000, now, now);
  assert.equal(got.price, 1.1050, 'the bar closing at expiry, not where price is now');
  assert.equal(got.lagMs, 0);
});

test('a price further than the tolerance from expiry is refused, not used', () => {
  const m1 = [bar(EXPIRY - 10 * M1, 1.0900)];
  const now = EXPIRY + 10 * M1;
  const got = priceAtExpiry(m1, EXPIRY, 1.2000, now, now);
  assert.ok(got, 'it still reports the nearest candidate');
  assert.equal(got.refused, true);
  assert.ok(got.lagMs > SETTLE_LAG_TOLERANCE_MS);
});

test('a stale feed timestamp stops the live price from pretending to be fresh', () => {
  const m1 = [bar(EXPIRY - M1, 1.1050)];
  const now = EXPIRY + 2 * M1;
  // priceOf() returns a number, but the feed has not updated since before expiry
  const got = priceAtExpiry(m1, EXPIRY, 1.3000, EXPIRY - 5 * M1, now);
  assert.equal(got.basis, 'bar', 'the completed bar is far nearer to expiry');
  assert.equal(got.price, 1.1050);
});

test('a live price with no feed timestamp is dated to now', () => {
  const now = EXPIRY + 2000;
  const got = priceAtExpiry([], EXPIRY, 1.1080, null, now);
  assert.equal(got.basis, 'live');
  assert.equal(got.lagMs, 2000);
});

test('malformed bars are skipped rather than poisoning the choice', () => {
  const m1 = [
    null,
    { t: EXPIRY - M1, c: NaN },
    { t: 'nope', c: 1.1 },
    bar(EXPIRY - M1, 1.1050),
  ];
  const got = priceAtExpiry(m1, EXPIRY, null, null, EXPIRY + 500);
  assert.equal(got.price, 1.1050);
});

test('no price at all returns null so the grace/void path can handle it', () => {
  assert.equal(priceAtExpiry(null, EXPIRY, null, null, EXPIRY + 1000), null);
  assert.equal(priceAtExpiry([], EXPIRY, null, null, EXPIRY + 1000), null);
  assert.equal(priceAtExpiry([], NaN, 1.1, EXPIRY, EXPIRY), null);
  assert.equal(priceAtExpiry([], EXPIRY, 0, EXPIRY, EXPIRY), null, 'a zero price is not a price');
  assert.equal(priceAtExpiry([], EXPIRY, -1.2, EXPIRY, EXPIRY), null);
});

test('the nearest of several bars is chosen, not merely the last one scanned', () => {
  const m1 = [bar(EXPIRY - 5 * M1, 1.01), bar(EXPIRY - M1, 1.02), bar(EXPIRY - 4 * M1, 1.03)];
  const got = priceAtExpiry(m1, EXPIRY, null, null, EXPIRY + 10 * M1);
  assert.equal(got.price, 1.02, 'the bar closing closest to expiry regardless of array order');
});

/* ------------------------- settleAllDue: consequences ---------------------- */

test('a slept worker settles at the expiry price, not at where the market drifted to', async () => {
  await fresh();
  // Struck at 1.1000 CALL. At expiry the price was 1.1050 — a clear win.
  // Three minutes later the pair has collapsed to 1.0800.
  const t = call(1.1000);
  const m1 = [bar(EXPIRY - 2 * M1, 1.0990), bar(EXPIRY - M1, 1.1050)];
  const now = EXPIRY + 3 * M1;

  const settled = ledger.settleAllDue(() => 1.0800, now, () => ({ m1, ts: now }));

  assert.equal(settled.length, 1);
  assert.equal(t.result, 'win', 'the trade the broker would have paid');
  assert.equal(t.exit, 1.1050, 'settled on the expiry close');
  assert.equal(t.settleBasis, 'bar');
  assert.ok(Math.abs(t.pnl - 10 * 0.85) < 1e-9, 'payout paid on the stake');
});

test('without the candle history a late settlement is voided rather than fabricated', async () => {
  await fresh();
  const t = call(1.1000);
  const now = EXPIRY + 3 * M1; // 180s of lag, beyond the 90s tolerance

  const settled = ledger.settleAllDue(() => 1.0800, now); // no seriesOf

  assert.equal(settled.length, 1);
  assert.equal(t.result, 'void', 'refuses to book a loss it cannot justify');
  assert.equal(t.pnl, 0);
  assert.match(t.voidReason, /no price within 90s of expiry/i);
  assert.match(t.voidReason, /180s away/);
});

test('a 60s-late settlement prefers the expiry bar over a live price that crossed the strike', async () => {
  await fresh();
  const t = call(1.1000);
  const m1 = [bar(EXPIRY - M1, 1.1020)]; // expiry price: a win by 20 pips
  const now = EXPIRY + 60_000; // live price 1.0980 would read as a loss
  const settled = ledger.settleAllDue(() => 1.0980, now, () => ({ m1, ts: now }));
  assert.equal(settled.length, 1);
  assert.equal(t.result, 'win');
  assert.equal(t.exit, 1.1020);
});

test('the same 60s-late trade settled WITHOUT history takes the wrong side — which is the bug', async () => {
  await fresh();
  const t = call(1.1000);
  const now = EXPIRY + 60_000;
  // Inside the tolerance, so no history means the live price is trusted.
  const settled = ledger.settleAllDue(() => 1.0980, now);
  assert.equal(settled.length, 1);
  assert.equal(t.result, 'loss', 'documents why seriesOf is wired in at all');
  assert.equal(t.settleBasis, 'live');
});

test('settlement records how the price was chosen', async () => {
  await fresh();
  const t = call(1.1000);
  const m1 = [bar(EXPIRY - M1, 1.1050)];
  ledger.settleAllDue(() => 1.1060, EXPIRY + 1000, () => ({ m1, ts: EXPIRY + 1000 }));
  assert.equal(t.settleBasis, 'bar');
  assert.equal(t.settleLagMs, 0);
});

test('a price taken well away from expiry is flagged in the event log', async () => {
  await fresh();
  call(1.1000);
  // No bar closes anywhere near expiry, so the live tick 45s on is the best
  // number available. That is within tolerance, but it deserves a warning.
  const now = EXPIRY + 45_000;
  ledger.settleAllDue(() => 1.1050, now, () => ({ m1: [bar(EXPIRY - 5 * M1, 1.0900)], ts: now }));
  const ev = ledger.events.find((e) => e.kind === 'win');
  assert.ok(ev, 'the win was logged');
  assert.match(ev.text, /settled on live 45s from expiry/, 'the log admits the price is approximate');
});

test('an exact expiry close needs no disclaimer, however late we settled', async () => {
  await fresh();
  call(1.1000);
  const now = EXPIRY + 5 * M1; // five minutes late — but the bar is exact
  ledger.settleAllDue(() => 1.4000, now, () => ({ m1: [bar(EXPIRY - M1, 1.1050)], ts: now }));
  const ev = ledger.events.find((e) => e.kind === 'win');
  assert.doesNotMatch(ev.text, /settled on/, 'lag measures price accuracy, not worker delay');
});

test('a prompt settlement does not clutter the log with lag warnings', async () => {
  await fresh();
  call(1.1000);
  ledger.settleAllDue(() => 1.1050, EXPIRY + 900);
  const ev = ledger.events.find((e) => e.kind === 'win');
  assert.ok(ev);
  assert.doesNotMatch(ev.text, /settled on/, 'a 1s heartbeat needs no disclaimer');
});

test('a tie at expiry is still a tie, using the expiry price', async () => {
  await fresh();
  const t = call(1.1000);
  const m1 = [bar(EXPIRY - M1, 1.1000)]; // closes exactly on the strike
  ledger.settleAllDue(() => 1.2000, EXPIRY + 1000, () => ({ m1, ts: EXPIRY + 1000 }));
  assert.equal(t.result, 'tie');
  assert.equal(t.pnl, 0);
  assert.equal(t.exit, 1.1000);
});

test('a PUT settles against the expiry price too', async () => {
  await fresh();
  const t = call(1.1000, { dir: 'down' });
  const m1 = [bar(EXPIRY - M1, 1.0900)]; // fell below the strike at expiry
  const now = EXPIRY + 3 * M1;
  ledger.settleAllDue(() => 1.1500, now, () => ({ m1, ts: now })); // rallied hard afterwards
  assert.equal(t.result, 'win', 'the expiry price decides, not the rally');
  assert.equal(t.exit, 1.0900);
});

test('several expired trades settle from their own symbols histories', async () => {
  await fresh();
  const a = call(1.1000, { sym: 'AAAUSD' });
  const b = call(2.0000, { sym: 'BBBUSD', dir: 'down' });
  const now = EXPIRY + 2 * M1;
  const series = {
    AAAUSD: { m1: [bar(EXPIRY - M1, 1.1050)], ts: now },
    BBBUSD: { m1: [bar(EXPIRY - M1, 2.0100)], ts: now },
  };
  const settled = ledger.settleAllDue(() => null, now, (s) => series[s] || null);
  assert.equal(settled.length, 2);
  assert.equal(a.result, 'win');
  assert.equal(b.result, 'loss');
});

test('an unexpired trade is untouched even when history is supplied', async () => {
  await fresh();
  const t = call(1.1000);
  t.expiresAt = EXPIRY + 10 * M1; // still running
  const settled = ledger.settleAllDue(() => 9.99, EXPIRY + 1000, () => ({ m1: [bar(EXPIRY - M1, 9.99)], ts: EXPIRY + 1000 }));
  assert.equal(settled.length, 0);
  assert.equal(t.result, null);
});

test('a settled trade is never re-settled by a later pass', async () => {
  await fresh();
  const t = call(1.1000);
  const m1 = [bar(EXPIRY - M1, 1.1050)];
  ledger.settleAllDue(() => 1.1050, EXPIRY + 1000, () => ({ m1, ts: EXPIRY + 1000 }));
  const first = { result: t.result, exit: t.exit, pnl: t.pnl };
  ledger.settleAllDue(() => 0.0001, EXPIRY + 5 * M1, () => ({ m1: [bar(EXPIRY + 4 * M1, 0.0001)], ts: EXPIRY + 5 * M1 }));
  assert.deepEqual({ result: t.result, exit: t.exit, pnl: t.pnl }, first, 'immutable once decided');
});

test('a refused settlement still releases the symbol so it can trade again', async () => {
  await fresh();
  call(1.1000);
  const now = EXPIRY + 10 * M1;
  ledger.settleAllDue(() => 1.5, now, () => ({ m1: [], ts: now }));
  assert.equal(ledger.openOn('EURUSD').length, 0);
});

test('a feed that is merely briefly quiet still waits for a real price', async () => {
  await fresh();
  const t = call(1.1000);
  const settled = ledger.settleAllDue(() => null, EXPIRY + 1000, () => ({ m1: [], ts: 0 }));
  assert.equal(settled.length, 0, 'inside the grace window: keep waiting');
  assert.equal(t.result, null);
  const later = ledger.settleAllDue(() => null, EXPIRY + SETTLE_GRACE_MS + 1000, () => ({ m1: [], ts: 0 }));
  assert.equal(later.length, 1);
  assert.equal(t.result, 'void', 'and eventually voids rather than wedging the pair');
});
