/* ------------------------------------------------------------------
 * feeds/binance.js — public klines REST fallback (no API key).
 * data-api.binance.vision is the read-only public mirror, so this works
 * from a service worker without any CORS proxy.
 * ----------------------------------------------------------------*/

import * as store from '../store.js';
import { upsertCandle, DEFAULT_CAP } from '../candles.js';
import { canonical } from '../symbols.js';

/**
 * Pair -> Binance symbol.
 *
 * Two honest caveats, both reflected in the UI:
 *  - every quote here is USDT, while a broker's "BTC/USD" is USD. The two
 *    prices differ, which is one more reason a proxy may never write into a
 *    series the broker owns (see store.ensureSymbol).
 *  - XAU/USD is proxied by PAXG, a tokenised gold claim, not spot metal.
 *    It tracks closely; it is not the same instrument.
 */
export const CRYPTO = {
  'BTC/USD': 'BTCUSDT',
  'ETH/USD': 'ETHUSDT',
  'SOL/USD': 'SOLUSDT',
  'BNB/USD': 'BNBUSDT',
  'XRP/USD': 'XRPUSDT',
  'XAU/USD': 'PAXGUSDT',
  'ADA/USD': 'ADAUSDT',
  'DOGE/USD': 'DOGEUSDT',
  'LTC/USD': 'LTCUSDT',
  'DOT/USD': 'DOTUSDT',
  'TRX/USD': 'TRXUSDT',
  'AVAX/USD': 'AVAXUSDT',
  'LINK/USD': 'LINKUSDT',
  'MATIC/USD': 'MATICUSDT',
  'SHIB/USD': '1000SHIBUSDT',
  'UNI/USD': 'UNIUSDT',
  'ATOM/USD': 'ATOMUSDT',
  'XLM/USD': 'XLMUSDT',
  'ETC/USD': 'ETCUSDT',
  'XMR/USD': 'XMRUSDT',
  'BCH/USD': 'BCHUSDT',
  'FIL/USD': 'FILUSDT',
  'NEAR/USD': 'NEARUSDT',
  'APT/USD': 'APTUSDT',
  'ARB/USD': 'ARBUSDT',
  'OP/USD': 'OPUSDT',
  'AAVE/USD': 'AAVEUSDT',
  'ALGO/USD': 'ALGOUSDT',
  'SAND/USD': 'SANDUSDT',
  'MANA/USD': 'MANAUSDT',
  'PEPE/USD': '1000PEPEUSDT',
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
  // null means the live broker already owns this pair, and a delayed proxy
  // must not write into its series.
  const s = store.ensureSymbol(pair, 'binance');
  if (!s) return 0;
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
/**
 * How many not-yet-seen pairs to discover per cycle.
 *
 * The fallback list grew from 6 to 30+ pairs. Polling all of it every 30s
 * meant 30 concurrent REST calls, plus a store symbol manufactured for every
 * pair the user never opened — half the 64-symbol cap spent on charts nobody
 * looked at, crowding out the ones actually on screen. So: pairs we already
 * hold are always refreshed, and the unseen tail is rotated through.
 */
const DISCOVER = 6;
let cursor = 0;

/** Pairs worth a REST call right now: everything we hold, plus a rotating
 *  slice of the fallback list we have not seen yet. */
export function pairsToPoll() {
  const all = Object.keys(CRYPTO);
  const held = new Set(store.listSymbols().map((x) => x.sym));
  const known = all.filter((p) => held.has(canonical(p)));
  const unseen = all.filter((p) => !held.has(canonical(p)));
  if (!unseen.length) {
    cursor = 0;
    return known;
  }
  const start = cursor % unseen.length;
  cursor = (start + DISCOVER) % unseen.length;
  const rotated = [...unseen.slice(start), ...unseen.slice(0, start)].slice(0, DISCOVER);
  return [...known, ...rotated];
}

export async function poll(pair, { signal } = {}) {
  const sym = CRYPTO[pair];
  if (!sym) return false;
  try {
    const r = await fetch(`${BASE}?symbol=${sym}&interval=1m&limit=2`, { cache: 'no-store', signal });
    // Report HTTP failures rather than returning false silently: a 451
    // geo-block or a 418 IP ban disables this fallback for good, and a chart
    // that simply stops updating gives the user nothing to diagnose it with.
    if (!r.ok) {
      store.noteError(`binance ${pair}: HTTP ${r.status}`);
      return false;
    }
    const arr = await r.json();
    if (!Array.isArray(arr)) {
      store.noteError(`binance ${pair}: bad payload`);
      return false;
    }
    const s = store.ensureSymbol(pair, 'binance');
    if (!s) return false; // the broker is streaming this pair; stand down
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
