/* ------------------------------------------------------------------
 * patterns.js — candlestick anatomy, swing pivots, market structure and
 * support/resistance levels. Pure functions only; `strategy.js` turns
 * these into scored signals.
 * ----------------------------------------------------------------*/

export const body = (c) => Math.abs(c.c - c.o);
export const range = (c) => c.h - c.l || 1e-9;
export const upperWick = (c) => c.h - Math.max(c.o, c.c);
export const lowerWick = (c) => Math.min(c.o, c.c) - c.l;
export const isBull = (c) => c.c > c.o;
export const isBear = (c) => c.c < c.o;
export const bodyPct = (c) => (body(c) / range(c)) * 100;

/** Where inside its own range the candle closed: 0 = at the low, 1 = at the high. */
export const closePosition = (c) => (c.c - c.l) / range(c);

/* ----------------------------- patterns ---------------------------- */

export function detectPatterns(candles) {
  const out = [];
  const n = candles.length;
  if (n < 3) return out;
  const c1 = candles[n - 1];
  const c2 = candles[n - 2];
  const c3 = candles[n - 3];
  const R = range(c1);
  const B = body(c1);

  const strong = B >= 0.55 * R;
  const tinyBody = B <= 0.12 * R;

  if (lowerWick(c1) >= 1.6 * B && closePosition(c1) >= 0.7 && B > 0.04 * R) {
    out.push({ name: 'Hammer / bullish pin', dir: 'up', weight: 3 });
  }
  if (upperWick(c1) >= 1.6 * B && closePosition(c1) <= 0.3 && B > 0.04 * R) {
    out.push({ name: 'Shooting star / bearish pin', dir: 'down', weight: 3 });
  }
  if (tinyBody && R > 0) {
    out.push({ name: 'Doji — indecision', dir: null, weight: 0, note: 'wait for the next close' });
  }
  const bullEngulf = isBear(c2) && isBull(c1) && c1.c >= c2.o && c1.o <= c2.c && body(c1) > body(c2);
  const bearEngulf = isBull(c2) && isBear(c1) && c1.c <= c2.o && c1.o >= c2.c && body(c1) > body(c2);
  if (bullEngulf) out.push({ name: 'Bullish engulfing', dir: 'up', weight: strong ? 3 : 2 });
  if (bearEngulf) out.push({ name: 'Bearish engulfing', dir: 'down', weight: strong ? 3 : 2 });

  const inside = c1.h <= c2.h && c1.l >= c2.l;
  if (inside) out.push({ name: 'Inside bar — compression', dir: null, weight: 0 });

  if (isBull(c3) && isBull(c2) && isBull(c1) && c1.c > c2.c && c2.c > c3.c && body(c3) > 0.5 * range(c3)) {
    out.push({ name: 'Three white soldiers', dir: 'up', weight: 2 });
  }
  if (isBear(c3) && isBear(c2) && isBear(c1) && c1.c < c2.c && c2.c < c3.c && body(c3) > 0.5 * range(c3)) {
    out.push({ name: 'Three black crows', dir: 'down', weight: 2 });
  }

  // Fakey: a bar that sweeps the previous bar's extreme then closes back inside.
  if (c1.l < c2.l && c1.c > c2.l && closePosition(c1) > 0.65) {
    out.push({ name: 'Fakey (low sweep)', dir: 'up', weight: 2 });
  }
  if (c1.h > c2.h && c1.c < c2.h && closePosition(c1) < 0.35) {
    out.push({ name: 'Fakey (high sweep)', dir: 'down', weight: 2 });
  }
  return out;
}

/* ------------------------------ pivots ----------------------------- */

/**
 * Fractal swing points: a high that is higher than `k` bars either side.
 * Returns {i,t,price,type:'H'|'L'} sorted by time.
 */
export function pivots(candles, k = 2) {
  const out = [];
  if (!candles || candles.length < k * 2 + 1) return out;
  for (let i = k; i < candles.length - k; i++) {
    let isH = true;
    let isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isH = false;
      if (candles[j].l <= candles[i].l) isL = false;
    }
    if (isH) out.push({ i, t: candles[i].t, price: candles[i].h, type: 'H' });
    else if (isL) out.push({ i, t: candles[i].t, price: candles[i].l, type: 'L' });
  }
  return out;
}

/** Cluster nearby pivots into levels, strongest first. */
export function levels(candles, atrValue, { lookback = 24, tolerance = 0.35 } = {}) {
  const pv = pivots(candles, 2).slice(-lookback);
  if (!atrValue || !pv.length) return [];
  const tol = tolerance * atrValue;
  const buckets = [];
  for (const p of pv) {
    const hit = buckets.find((b) => Math.abs(b.price - p.price) <= tol);
    if (hit) {
      hit.touches += 1;
      hit.price = (hit.price * (hit.touches - 1) + p.price) / hit.touches;
      hit.last = Math.max(hit.last, p.t);
      hit.types.add(p.type);
    } else {
      buckets.push({ price: p.price, touches: 1, last: p.t, types: new Set([p.type]) });
    }
  }
  return buckets
    .map((b) => ({
      price: b.price,
      touches: b.touches,
      last: b.last,
      kind: b.types.size > 1 ? 'both' : [...b.types][0] === 'H' ? 'resistance' : 'support',
    }))
    .sort((a, b) => b.touches - a.touches || b.last - a.last);
}

/** Nearest level within `maxDist`, or null. */
export function nearestLevel(price, lvls, maxDist) {
  let best = null;
  for (const l of lvls || []) {
    const d = Math.abs(price - l.price);
    if (d <= maxDist && (!best || d < best.d)) best = { level: l, d };
  }
  return best;
}

/* --------------------------- structure ----------------------------- */

/** 'up' | 'down' | 'range' | 'warming' from the last two swing highs/lows. */
export function structure(candles, atrValue) {
  const pv = pivots(candles, 2);
  const hs = pv.filter((p) => p.type === 'H').slice(-2);
  const ls = pv.filter((p) => p.type === 'L').slice(-2);
  if (hs.length < 2 || ls.length < 2 || !atrValue) return 'warming';
  const tol = 0.15 * atrValue;
  const higherHighs = hs[1].price > hs[0].price + tol;
  const higherLows = ls[1].price > ls[0].price + tol;
  const lowerHighs = hs[1].price < hs[0].price - tol;
  const lowerLows = ls[1].price < ls[0].price - tol;
  if (higherHighs && higherLows) return 'up';
  if (lowerHighs && lowerLows) return 'down';
  return 'range';
}

/**
 * Break-and-retest detection over the last `window` bars.
 * Returns 'up' | 'down' | null for the most recent valid retest of `level`.
 */
export function breakAndRetest(candles, level, atrValue, window = 8) {
  const n = candles.length;
  if (n < 4 || !atrValue) return null;
  const band = 0.2 * atrValue;
  const reach = 0.7 * atrValue;
  const last = candles[n - 1];

  for (let j = Math.max(1, n - window); j < n; j++) {
    // bullish break: close above, hold above, then pull back to the level
    if (candles[j].c > level + band) {
      let held = true;
      for (let m = j + 1; m < n - 1; m++) if (candles[m].c < level - band) held = false;
      if (held && last.l <= level + reach && last.c > level && isBull(last)) return 'up';
    }
    if (candles[j].c < level - band) {
      let held = true;
      for (let m = j + 1; m < n - 1; m++) if (candles[m].c > level + band) held = false;
      if (held && last.h >= level - reach && last.c < level && isBear(last)) return 'down';
    }
  }
  return null;
}

/** Session VWAP anchored at the start of the provided window. */
export function vwap(candles) {
  let pv = 0;
  let vol = 0;
  const out = [];
  for (const c of candles || []) {
    const typical = (c.h + c.l + c.c) / 3;
    const v = c.v && c.v > 0 ? c.v : 1;
    pv += typical * v;
    vol += v;
    out.push(vol ? pv / vol : typical);
  }
  return out;
}
