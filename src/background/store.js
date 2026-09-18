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

import { makeSeries, pushTick, upsertCandle, isCandle, aggregate, trim, lastOf, normaliseTs, compact, expand, DEFAULT_CAP, TF_MS } from './candles.js';
import { detectTf, minuteSpaced, splitCoarseRuns } from './sync.js';
import { canonical, classifyWith, pretty as prettyName, classPayout } from './symbols.js';

export const MAX_SYMBOLS = 64;
export const PERSIST_SYMBOLS = 24;
export const PERSIST_CANDLES = 150;
/** How many broker-sent (coarser timeframe) candles a pair keeps. */
export const BROKER_CAP = 400;

/** sym -> SymbolState (keys are always canonical — see symbols.js) */
export const symbols = new Map();

/**
 * Facts that arrived before their instrument did.
 *
 * Quotex pushes its asset list — which carries both the payout and the
 * asset type — before the first tick for that asset. The old setPayout()
 * looked the symbol up and returned silently when it was absent, so the
 * real payout was thrown away every single time and the global default of
 * 86% was used instead. That default then fed the break-even maths the
 * risk gate is built on, and every classification fell back to guessing
 * from the name.
 */
const inbox = new Map();
const INBOX_MAX = 512;
const PAYOUT_TTL_MS = 6 * 60 * 60 * 1000; // a stale payout is worse than none

function park(key, patch) {
  if (!key) return;
  if (!inbox.has(key) && inbox.size >= INBOX_MAX) inbox.delete(inbox.keys().next().value);
  inbox.set(key, { ...(inbox.get(key) || {}), ...patch });
}

/**
 * Symbols that must survive eviction and pruning: the one the user is
 * watching, plus anything carrying an open paper trade. Losing either
 * destroys candle history that cannot be rebuilt.
 */
const protectedSyms = new Set();

export const diag = {
  frames: 0,
  ticks: 0,
  historyRows: 0,
  /** How many history blocks have been stored, and how they were filed. */
  historyBlocks: 0,
  brokerRows: 0,
  tfSwitches: 0,
  /** History blocks whose timeframe could not be read — kept out, not guessed. */
  oddBlocks: 0,
  binaryFrames: 0,
  unparsed: 0,
  /** Extraction path -> how many frames it resolved (Diagnostics). */
  methods: {},
  sockets: 0,
  samples: [],
  errors: [],
  startedAt: Date.now(),
  restPolls: 0,
  lastFrameAt: 0,
  bridges: new Set(),
  evictions: 0,
  pruned: 0,
  sourceTakeovers: 0,
  proxyRefusals: 0,
  payoutsQueued: 0,
  payoutsApplied: 0,
  /** Pairs scored beyond the one on screen, so the ranker has real signals. */
  candidates: 0,
};

export function resetDiag() {
  diag.frames = 0;
  diag.ticks = 0;
  diag.historyRows = 0;
  diag.historyBlocks = 0;
  diag.brokerRows = 0;
  diag.tfSwitches = 0;
  diag.oddBlocks = 0;
  diag.binaryFrames = 0;
  diag.unparsed = 0;
  diag.methods = {};
  diag.sockets = 0;
  diag.samples = [];
  diag.errors = [];
  diag.lastFrameAt = 0;
  diag.candidates = 0;
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
  return symbols.get(canonical(sym)) || null;
}

/**
 * Source authority.
 *
 * The broker's own socket is the truth about the broker's price. A REST
 * proxy is delayed, and for crypto it is not even the same underlying —
 * Binance quotes BTCUSDT while the broker quotes BTC/USD, and those two
 * numbers differ. Now that one canonical key covers every spelling, a proxy
 * would otherwise append its rows straight into the live series, quietly
 * poisoning every indicator computed from it.
 *
 * So: a proxy may never write to a key the broker owns, and when the broker
 * starts streaming a key a proxy was standing in for, the proxy's candles are
 * discarded rather than blended. Losing a warm-up costs minutes; a blended
 * series costs correctness.
 */
const LIVE_SOURCE = 'quotex';

export function ensureSymbol(sym, source = LIVE_SOURCE, hint = null, opts = null) {
  const key = canonical(sym);
  if (!key) return null;
  const force = !!(opts && opts.force);
  let s = symbols.get(key);
  if (!s) {
    if (symbols.size >= MAX_SYMBOLS) evictOldest();
    const info = classifyWith(key, hint);
    s = {
      sym: key,
      pretty: info.pretty,
      assetClass: info.assetClass,
      otc: info.otc,
      base: info.base,
      quote: info.quote,
      source,
      price: NaN,
      ts: 0,
      payout: null,
      payoutAt: 0,
      declaredType: null,
      tickCount: 0,
      seenAt: Date.now(),
      lastTickAt: 0,
      /**
       * Candles the BROKER sent for its own chart, per timeframe, when that
       * chart was not on m1. Kept apart from `tf` (which is built from ticks)
       * so a block of 5-minute candles can never be mistaken for 1-minute
       * data — see ingestHistory() and sync.js.
       */
      broker: {},
      brokerAt: 0,
      brokerLastTf: null,
      historyRows: 0,
      historyAt: 0,
      tf: { m1: makeSeries(TF_MS.m1), m5: makeSeries(TF_MS.m5), m15: makeSeries(TF_MS.m15) },
    };
    symbols.set(key, s);
    // Facts that arrived before the instrument did are applied now instead
    // of having been dropped on the floor.
    const pending = inbox.get(key);
    if (pending) {
      inbox.delete(key);
      if (pending.payout != null) applyPayout(s, pending.payout, pending.payoutAt || Date.now());
      if (pending.type || pending.otc != null) applyMeta(s, { type: pending.type, otc: pending.otc });
    }
  } else if (s.source !== source && !force) {
    if (source === LIVE_SOURCE) {
      // Broker taking over from a proxy: drop the proxy's candles.
      if (s.tf.m1.length) {
        s.tf.m1 = makeSeries(TF_MS.m1);
        s.tf.m5 = makeSeries(TF_MS.m5);
        s.tf.m15 = makeSeries(TF_MS.m15);
        s.price = NaN;
        s.ts = 0;
        s.tickCount = 0;
        diag.sourceTakeovers = (diag.sourceTakeovers || 0) + 1;
      }
      s.source = LIVE_SOURCE;
    } else if (s.source === LIVE_SOURCE) {
      diag.proxyRefusals = (diag.proxyRefusals || 0) + 1;
      return null; // a proxy may not write into a live broker series
    } else {
      diag.proxyRefusals = (diag.proxyRefusals || 0) + 1;
      return null; // first proxy to claim a key keeps it
    }
  }
  if (hint) applyMeta(s, hint);
  return s;
}

/**
 * Record what the broker itself declared about an instrument.
 * A declared type always beats the classification inferred from the name.
 */
export function applyMeta(s, hint) {
  if (!s || !hint) return;
  const changed = (hint.type && s.declaredType !== hint.type) || (typeof hint.otc === 'boolean' && s.otc !== hint.otc);
  if (hint.type) s.declaredType = hint.type;
  if (!changed) return;
  const info = classifyWith(s.sym, { type: s.declaredType || undefined, otc: s.otc });
  s.assetClass = info.assetClass;
  s.otc = info.otc;
  s.pretty = info.pretty;
}

export function setMeta(sym, hint) {
  const key = canonical(sym);
  if (!key || !hint) return false;
  const s = symbols.get(key);
  if (!s) {
    park(key, { type: hint.type ?? null, otc: hint.otc ?? null });
    return false;
  }
  applyMeta(s, hint);
  return true;
}

/**
 * Evict the least valuable symbol to make room.
 *
 * Protected symbols are skipped entirely — evicting the pair the user is
 * watching, or one holding an unsettled trade, silently destroys data that
 * cannot be reconstructed. When nothing evictable is left we prefer
 * symbols with no candles (a name we merely saw mentioned) over ones with
 * real history.
 */
function evictOldest() {
  let victim = null;
  for (const s of symbols.values()) {
    if (protectedSyms.has(s.sym)) continue;
    const bars = s.tf.m1.length;
    if (!victim) {
      victim = s;
      continue;
    }
    const victimBars = victim.tf.m1.length;
    if (bars < victimBars) victim = s;
    else if (bars === victimBars && s.lastTickAt < victim.lastTickAt) victim = s;
  }
  if (victim) {
    symbols.delete(victim.sym);
    diag.evictions = (diag.evictions || 0) + 1;
  }
  return !!victim;
}

/** Apply one tick. Returns the symbol state, or null when rejected. */
export function ingestTick(sym, price, ts = null, source = 'quotex', hint = null) {
  if (!sym || !Number.isFinite(price) || price <= 0) return null;
  const s = ensureSymbol(sym, source, hint);
  if (!s) return null;
  const t = ts == null ? Date.now() : normaliseTs(ts);
  // Reject ticks that would rewind the clock by more than a minute; the
  // candle builder appends only, so old data would corrupt the series.
  if (s.ts && t < s.ts - 60_000) return null;
  pushTick(s.tf.m1, price, t, DEFAULT_CAP.m1);
  // A tick that is merely late still lands in the bar it belongs to, but it
  // must not drag the live quote backwards: s.ts is what settlement uses as
  // "the feed's clock for this price" and what isStale() judges freshness by,
  // so rewinding it would make a live pair look stale and a settlement pick
  // the wrong price.
  if (!s.ts || t >= s.ts) {
    s.price = price;
    s.ts = t;
  }
  s.lastTickAt = Date.now();
  s.tickCount++;
  diag.ticks++;
  diag.lastFrameAt = Date.now();
  return s;
}

/**
 * Apply a block of history rows; also back-fills the live price.
 *
 * Two things are decided here, and both of them were silently wrong before.
 *
 * 1. WHICH TIMEFRAME the block is in. The broker sends candles for the chart
 *    the user is looking at, so a user on a 5-minute chart receives 5-minute
 *    candles. Filing those into the m1 series made the m1 series a mix of
 *    real 1-minute tick bars and 5/15-minute broker bars: every indicator,
 *    every aggregate, the "last closed bar" the strategy fires on and the
 *    chart all reported numbers that belonged to no timeframe at all. The
 *    extension's chart could therefore never match the broker's.
 * 2. THE ORDER. upsertCandle() refuses to rewrite history, so a block that
 *    arrives newest-first used to leave exactly one candle behind. Rows are
 *    sorted before they are stored.
 *
 * @param {{tf?:string}} [opts] the timeframe the block is known to be in;
 *   measured from the row spacing when it is not supplied.
 * @returns {number} rows stored
 */
export function ingestHistory(sym, rows, source = 'quotex', hint = null, opts = null) {
  if (!sym || !Array.isArray(rows) || !rows.length) return 0;
  const s = ensureSymbol(sym, source, hint);
  if (!s) return 0;

  const sorted = rows.filter(isCandle).slice().sort((a, b) => a.t - b.t);
  if (!sorted.length) return 0;

  const tf = (opts && opts.tf) || detectTf(sorted) || (minuteSpaced(sorted) ? 'm1' : null);
  if (!tf) {
    // A block whose spacing cannot be read. Filing it as 1-minute data is how
    // the m1 series got polluted in the first place, so it is counted and kept
    // out instead — Diagnostics shows the count, and the Protocol Lab keeps the
    // payload, so "some frames were not stored" is visible rather than silent.
    diag.oddBlocks = (diag.oddBlocks || 0) + 1;
    s.historyRows += sorted.length;
    s.historyAt = Date.now();
    return 0;
  }
  let n = 0;
  let list = null;
  if (tf === 'm1') {
    for (const c of sorted) if (upsertCandle(s.tf.m1, c, DEFAULT_CAP.m1)) n++;
  } else {
    list = s.broker[tf] || makeSeries(TF_MS[tf] || TF_MS.m5);
    for (const c of sorted) if (upsertCandle(list, c, BROKER_CAP)) n++;
    if (n) {
      if (s.brokerLastTf && s.brokerLastTf !== tf) diag.tfSwitches++;
      s.broker[tf] = list;
      s.brokerLastTf = tf;
      s.brokerAt = Date.now();
      diag.brokerRows += n;
    }
  }

  if (n) {
    diag.historyBlocks++;
    diag.historyRows += n;
    s.historyRows += n;
    s.historyAt = Date.now();
    const last = tf === 'm1' ? lastOf(s.tf.m1) : lastOf(list);
    if (last) {
      if (!Number.isFinite(s.price) || last.t >= s.ts) {
        s.price = last.c;
        s.ts = last.t;
      }
      s.lastTickAt = Date.now();
    }
  }
  return n;
}

/**
 * Record a payout. Returns true when it was stored.
 *
 * Payouts arriving for an instrument we have not seen yet are parked in an
 * inbox rather than discarded — the broker sends its asset list before the
 * first tick, so under the old behaviour the real payout never survived.
 */
export function setPayout(sym, payout) {
  const p = Number(payout);
  if (!Number.isFinite(p) || p <= 0 || p > 200) return false;
  const key = canonical(sym);
  if (!key) return false;
  const s = symbols.get(key);
  if (!s) {
    park(key, { payout: p, payoutAt: Date.now() });
    diag.payoutsQueued = (diag.payoutsQueued || 0) + 1;
    return false;
  }
  return applyPayout(s, p, Date.now());
}

function applyPayout(s, p, at) {
  // Only accept a value that is not absurdly older than the one we hold.
  if (s.payout != null && s.payoutAt && at && at < s.payoutAt - 60_000) return false;
  s.payout = Math.round(p * 10) / 10;
  s.payoutAt = at || Date.now();
  diag.payoutsApplied = (diag.payoutsApplied || 0) + 1;
  return true;
}

/**
 * The payout to use for maths on this instrument.
 *
 * Priority: the live payout the broker sent (if it has not gone stale),
 * then the default typical for this asset class, then the user's global
 * setting. Falling back to a single global 86% for every market was what
 * made the break-even figure on screen wrong for crypto pairs.
 */
export function effectivePayout(sym, settingsPayout) {
  const s = symbols.get(canonical(sym));
  if (s && Number.isFinite(s.payout) && s.payout > 0) {
    const fresh = !s.payoutAt || Date.now() - s.payoutAt < PAYOUT_TTL_MS;
    if (fresh) return { payout: s.payout, origin: 'live' };
  }
  const cls = s ? s.assetClass || 'unknown' : 'unknown';
  const userPayout = Number.isFinite(settingsPayout) && settingsPayout > 0 ? settingsPayout : null;
  // When we know what the instrument is, the class default beats a single
  // global number: crypto pays less than forex, and pretending otherwise
  // understates the win rate a trade actually needs. When we do NOT know
  // what it is, the user's own setting is the better guess.
  if (cls === 'unknown' && userPayout != null) return { payout: userPayout, origin: 'setting' };
  const byClass = classPayout(cls);
  if (Number.isFinite(byClass)) return { payout: byClass, origin: 'class' };
  return { payout: userPayout ?? 86, origin: 'setting' };
}

/**
 * Rebuild m5/m15. Cheap enough to call on demand.
 *
 * When the broker has sent candles for a timeframe itself, those candles are
 * the chart the user is looking at — they win over anything aggregated from
 * our own ticks. Bars newer than the last broker candle (ticks that arrived
 * between two history blocks) are appended so the series still ends at "now"
 * instead of at the last time the broker felt like sending history.
 */
export function refreshDerived(sym) {
  const s = symbols.get(canonical(sym));
  if (!s) return null;
  for (const tf of ['m5', 'm15']) {
    const agg = aggregate(s.tf.m1, TF_MS[tf], DEFAULT_CAP[tf]);
    agg.__tfMs = TF_MS[tf];
    const own = s.broker[tf];
    s.tf[tf] = own && own.length ? mergeUp(own, agg, DEFAULT_CAP[tf], TF_MS[tf]) : agg;
  }
  return s;
}

/** Broker candles first; append only what is strictly newer from `agg`. */
function mergeUp(broker, agg, cap, tfMs) {
  const out = broker.slice(-cap);
  let lastT = out.length ? out[out.length - 1].t : -Infinity;
  for (const c of agg) {
    if (c.t <= lastT) continue;
    out.push({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c });
    lastT = c.t;
  }
  trim(out, cap);
  out.__tfMs = tfMs || broker.__tfMs || TF_MS.m5;
  return out;
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
      pretty: s.pretty || prettyName(s.sym),
      assetClass: s.assetClass || 'unknown',
      otc: !!s.otc,
      source: s.source,
      price: Number.isFinite(s.price) ? s.price : null,
      ts: s.ts,
      payout: s.payout,
      ticks: s.tickCount,
      bars: s.tf.m1.length,
      // Candles the broker itself sent (they are the broker's chart), and how
      // many history rows we have ever stored for this pair. Both are shown in
      // Diagnostics: "0 broker bars while the site shows candles" is the
      // difference between a feed problem and a parsing problem.
      brokerTf: s.brokerLastTf || null,
      brokerBars: Object.values(s.broker || {}).reduce((a, l) => a + (l ? l.length : 0), 0),
      historyRows: s.historyRows || 0,
      stale: isStale(s),
      selected: protectedSyms.has(s.sym),
    }))
    .sort((a, b) => (a.stale - b.stale) || b.ticks - a.ticks || a.sym.localeCompare(b.sym));
}

/* --------------------------- snapshot I/O ---------------------------- */

export function serialize({ limit = PERSIST_SYMBOLS, bars = PERSIST_CANDLES } = {}) {
  const all = [...symbols.values()];
  // Protected symbols go first. Sorting purely by recency meant a pair the
  // user was watching but that had gone quiet (a forex pair over the
  // weekend, say) could fall outside the limit and lose its history on the
  // next worker restart.
  const ordered = all
    .sort((a, b) => (protectedSyms.has(b.sym) - protectedSyms.has(a.sym)) || b.lastTickAt - a.lastTickAt)
    .slice(0, Math.max(limit, protectedSyms.size));
  const out = {};
  for (const s of ordered) {
    out[s.sym] = {
      source: s.source,
      assetClass: s.assetClass,
      otc: !!s.otc,
      declaredType: s.declaredType,
      price: Number.isFinite(s.price) ? s.price : null,
      ts: s.ts,
      payout: s.payout,
      payoutAt: s.payoutAt,
      tickCount: s.tickCount,
      lastTickAt: s.lastTickAt,
      m1: compact(s.tf.m1.slice(-bars)),
      // Broker candles are not derivable from m1 (that is the whole point of
      // keeping them apart), so losing them across a worker restart would
      // blank the chart the user is actually watching.
      broker: brokerRows(s, bars),
    };
  }
  return { v: 8, at: Date.now(), symbols: out };
}

/** {m5: [[t,o,h,l,c],...], m15: [...]} — only the timeframes we hold. */
function brokerRows(s, bars) {
  const out = {};
  for (const [tf, list] of Object.entries(s.broker || {})) {
    if (list && list.length) out[tf] = compact(list.slice(-bars));
  }
  return Object.keys(out).length ? out : null;
}

export function deserialize(snap) {
  if (!snap || !snap.symbols) return 0;
  let n = 0;
  for (const [sym, data] of Object.entries(snap.symbols)) {
    const key = canonical(sym);
    if (!key) continue;
    const s = ensureSymbol(key, data.source || LIVE_SOURCE, {
      type: data.declaredType || undefined,
      otc: typeof data.otc === 'boolean' ? data.otc : undefined,
    }, { force: true }); // restoring our own snapshot is not a foreign write
    if (!s) continue;
    // Snapshots written by an older build can hold the same instrument under
    // two spellings ("EURUSD_OTC" and "EUR/USD_OTC"). Both canonicalise to
    // one key, so their candles are merged rather than letting whichever
    // came second overwrite the first.
    mergeSeries(s, expand(data.m1));
    adoptBroker(s, data.broker);
    healSeries(s);
    refreshDerived(key);
    s.price = Number.isFinite(data.price) ? data.price : s.price;
    s.ts = data.ts || s.ts;
    s.payout = data.payout ?? s.payout;
    s.payoutAt = data.payoutAt || s.payoutAt;
    s.tickCount = data.tickCount || s.tickCount;
    s.lastTickAt = data.lastTickAt || s.lastTickAt;
    n++;
  }
  return n;
}

/** Restore the broker's own candles from a snapshot (v8 and later). */
function adoptBroker(s, broker) {
  if (!broker || typeof broker !== 'object') return 0;
  let n = 0;
  for (const [tf, rows] of Object.entries(broker)) {
    if (!TF_MS[tf] || tf === 'm1' || !Array.isArray(rows) || !rows.length) continue;
    const list = s.broker[tf] || makeSeries(TF_MS[tf]);
    for (const c of expand(rows)) if (upsertCandle(list, c, BROKER_CAP)) n++;
    if (list.length) s.broker[tf] = list;
  }
  if (n) {
    s.brokerAt = Date.now();
    diag.brokerRows += n;
  }
  return n;
}

/**
 * Unpick a series built by a build that did not know the broker's timeframe.
 *
 * Snapshots written before v8 can hold the broker's 5- and 15-minute candles
 * inside the m1 series, because every history block used to be filed as
 * 1-minute data. Those bars are moved to the timeframe they belong to, so a
 * restored session does not keep computing indicators on a series that is not
 * what it claims to be. Only runs of consecutive same-spacing bars are moved
 * (see sync.splitCoarseRuns), so a genuine m1 series with gaps is untouched.
 */
function healSeries(s) {
  const { m1, coarse } = splitCoarseRuns(s.tf.m1, { minRun: 4 });
  const moved = coarse.m5.length + coarse.m15.length;
  if (!moved) return 0;
  const clean = makeSeries(TF_MS.m1);
  for (const c of m1) upsertCandle(clean, c, DEFAULT_CAP.m1);
  s.tf.m1 = clean;
  for (const tf of ['m15', 'm5']) {
    const run = coarse[tf];
    if (!run.length) continue;
    const list = s.broker[tf] || makeSeries(TF_MS[tf]);
    for (const c of run) upsertCandle(list, c, BROKER_CAP);
    s.broker[tf] = list;
  }
  s.brokerAt = Date.now();
  diag.repaired = (diag.repaired || 0) + moved;
  return moved;
}

/** Union two candle sets into the symbol's m1 series, newest-wins per bar. */
function mergeSeries(s, rows) {
  if (!rows || !rows.length) return;
  if (!s.tf.m1.length) {
    s.tf.m1 = makeSeries(TF_MS.m1);
    for (const c of rows) upsertCandle(s.tf.m1, c, DEFAULT_CAP.m1);
    return;
  }
  const byT = new Map();
  for (const c of [...s.tf.m1, ...rows]) {
    const prev = byT.get(c.t);
    if (!prev) byT.set(c.t, { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c });
    else {
      prev.h = Math.max(prev.h, c.h);
      prev.l = Math.min(prev.l, c.l);
      prev.c = c.c;
    }
  }
  const merged = [...byT.values()].sort((a, b) => a.t - b.t).slice(-DEFAULT_CAP.m1);
  s.tf.m1 = makeSeries(TF_MS.m1);
  for (const c of merged) upsertCandle(s.tf.m1, c, DEFAULT_CAP.m1);
}

/** Trim every series back to its cap — call from the housekeeping alarm. */
export function housekeep() {
  for (const s of symbols.values()) {
    trim(s.tf.m1, DEFAULT_CAP.m1);
    trim(s.tf.m5, DEFAULT_CAP.m5);
    trim(s.tf.m15, DEFAULT_CAP.m15);
    for (const list of Object.values(s.broker || {})) trim(list, BROKER_CAP);
  }
}

/**
 * Drop symbols that have been silent for `ms`.
 *
 * Protected symbols are exempt. The old guard compared against `selected`,
 * which was always null because setSelected() was never called from
 * anywhere — so the pair being watched was pruned exactly like any other,
 * taking its whole candle history with it.
 */
export function pruneStale(ms = 2 * 60 * 60 * 1000) {
  const now = Date.now();
  let removed = 0;
  for (const s of [...symbols.values()]) {
    if (protectedSyms.has(s.sym)) continue;
    if (s.lastTickAt && now - s.lastTickAt > ms) {
      symbols.delete(s.sym);
      removed++;
    }
  }
  if (removed) diag.pruned = (diag.pruned || 0) + removed;
  return removed;
}

export let selected = null;

/**
 * Mark the instrument the user is watching. It is now immune to eviction
 * and pruning. Returns the canonical key, so callers can store exactly the
 * key the data lives under.
 */
export function setSelected(sym) {
  const key = sym ? canonical(sym) : '';
  if (selected && selected !== key) protectedSyms.delete(selected);
  selected = key || null;
  if (selected) protectedSyms.add(selected);
  return selected;
}

/**
 * Symbols carrying an open paper trade must not be dropped either — losing
 * their price series means the trade can never settle, and an unsettled
 * trade blocks every future trade on that pair.
 */
export function protectOpen(syms) {
  const keep = new Set([selected].filter(Boolean));
  for (const s of syms || []) {
    const k = canonical(s);
    if (k) keep.add(k);
  }
  for (const k of [...protectedSyms]) if (!keep.has(k)) protectedSyms.delete(k);
  for (const k of keep) protectedSyms.add(k);
  return protectedSyms.size;
}

export function isProtected(sym) {
  return protectedSyms.has(canonical(sym));
}
