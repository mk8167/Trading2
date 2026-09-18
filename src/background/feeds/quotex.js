/* ------------------------------------------------------------------
 * feeds/quotex.js — turns raw page payloads into store updates.
 *
 * The content-script bridge (MAIN world) hands us whatever the page's own
 * WebSocket received. We decode, parse, and file it. Anything we cannot
 * parse is kept as a labelled sample so the Protocol Lab can show the
 * user the real payload shape instead of failing silently.
 * ----------------------------------------------------------------*/

import { decodeFrame, extract, sampleOf } from '../parsers/quotex.js';
import { detectTf } from '../sync.js';
import * as store from '../store.js';

const NOISE = /^(\d{1,3}|2probe|3|0\{.*)$/;

/**
 * Handler installed by index.js, called once per history block the broker
 * sends. A history block IS the chart the user has open on the site, so it is
 * the signal the extension follows (settings.syncSite) to stay on the same
 * pair and the same timeframe as the page.
 */
let siteChart = null;

export function setSiteChartHandler(fn) {
  siteChart = typeof fn === 'function' ? fn : null;
}

/**
 * @param {{text?:string,b64?:string,binary?:boolean,url?:string,frameId?:number}} frame
 * @returns {{ticks:number, history:number, payouts:number, samples:number}}
 */
export function handleFrame(frame) {
  const out = { ticks: 0, history: 0, payouts: 0, meta: 0, samples: 0 };
  store.diag.frames++;
  try {
    let text = '';
    if (frame.binary || frame.b64) {
      store.diag.binaryFrames++;
      text = frame.text ? String(frame.text) : decodeFrame(frame.b64, { isBinary: true });
    } else {
      text = decodeFrame(frame.text);
    }
    if (!text) return out;
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 262_144 || NOISE.test(trimmed)) return out;

    const r = extract(trimmed);

    for (const t of r.ticks) {
      if (store.ingestTick(t.sym, t.price, t.ts, 'quotex')) out.ticks++;
    }
    for (const h of r.history) {
      // The timeframe is measured from the block itself, so a 5- or 15-minute
      // history can never be filed as 1-minute data (see store.ingestHistory).
      const tf = detectTf(h.rows);
      const stored = store.ingestHistory(h.sym, h.rows, 'quotex', null, tf ? { tf } : null);
      out.history += stored;
      if (stored && tf && siteChart) {
        try {
          siteChart({ sym: h.sym, tf, rows: stored, at: Date.now() });
        } catch (e) {
          store.noteError(`siteChart: ${e?.message || e}`);
        }
      }
    }
    for (const p of r.payouts) {
      store.setPayout(p.sym, p.payout);
      out.payouts++;
    }
    // The broker's own asset-type declaration outranks anything inferred
    // from a name, and it usually arrives before the first tick.
    for (const m of r.meta || []) {
      store.setMeta(m.sym, { type: m.type, otc: m.otc });
      out.meta++;
    }

    // Which extraction path found the data, counted per frame. Without this,
    // "the socket is alive but nothing arrives" and "frames arrive in a shape
    // we cannot read" look identical from the outside — and they need
    // completely different fixes.
    for (const m of r.methods) {
      store.diag.methods[m] = (store.diag.methods[m] || 0) + 1;
    }

    if (!out.ticks && !out.history && !out.payouts && !out.meta) {
      // Only keep samples that could plausibly carry market data.
      if (trimmed.length > 24 && /[0-9]/.test(trimmed)) {
        const s = sampleOf(trimmed);
        if (s) {
          store.noteSample(s);
          store.diag.unparsed++;
          out.samples = 1;
        }
      }
    }
    return out;
  } catch (e) {
    store.noteError(`quotex.handleFrame: ${e?.message || e}`);
    return out;
  }
}

/** Batch entry point used by the bridge's message channel. */
export function handleBatch(frames) {
  let ticks = 0;
  let history = 0;
  let payouts = 0;
  let meta = 0;
  for (const f of frames || []) {
    const r = handleFrame(f);
    ticks += r.ticks;
    history += r.history;
    payouts += r.payouts;
    meta += r.meta;
  }
  return { ticks, history, payouts, meta };
}
