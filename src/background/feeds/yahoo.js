/* ------------------------------------------------------------------
 * feeds/yahoo.js — FX fallback via the public Yahoo chart endpoint.
 *
 * Yahoo rate-limits aggressively, so this feed is polled one symbol at a
 * time on a slow rotation and is always labelled "delayed proxy" in the
 * UI. It exists so the strategy engine has *something* to chew on when no
 * Quotex tab is open — never as a substitute for the real feed.
 * ----------------------------------------------------------------*/

import * as store from '../store.js';
import { upsertCandle, aggregate, DEFAULT_CAP, TF_MS } from '../candles.js';

export const FX = {
  'EUR/USD': 'EURUSD=X',
  'GBP/USD': 'GBPUSD=X',
  'USD/JPY': 'USDJPY=X',
  'USD/CAD': 'USDCAD=X',
  'USD/CHF': 'USDCHF=X',
  'AUD/USD': 'AUDUSD=X',
  'NZD/USD': 'NZDUSD=X',
  'EUR/JPY': 'EURJPY=X',
  'GBP/JPY': 'GBPJPY=X',
  'EUR/GBP': 'EURGBP=X',
  'AUD/JPY': 'AUDJPY=X',
  'CAD/JPY': 'CADJPY=X',
};

const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

function rowsFrom(chart) {
  const res = chart?.chart?.result?.[0];
  if (!res) return [];
  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if ([o, h, l, c].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      out.push({ t: ts[i] * 1000, o, h, l, c });
    }
  }
  return out;
}

export async function poll(pair, { signal } = {}) {
  const sym = FX[pair];
  if (!sym) return false;
  let lastErr = null;
  for (const host of HOSTS) {
    try {
      const r = await fetch(`${host}/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`, {
        cache: 'no-store',
        signal,
      });
      if (!r.ok) {
        lastErr = new Error(`HTTP ${r.status}`);
        continue;
      }
      const rows = rowsFrom(await r.json());
      if (!rows.length) {
        lastErr = new Error('no rows');
        continue;
      }
      const s = store.ensureSymbol(pair, 'yahoo');
      for (const c of rows) upsertCandle(s.tf.m1, c, DEFAULT_CAP.m1);
      s.tf.m5 = aggregate(s.tf.m1, TF_MS.m5, DEFAULT_CAP.m5);
      s.tf.m15 = aggregate(s.tf.m1, TF_MS.m15, DEFAULT_CAP.m15);
      const last = rows[rows.length - 1];
      s.price = last.c;
      s.ts = last.t;
      s.lastTickAt = Date.now();
      store.diag.restPolls++;
      return true;
    } catch (e) {
      lastErr = e;
    }
  }
  store.noteError(`yahoo ${pair}: ${lastErr?.message || lastErr}`);
  return false;
}

/** Least-recently-polled FX pair — used to rotate fairly. */
export function nextPair(lastPoll = {}) {
  const keys = Object.keys(FX);
  let pick = keys[0];
  let oldest = Infinity;
  for (const k of keys) {
    const t = lastPoll[k] || 0;
    if (t < oldest) {
      oldest = t;
      pick = k;
    }
  }
  return pick;
}
