/* ------------------------------------------------------------------
 * ledger.js — in-memory paper-trading ledger backed by chrome.storage.
 * ----------------------------------------------------------------*/

import { createTrade, settleTrade, voidTrade, stats, rollingWinRate, streaks, maxDrawdown, equityCurve } from './journal.js';
import { canonical } from './symbols.js';

const KEY = 'journal.v6';
const MAX_TRADES = 2000;

/**
 * How long an expired trade waits for a usable settlement price before it
 * is voided. A trade left open forever blocks every future trade on its
 * symbol, so a pair whose feed disappears must eventually be released —
 * but not so quickly that a brief socket gap turns real results into voids.
 */
export const SETTLE_GRACE_MS = 5 * 60 * 1000;

export let trades = [];
export let events = [];

export async function load() {
  try {
    const got = await chrome.storage.local.get(KEY);
    const d = got?.[KEY];
    trades = Array.isArray(d?.trades) ? d.trades.slice(-MAX_TRADES) : [];
    events = Array.isArray(d?.events) ? d.events.slice(-200) : [];
  } catch {
    trades = [];
    events = [];
  }
  // Journals written before canonical keys existed may hold the same
  // instrument as both "EUR/USD_OTC" and "EURUSD_OTC". Folding them here
  // keeps the per-symbol breakdown honest across the upgrade.
  let migrated = 0;
  for (const t of trades) {
    const k = canonical(t.sym);
    if (k && k !== t.sym) {
      t.sym = k;
      migrated++;
    }
  }
  if (migrated) persist();
  return trades;
}

let saveTimer = null;
export function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    chrome.storage.local
      .set({ [KEY]: { trades: trades.slice(-MAX_TRADES), events: events.slice(-200) } })
      .catch(() => {});
  }, 1200);
}

export function logEvent(kind, text, extra = {}) {
  events.unshift({ t: Date.now(), kind, text, ...extra });
  if (events.length > 200) events.length = 200;
  persist();
}

export function openTrade({ sym, dir, entry, stake, payout, tf, expiryMinutes, signals, score, confidence, source, assetClass }) {
  const key = canonical(sym) || sym;
  const t = createTrade({ sym: key, dir, entry, stake, payout, tf, expiryMinutes, signals, score, confidence, source, assetClass });
  trades.push(t);
  if (trades.length > MAX_TRADES) trades.splice(0, trades.length - MAX_TRADES);
  logEvent('signal', `${dir.toUpperCase()} ${sym} @ ${entry}`, { tradeId: t.id });
  persist();
  return t;
}

/**
 * Close every expired trade, on every symbol.
 *
 * `settleDue(sym)` alone only ever ran for the single symbol the heartbeat
 * happened to evaluate. A trade opened on a pair the user then navigated
 * away from therefore stayed open forever — which both froze that pair
 * (engine.maybeTrade refuses to trade while ledger.openOn(sym) is non-empty)
 * and left the trade out of every statistic, so the journal quietly
 * reported a win rate computed from a subset of what was actually taken.
 *
 * @param {(sym:string)=>number|null} priceOf last known price for a symbol
 * @returns {Array} trades that were settled or voided on this pass
 */
export function settleAllDue(priceOf, now = Date.now()) {
  const settled = [];
  for (const t of trades) {
    if (t.result || now < t.expiresAt) continue;
    const price = typeof priceOf === 'function' ? priceOf(t.sym) : null;
    if (Number.isFinite(price) && price > 0) {
      settleTrade(t, price, now);
      logEvent(
        t.result === 'win' ? 'win' : t.result === 'loss' ? 'loss' : 'tie',
        `${t.result.toUpperCase()} ${t.sym} ${t.dir} · ${(t.pnl >= 0 ? '+' : '')}${t.pnl.toFixed(2)}`,
        { tradeId: t.id }
      );
    } else if (now - t.expiresAt > SETTLE_GRACE_MS) {
      // No price is coming. Release the symbol instead of wedging it, and
      // record it as a void so it cannot masquerade as a win or a loss.
      voidTrade(t, 'no settlement price within grace period', now);
      logEvent('void', `VOID ${t.sym} ${t.dir} — expired with no price to settle against`, { tradeId: t.id });
    } else {
      continue; // still inside the grace window; try again next tick
    }
    settled.push(t);
  }
  if (settled.length) persist();
  return settled;
}

/** Symbols carrying an unsettled trade — these must never be evicted. */
export function openSymbols() {
  const out = new Set();
  for (const t of trades) if (!t.result) out.add(t.sym);
  return [...out];
}

export function openOn(sym) {
  const key = canonical(sym) || sym;
  return trades.filter((t) => !t.result && t.sym === key);
}

export function summary(payout) {
  const s = stats(trades, { payout });
  return {
    ...s,
    ...streaks(trades),
    maxDrawdown: maxDrawdown(trades),
    rolling20: rollingWinRate(trades, 20),
    equity: equityCurve(trades).slice(-120),
  };
}

export function reset() {
  trades = [];
  events = [];
  persist();
}

export { createTrade, settleTrade };
