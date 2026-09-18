/* ------------------------------------------------------------------
 * recommend.js — which pair is worth trading right now, and why.
 *
 * Picking a pair by feel is where most of the damage in binary options is
 * done: the same strategy on a dead OTC feed and on a liquid crypto pair
 * has nothing in common, and a 92% payout pair and a 70% payout pair need
 * completely different win rates just to break even.
 *
 * So this ranks instruments on evidence the extension already has, and it
 * refuses to recommend anything it cannot justify:
 *
 *   - a pair with no live data, or too few closed candles to compute on
 *   - a market that is closed (forex over the weekend is frozen, and a
 *     "signal" read off a frozen chart is noise wearing a confident label)
 *   - a pair whose payout is below the break-even floor for its own class
 *   - a pair that already has an open trade (it cannot take another)
 *
 * Historical performance is scored with a Wilson lower bound rather than a
 * raw win rate. Two wins out of two is not an edge, it is two trades; the
 * lower bound says so numerically instead of letting a lucky pair jump to
 * the top of the list.
 *
 * Pure and deterministic: same inputs, same order, every time.
 * ----------------------------------------------------------------*/

import { marketOpen, closedReason, volBand, pretty as prettyName } from './symbols.js';
import { breakEvenWinRate } from './strategy.js';
import { isDecided } from './journal.js';

/** Minimum decided trades before history is allowed to influence a score. */
export const MIN_HISTORY = 8;

/** Score weights. They sum to 100 so a score reads as a percentage. */
export const WEIGHTS = {
  signal: 40,
  history: 30,
  quality: 20,
  volatility: 10,
};

/**
 * Lower bound of a binomial proportion at ~95% confidence.
 * Returns 0 for an empty sample rather than NaN, so callers can compare
 * against a break-even rate without a guard everywhere.
 */
export function wilsonLowerBound(wins, n, z = 1.96) {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const w = Math.max(0, Math.min(n, wins));
  const ph = w / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = ph + z2 / (2 * n);
  const spread = z * Math.sqrt((ph * (1 - ph) + z2 / (4 * n)) / n);
  const lb = (centre - spread) / denom;
  return Math.max(0, Math.min(1, lb));
}

/** How trustworthy is the data behind this pair? 0..1 */
function qualityScore(s) {
  // Source: the broker's own socket is the truth; REST proxies lag.
  const src = s.source === 'quotex' ? 1 : s.source === 'binance' ? 0.6 : 0.4;
  // Enough closed candles to compute indicators, with headroom beyond the
  // 40-bar minimum the strategy needs.
  const bars = Math.min(1, Math.max(0, (s.bars - 40) / 160));
  // Freshness: a tick from 2 seconds ago vs one from a minute ago.
  const age = s.ts ? (Date.now() - s.ts) / 1000 : Infinity;
  const fresh = age <= 5 ? 1 : age <= 20 ? 0.7 : age <= 60 ? 0.4 : 0.1;
  return Math.max(0, Math.min(1, 0.4 * src + 0.3 * bars + 0.3 * fresh));
}

/**
 * Is volatility in the useful middle of this class's band? 0..1
 *
 * Near the floor there is nothing to capture; near the cap the next candle
 * is a coin flip with leverage. The middle of the band is where a
 * directional read has the best chance of being right within one expiry.
 */
function volatilityScore(vol, assetClass) {
  if (!Number.isFinite(vol) || vol <= 0) return 0;
  const b = volBand(assetClass);
  if (vol <= b.min || vol >= b.max) return 0;
  // Position within the band, 0 = at the floor, 1 = at the cap.
  const pos = (vol - b.min) / (b.max - b.min);
  // Triangular peak at 45% of the band.
  const ideal = 0.45;
  return Math.max(0, 1 - Math.abs(pos - ideal) / Math.max(ideal, 1 - ideal));
}

/** Per-symbol history: decided trades, wins, and the Wilson lower bound. */
export function historyBySymbol(trades) {
  const out = new Map();
  for (const t of trades || []) {
    if (!isDecided(t) || !t.sym) continue;
    const h = out.get(t.sym) || { n: 0, wins: 0 };
    h.n++;
    if (t.result === 'win') h.wins++;
    out.set(t.sym, h);
  }
  for (const h of out.values()) h.lb = wilsonLowerBound(h.wins, h.n);
  return out;
}

/**
 * Rank every known instrument.
 *
 * @param {Array} symbols  rows from store.listSymbols()
 * @param {Array} trades   the paper-trading journal
 * @param {object} deps
 * @param {object} deps.settings      merged settings
 * @param {(sym:string)=>object|null} deps.signalOf cached signal for a symbol
 * @param {(sym:string)=>{payout:number,origin:string}} deps.payoutOf
 * @param {number} [deps.now]
 * @param {number} [deps.limit]
 * @returns {{best:object|null, ranked:Array, ineligible:Array}}
 */
export function recommend(symbols, trades, deps = {}) {
  const {
    settings = {},
    signalOf = () => null,
    payoutOf = () => null,
    openSymbols = [],
    now = Date.now(),
    limit = 8,
  } = deps;

  const strat = settings.strategy || {};
  const minScore = Number.isFinite(strat.minScore) ? strat.minScore : 3;
  const minPayout = Number.isFinite(strat.minPayout) ? strat.minPayout : 70;
  const history = historyBySymbol(trades);

  const ranked = [];
  const ineligible = [];

  for (const s of symbols || []) {
    if (!s || typeof s !== 'object' || !s.sym) continue; // junk row, not a crash
    const row = assess(s, { signalOf, payoutOf, history, minPayout, minScore, now, open: openSymbols });
    if (row.eligible) ranked.push(row);
    else ineligible.push(row);
  }

  ranked.sort((a, b) => b.score - a.score || a.sym.localeCompare(b.sym));
  ineligible.sort((a, b) => a.sym.localeCompare(b.sym));

  return { best: ranked[0] || null, ranked: ranked.slice(0, limit), ineligible: ineligible.slice(0, limit) };
}

/** Score one instrument, or explain precisely why it cannot be traded. */
function assess(s, { signalOf, payoutOf, history, minPayout, minScore, now, open }) {
  const sym = s.sym;
  const assetClass = s.assetClass || 'unknown';
  const pretty = s.pretty || prettyName(sym);
  const sig = signalOf(sym) || null;
  // Payout resolution order: what the caller resolved (the store knows the
  // live broker figure and the class default), then the row's own payout,
  // then the user's global setting. Inventing 86% here would let a pair
  // paying 60% pass a floor it cannot actually clear.
  const pay = payoutOf(sym);
  const payout = Number.isFinite(pay?.payout) && pay.payout > 0
    ? pay.payout
    : Number.isFinite(s.payout) && s.payout > 0
      ? s.payout
      : Number(settings.payout) || 86;
  const be = breakEvenWinRate(payout);
  const h = history.get(sym) || { n: 0, wins: 0, lb: 0 };

  const base = {
    sym,
    pretty,
    assetClass,
    otc: !!s.otc,
    source: s.source,
    bars: s.bars || 0,
    price: s.price ?? null,
    payout,
    payoutOrigin: pay?.origin || (Number.isFinite(s.payout) && s.payout > 0 ? 'row' : 'setting'),
    breakEven: round(be, 4),
    dir: sig?.dir || null,
    confidence: sig?.confidence || 0,
    score: 0,
    historyN: h.n,
    historyWinRate: h.n ? round(h.wins / h.n, 4) : null,
    historyLowerBound: round(h.lb, 4),
    volatility: Number.isFinite(sig?.ctx?.volatility) ? sig.ctx.volatility : null,
    eligible: false,
    reasons: [],
  };

  /* ---- hard filters: each one is a fact, not a preference ---- */
  if (s.stale) return { ...base, reasons: ['No live data — feed is stale'] };
  if ((s.bars || 0) < 40) return { ...base, reasons: [`Only ${s.bars || 0}/40 closed candles — still warming up`] };

  const closed = !marketOpen(assetClass, now);
  if (closed) return { ...base, reasons: [closedReason(assetClass, now) || 'Market closed'] };

  if (payout < minPayout) {
    return { ...base, reasons: [`Payout ${payout}% is below the ${minPayout}% floor — break-even would be ${(be * 100).toFixed(1)}%`] };
  }

  // A pair already carrying an unsettled trade cannot take another one.
  if ((open || []).includes(sym)) {
    return { ...base, reasons: ['A trade is already open on this pair'] };
  }

  /* ---- scored components ---- */
  const reasons = [];

  // 1. Is there a usable directional signal right now?
  const directional = sig && (sig.dir === 'up' || sig.dir === 'down');
  const sigScore = directional
    ? WEIGHTS.signal * clamp((sig.confidence || 0) / 100) * clamp((sig.score || 0) / Math.max(1, minScore * 2))
    : 0;
  if (directional) reasons.push(`${sig.dir.toUpperCase()} signal · confidence ${sig.confidence}% · net score ${sig.score}`);
  else if (sig?.dir === 'veto') reasons.push(`Signal blocked: ${sig.vetoes?.[0] || 'vetoed'}`);
  else reasons.push('No directional signal right now');

  // 2. Does this pair have a demonstrated edge for this strategy?
  let histScore = 0;
  if (h.n >= MIN_HISTORY) {
    // Points come from the lower bound clearing break-even, not from the raw
    // rate, so a short lucky run cannot outrank a long proven one.
    const margin = h.lb - be;
    histScore = WEIGHTS.history * clamp(margin / 0.15);
    reasons.push(
      margin > 0
        ? `Proven edge: ${(h.wins)}/${h.n} wins, 95% lower bound ${(h.lb * 100).toFixed(1)}% vs ${(be * 100).toFixed(1)}% break-even`
        : `No proven edge yet: ${(h.wins)}/${h.n} wins, lower bound ${(h.lb * 100).toFixed(1)}% is below the ${(be * 100).toFixed(1)}% break-even`
    );
  } else {
    reasons.push(h.n ? `Only ${h.n} decided trades — too few to judge (<${MIN_HISTORY})` : 'Never traded on this pair');
  }

  // 3. Data quality.
  const q = qualityScore({ ...s, ts: s.ts });
  const qualScore = WEIGHTS.quality * q;
  reasons.push(`Data: ${s.bars} bars · ${s.source} feed · ${s.stale ? 'stale' : 'live'}`);

  // 4. Volatility sitting in the useful part of this class's band.
  const vol = base.volatility;
  const volScore = WEIGHTS.volatility * volatilityScore(vol, assetClass);
  if (vol != null) {
    const b = volBand(assetClass);
    reasons.push(`Volatility ${(vol * 100).toFixed(3)}% vs ${assetClass} band ${(b.min * 100).toFixed(3)}–${(b.max * 100).toFixed(3)}%`);
  }

  const total = round(sigScore + histScore + qualScore + volScore, 2);

  return {
    ...base,
    eligible: true,
    score: total,
    parts: {
      signal: round(sigScore, 2),
      history: round(histScore, 2),
      quality: round(qualScore, 2),
      volatility: round(volScore, 2),
    },
    reasons,
  };
}

const clamp = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const round = (v, dp = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : v);
