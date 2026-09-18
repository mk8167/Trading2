/* ------------------------------------------------------------------
 * ledger.js — in-memory paper-trading ledger backed by chrome.storage.
 * ----------------------------------------------------------------*/

import { createTrade, settleTrade, voidTrade, stats, rollingWinRate, streaks, maxDrawdown, equityCurve } from './journal.js';
import { canonical } from './symbols.js';
import { TF_MS } from './candles.js';

const KEY = 'journal.v6';
const MAX_TRADES = 2000;

/**
 * How long an expired trade waits for a usable settlement price before it
 * is voided. A trade left open forever blocks every future trade on its
 * symbol, so a pair whose feed disappears must eventually be released —
 * but not so quickly that a brief socket gap turns real results into voids.
 */
export const SETTLE_GRACE_MS = 5 * 60 * 1000;

/**
 * How far from `expiresAt` a price may sit and still be allowed to decide the
 * trade. Beyond this we void instead of guessing: a binary option pays on the
 * price AT expiry, so settling one against a number from three minutes later
 * would fabricate a result that the broker would never have produced.
 */
export const SETTLE_LAG_TOLERANCE_MS = 90 * 1000;

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
 * The price that actually decides an expired trade.
 *
 * A binary option settles at `expiresAt`, not at "whenever the heartbeat next
 * happened to run". Those coincide while the service worker is awake, but MV3
 * kills idle workers: if it wakes three minutes late, `priceOf(sym)` is three
 * minutes of market movement away from the number that matters — easily enough
 * to turn a real win into a recorded loss, or the reverse. So we compare every
 * price we can actually observe by how close its own timestamp sits to expiry:
 *
 *   - the close of each COMPLETED 1m bar (a bar still forming has no close yet,
 *     and treating its running value as one is how stale data sneaks in);
 *   - the live price, timestamped by the feed that produced it.
 *
 * Whichever is nearest to `expiresAt` wins. On a prompt 1s heartbeat that is
 * the live price, exactly as before; on a late wake it is the bar that closed
 * at expiry. Anything further away than SETTLE_LAG_TOLERANCE_MS is refused and
 * reported, so the caller can void rather than invent a result.
 *
 * @param {Array} m1 completed-or-forming 1m candles for the symbol
 * @param {number} expiresAt ms
 * @param {number|null} livePrice latest price from the feed
 * @param {number} liveTs timestamp of that price (the feed's clock, not ours)
 * @param {number} now ms
 * @returns {{price:number, basis:'bar'|'live', lagMs:number}|null}
 */
export function priceAtExpiry(m1, expiresAt, livePrice, liveTs, now = Date.now()) {
  if (!Number.isFinite(expiresAt)) return null;
  let best = null;
  const consider = (price, ts, basis) => {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(ts)) return;
    const lagMs = Math.abs(ts - expiresAt);
    if (!best || lagMs < best.lagMs) best = { price, basis, lagMs };
  };
  if (Array.isArray(m1)) {
    for (const c of m1) {
      if (!c || !Number.isFinite(c.t) || !Number.isFinite(c.c)) continue;
      const closeTs = c.t + TF_MS.m1;
      // Only bars that have finished. An unfinished bar's `c` is just the most
      // recent tick wearing a candle's clothes, and its close timestamp is in
      // the future, so it would misstate how old the number really is.
      if (closeTs <= now + 1) consider(c.c, closeTs, 'bar');
    }
  }
  consider(livePrice, Number.isFinite(liveTs) && liveTs > 0 ? liveTs : now, 'live');
  if (!best) return null;
  if (best.lagMs > SETTLE_LAG_TOLERANCE_MS) return { ...best, refused: true };
  return best;
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
 * @param {number} [now]
 * @param {(sym:string)=>{m1:Array, ts:number}|null} [seriesOf] gives access to
 *        the candle history, which is what lets a late settlement use the
 *        expiry price instead of the current one. Omit it and settlement falls
 *        back to `priceOf` alone (still lag-checked).
 * @returns {Array} trades that were settled or voided on this pass
 */
export function settleAllDue(priceOf, now = Date.now(), seriesOf = null) {
  const settled = [];
  for (const t of trades) {
    if (t.result || now < t.expiresAt) continue;
    const ctx = typeof seriesOf === 'function' ? seriesOf(t.sym) : null;
    const found = priceAtExpiry(
      ctx?.m1 || null,
      t.expiresAt,
      typeof priceOf === 'function' ? priceOf(t.sym) : null,
      ctx?.ts ?? null,
      now
    );
    const price = found && !found.refused ? found.price : null;
    if (price != null) {
      settleTrade(t, price, now);
      // Keep a record of how the number was chosen. Real money means the user
      // has to be able to ask "why did this settle at 1.08412?" later.
      t.settleBasis = found.basis;
      t.settleLagMs = Math.round(found.lagMs);
      logEvent(
        t.result === 'win' ? 'win' : t.result === 'loss' ? 'loss' : 'tie',
        `${t.result.toUpperCase()} ${t.sym} ${t.dir} · ${(t.pnl >= 0 ? '+' : '')}${t.pnl.toFixed(2)}` +
          (found.lagMs > 2000 ? ` (settled on ${found.basis} ${Math.round(found.lagMs / 1000)}s from expiry)` : ''),
        { tradeId: t.id }
      );
    } else if (found?.refused) {
      // We have a price, but it is too far from expiry to be the price the
      // broker would have used. Void it and say why, rather than booking a
      // win or loss nobody could reproduce.
      voidTrade(t, `no price within ${SETTLE_LAG_TOLERANCE_MS / 1000}s of expiry (nearest was ${Math.round(found.lagMs / 1000)}s away)`, now);
      logEvent('void', `VOID ${t.sym} ${t.dir} — nearest price was ${Math.round(found.lagMs / 1000)}s from expiry`, { tradeId: t.id });
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
