/* Bankroll protection — the guard between a losing streak and a dead account.
 *
 * `settings.balance` is typed once and never moves. Without this, sizing is a
 * percentage of a number that stopped being true twenty trades ago, so the
 * engine keeps opening positions on money that losses have already spent.
 * These tests pin the arithmetic and, more importantly, the refusal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { install, reset as resetChrome } from './chrome-stub.mjs';
import { series } from './helpers.mjs';

install();
const { handleMessage } = await import('../src/background/api.js');
const store = await import('../src/background/store.js');
const engine = await import('../src/background/engine.js');
const ledger = await import('../src/background/ledger.js');
const settings = await import('../src/background/settings.js');
const { bankroll } = engine;

const send = (cmd, payload = {}) => handleMessage({ cmd, ...payload }, { tab: { id: 7 } });
const T0 = 1_700_000_000;
const SYM = 'EURUSD_OTC';
const frame = (sym, epochSec, price) => ({
  text: `42["tick",["${sym}",${epochSec},${price},1]]`,
  binary: false,
  url: 'wss://example.test/socket.io/?EIO=4&transport=websocket',
});

/** A decided trade with a given pnl; only `result` and `pnl` matter here. */
const t = (pnl, result = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'tie') => ({ result, pnl });

/* ------------------------------ arithmetic ------------------------------- */

test('the bankroll is the starting balance plus realized P&L', () => {
  const b = bankroll({ balance: 100, riskPct: 5 }, [t(8.5), t(-5), t(2)]);
  assert.equal(b.starting, 100);
  assert.equal(b.realized, 5.5);
  assert.equal(b.current, 105.5);
  assert.equal(b.canTrade, true);
  assert.equal(b.reason, null);
});

test('a clean run leaves the bankroll exactly where it started', () => {
  const b = bankroll({ balance: 250, riskPct: 2 }, [t(10), t(-10)]);
  assert.equal(b.current, 250);
  assert.equal(b.realized, 0);
});

test('losses shrink the stake instead of being ignored', () => {
  const start = bankroll({ balance: 100, riskPct: 5 }, []);
  assert.equal(start.stake, 5);
  const after = bankroll({ balance: 100, riskPct: 5 }, [t(-10), t(-10), t(-10)]);
  assert.equal(after.current, 70);
  assert.equal(after.stake, 3.5, 'risking 5% of a balance that no longer exists is the bug');
  assert.ok(after.stake < start.stake);
});

test('voids contribute nothing — a voided trade returned its stake', () => {
  const b = bankroll({ balance: 100, riskPct: 5 }, [
    { result: 'void', pnl: 0 },
    { result: 'void', pnl: 0 },
    t(5),
  ]);
  assert.equal(b.realized, 5);
  assert.equal(b.current, 105);
});

test('open trades are not counted until they are settled', () => {
  const b = bankroll({ balance: 100, riskPct: 5 }, [{ result: null, pnl: -99 }, t(1)]);
  assert.equal(b.realized, 1, 'an unsettled trade has no realized pnl yet');
});

test('the guard trips once losses have eaten the balance', () => {
  const b = bankroll({ balance: 100, riskPct: 5 }, [t(-60), t(-45)]);
  assert.equal(b.current, -5);
  assert.equal(b.canTrade, false);
  assert.match(b.reason, /bankroll is -5\.00/);
  assert.match(b.reason, /starting balance plus realized P&L is gone/);
});

test('the guard trips at exactly zero too', () => {
  const b = bankroll({ balance: 100, riskPct: 5 }, [t(-100)]);
  assert.equal(b.current, 0);
  assert.equal(b.canTrade, false);
});

test('a bankroll too small for the 0.01 minimum stake is refused', () => {
  const b = bankroll({ balance: 100, riskPct: 1 }, [t(-99.995)]);
  assert.ok(b.current > 0, 'there is still a fraction of a cent left');
  assert.equal(b.stake, 0.01, 'the floor keeps the stake sane');
  assert.equal(b.canTrade, b.stake <= b.current);
});

test('a bankroll that cannot cover the floored stake says so', () => {
  const b = bankroll({ balance: 100, riskPct: 1 }, [t(-99.998)]);
  assert.equal(b.canTrade, false);
  assert.match(b.reason, /cannot cover even the minimum 0\.01 stake/);
});

test('the stake is rounded to cents, never a fractional cent', () => {
  for (const balance of [100, 33.33, 0.07, 12345.67]) {
    const b = bankroll({ balance, riskPct: 3 }, []);
    assert.ok(Number.isFinite(b.stake));
    assert.equal(b.stake, Math.round(b.stake * 100) / 100, `stake ${b.stake} is not whole cents`);
    assert.ok(b.stake >= 0.01);
  }
});

test('missing or nonsense settings cannot produce a NaN bankroll', () => {
  for (const s of [{}, null, undefined, { balance: NaN }, { balance: 'abc' }, { balance: -50 }, { riskPct: 0 }, { riskPct: NaN }]) {
    const b = bankroll(s, []);
    assert.ok(Number.isFinite(b.current), `current was ${b.current} for ${JSON.stringify(s)}`);
    assert.ok(Number.isFinite(b.stake), `stake was ${b.stake} for ${JSON.stringify(s)}`);
    assert.equal(typeof b.canTrade, 'boolean');
  }
});

test('a zero or negative balance is refused rather than staked', () => {
  assert.equal(bankroll({ balance: 0, riskPct: 1 }, []).canTrade, false);
  assert.equal(bankroll({ balance: -10, riskPct: 1 }, []).canTrade, false);
});

test('a corrupt trade row cannot break the sum', () => {
  const b = bankroll({ balance: 100, riskPct: 1 }, [null, {}, { result: 'win' }, { result: 'win', pnl: NaN }, t(5)]);
  assert.equal(b.realized, 5);
});

test('riskPct above 100 is still bounded by what the bankroll can cover', () => {
  const b = bankroll({ balance: 10, riskPct: 500 }, []);
  assert.equal(b.stake, 50);
  assert.equal(b.canTrade, false, 'a 50-unit stake on a 10-unit bankroll must not open');
  assert.match(b.reason, /cannot cover/);
});

test('the guard defaults to the ledger when no trades are passed', () => {
  ledger.reset();
  ledger.trades.push(t(-1000));
  assert.equal(bankroll({ balance: 100, riskPct: 1 }).canTrade, false);
  ledger.reset();
});

/* --------------------------- end-to-end refusal ---------------------------- */

/** Drive a real signal through the real message surface. */
async function armEngine({ balance, riskPct = 1 }) {
  resetChrome();
  store.symbols.clear();
  await ledger.load();
  ledger.reset();
  await settings.load();
  await send('settings.patch', {
    patch: {
      balance,
      riskPct,
      autoPaperTrade: true,
      strategy: { minScore: 1, cooldownMs: 0, gateEnabled: false },
    },
  });
  const cs = series({ n: 245, drift: 0.05, amp: 0.1, noise: 0.01, seed: 5 });
  const push = (from, to) =>
    send('feed.batch', { frames: cs.slice(from, to).map((c, i) => frame('EURUSD_otc', T0 + (from + i) * 60, c.c)) });

  await push(0, 244);
  store.refreshDerived(SYM);
  // The engine only acts on a bar it has not seen before, so it has to observe
  // one closed bar before the bar it may trade on. state.get drives evaluate();
  // feed.batch alone only builds candles.
  await send('state.get', { sym: SYM });

  await push(244, 245);
  store.refreshDerived(SYM);
  const r = await send('state.get', { sym: SYM });
  return { expected: r.signal, s: await settings.load() };
}

test('a healthy bankroll lets the engine trade', async () => {
  const { expected } = await armEngine({ balance: 500 });
  assert.ok(expected.dir === 'up' || expected.dir === 'down', `fixture must produce a signal, got ${expected.dir}`);
  assert.ok(ledger.trades.length > 0, 'the signal should have opened a paper trade');
  const trade = ledger.trades[ledger.trades.length - 1];
  assert.equal(trade.stake, 5, '1% of 500');
});

test('an exhausted bankroll stops the engine opening that same trade', async () => {
  const { expected } = await armEngine({ balance: 500 });
  assert.ok(expected.dir === 'up' || expected.dir === 'down');
  // Burn the balance the way a losing run would. The trade armEngine just
  // opened is part of that run, and it has to be settled first: maybeTrade
  // refuses to trade a symbol with an open position before it ever reaches the
  // bankroll guard, which would make this test pass for the wrong reason.
  for (const o of ledger.trades) if (!o.result) { o.result = 'loss'; o.pnl = -o.stake; }
  for (let i = 0; i < 12; i++) ledger.trades.push(t(-50));
  const before = ledger.trades.length;
  assert.equal(ledger.openOn(SYM).length, 0, 'nothing open, so the guard is the only thing that can stop it');
  const cs = series({ n: 247, drift: 0.05, amp: 0.1, noise: 0.01, seed: 5 });
  await send('feed.batch', { frames: cs.slice(245, 246).map((c, i) => frame('EURUSD_otc', T0 + (245 + i) * 60, c.c)) });
  store.refreshDerived(SYM);
  await send('state.get', { sym: SYM });
  await send('feed.batch', { frames: cs.slice(246, 247).map((c, i) => frame('EURUSD_otc', T0 + (246 + i) * 60, c.c)) });
  store.refreshDerived(SYM);
  await send('state.get', { sym: SYM });

  assert.equal(ledger.trades.length, before, 'no new trade may be opened');
  const ev = ledger.events.find((e) => /STOPPED/.test(e.text || ''));
  assert.ok(ev, 'and the refusal must be visible in the event log, not silent');
  assert.match(ev.text, /bankroll/);
});

test('the panel is told the bankroll and whether trading is allowed', async () => {
  await armEngine({ balance: 500 });
  const r = await send('state.get', { sym: SYM });
  assert.ok(r.ok);
  assert.ok(r.bankroll, 'state.get must expose the bankroll');
  assert.equal(r.bankroll.starting, 500);
  assert.equal(typeof r.bankroll.canTrade, 'boolean');
  assert.equal(typeof r.bankroll.stake, 'number');
  assert.equal(typeof r.bankroll.riskPct, 'number');

  for (let i = 0; i < 12; i++) ledger.trades.push(t(-50));
  const r2 = await send('state.get', { sym: SYM });
  assert.equal(r2.bankroll.canTrade, false);
  assert.ok(r2.bankroll.reason, 'the UI needs a reason to show, not just a flag');
});

test('data provenance counters reach the UI so a proxy feed is never invisible', async () => {
  await armEngine({ balance: 500 });
  const r = await send('state.get', { sym: SYM });
  assert.equal(typeof r.diag.proxyRefusals, 'number');
  assert.equal(typeof r.diag.sourceTakeovers, 'number');
});
