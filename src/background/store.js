/* ------------------------------------------------------------------
 * store.js — the market state container.
 *
 * MV3 service workers die after ~30s of idleness, so this module keeps
 * state in memory for speed but is designed to be fully rebuilt from a
 * plain JSON snapshot (serialize/deserialize). index.js persists that
 * snapshot to chrome.storage.session on a timer, which is what makes the
 * live feed survive a worker restart — the single biggest failure of the
 * previous version.
 * ----------------------------------------------------------------*/

import { makeSeries, pushTick, upsertCandle, aggregate, trim, lastOf, normaliseTs, compact, expand, DEFAULT_CAP, TF_MS } from './candles.js';

export const MAX_SYMBOLS = 64;
export const PERSIST_SYMBOLS = 24;
export const PERSIST_CANDLES = 150;

/** sym -> SymbolState */
export const symbols = new Map();
export const diag = {
  frames: 0,
  ticks: 0,
  historyRows: 0,
  binaryFrames: 0,
  unparsed: 0,
  sockets: 0,
  samples: [],
  errors: [],
  startedAt: Date.now(),
  restPolls: 0,
  lastFrameAt: 0,
  bridges: new Set(),
};

export function resetDiag() {
  diag.frames = 0;
  diag.ticks = 0;
  diag.historyRows = 0;
  diag.binaryFrames = 0;
  diag.unparsed = 0;
  diag.sockets = 0;
  diag.samples = [];
  diag.errors = [];
  diag.lastFrameAt = 0;
}

export function noteError(msg) {
  const s = String(msg || '').slice(0, 200);
  if (!s) return;
  diag.errors.unshift(`${new Date().toISOString().slice(11, 19)} ${s}`);
  if (diag.errors.length > 12) diag.errors.pop();
}

export function noteSample(sample) {
  if (!sample) return;
  if (diag.samples.some((s) => s.text === sample.text)) return;
  diag.samples.unshift(sample);
  if (diag.samples.length > 10) diag.samples.pop();
}

export function getSymbol(sym) {
  return symbols.get(sym) || null;
}

export function ensureSymbol(sym, source = 'quotex') {
  let s = symbols.get(sym);
  if (!s) {
    if (symbols.size >= MAX_SYMBOLS) evictOldest();
    s = {
      sym,
      source,
      price: NaN,
      ts: 0,
      payout: null,
      tickCount: 0,
      seenAt: Date.now(),
      lastTickAt: 0,
      tf: { m1: makeSeries(TF_MS.m1), m5: makeSeries(TF_MS.m5), m15: makeSeries(TF_MS.m15) },
    };
    symbols.set(sym, s);
  }
  if (source && s.source !== source && source === 'quotex') s.source = source;
  return s;
}

function evictOldest() {
  let oldest = null;
  for (const s of symbols.values()) {
    if (!oldest || s.lastTickAt < oldest.lastTickAt) oldest = s;
  }
  if (oldest) symbols.delete(oldest.sym);
}

/** Apply one tick. Returns the symbol state, or null when rejected. */
export function ingestTick(sym, price, ts = null, source = 'quotex') {
  if (!sym || !Number.isFinite(price) || price <= 0) return null;
  const s = ensureSymbol(sym, source);
  const t = ts == null ? Date.now() : normaliseTs(ts);
  // Reject ticks that would rewind the clock by more than a minute; the
  // candle builder appends only, so old data would corrupt the series.
  if (s.ts && t < s.ts - 60_000) return null;
  pushTick(s.tf.m1, price, t, DEFAULT_CAP.m1);
  s.price = price;
  s.ts = t;
  s.lastTickAt = Date.now();
  s.tickCount++;
  diag.ticks++;
  diag.lastFrameAt = Date.now();
  return s;
}

/** Apply a block of history rows; also back-fills the live price. */
export function ingestHistory(sym, rows, source = 'quotex') {
  if (!sym || !Array.isArray(rows) || !rows.length) return 0;
  const s = ensureSymbol(sym, source);
  let n = 0;
  for (const c of rows) {
    if (upsertCandle(s.tf.m1, c, DEFAULT_CAP.m1)) n++;
  }
  if (n) {
    const last = lastOf(s.tf.m1);
    if (last) {
      if (!Number.isFinite(s.price) || last.t >= s.ts) {
        s.price = last.c;
        s.ts = last.t;
      }
      s.lastTickAt = Date.now();
    }
    diag.historyRows += n;
  }
  return n;
}

export function setPayout(sym, payout) {
  const s = symbols.get(sym);
  if (!s) return;
  const p = Number(payout);
  if (Number.isFinite(p) && p > 0 && p <= 200) s.payout = Math.round(p * 10) / 10;
}

/** Rebuild m5/m15 from m1. Cheap enough to call on demand. */
export function refreshDerived(sym) {
  const s = symbols.get(sym);
  if (!s) return null;
  s.tf.m5 = aggregate(s.tf.m1, TF_MS.m5, DEFAULT_CAP.m5);
  s.tf.m15 = aggregate(s.tf.m1, TF_MS.m15, DEFAULT_CAP.m15);
  s.tf.m5.__tfMs = TF_MS.m5;
  s.tf.m15.__tfMs = TF_MS.m15;
  return s;
}

export function isStale(s, now = Date.now()) {
  if (!s || !s.ts) return true;
  const age = now - s.ts;
  if (s.source === 'quotex') return age > 90_000;
  if (s.source === 'binance') return age > 120_000;
  return age > 600_000;
}

export function listSymbols() {
  return [...symbols.values()]
    .map((s) => ({
      sym: s.sym,
      source: s.source,
      price: Number.isFinite(s.price) ? s.price : null,
      ts: s.ts,
      payout: s.payout,
      ticks: s.tickCount,
      bars: s.tf.m1.length,
      stale: isStale(s),
    }))
    .sort((a, b) => (a.stale - b.stale) || b.ticks - a.ticks || a.sym.localeCompare(b.sym));
}

/* --------------------------- snapshot I/O ---------------------------- */

export function serialize({ limit = PERSIST_SYMBOLS, bars = PERSIST_CANDLES } = {}) {
  const ordered = [...symbols.values()].sort((a, b) => b.lastTickAt - a.lastTickAt).slice(0, limit);
  const out = {};
  for (const s of ordered) {
    out[s.sym] = {
      source: s.source,
      price: Number.isFinite(s.price) ? s.price : null,
      ts: s.ts,
      payout: s.payout,
      tickCount: s.tickCount,
      lastTickAt: s.lastTickAt,
      m1: compact(s.tf.m1.slice(-bars)),
    };
  }
  return { v: 6, at: Date.now(), symbols: out };
}

export function deserialize(snap) {
  if (!snap || !snap.symbols) return 0;
  let n = 0;
  for (const [sym, data] of Object.entries(snap.symbols)) {
    const s = ensureSymbol(sym, data.source || 'quotex');
    const rows = expand(data.m1);
    if (rows.length) {
      s.tf.m1 = makeSeries(TF_MS.m1);
      for (const c of rows) upsertCandle(s.tf.m1, c, DEFAULT_CAP.m1);
      refreshDerived(sym);
    }
    s.price = Number.isFinite(data.price) ? data.price : s.price;
    s.ts = data.ts || s.ts;
    s.payout = data.payout ?? s.payout;
    s.tickCount = data.tickCount || s.tickCount;
    s.lastTickAt = data.lastTickAt || s.lastTickAt;
    n++;
  }
  return n;
}

/** Trim every series back to its cap — call from the housekeeping alarm. */
export function housekeep() {
  for (const s of symbols.values()) {
    trim(s.tf.m1, DEFAULT_CAP.m1);
    trim(s.tf.m5, DEFAULT_CAP.m5);
    trim(s.tf.m15, DEFAULT_CAP.m15);
  }
}

/** Drop symbols that have been silent for `ms`. */
export function pruneStale(ms = 2 * 60 * 60 * 1000) {
  const now = Date.now();
  for (const s of [...symbols.values()]) {
    if (s.lastTickAt && now - s.lastTickAt > ms && s.sym !== selected) symbols.delete(s.sym);
  }
}

export let selected = null;
export function setSelected(sym) {
  selected = sym;
  return selected;
}
