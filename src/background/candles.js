/* ------------------------------------------------------------------
 * candles.js — timeframe aggregation + ring-buffer candle series
 *
 * A Candle is always {t,o,h,l,c} where t is the OPEN time of the bar in
 * epoch milliseconds. Everything here is pure + side-effect free except
 * the explicitly mutating helpers (pushTick/upsertCandle), which are the
 * only place candles are ever written.
 * ----------------------------------------------------------------*/

export const TF_MS = { m1: 60_000, m5: 300_000, m15: 900_000, m30: 1_800_000 };
export const DEFAULT_CAP = { m1: 600, m5: 400, m15: 300, m30: 240 };

export const bucketOf = (ts, tfMs) => Math.floor(ts / tfMs) * tfMs;

export const isCandle = (c) =>
  !!c &&
  typeof c === 'object' &&
  [c.t, c.o, c.h, c.l, c.c].every((v) => typeof v === 'number' && Number.isFinite(v));

export function lastOf(arr) {
  return arr && arr.length ? arr[arr.length - 1] : null;
}

/** Drop everything but the newest `cap` candles, in place. */
export function trim(arr, cap) {
  if (Array.isArray(arr) && cap > 0 && arr.length > cap) arr.splice(0, arr.length - cap);
  return arr;
}

/**
 * Merge one finished (or partial) candle into a sorted series.
 * - same bucket  -> update h/l/c in place
 * - newer bucket -> append
 * - older bucket -> ignored (late data cannot rewrite history here)
 * Returns true when the series changed.
 */
export function upsertCandle(arr, c, cap = 0) {
  if (!isCandle(c)) return false;
  const last = lastOf(arr);
  if (last && c.t === last.t) {
    if (c.h > last.h) last.h = c.h;
    if (c.l < last.l) last.l = c.l;
    last.c = c.c;
    return true;
  }
  if (!last || c.t > last.t) {
    arr.push({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c });
    if (cap > 0) trim(arr, cap);
    return true;
  }
  return false;
}

/**
 * Feed a raw tick into a series, creating/extending the bar that owns `ts`.
 *
 * The series must stay sorted — `lastOf`, `aggregate`, the engine's "last
 * closed bar" and the chart all assume `arr[i].t` increases. A tick that
 * arrives late (the socket delivered it out of order, or it carried a clock a
 * few seconds behind) belongs to an OLDER bucket, and appending it produced a
 * bar at the end whose timestamp was in the past: the newest candle stopped
 * being the last one, and aggregating the series to 5m emitted buckets that ran
 * backwards. So a late tick updates the bar that owns it when that bar is still
 * in the buffer (high/low only — its close is history and is not rewritten) and
 * is otherwise dropped.
 */
export function pushTick(arr, price, ts = Date.now(), cap = 0) {
  if (!Number.isFinite(price) || price <= 0) return false;
  const t = normaliseTs(ts);
  const b = bucketOf(t, TF_MS_OF(arr));
  const last = lastOf(arr);
  if (!last || b > last.t) {
    arr.push({ t: b, o: price, h: price, l: price, c: price });
    if (cap > 0) trim(arr, cap);
    return true;
  }
  if (b === last.t) {
    if (price > last.h) last.h = price;
    if (price < last.l) last.l = price;
    last.c = price;
    return true;
  }
  // Older than the newest bar: fold it into its own bar if we still hold it.
  for (let i = arr.length - 2; i >= 0; i--) {
    const c = arr[i];
    if (c.t === b) {
      if (price > c.h) c.h = price;
      if (price < c.l) c.l = price;
      return true;
    }
    if (c.t < b) break; // sorted series: an exact match would have appeared already
  }
  return false;
}

/* pushTick needs the series' own bucket size; callers tag it once. */
function TF_MS_OF(arr) {
  return arr.__tfMs || 60_000;
}

/** Create a series array that pushTick() can aggregate into. */
export function makeSeries(tfMs = 60_000) {
  const arr = [];
  arr.__tfMs = tfMs;
  return arr;
}

export const normaliseTs = (ts) => {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n < 1e12 ? n * 1000 : n; // seconds -> ms
};

/**
 * Re-bucket a finer series into a coarser one.
 * aggregate(m1Candles, 300000) -> 5m candles.
 */
export function aggregate(src, tfMs, cap = 0) {
  const out = [];
  let cur = null;
  for (const c of src || []) {
    if (!isCandle(c)) continue;
    const b = bucketOf(c.t, tfMs);
    if (cur && cur.t === b) {
      if (c.h > cur.h) cur.h = c.h;
      if (c.l < cur.l) cur.l = c.l;
      cur.c = c.c;
    } else {
      if (cur) out.push(cur);
      cur = { t: b, o: c.o, h: c.h, l: c.l, c: c.c };
    }
  }
  if (cur) out.push(cur);
  return cap > 0 ? trim(out, cap) : out;
}

/** Build every timeframe in TF_MS from a single m1 source. */
export function deriveAll(m1, caps = DEFAULT_CAP) {
  const out = { m1: m1 ? trim(m1.slice(), caps.m1) : [] };
  for (const tf of ['m5', 'm15', 'm30']) {
    out[tf] = aggregate(out.m1, TF_MS[tf], caps[tf]);
  }
  return out;
}

/** Close-only series, for indicator maths. */
export const closes = (arr) => (arr || []).map((c) => c.c);
export const highs = (arr) => (arr || []).map((c) => c.h);
export const lows = (arr) => (arr || []).map((c) => c.l);

/* --- compact wire/storage format: [t,o,h,l,c] rounds prices to 8dp --- */
export const compact = (arr) =>
  (arr || []).map((c) => [c.t, r8(c.o), r8(c.h), r8(c.l), r8(c.c)]);

export function expand(rows) {
  const out = [];
  for (const r of rows || []) {
    if (!Array.isArray(r) || r.length < 5) continue;
    const c = { t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] };
    if (isCandle(c)) out.push(c);
  }
  return out;
}

function r8(n) {
  return Math.round(n * 1e8) / 1e8;
}

/** Number of decimals a price should be printed with, based on magnitude. */
export function precisionFor(price) {
  const p = Math.abs(price || 0);
  if (!Number.isFinite(p) || p === 0) return 5;
  if (p >= 1000) return 2;
  if (p >= 100) return 3;
  if (p >= 10) return 4;
  if (p >= 1) return 5;
  return 6;
}

export function formatPrice(price) {
  if (!Number.isFinite(price)) return '—';
  return price.toFixed(precisionFor(price));
}

/** Seconds remaining in the currently forming bar. */
export function secondsToClose(tf = 'm1', now = Date.now()) {
  const ms = TF_MS[tf] || TF_MS.m1;
  return Math.max(0, Math.ceil((bucketOf(now, ms) + ms - now) / 1000));
}
