/* ------------------------------------------------------------------
 * feeds/binance.js — public klines REST fallback (no API key).
 * data-api.binance.vision is the read-only public mirror, so this works
 * from a service worker without any CORS proxy.
 * ----------------------------------------------------------------*/

import * as store from '../store.js';
import { upsertCandle, DEFAULT_CAP } from '../candles.js';

export const CRYPTO = {
  'BTC/USD': 'BTCUSDT',
  'ETH/USD': 'ETHUSDT',
  'SOL/USD': 'SOLUSDT',
  'BNB/USD': 'BNBUSDT',
  'XRP/USD': 'XRPUSDT',
  'XAU/USD': 'PAXGUSDT',
};

const BASE = 'https://data-api.binance.vision/api/v3/klines';

const row = (x) => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4] });
const valid = (c) => [c.t, c.o, c.h, c.l, c.c].every((v) => Number.isFinite(v));

export async function seed(pair, { limit = 500, signal } = {}) {
  const sym = CRYPTO[pair];
  if (!sym) return 0;
  const r = await fetch(`${BASE}?symbol=${sym}&interval=1m&limit=${limit}`, { cache: 'no-store', signal });
  if (!r.ok) throw new Error(`binance ${r.status}`);
  const arr = await r.json();
  if (!Array.isArray(arr)) throw new Error('binance bad payload');
  const s = store.ensureSymbol(pair, 'binance');
  let n = 0;
  for (const x of arr) {
    const c = row(x);
    if (valid(c) && upsertCandle(s.tf.m1, c, DEFAULT_CAP.m1)) n++;
  }
  const last = arr[arr.length - 1];
  if (last) {
    s.price = +last[4];
    s.ts = +last[0];
    s.lastTickAt = Date.now();
  }
  store.refreshDerived(pair);
  return n;
}

/** Cheap top-up: last 2 bars only. Called on the housekeeping alarm. */
export async function poll(pair, { signal } = {}) {
  const sym = CRYPTO[pair];
  if (!sym) return false;
  try {
    const r = await fetch(`${BASE}?symbol=${sym}&interval=1m&limit=2`, { cache: 'no-store', signal });
    if (!r.ok) return false;
    const arr = await r.json();
    if (!Array.isArray(arr)) return false;
    const s = store.ensureSymbol(pair, 'binance');
    for (const x of arr) {
      const c = row(x);
      if (valid(c)) upsertCandle(s.tf.m1, c, DEFAULT_CAP.m1);
    }
    const last = arr[arr.length - 1];
    if (last) {
      s.price = +last[4];
      s.ts = +last[0];
      s.lastTickAt = Date.now();
    }
    store.diag.restPolls++;
    return true;
  } catch (e) {
    store.noteError(`binance ${pair}: ${e?.message || e}`);
    return false;
  }
}
