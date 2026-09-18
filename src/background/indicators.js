/* ------------------------------------------------------------------
 * indicators.js — pure technical indicators.
 *
 * Every function takes plain number[] (usually closes) and returns an
 * array of the SAME length, padded with `null` where the indicator is
 * not yet defined. That keeps index alignment with the candle array, so
 * callers can do `ema[i]` next to `candles[i]` without bookkeeping.
 * ----------------------------------------------------------------*/

const align = (out, n) => {
  while (out.length < n) out.unshift(null);
  return out;
};

export function sma(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (period <= 0 || n < period) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (period <= 0 || n === 0) return out;
  const k = 2 / (period + 1);
  // Seed with the SMA of the first `period` values so the result is
  // deterministic regardless of how much history we happen to hold.
  if (n < period) {
    let p = values[0];
    for (let i = 1; i < n; i++) {
      p = values[i] * k + p * (1 - k);
      out[i] = p;
    }
    return out;
  }
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let p = seed / period;
  out[period - 1] = p;
  for (let i = period; i < n; i++) {
    p = values[i] * k + p * (1 - k);
    out[i] = p;
  }
  return out;
}

/** Wilder-smoothed RSI. Returns 50-ish neutral when there is no data. */
export function rsi(values, period = 14) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  let ag = gain / period;
  let al = loss / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < n; i++) {
    const d = values[i] - values[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

/** True Range series (index 0 = high-low). */
export function trueRange(candles) {
  return (candles || []).map((c, i) => {
    if (i === 0) return c.h - c.l;
    const pc = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  });
}

/** Wilder-smoothed ATR, aligned to the candle array. */
export function atr(candles, period = 14) {
  const tr = trueRange(candles || []);
  const n = tr.length;
  const out = new Array(n).fill(null);
  if (n < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let a = sum / period;
  out[period - 1] = a;
  for (let i = period; i < n; i++) {
    a = (a * (period - 1) + tr[i]) / period;
    out[i] = a;
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  const n = values.length;
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const line = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (ef[i] != null && es[i] != null) line[i] = ef[i] - es[i];
  }
  const compact = line.filter((v) => v != null);
  const sig = ema(compact, signal);
  const sigFull = new Array(n).fill(null);
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (line[i] != null) {
      sigFull[i] = sig[j] ?? null;
      j++;
    }
  }
  const hist = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (line[i] != null && sigFull[i] != null) hist[i] = line[i] - sigFull[i];
  }
  return { macd: line, signal: sigFull, hist };
}

export function bollinger(values, period = 20, mult = 2) {
  const n = values.length;
  const mid = sma(values, period);
  const up = new Array(n).fill(null);
  const low = new Array(n).fill(null);
  const width = new Array(n).fill(null);
  const pctB = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    const m = s / period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j] - m) ** 2;
    const sd = Math.sqrt(v / period);
    up[i] = m + mult * sd;
    low[i] = m - mult * sd;
    mid[i] = m;
    width[i] = m ? (up[i] - low[i]) / m : null;
    pctB[i] = up[i] === low[i] ? 0.5 : (values[i] - low[i]) / (up[i] - low[i]);
  }
  return { mid, upper: up, lower: low, width, pctB };
}

export function stochastic(candles, kPeriod = 14, dPeriod = 3) {
  const n = (candles || []).length;
  const k = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].h > hh) hh = candles[j].h;
      if (candles[j].l < ll) ll = candles[j].l;
    }
    k[i] = hh === ll ? 50 : ((candles[i].c - ll) / (hh - ll)) * 100;
  }
  const compact = k.map((v, i) => (v == null ? null : { i, v })).filter((x) => x);
  const ds = sma(compact.map((x) => x.v), dPeriod);
  const d = new Array(n).fill(null);
  compact.forEach((x, idx) => (d[x.i] = ds[idx] ?? null));
  return { k, d };
}

/** Wilder ADX + directional indicators. */
export function adx(candles, period = 14) {
  const n = (candles || []).length;
  const out = { adx: new Array(n).fill(null), pdi: new Array(n).fill(null), mdi: new Array(n).fill(null) };
  if (n < period + 1) return out;
  const tr = trueRange(candles);
  let pdm = 0;
  let mdm = 0;
  let trSum = 0;
  const dx = [];
  for (let i = 1; i < n; i++) {
    const up = candles[i].h - candles[i - 1].h;
    const dn = candles[i - 1].l - candles[i].l;
    const pd = up > dn && up > 0 ? up : 0;
    const md = dn > up && dn > 0 ? dn : 0;
    const range = tr[i];
    if (i <= period) {
      pdm += pd;
      mdm += md;
      trSum += range;
      if (i === period) {
        const p = trSum ? (pdm / trSum) * 100 : 0;
        const m = trSum ? (mdm / trSum) * 100 : 0;
        out.pdi[i] = p;
        out.mdi[i] = m;
        dx.push(p + m === 0 ? 0 : (Math.abs(p - m) / (p + m)) * 100);
      }
      continue;
    }
    pdm = pdm - pdm / period + pd;
    mdm = mdm - mdm / period + md;
    trSum = trSum - trSum / period + range;
    const p = trSum ? (pdm / trSum) * 100 : 0;
    const m = trSum ? (mdm / trSum) * 100 : 0;
    out.pdi[i] = p;
    out.mdi[i] = m;
    dx.push(p + m === 0 ? 0 : (Math.abs(p - m) / (p + m)) * 100);
  }
  let a = null;
  for (let i = 0; i < dx.length; i++) {
    a = a == null ? dx[i] : (a * (period - 1) + dx[i]) / period;
    out.adx[period + i] = a;
  }
  return alignAdx(out, n);
}

function alignAdx(o, n) {
  for (const k of ['adx', 'pdi', 'mdi']) {
    while (o[k].length < n) o[k].push(null);
    o[k] = o[k].slice(0, n);
  }
  return o;
}

/** Simple linear-regression slope of the last `n` values (per bar). */
export function slope(values, n = 5) {
  if (!values || values.length < n) return 0;
  const v = values.slice(-n);
  const m = v.length;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < m; i++) {
    sx += i;
    sy += v[i];
    sxy += i * v[i];
    sxx += i * i;
  }
  const den = m * sxx - sx * sx;
  return den === 0 ? 0 : (m * sxy - sx * sy) / den;
}

export function highest(values, n) {
  if (!values || !values.length) return null;
  const v = values.slice(-n);
  return Math.max(...v);
}

export function lowest(values, n) {
  if (!values || !values.length) return null;
  const v = values.slice(-n);
  return Math.min(...v);
}

/** Percentage change over the last n bars. */
export function changePct(values, n = 1) {
  if (!values || values.length < n + 1) return 0;
  const a = values[values.length - 1 - n];
  const b = values[values.length - 1];
  return a ? ((b - a) / a) * 100 : 0;
}

export const last = (arr) => {
  if (!arr || !arr.length) return null;
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
};

export const prev = (arr, back = 1) => {
  if (!arr) return null;
  let seen = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] == null) continue;
    if (seen === back) return arr[i];
    seen++;
  }
  return null;
};

/** Round to a fixed number of decimals, null-safe. */
export const round = (v, dp = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);
