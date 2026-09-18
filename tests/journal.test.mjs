import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTrade, settleTrade, stats, equityCurve, maxDrawdown, streaks,
  rollingWinRate, toCSV, bySetup, bySymbol, byDirection,
} from '../src/background/journal.js';

const base = {
  sym: 'EURUSD_OTC', dir: 'up', entry: 1.08, stake: 10, payout: 86,
  tf: 'm1', expiryMinutes: 1, signals: [{ name: 'Bullish engulfing' }],
  score: 5, confidence: 72, openedAt: 1_700_000_000_000,
};

test('a winning trade pays stake * payout%', () => {
  const t = settleTrade(createTrade(base), 1.081);
  assert.equal(t.result, 'win');
  assert.ok(Math.abs(t.pnl - 8.6) < 1e-9);
  assert.equal(t.exit, 1.081);
});

test('a losing trade loses the whole stake', () => {
  const t = settleTrade(createTrade(base), 1.079);
  assert.equal(t.result, 'loss');
  assert.equal(t.pnl, -10);
});

test('an exact tie pushes the stake back', () => {
  const t = settleTrade(createTrade(base), 1.08);
  assert.equal(t.result, 'tie');
  assert.equal(t.pnl, 0);
});

test('a DOWN trade wins when price falls', () => {
  const t = settleTrade(createTrade({ ...base, dir: 'down' }), 1.079);
  assert.equal(t.result, 'win');
  const l = settleTrade(createTrade({ ...base, dir: 'down' }), 1.081);
  assert.equal(l.result, 'loss');
});

test('settling twice is a no-op', () => {
  const t = createTrade(base);
  settleTrade(t, 1.09);
  const first = t.pnl;
  settleTrade(t, 1.01);
  assert.equal(t.pnl, first);
});

test('invalid prices do not settle a trade', () => {
  const t = settleTrade(createTrade(base), NaN);
  assert.equal(t.result, null);
  assert.equal(settleTrade(createTrade(base), 0).result, null);
});

test('expiry is computed from expiryMinutes', () => {
  const t = createTrade({ ...base, expiryMinutes: 5 });
  assert.equal(t.expiresAt, t.openedAt + 300_000);
});

test('stats report win rate, edge over break-even and profit factor', () => {
  const trades = [];
  for (let i = 0; i < 6; i++) trades.push(settleTrade(createTrade({ ...base, openedAt: base.openedAt + i }), 1.09));
  for (let i = 0; i < 4; i++) trades.push(settleTrade(createTrade({ ...base, openedAt: base.openedAt + 100 + i }), 1.07));
  const s = stats(trades, { payout: 86 });
  assert.equal(s.decided, 10);
  assert.equal(s.wins, 6);
  assert.equal(s.losses, 4);
  assert.equal(s.winRate, 0.6);
  assert.ok(s.breakEven > 0.53 && s.breakEven < 0.54);
  assert.ok(s.edge > 0.06, `edge ${s.edge}`);
  assert.ok(Math.abs(s.grossWin - 6 * 8.6) < 1e-9);
  assert.ok(Math.abs(s.grossLoss - 40) < 1e-9);
  assert.ok(Math.abs(s.profitFactor - 51.6 / 40) < 1e-9);
  assert.ok(Math.abs(s.expectancy - (51.6 - 40) / 10) < 1e-9);
});

test('stats on an empty ledger are all zero, never NaN', () => {
  const s = stats([], { payout: 86 });
  assert.equal(s.decided, 0);
  assert.equal(s.winRate, 0);
  assert.equal(s.expectancy, 0);
  assert.equal(s.profitFactor, 0);
  assert.ok(Number.isFinite(s.roiPct));
});

test('open trades are counted but not scored', () => {
  const trades = [settleTrade(createTrade(base), 1.09), createTrade({ ...base, openedAt: base.openedAt + 1 })];
  const s = stats(trades, { payout: 86 });
  assert.equal(s.total, 1);
  assert.equal(s.open, 1);
});

test('equity curve accumulates pnl from zero', () => {
  const trades = [
    settleTrade(createTrade({ ...base, openedAt: 1 }), 1.09),
    settleTrade(createTrade({ ...base, openedAt: 2 }), 1.07),
    settleTrade(createTrade({ ...base, openedAt: 3 }), 1.09),
  ];
  const eq = equityCurve(trades);
  assert.equal(eq.length, 4);
  assert.equal(eq[0].equity, 0);
  assert.ok(Math.abs(eq[3].equity - (8.6 - 10 + 8.6)) < 1e-9);
});

test('max drawdown measures the worst peak-to-trough drop', () => {
  const trades = [
    settleTrade(createTrade({ ...base, openedAt: 1 }), 1.09), // +8.6
    settleTrade(createTrade({ ...base, openedAt: 2 }), 1.07), // -10
    settleTrade(createTrade({ ...base, openedAt: 3 }), 1.07), // -10  -> dd 20 - 8.6? no: peak 8.6, trough -11.4 => 20
    settleTrade(createTrade({ ...base, openedAt: 4 }), 1.09),
  ];
  assert.equal(maxDrawdown(trades), 20);
});

test('streaks find the best run of wins and losses', () => {
  const mk = (r, i) => settleTrade(createTrade({ ...base, openedAt: i }), r === 'win' ? 1.09 : 1.07);
  const trades = ['win', 'win', 'loss', 'loss', 'loss', 'win'].map(mk);
  const s = streaks(trades);
  assert.equal(s.bestWinStreak, 2);
  assert.equal(s.bestLossStreak, 3);
});

test('rolling win rate uses only the most recent window', () => {
  const mk = (r, i) => settleTrade(createTrade({ ...base, openedAt: i }), r === 'win' ? 1.09 : 1.07);
  const trades = [...Array.from({ length: 10 }, (_, i) => mk('loss', i)), ...Array.from({ length: 10 }, (_, i) => mk('win', 100 + i))];
  assert.equal(rollingWinRate(trades, 10), 1);
  assert.equal(rollingWinRate(trades, 20), 0.5);
  assert.equal(rollingWinRate([], 10), null);
});

test('breakdowns group by setup, symbol and direction', () => {
  const a = settleTrade(createTrade({ ...base, signals: [{ name: 'Pin' }] }), 1.09);
  const b = settleTrade(createTrade({ ...base, sym: 'XAUUSD_OTC', dir: 'down', signals: [{ name: 'Pin' }] }), 1.07);
  const setup = bySetup([a, b]);
  assert.equal(setup.length, 1);
  assert.equal(setup[0].key, 'Pin');
  assert.equal(setup[0].n, 2);
  assert.equal(bySymbol([a, b]).length, 2);
  assert.equal(byDirection([a, b]).length, 2);
});

test('CSV escapes commas and quotes and keeps one row per trade', () => {
  const t = settleTrade(createTrade({ ...base, signals: [{ name: 'Break + retest, up' }] }), 1.09);
  const csv = toCSV([t]);
  const lines = csv.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^id,openedAt,/);
  assert.ok(lines[1].includes('"Break + retest, up"'));
  assert.ok(lines[1].includes('win'));
});
