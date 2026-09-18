/* ------------------------------------------------------------------
 * feeds/quotex.js — turns raw page payloads into store updates.
 *
 * The content-script bridge (MAIN world) hands us whatever the page's own
 * WebSocket received. We decode, parse, and file it. Anything we cannot
 * parse is kept as a labelled sample so the Protocol Lab can show the
 * user the real payload shape instead of failing silently.
 * ----------------------------------------------------------------*/

import { decodeFrame, extract, sampleOf } from '../parsers/quotex.js';
import * as store from '../store.js';

const NOISE = /^(\d{1,3}|2probe|3|0\{.*)$/;

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
      out.history += store.ingestHistory(h.sym, h.rows, 'quotex');
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
