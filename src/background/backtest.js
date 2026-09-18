/* ------------------------------------------------------------------
 * backtest.js — replay the exact same strategy over historical candles.
 *
 * Realism rules:
 *  - a signal is only evaluated on CLOSED bars (analyze() drops the last)
 *  - entry is the OPEN of the next bar, never the close that produced it
 *  - exit is the close of the bar `expiry` bars later
 *  - cooldown / win-rate gate / volatility vetoes apply exactly as live
 * ----------------------------------------------------------------*/

import { analyze, gate, DEFAULT_OPTS } from './strategy.js';
import { aggregate, TF_MS, bucketOf } from './candles.js';
import { createTrade, settleTrade, stats, maxDrawdown, streaks } from './journal.js';

export const BACKTEST_DEFAULTS = {
  warmup: 60, // bars consumed before the first evaluation
  expiryBars: 1, // bars to hold (1 = classic 1-minute binary)
  stake: 1,
  payout: 86,
  tf: 'm1',
  maxTrades: 2000,
  useMtf: true,
};

/**
 * @param {Array} m1 base series of 1-minute candles
 * @param {object} cfg merged over BACKTEST_DEFAULTS
 */
export function runBacktest(m1, cfg = {}) {
  const o = { ...BACKTEST_DEFAULTS, ...cfg };
  const src = (m1 || []).filter((c) => c && Number.isFinite(c.t) && Number.isFinite(c.c));
  if (src.length < o.warmup + o.expiryBars + 2) {
    return { ok: false, error: `Need at least ${o.warmup + o.expiryBars + 2} candles, got ${src.length}`, trades: [], stats: null };
  }

  const tfMs = TF_MS[o.tf] || TF_MS.m1;
  const barsPerTrade = o.expiryBars;
  const trades = [];
  const skipped = { veto: 0, gate: 0, none: 0, warmup: 0 };
  const equity = [];
  let cash = 0;
  const opts = { ...DEFAULT_OPTS, ...(o.strategy || {}), useMtf: o.useMtf };

  // Precompute the coarser series once; slice per bar is still O(n) overall
  // because we only ever look at the tail.
  const m5All = aggregate(src, TF_MS.m5);
  const m15All = aggregate(src, TF_MS.m15);

  const upto = (arr, t) => {
    // binary search for the last bar with open time <= t
    let lo = 0;
    let hi = arr.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t <= t) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return idx < 0 ? [] : arr.slice(0, idx + 1);
  };

  for (let i = o.warmup; i < src.length - barsPerTrade; i++) {
    const bar = src[i];
    const slice = src.slice(0, i + 1);
    const now = bar.t + tfMs; // decision happens at the close of `bar`
    const sig = analyze(
      {
        m1: slice,
        m5: o.useMtf ? upto(m5All, bar.t) : [],
        m15: o.useMtf ? upto(m15All, bar.t) : [],
        price: bar.c,
        payout: o.payout,
      },
      opts
    );

    if (sig.dir === 'wait') {
      skipped.warmup++;
      continue;
    }
    if (sig.dir === 'veto') {
      skipped.veto++;
      continue;
    }
    if (sig.dir === 'none') {
      skipped.none++;
      continue;
    }

    const g = gate({ signal: sig, trades, payout: o.payout, now, opts });
    if (!g.ok) {
      skipped.gate++;
      continue;
    }

    const entry = src[i + 1].o; // next bar's open — no look-ahead
    const exitBar = src[Math.min(src.length - 1, i + 1 + barsPerTrade - 1 + 0)] ?? src[src.length - 1];
    const exitIdx = Math.min(src.length - 1, i + barsPerTrade);
    const exitClose = src[exitIdx].c;

    const trade = settleTrade(
      createTrade({
        sym: o.sym || 'BACKTEST',
        dir: sig.dir,
        entry,
        stake: o.stake,
        payout: o.payout,
        tf: o.tf,
        expiryMinutes: (barsPerTrade * tfMs) / 60000,
        signals: sig.signals.filter((s) => s.dir === sig.dir),
        score: sig.score,
        confidence: sig.confidence,
        openedAt: now,
        source: 'backtest',
      }),
      exitClose,
      src[exitIdx].t + tfMs
    );
    trade.exitBar = exitBar.t;
    trades.push(trade);
    cash += trade.pnl;
    equity.push({ t: trade.settledAt, equity: round(cash, 4) });

    if (trades.length >= o.maxTrades) break;
  }

  const s = stats(trades, { payout: o.payout });
  return {
    ok: true,
    bars: src.length,
    evaluated: src.length - o.warmup - barsPerTrade,
    skipped,
    trades,
    equity,
    stats: { ...s, maxDrawdown: maxDrawdown(trades), ...streaks(trades) },
    config: o,
    startedAt: src[o.warmup]?.t ?? null,
    endedAt: src[src.length - 1]?.t ?? null,
  };
}

/** Aggregate a backtest's trades into a compact, UI-ready summary. */
export function summarise(result) {
  if (!result?.ok) return result;
  const s = result.stats;
  return {
    bars: result.bars,
    trades: s.decided,
    winRate: +(s.winRate * 100).toFixed(1),
    breakEven: +(s.breakEven * 100).toFixed(1),
    edge: +(s.edge * 100).toFixed(1),
    profitFactor: Number.isFinite(s.profitFactor) ? s.profitFactor : null,
    expectancy: s.expectancy,
    net: s.net,
    roiPct: s.roiPct,
    maxDrawdown: s.maxDrawdown,
    skipped: result.skipped,
  };
}

const round = (v, dp = 4) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : v);

/**
 * Walk-forward evaluation: run the strategy on several disjoint folds and
 * report each fold's out-of-sample result. No parameter is tuned on the
 * data, so every fold is genuinely unseen — this is the honest way to see
 * whether the edge is real or a fluke of one lucky window.
 */
export function walkForward(m1, cfg = {}, folds = 4) {
  const n = (m1 || []).length;
  const per = Math.floor(n / folds);
  if (per < (cfg.warmup || 60) + 20) return { ok: false, error: `Need ~${((cfg.warmup || 60) + 20) * folds} candles for ${folds} folds, have ${n}` };
  const perFold = [];
  for (let f = 0; f < folds; f++) {
    const chunk = m1.slice(f * per, f === folds - 1 ? n : (f + 1) * per);
    const r = runBacktest(chunk, cfg);
    if (r.ok && r.stats.decided > 0) {
      perFold.push({
        fold: f + 1,
        bars: chunk.length,
        n: r.stats.decided,
        winRate: round(r.stats.winRate * 100, 1),
        breakEven: round(r.stats.breakEven * 100, 1),
        edge: round(r.stats.edge * 100, 1),
        net: r.stats.net,
      });
    }
  }
  if (!perFold.length) return { ok: false, error: 'No fold produced any trades', perFold };
  const edges = perFold.map((x) => x.edge);
  const wrs = perFold.map((x) => x.winRate);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return {
    ok: true,
    folds: perFold.length,
    meanWinRate: round(avg(wrs), 1),
    minWinRate: Math.min(...wrs),
    maxWinRate: Math.max(...wrs),
    meanEdge: round(avg(edges), 1),
    positiveFolds: edges.filter((e) => e > 0).length,
    stable: edges.filter((e) => e > 0).length >= Math.ceil(perFold.length * 0.6),
    perFold,
  };
}

export { bucketOf };
