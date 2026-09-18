/* ------------------------------------------------------------------
 * feeds/select.js — making "the user picked a pair" actually fetch data.
 *
 * The pair picker offered ~67 instruments and only one of them could ever
 * have data: the pair the broker happened to be streaming. Selecting any
 * other one wrote a name into settings and stopped there — no symbol was
 * created, no request was fired, and both pollers ignored the choice
 * (Binance rotates six unseen pairs per cycle, Yahoo polls exactly one pair
 * per minute oldest-first). So the panel showed an empty chart, a dash for
 * the price and "no data" for the signal, which reads as a broken extension
 * rather than as "nobody went and got it".
 *
 * This module owns that gap. It knows which REST fallback can serve a
 * canonical key, kicks one off the moment the key is selected, and — just as
 * importantly — says out loud when a pair CANNOT be fetched, because an OTC
 * instrument or a pair the broker owns has no external source at all and
 * pretending otherwise is how the user ends up staring at a blank chart.
 *
 * Nothing here touches settings.syncSite: following the site's chart is a
 * separate decision (sync.decideFollow) and stays exactly as it was.
 * ----------------------------------------------------------------*/

import * as store from '../store.js';
import { canonical, isOtc, pretty } from '../symbols.js';
import { CRYPTO, seed as binanceSeed } from './binance.js';
import { FX, poll as yahooPoll } from './yahoo.js';

/**
 * canonical key -> the REST fallback that can serve it.
 *
 * Built once, lazily. Crypto is written last so it wins XAU/USD, which both
 * lists claim: buildCatalog() puts it in the Binance group for the same
 * reason, and the picker must not offer one instrument under two feeds.
 */
let INDEX = null;
function index() {
  if (INDEX) return INDEX;
  INDEX = new Map();
  for (const pair of Object.keys(FX)) {
    const k = canonical(pair);
    if (k) INDEX.set(k, { source: 'yahoo', pair });
  }
  for (const pair of Object.keys(CRYPTO)) {
    const k = canonical(pair);
    if (k) INDEX.set(k, { source: 'binance', pair });
  }
  return INDEX;
}

/** Which fallback feed can serve this instrument, or null when none can. */
export function feedFor(sym) {
  const key = canonical(sym);
  return key ? index().get(key) || null : null;
}

/**
 * Why a selected pair does or does not have data.
 *
 * These codes are the whole contract with the UI: the panel and the HUD print
 * `text` verbatim, so a pair that cannot be fed explains itself instead of
 * showing a blank chart.
 *
 * @typedef {'broker-live'|'broker-idle'|'otc-site-only'|'proxy-live'|'proxy-stale'|'proxy-cold'|'no-source'} Reason
 */

/** Human-readable form of each reason. `p` is the pretty pair name. */
const TEXT = {
  'broker-live': (p) => `${p} is streaming from the site right now — this is the broker's own live feed.`,
  'broker-idle': (p) =>
    `${p} belongs to the site, which has not streamed it recently. Open that chart on the site to revive it; a delayed proxy is deliberately not mixed into broker data.`,
  'otc-site-only': (p) =>
    `${p} is broker-generated (OTC), so no external feed exists for it. Only the site can stream this pair — open its chart there.`,
  'proxy-live': (p, src) => `${p} is on the delayed ${src} proxy — the site does not stream this pair, so this is not the broker's price.`,
  'proxy-stale': (p, src) => `${p} went quiet; refreshing it from ${src}…`,
  'proxy-cold': (p, src) => `${p} has no data yet; fetching its history from ${src}…`,
  'no-source': (p) => `${p} is not in any feed this extension knows. It can only appear if the site streams it.`,
};

/** Reasons whose answer is "go and fetch it now". */
const FETCHABLE = new Set(['proxy-cold', 'proxy-stale']);

/** Keys with a request in flight, so a burst of clicks cannot stack them. */
const inflight = new Set();

/** When each key was last fetched by a selection, for the UI's "just now". */
const fetchedAt = new Map();

/**
 * Notifier installed by index.js — the same injection pattern feeds/quotex.js
 * uses for setSiteChartHandler, so this module never imports the worker that
 * imports it.
 */
let notify = null;
export function setSelectionNotifier(fn) {
  notify = typeof fn === 'function' ? fn : null;
}

/**
 * Describe a pair's feed situation without changing anything.
 *
 * @param {string|null} sym
 * @returns {{sym:string, feed:string|null, reason:Reason, text:string,
 *   pending:boolean, bars:number, stale:boolean, source:string|null,
 *   fetchedAt:number}|null}
 */
export function describe(sym) {
  const key = canonical(sym);
  if (!key) return null;
  const s = store.getSymbol(key);
  const hit = feedFor(key);
  const brokerOwned = !!s && s.source === 'quotex';

  let reason;
  if (brokerOwned) reason = store.isStale(s) ? 'broker-idle' : 'broker-live';
  else if (isOtc(key)) reason = 'otc-site-only';
  else if (!hit) reason = 'no-source';
  else if (!s) reason = 'proxy-cold';
  else reason = store.isStale(s) ? 'proxy-stale' : 'proxy-live';

  return {
    sym: key,
    feed: brokerOwned ? 'quotex' : hit ? hit.source : null,
    reason,
    text: TEXT[reason](pretty(key), hit ? hit.source : ''),
    pending: inflight.has(key),
    bars: s ? s.tf.m1.length : 0,
    stale: s ? store.isStale(s) : true,
    source: s ? s.source : null,
    fetchedAt: fetchedAt.get(key) || 0,
  };
}

/**
 * The user selected `sym`: describe it, and fetch it when a feed can serve it.
 *
 * The fetch is deliberately NOT awaited. `symbols.select` answers a UI message
 * and the caller renders within a second; a 500-bar REST call must not hold
 * that reply hostage. When it lands, the notifier pushes fresh state out, so
 * the chart fills in on its own — the same path market data already uses.
 *
 * @returns {ReturnType<typeof describe>}
 */
export function request(sym) {
  const d = describe(sym);
  if (!d) return null;
  if (!FETCHABLE.has(d.reason)) return d;
  if (inflight.has(d.sym)) return { ...d, pending: true };

  const hit = feedFor(d.sym);
  inflight.add(d.sym);
  const run =
    hit.source === 'binance'
      ? binanceSeed(hit.pair).catch((e) => {
          store.noteError(`select ${hit.pair}: ${e?.message || e}`);
          return 0;
        })
      : yahooPoll(hit.pair).catch((e) => {
          store.noteError(`select ${hit.pair}: ${e?.message || e}`);
          return false;
        });

  Promise.resolve(run)
    .then(() => {
      fetchedAt.set(d.sym, Date.now());
      const s = store.getSymbol(d.sym);
      // A proxy can be refused entry mid-flight — the broker took the key back
      // while the request was in the air — and both pollers report that as
      // success rather than as an error. Without this check the UI would say
      // "fetching…" and then show nothing at all, with no trace in Diagnostics.
      if (!s || !s.tf.m1.length) store.noteError(`select ${hit.pair}: fetch returned no usable rows`);
    })
    .catch((e) => store.noteError(`select ${d.sym}: ${e?.message || e}`))
    .finally(() => {
      inflight.delete(d.sym);
      try {
        if (notify) notify();
      } catch {
        /* a dead port must not break the fetch path */
      }
    });

  return { ...d, pending: true };
}

/** Test/diagnostic hook: forget in-flight state (the worker may restart). */
export function resetSelectionFeeds() {
  inflight.clear();
  fetchedAt.clear();
}
