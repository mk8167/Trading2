/* ------------------------------------------------------------------
 * journal.js — paper-trading ledger + performance maths.
 *
 * Nothing here touches the network or the page: it is a pure accounting
 * module so the same code can score live paper trades and backtests.
 * ----------------------------------------------------------------*/

import { breakEvenWinRate } from './strategy.js';

export function createTrade({ sym, dir, entry, stake, payout, tf = 'm1', expiryMinutes = 1, signals = [], score = 0, confidence = 0, openedAt = Date.now(), source = 'quotex', assetClass = null, otc = false, id }) {
  return {
    id: id || `t_${openedAt}_${Math.random().toString(36).slice(2, 8)}`,
    sym,
    dir,
    entry,
    exit: null,
    stake,
    payout,
    tf,
    expiryMinutes,
    score,
    confidence,
    signals: signals.map((s) => s.name).slice(0, 6),
    openedAt,
    expiresAt: openedAt + expiryMinutes * 60_000,
    settledAt: null,
    result: null, // 'win' | 'loss' | 'tie'
    pnl: 0,
    source,
    assetClass,
    otc,
  };
}

/**
 * Settle an open trade against a price.
 * Expiry uses "strictly above / strictly below"; an exact tie is a push
 * (stake returned) because that is what a real broker does.
 */
export function settleTrade(trade, price, at = Date.now()) {
  if (!trade || trade.result) return trade;
  if (!Number.isFinite(price) || price <= 0) return trade;
  trade.exit = price;
  trade.settledAt = at;
  if (price === trade.entry) {
    trade.result = 'tie';
    trade.pnl = 0;
  } else {
    const win = trade.dir === 'up' ? price > trade.entry : price < trade.entry;
    trade.result = win ? 'win' : 'loss';
    trade.pnl = win ? (trade.stake * (trade.payout || 0)) / 100 : -trade.stake;
  }
  return trade;
}

/* ------------------------------ stats -------------------------------- */

/**
 * True for an outcome that actually decided something.
 *
 * 'tie' returns the stake and 'void' means we never obtained a real
 * settlement price, so neither may enter a win rate, a streak, or a
 * per-setup breakdown — doing so silently biases the numbers the risk gate
 * and the journal both depend on.
 */
export function isDecided(t) {
  return !!t && (t.result === 'win' || t.result === 'loss');
}

/**
 * Mark a trade un-settleable rather than leaving it open forever.
 *
 * An open trade blocks every future trade on its symbol, so a pair whose
 * feed disappears would otherwise wedge permanently. Voiding releases the
 * block without inventing a win or a loss.
 */
export function voidTrade(trade, reason = 'no settlement price available', at = Date.now()) {
  if (!trade || trade.result) return trade;
  trade.result = 'void';
  trade.pnl = 0;
  trade.exit = null;
  trade.settledAt = at;
  trade.voidReason = reason;
  return trade;
}

export function stats(trades, { payout } = {}) {
  const settled = (trades || []).filter((t) => t.result);
  // Only wins and losses are "decided". A tie returns the stake, and a void
  // is a trade that could never be settled against a real price — counting
  // either as a decided outcome would skew the win rate that the risk gate
  // is built on.
  const decided = settled.filter((t) => t.result === 'win' || t.result === 'loss');
  const ties = settled.filter((t) => t.result === 'tie');
  const voids = settled.filter((t) => t.result === 'void');
  const wins = decided.filter((t) => t.result === 'win');
  const losses = decided.filter((t) => t.result === 'loss');
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const net = settled.reduce((s, t) => s + t.pnl, 0);
  const staked = decided.reduce((s, t) => s + t.stake, 0);
  const winRate = decided.length ? wins.length / decided.length : 0;
  const be = breakEvenWinRate(payout ?? avgPayout(decided));
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;

  return {
    total: settled.length,
    decided: decided.length,
    wins: wins.length,
    losses: losses.length,
    ties: ties.length,
    voids: voids.length,
    open: (trades || []).length - settled.length,
    winRate: round(winRate, 4),
    breakEven: round(be, 4),
    edge: round(winRate - be, 4),
    net: round(net, 2),
    staked: round(staked, 2),
    roiPct: staked ? round((net / staked) * 100, 2) : 0,
    grossWin: round(grossWin, 2),
    grossLoss: round(grossLoss, 2),
    profitFactor: grossLoss ? round(grossWin / grossLoss, 2) : grossWin > 0 ? Infinity : 0,
    avgWin: round(avgWin, 2),
    avgLoss: round(avgLoss, 2),
    expectancy: decided.length ? round(net / decided.length, 3) : 0,
    expectancyPct: staked ? round((net / staked) * 100, 2) : 0,
    avgPayout: round(avgPayout(decided), 1),
    bestWin: round(Math.max(0, ...settled.map((t) => t.pnl)), 2),
    worstLoss: round(Math.min(0, ...settled.map((t) => t.pnl)), 2),
  };
}

const avgPayout = (list) => (list && list.length ? list.reduce((s, t) => s + (t.payout || 0), 0) / list.length : 86);

/** Group settled trades by an arbitrary key function. */
export function groupStats(trades, keyFn) {
  const map = new Map();
  for (const t of trades || []) {
    if (!isDecided(t)) continue;
    const k = keyFn(t);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return [...map.entries()]
    .map(([key, list]) => ({ key, ...stats(list, { payout: avgPayout(list) }), n: list.length }))
    .sort((a, b) => b.n - a.n);
}

export const bySetup = (trades) => groupStats(trades, (t) => (t.signals && t.signals.length ? t.signals[0] : 'unlabelled'));
export const bySymbol = (trades) => groupStats(trades, (t) => t.sym);
export const byTimeframe = (trades) => groupStats(trades, (t) => t.tf);
export const byDirection = (trades) => groupStats(trades, (t) => t.dir);
/** Per asset class — the edge on a synthesised OTC feed is not the edge on
 *  a real crypto market, and averaging them hides which is which. */
export const byClass = (trades) => groupStats(trades, (t) => t.assetClass || 'unknown');
/** Equity curve as [{t, equity}] starting from `start`. */
export function equityCurve(trades, start = 0) {
  let eq = start;
  const out = [{ t: trades?.[0]?.openedAt ?? Date.now(), equity: eq }];
  for (const t of (trades || []).filter(isDecided)) {
    eq += t.pnl;
    out.push({ t: t.settledAt || t.expiresAt, equity: round(eq, 2) });
  }
  return out;
}

/** Largest peak-to-trough drop in currency units. */
export function maxDrawdown(trades, start = 0) {
  let eq = start;
  let peak = start;
  let mdd = 0;
  for (const t of (trades || []).filter(isDecided)) {
    eq += t.pnl;
    if (eq > peak) peak = eq;
    if (peak - eq > mdd) mdd = peak - eq;
  }
  return round(mdd, 2);
}

export function streaks(trades) {
  let bestWin = 0;
  let bestLoss = 0;
  let cw = 0;
  let cl = 0;
  for (const t of (trades || []).filter(isDecided)) {
    if (t.result === 'win') {
      cw++;
      cl = 0;
      bestWin = Math.max(bestWin, cw);
    } else {
      cl++;
      cw = 0;
      bestLoss = Math.max(bestLoss, cl);
    }
  }
  return { bestWinStreak: bestWin, bestLossStreak: bestLoss };
}

/** Rolling win rate over `window` trades — drives the live risk gate. */
export function rollingWinRate(trades, window = 20) {
  const d = (trades || []).filter(isDecided).slice(-window);
  if (!d.length) return null;
  return d.filter((t) => t.result === 'win').length / d.length;
}

/* ------------------------------- CSV --------------------------------- */

const CSV_COLS = [
  'id', 'openedAt', 'openedAtIso', 'sym', 'source', 'assetClass', 'tf', 'dir', 'entry', 'exit',
  'stake', 'payout', 'result', 'pnl', 'score', 'confidence', 'signals',
];

export function toCSV(trades) {
  const rows = [CSV_COLS.join(',')];
  for (const t of trades || []) {
    rows.push(
      CSV_COLS.map((col) => {
        let v;
        if (col === 'openedAtIso') v = new Date(t.openedAt).toISOString();
        else if (col === 'signals') v = (t.signals || []).join(' | ');
        else v = t[col];
        if (v == null) v = '';
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',')
    );
  }
  return rows.join('\n');
}

const round = (v, dp = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : v);
