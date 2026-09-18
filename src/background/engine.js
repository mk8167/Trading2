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
 * @returns {{signal:object|null, open:Array, settled:Array, newBar:boolean}}
 */
export function evaluate(sym, settings) {
  const s = store.getSymbol(sym);
  if (!s) return { signal: null, open: [], settled: [], newBar: false };

  store.refreshDerived(sym);
  const m1 = s.tf.m1;
  const price = Number.isFinite(s.price) ? s.price : lastOf(m1)?.c;
  const payout = Number.isFinite(s.payout) ? s.payout : settings.payout;

  // Settle anything that expired while we were asleep.
  const settled = ledger.settleDue(sym, price);

  const barT = m1.length > 1 ? m1[m1.length - 2].t : 0; // last CLOSED bar
  let newBar = false;
  let signal = cache.get(sym);

  if (!signal || signal.barT !== barT || !barT) {
    const computed = analyze(
      { m1: s.tf.m1, m5: s.tf.m5, m15: s.tf.m15, price, payout },
      settings.strategy
    );
    signal = { barT, signal: computed };
    cache.set(sym, signal);
    newBar = barT !== 0 && evaluatedAt.get(sym) !== undefined && evaluatedAt.get(sym) !== barT;
    if (barT) evaluatedAt.set(sym, barT);
  }

  const sig = signal.signal;

  if (newBar && sig && (sig.dir === 'up' || sig.dir === 'down')) {
    maybeTrade(sym, sig, { settings, price, payout, source: s.source });
  } else if (newBar && sig?.dir === 'veto') {
    ledger.logEvent('veto', `${sym} blocked — ${sig.vetoes[0]}`);
  }

  // Forming-bar preview (NOT the executed decision). Recomputed every call so
  // the HUD can show the developing direction a few seconds before the close.
  const tf = settings.tf === 'm15' ? 'm15' : settings.tf === 'm5' ? 'm5' : 'm1';
  const tfMs = TF_MS[tf] || TF_MS.m1;
  const formingOpen = m1.length ? m1[m1.length - 1].t : 0;
  const secondsToClose = formingOpen ? Math.max(0, Math.ceil((formingOpen + tfMs - Date.now()) / 1000)) : 0;
  let preview = null;
  if (m1.length >= 40) {
    preview = analyze(
      { m1: s.tf.m1, m5: s.tf.m5, m15: s.tf.m15, price, payout },
      { ...settings.strategy, preview: true }
    );
  }

  return { signal: sig, preview, secondsToClose, tf, open: ledger.openOn(sym), settled, newBar };
}

function maybeTrade(sym, sig, { settings, price, payout, source }) {
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

  const stake = Math.max(0.01, +(((settings.balance || 100) * (settings.riskPct || 1)) / 100).toFixed(2));
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
      title: `Q-Sync · ${sig.dir.toUpperCase()} ${sym}`,
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
