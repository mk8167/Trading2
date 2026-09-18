/* ------------------------------------------------------------------
 * engine.js — the evaluation loop.
 *
 * One place decides "is there a signal right now?" and "did a candle just
 * close?". Every UI surface (HUD, popup, side panel) reads the cached
 * result of this function instead of re-running the strategy, so all of
 * them always agree and the maths runs at most once per closed bar.
 * ----------------------------------------------------------------*/

import * as store from './store.js';
import * as ledger from './ledger.js';
import { analyze, gate, breakEvenWinRate } from './strategy.js';
import { lastOf, TF_MS, bucketOf } from './candles.js';
import { marketOpen, pretty as prettyName } from './symbols.js';

/** Last known price for any symbol, or null when we have none. */
function lastPrice(sym) {
  const st = store.getSymbol(sym);
  return st && Number.isFinite(st.price) && st.price > 0 ? st.price : null;
}

const evaluatedAt = new Map(); // sym -> open time of the last bar we acted on
const cache = new Map(); // sym -> {barT, signal}

export function currentSignal(sym) {
  return cache.get(sym)?.signal || null;
}

export function invalidate(sym) {
  cache.delete(sym);
  evaluatedAt.delete(sym);
}

/**
 * Recompute (or reuse) the signal for `sym`, act on newly closed bars and
 * settle expired paper trades. Safe to call every second.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.trade]    may this call open a paper trade / write a
 *   journal event? Only the symbol the user is watching may (see index.js's
 *   candidate pass) — otherwise "auto paper trade" would also stake money on
 *   every pair the ranker looks at.
 * @param {boolean} [opts.preview]  compute the forming-bar preview (the most
 *   expensive part; the panel needs it, a background candidate does not).
 * @param {boolean} [opts.settle]   run the ledger sweep. It is idempotent, but
 *   it does not need to run once per candidate per second.
 * @returns {{signal:object|null, open:Array, settled:Array, newBar:boolean}}
 */
export function evaluate(sym, settings, { trade = true, preview: wantPreview = true, settle = true } = {}) {
  const s = store.getSymbol(sym);
  if (!s) return { signal: null, open: [], settled: [], newBar: false };

  store.refreshDerived(sym);
  const m1 = s.tf.m1;
  const price = Number.isFinite(s.price) ? s.price : lastOf(m1)?.c;
  // Class-aware payout: the live figure from the broker when we have it,
  // otherwise what is typical for this asset class — not one global 86%
  // applied to crypto and forex alike, which made the break-even number on
  // screen wrong for every pair that was not forex.
  const resolved = store.effectivePayout(sym, settings.payout);
  const payout = resolved.payout;
  const now = Date.now();

  // Settle everything that expired, on this symbol AND every other one.
  // Settling only `sym` stranded trades whenever the user switched pairs,
  // and a stranded trade blocks that pair from ever trading again.
  // seriesOf gives the ledger the candle history so a settlement made after a
  // service-worker restart can use the price AT expiry rather than the price
  // whenever the worker happened to wake up. See ledger.priceAtExpiry.
  const settled = settle
    ? ledger.settleAllDue(lastPrice, now, (sym) => {
        const x = store.getSymbol(sym);
        return x ? { m1: x.tf.m1, ts: x.ts } : null;
      })
    : [];
  if (!trade) store.diag.candidates = (store.diag.candidates || 0) + 1;

  const assetClass = s.assetClass || 'unknown';
  const data = {
    m1: s.tf.m1,
    m5: s.tf.m5,
    m15: s.tf.m15,
    price,
    payout,
    assetClass,
    marketOpen: marketOpen(assetClass, now),
    now,
  };

  const barT = m1.length > 1 ? m1[m1.length - 2].t : 0; // last CLOSED bar
  let newBar = false;
  let signal = cache.get(sym);

  if (!signal || signal.barT !== barT || !barT) {
    const computed = analyze(data, settings.strategy);
    signal = { barT, signal: computed };
    cache.set(sym, signal);
    newBar = barT !== 0 && evaluatedAt.get(sym) !== undefined && evaluatedAt.get(sym) !== barT;
    if (barT) evaluatedAt.set(sym, barT);
  }

  const sig = signal.signal;

  if (trade && newBar && sig && (sig.dir === 'up' || sig.dir === 'down')) {
    maybeTrade(sym, sig, { settings, price, payout, source: s.source, assetClass, otc: !!s.otc });
  } else if (trade && newBar && sig?.dir === 'veto') {
    ledger.logEvent('veto', `${sym} blocked — ${sig.vetoes[0]}`);
  }

  // Forming-bar preview (NOT the executed decision). Recomputed every call so
  // the HUD can show the developing direction a few seconds before the close.
  const tf = settings.tf === 'm15' ? 'm15' : settings.tf === 'm5' ? 'm5' : 'm1';
  const tfMs = TF_MS[tf] || TF_MS.m1;
  const formingOpen = m1.length ? m1[m1.length - 1].t : 0;
  const secondsToClose = formingOpen ? Math.max(0, Math.ceil((formingOpen + tfMs - Date.now()) / 1000)) : 0;
  let preview = null;
  if (wantPreview && m1.length >= 40) {
    preview = analyze(data, { ...settings.strategy, preview: true });
  }

  return {
    signal: sig,
    preview,
    secondsToClose,
    tf,
    open: ledger.openOn(sym),
    settled,
    newBar,
    // Report the numbers the decision was actually made with, so the UI can
    // never show a break-even figure the engine did not use.
    payout,
    payoutOrigin: resolved.origin,
    assetClass,
    marketOpen: data.marketOpen,
  };
}

/**
 * Bankroll protection.
 *
 * `settings.balance` is a number the user typed once. Every trade since then
 * has moved the real bankroll without moving that number, so a fixed
 * percentage of a stale balance keeps staking after the money is gone: start
 * at $100 risking 5%, lose twenty in a row, and the engine is still risking $5
 * of an account that no longer exists. So the figure we risk against is the
 * starting balance plus realized P&L — voids contribute nothing, which is
 * right, since a voided trade returned its stake.
 *
 * @returns {{starting:number, realized:number, current:number, riskPct:number, stake:number, canTrade:boolean, reason:string|null}}
 */
export function bankroll(settings, trades = ledger.trades) {
  const starting = Number.isFinite(settings?.balance) && settings.balance > 0 ? settings.balance : 0;
  const riskPct = Number.isFinite(settings?.riskPct) && settings.riskPct > 0 ? settings.riskPct : 1;
  let realized = 0;
  // A corrupt or partially-written journal row must not be able to throw here:
  // this runs inside maybeTrade, so a crash would silently stop all trading.
  for (const t of trades || []) if (t && t.result && Number.isFinite(t.pnl)) realized += t.pnl;
  const current = starting + realized;
  const stake = Math.max(0.01, +((current * riskPct) / 100).toFixed(2));
  let reason = null;
  if (!(current > 0)) reason = `bankroll is ${current.toFixed(2)} — the starting balance plus realized P&L is gone`;
  else if (!(stake <= current)) reason = `bankroll ${current.toFixed(2)} cannot cover even the minimum ${stake.toFixed(2)} stake`;
  return { starting, realized, current, riskPct, stake, canTrade: !reason, reason };
}

function maybeTrade(sym, sig, { settings, price, payout, source, assetClass, otc }) {
  if (!settings.autoPaperTrade) return;
  if (ledger.openOn(sym).length) return;
  if (!Number.isFinite(price) || price <= 0) return;

  const g = gate({
    signal: sig,
    trades: ledger.trades,
    payout,
    now: Date.now(),
    opts: settings.strategy,
  });
  if (!g.ok) {
    ledger.logEvent('gate', `${sym} — ${g.reason}`);
    return;
  }

  // Refuse to trade once losses have eaten the bankroll. This is a stop, not a
  // suggestion: sizing off the stale starting balance is how a paper account
  // quietly goes negative and keeps reporting a strategy as viable.
  const bk = bankroll(settings);
  if (!bk.canTrade) {
    ledger.logEvent('gate', `${sym} — STOPPED: ${bk.reason}`);
    return;
  }
  const stake = bk.stake;
  ledger.openTrade({
    sym,
    dir: sig.dir,
    entry: price,
    stake,
    payout,
    tf: settings.tf,
    expiryMinutes: settings.expiryMinutes,
    signals: sig.signals.filter((x) => x.dir === sig.dir),
    score: sig.score,
    confidence: sig.confidence,
    source,
    assetClass,
    otc,
  });

  if (settings.alerts?.desktop && sig.confidence >= (settings.alerts.minConfidence ?? 0)) {
    notify(sig, sym, price, payout);
  }
}

function notify(sig, sym, price, payout) {
  try {
    chrome.notifications.create(`qsync-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `Q-Sync · ${sig.dir.toUpperCase()} ${prettyName(sym)}`,
      message: `${sig.summary}\nEntry ${price} · payout ${payout}% · break-even ${(breakEvenWinRate(payout) * 100).toFixed(1)}%`,
      priority: 2,
    });
  } catch {
    /* notifications are best-effort */
  }
}

/** Drop cache for symbols we no longer track. */
export function prune(keep) {
  for (const k of [...cache.keys()]) if (!keep.includes(k)) cache.delete(k);
  for (const k of [...evaluatedAt.keys()]) if (!keep.includes(k)) evaluatedAt.delete(k);
}
