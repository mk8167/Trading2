/* Lifecycle guarantees: data survival, payout capture, and settlement.
 *
 * These cover the failures that never show up as an error. A pruned symbol
 * just draws an empty chart; a dropped payout just makes the break-even
 * number on screen wrong; an unsettled trade just silently blocks that pair
 * from ever trading again.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { install, reset as resetChrome } from './chrome-stub.mjs';

install();
const store = await import('../src/background/store.js');
const ledger = await import('../src/background/ledger.js');
const { stats, streaks, rollingWinRate, voidTrade, createTrade, settleTrade } = await import('../src/background/journal.js');
const { SETTLE_GRACE_MS } = ledger;

const T0 = 1_700_000_000_000;

function clearStore() {
  store.symbols.clear();
  store.setSelected(null);
  store.protectOpen([]);
}

function tick(sym, price, ts = Date.now()) {
  return store.ingestTick(sym, price, ts, 'quotex');
}

/** Fill a symbol with n closed m1 bars. */
function fill(sym, n = 50, start = 1.1) {
  for (let i = 0; i < n; i++) store.ingestTick(sym, start + i * 0.0001, T0 + i * 60_000, 'quotex');
  return store.getSymbol(sym);
}

/* --------------------- canonical keys in the store -------------------- */

test('two spellings of one pair land in ONE store entry, not two', () => {
  clearStore();
  tick('EUR/USD_otc', 1.1);
  tick('eurusd_otc', 1.2);
  tick('EURUSD_OTC', 1.3);
  tick('EUR USD OTC', 1.4);
  assert.equal(store.symbols.size, 1, 'all four spellings are one instrument');
  assert.equal(store.getSymbol('EURUSD_OTC').price, 1.4);
  // Every spelling resolves to the same object.
  for (const s of ['EUR/USD_otc', 'eurusd_otc', 'EURUSD_OTC', 'EUR USD OTC']) {
    assert.equal(store.getSymbol(s).sym, 'EURUSD_OTC', s);
  }
});

test('slash and dash spellings of a crypto pair also merge', () => {
  clearStore();
  tick('BTC/USD', 60000);
  tick('btc-usd', 60100);
  tick('BTCUSD', 60200);
  assert.equal(store.symbols.size, 1);
  assert.equal(store.getSymbol('BTCUSD').price, 60200);
  assert.equal(store.getSymbol('BTCUSD').assetClass, 'crypto');
});

test('each symbol records its asset class and a readable name', () => {
  clearStore();
  tick('EURUSD', 1.1);
  tick('EURUSD_OTC', 1.1);
  tick('BTCUSDT', 60000);
  tick('XAUUSD', 2400);
  assert.equal(store.getSymbol('EURUSD').assetClass, 'forex');
  assert.equal(store.getSymbol('EURUSD_OTC').assetClass, 'synthetic');
  assert.equal(store.getSymbol('BTCUSDT').assetClass, 'crypto');
  assert.equal(store.getSymbol('XAUUSD').assetClass, 'commodity');
  assert.equal(store.getSymbol('BTCUSDT').pretty, 'BTC/USDT');
  assert.equal(store.getSymbol('EURUSD_OTC').pretty, 'EUR/USD OTC');
});

test('a broker-declared asset type overrides the name-based guess', () => {
  clearStore();
  store.setMeta('XYZUSD', { type: 'crypto' }); // arrives before the symbol exists
  tick('XYZUSD', 1.5);
  assert.equal(store.getSymbol('XYZUSD').assetClass, 'crypto', 'declared type wins over the USD quote');

  store.setMeta('BTCUSD', { type: 'forex' });
  tick('BTCUSD', 60000);
  assert.equal(store.getSymbol('BTCUSD').assetClass, 'forex');
});

/* ---------------------- protection: eviction/prune -------------------- */

test('the selected pair survives a stale-prune that clears everything else', () => {
  clearStore();
  const old = Date.now() - 3 * 60 * 60 * 1000; // older than the 2h threshold
  fill('EURUSD_OTC', 50);
  fill('GBPJPY_OTC', 50);
  // Both go quiet at the same time.
  for (const s of store.symbols.values()) s.lastTickAt = old;
  store.setSelected('EURUSD_OTC');

  const removed = store.pruneStale(2 * 60 * 60 * 1000);
  assert.equal(removed, 1);
  assert.ok(store.getSymbol('EURUSD_OTC'), 'the watched pair must survive');
  assert.equal(store.getSymbol('GBPJPY_OTC'), null, 'the other one is pruned');
  assert.equal(store.getSymbol('EURUSD_OTC').tf.m1.length, 50, 'history intact');
});

test('a pair holding an open trade survives the stale-prune', () => {
  clearStore();
  const old = Date.now() - 3 * 60 * 60 * 1000;
  fill('AAAUSD', 50);
  fill('BBBUSD', 50);
  for (const s of store.symbols.values()) s.lastTickAt = old;
  store.protectOpen(['BBBUSD']);

  store.pruneStale(2 * 60 * 60 * 1000);
  assert.ok(store.getSymbol('BBBUSD'), 'a symbol with an open trade must not vanish');
  assert.equal(store.getSymbol('AAAUSD'), null);
});

test('eviction never removes the selected pair, even when it is the oldest', () => {
  clearStore();
  fill('KEEPME', 10);
  store.getSymbol('KEEPME').lastTickAt = 1; // the oldest thing in the store
  store.setSelected('KEEPME');
  for (let i = 0; i < store.MAX_SYMBOLS + 10; i++) tick(`SYM${String(i).padStart(3, '0')}USD`, 1 + i, Date.now() + i);

  assert.ok(store.getSymbol('KEEPME'), 'the watched pair survived filling the store');
  assert.ok(store.symbols.size <= store.MAX_SYMBOLS, 'the cap is still respected');
});

test('eviction drops names with no candles before ones with real history', () => {
  clearStore();
  fill('RICH', 100);
  store.getSymbol('RICH').lastTickAt = 5; // oldest, but has 100 bars
  tick('POOR', 1); // newest, but a single bar
  store.getSymbol('POOR').lastTickAt = 2;

  for (let i = 0; i < store.MAX_SYMBOLS + 5; i++) tick(`FILL${String(i).padStart(3, '0')}USD`, 1, Date.now() + i);

  assert.ok(store.getSymbol('RICH'), 'history is worth more than recency');
});

test('the snapshot keeps a quiet protected pair inside its limit', () => {
  clearStore();
  const watched = fill('EURUSD', 100);
  watched.lastTickAt = 1; // far older than everything else
  for (let i = 0; i < store.PERSIST_SYMBOLS + 10; i++) {
    const noisy = `AAA${String(i).padStart(3, '0')}USD`;
    fill(noisy, 50);
    store.getSymbol(noisy).lastTickAt = Date.now() + i;
  }
  store.setSelected('EURUSD');

  const snap = store.serialize();
  assert.ok(snap.symbols.EURUSD, 'the watched pair is always snapshotted');
  assert.equal(snap.symbols.EURUSD.assetClass, 'forex', 'classification survives the snapshot');
  assert.equal(snap.symbols.EURUSD.m1.length > 0, true, 'and so does its history');
});

test('a restored snapshot merges two old spellings instead of overwriting', () => {
  clearStore();
  const mk = (price, t) => [{ t, o: price, h: price + 0.001, l: price - 0.001, c: price }];
  const snap = {
    v: 6,
    symbols: {
      'EUR/USD_OTC': { source: 'quotex', price: 1.1, ts: T0, m1: [[T0, 1.1, 1.101, 1.099, 1.1]] },
      'EURUSD_otc': { source: 'quotex', price: 1.2, ts: T0 + 60_000, m1: [[T0 + 60_000, 1.2, 1.201, 1.199, 1.2]] },
    },
  };
  const n = store.deserialize(snap);
  assert.equal(store.symbols.size, 1, 'one instrument, one entry');
  const s = store.getSymbol('EURUSD_OTC');
  assert.ok(s.tf.m1.length >= 2, `both bars survived the merge, got ${s.tf.m1.length}`);
  assert.ok(n >= 1);
});

/* --------------------------- the payout inbox -------------------------- */

test('a payout arriving BEFORE its symbol is applied when the symbol appears', () => {
  clearStore();
  // This is the real Quotex order: asset list first, ticks later.
  const queued = store.setPayout('EURUSD_OTC', 92);
  assert.equal(queued, false, 'not applied yet — nothing to apply it to');
  assert.equal(store.symbols.size, 0, 'and it did not create a phantom symbol');

  tick('EURUSD_OTC', 1.1);
  assert.equal(store.getSymbol('EURUSD_OTC').payout, 92, 'the parked payout was applied');
});

test('a payout arriving after its symbol is applied immediately', () => {
  clearStore();
  tick('GBPJPY', 189.4);
  assert.equal(store.setPayout('GBPJPY', 88), true);
  assert.equal(store.getSymbol('GBPJPY').payout, 88);
});

test('absurd payouts are rejected either way', () => {
  clearStore();
  tick('EURUSD', 1.1);
  for (const bad of [0, -5, 500, NaN, null, undefined, 'x']) {
    assert.equal(store.setPayout('EURUSD', bad), false, JSON.stringify(bad));
  }
  assert.equal(store.getSymbol('EURUSD').payout, null);
});

test('effectivePayout prefers the live broker figure above everything', () => {
  clearStore();
  tick('EURUSD', 1.1);
  store.setPayout('EURUSD', 94);
  const r = store.effectivePayout('EURUSD', 86);
  assert.deepEqual(r, { payout: 94, origin: 'live' });
});

test('effectivePayout falls back to the class default for a KNOWN class', () => {
  clearStore();
  tick('BTCUSD', 60000); // crypto, no payout ever sent
  assert.deepEqual(store.effectivePayout('BTCUSD', 86), { payout: 75, origin: 'class' });
  tick('EURUSD', 1.1);
  assert.deepEqual(store.effectivePayout('EURUSD', 86), { payout: 85, origin: 'class' });
});

test('effectivePayout respects the user setting for an UNKNOWN class', () => {
  clearStore();
  tick('QQQQQQ', 5);
  assert.equal(store.getSymbol('QQQQQQ').assetClass, 'unknown');
  assert.deepEqual(store.effectivePayout('QQQQQQ', 91), { payout: 91, origin: 'setting' });
});

test('effectivePayout ignores a payout that has gone stale', () => {
  clearStore();
  tick('EURUSD', 1.1);
  store.setPayout('EURUSD', 94);
  store.getSymbol('EURUSD').payoutAt = Date.now() - 7 * 60 * 60 * 1000; // beyond the 6h TTL
  const r = store.effectivePayout('EURUSD', 86);
  assert.equal(r.origin, 'class', 'a stale live figure must not be trusted');
});

/* -------------------------- settlement of trades ----------------------- */

function openTrade(sym, over = {}) {
  return ledger.openTrade({
    sym, dir: 'up', entry: 1.1, stake: 1, payout: 86, tf: 'm1',
    expiryMinutes: 0, signals: [], score: 5, confidence: 80, source: 'quotex', ...over,
  });
}

test('settleAllDue closes a trade on a symbol nobody is evaluating', async () => {
  resetChrome();
  clearStore();
  await ledger.load();
  ledger.reset();
  fill('EURUSD_OTC', 50);
  store.ingestTick('EURUSD_OTC', 1.2, Date.now()); // above the 1.1 entry

  const t = openTrade('EURUSD_OTC');
  const settled = ledger.settleAllDue((s) => (s === 'EURUSD_OTC' ? 1.2 : null), Date.now() + 5000);

  assert.equal(settled.length, 1);
  assert.equal(t.result, 'win');
  assert.equal(ledger.openOn('EURUSD_OTC').length, 0, 'the pair is unblocked');
});

test('settleAllDue settles trades on SEVERAL symbols in one pass', () => {
  ledger.reset();
  const a = openTrade('AAAUSD', { dir: 'up' });
  const b = openTrade('BBBUSD', { dir: 'down' });
  const prices = { AAAUSD: 1.2, BBBUSD: 1.0 }; // A up-win, B down-win
  const settled = ledger.settleAllDue((s) => prices[s] ?? null, Date.now() + 5000);
  assert.equal(settled.length, 2);
  assert.equal(a.result, 'win');
  assert.equal(b.result, 'win');
});

test('settleAllDue leaves a trade alone before its expiry', () => {
  ledger.reset();
  const t = openTrade('AAAUSD', { expiryMinutes: 5 });
  const settled = ledger.settleAllDue(() => 1.5, Date.now() + 1000);
  assert.equal(settled.length, 0);
  assert.equal(t.result, null);
});

test('a trade with no price waits inside the grace window instead of being voided', () => {
  ledger.reset();
  const t = openTrade('GONEUSD');
  const settled = ledger.settleAllDue(() => null, Date.now() + 1000);
  assert.equal(settled.length, 0);
  assert.equal(t.result, null, 'still open — a brief socket gap must not erase a trade');
});

test('a trade with no price is voided after the grace period, never faked', () => {
  ledger.reset();
  const t = openTrade('GONEUSD');
  const settled = ledger.settleAllDue(() => null, Date.now() + SETTLE_GRACE_MS + 1000);
  assert.equal(settled.length, 1);
  assert.equal(t.result, 'void');
  assert.equal(t.pnl, 0);
  assert.match(t.voidReason, /no settlement price/i);
  assert.equal(ledger.openOn('GONEUSD').length, 0, 'the pair is released, not wedged forever');
});

test('a void is excluded from every statistic that assumes a real result', () => {
  const trades = [
    { ...createTrade({ sym: 'A', dir: 'up', entry: 1, stake: 1, payout: 86 }), result: 'win', pnl: 0.86, settledAt: 1 },
    { ...createTrade({ sym: 'A', dir: 'up', entry: 1, stake: 1, payout: 86 }), result: 'loss', pnl: -1, settledAt: 2 },
    { ...createTrade({ sym: 'A', dir: 'up', entry: 1, stake: 1, payout: 86 }), result: 'void', pnl: 0, settledAt: 3 },
  ];
  const s = stats(trades, { payout: 86 });
  assert.equal(s.decided, 2, 'the void did not become a decided trade');
  assert.equal(s.voids, 1);
  assert.equal(s.winRate, 0.5, 'one win of two decided — not one of three');
  assert.equal(streaks(trades).bestLossStreak, 1, 'a void must not extend a losing streak');
  assert.equal(rollingWinRate(trades, 20), 0.5);
});

test('a tie is still a tie, and is also excluded from the win rate', () => {
  const t = settleTrade(createTrade({ sym: 'A', dir: 'up', entry: 1.1, stake: 10, payout: 86 }), 1.1);
  assert.equal(t.result, 'tie');
  assert.equal(t.pnl, 0);
  const s = stats([t], { payout: 86 });
  assert.equal(s.decided, 0);
  assert.equal(s.ties, 1);
  assert.equal(s.winRate, 0);
});

test('voidTrade is idempotent and cannot overwrite a real result', () => {
  const t = settleTrade(createTrade({ sym: 'A', dir: 'up', entry: 1, stake: 10, payout: 86 }), 1.5);
  assert.equal(t.result, 'win');
  voidTrade(t, 'too late');
  assert.equal(t.result, 'win', 'a settled trade is never voided after the fact');
  assert.equal(t.pnl, 8.6);
});

test('openSymbols lists exactly the symbols holding unsettled trades', () => {
  ledger.reset();
  openTrade('AAAUSD');
  openTrade('BBBUSD');
  const c = openTrade('CCCUSD');
  c.result = 'win'; // settled
  assert.deepEqual(ledger.openSymbols().sort(), ['AAAUSD', 'BBBUSD']);
});

test('a trade opened with a non-canonical symbol is stored canonically', () => {
  ledger.reset();
  const t = openTrade('eur/usd_otc');
  assert.equal(t.sym, 'EURUSD_OTC');
  assert.equal(ledger.openOn('EURUSD_OTC').length, 1);
  assert.equal(ledger.openOn('EUR/USD_otc').length, 1, 'lookup by any spelling works');
});

test('an old journal with mixed spellings is folded together on load', async () => {
  resetChrome();
  await globalThis.chrome.storage.local.set({
    'journal.v6': {
      trades: [
        { id: 'a', sym: 'EUR/USD_OTC', dir: 'up', entry: 1, stake: 1, payout: 86, result: 'win', pnl: 0.86 },
        { id: 'b', sym: 'EURUSD_otc', dir: 'up', entry: 1, stake: 1, payout: 86, result: 'loss', pnl: -1 },
      ],
      events: [],
    },
  });
  await ledger.load();
  assert.equal(ledger.trades.length, 2);
  for (const t of ledger.trades) assert.equal(t.sym, 'EURUSD_OTC');
  // They now group as one instrument instead of two.
  const s = stats(ledger.trades, { payout: 86 });
  assert.equal(s.decided, 2);
});

test('a late tick cannot drag the live quote or the clock backwards', () => {
  clearStore();
  const sym = 'EURUSD_OTC';
  tick(sym, 1.10, T0);
  tick(sym, 1.11, T0 + 60_000);
  tick(sym, 1.12, T0 + 120_000);

  // Within the tolerance the store accepts (60s back), but older than the bar
  // we are on: the candle builder must not append it behind the newest bar and
  // the live price must stay at the newest observation.
  const s = tick(sym, 1.05, T0 + 60_000 + 5_000);
  assert.ok(s, 'a merely-late tick is still accepted');
  assert.equal(s.price, 1.12, 'the live quote did not go backwards');
  assert.equal(s.ts, T0 + 120_000, 's.ts is the feed clock for the live price');
  assert.equal(s.tickCount, 4, 'the tick was counted');
  assert.equal(s.tf.m1.length, 3, 'no phantom bar was appended');
  assert.equal(store.isStale(s, T0 + 120_000 + 10_000), false, 'freshness is judged from the newest tick');
});

test('a tick that rewinds the clock by more than a minute is rejected outright', () => {
  clearStore();
  const sym = 'EURUSD_OTC';
  tick(sym, 1.10, T0 + 300_000);
  assert.equal(tick(sym, 9.99, T0), null, 'two minutes back is not a late tick, it is stale data');
  assert.equal(store.getSymbol(sym).price, 1.10);
  assert.equal(store.getSymbol(sym).tf.m1.length, 1);
});
