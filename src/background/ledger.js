/* ------------------------------------------------------------------
 * ledger.js — in-memory paper-trading ledger backed by chrome.storage.
 * ----------------------------------------------------------------*/

import { createTrade, settleTrade, stats, rollingWinRate, streaks, maxDrawdown, equityCurve } from './journal.js';

const KEY = 'journal.v6';
const MAX_TRADES = 2000;

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

export function openTrade({ sym, dir, entry, stake, payout, tf, expiryMinutes, signals, score, confidence, source }) {
  const t = createTrade({ sym, dir, entry, stake, payout, tf, expiryMinutes, signals, score, confidence, source });
  trades.push(t);
  if (trades.length > MAX_TRADES) trades.splice(0, trades.length - MAX_TRADES);
  logEvent('signal', `${dir.toUpperCase()} ${sym} @ ${entry}`, { tradeId: t.id });
  persist();
  return t;
}

/** Close every trade whose expiry has passed, at the given price. */
export function settleDue(sym, price, now = Date.now()) {
  const settled = [];
  for (const t of trades) {
    if (t.result) continue;
    if (t.sym !== sym) continue;
    if (now < t.expiresAt) continue;
    settleTrade(t, price, now);
    settled.push(t);
    logEvent(t.result === 'win' ? 'win' : t.result === 'loss' ? 'loss' : 'tie',
      `${t.result.toUpperCase()} ${t.sym} ${t.dir} · ${(t.pnl >= 0 ? '+' : '')}${t.pnl.toFixed(2)}`,
      { tradeId: t.id });
  }
  if (settled.length) persist();
  return settled;
}

export function openOn(sym) {
  return trades.filter((t) => !t.result && t.sym === sym);
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
