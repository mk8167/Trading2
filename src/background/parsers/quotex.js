/* ------------------------------------------------------------------
 * parsers/quotex.js — turn raw WebSocket payloads into market data.
 *
 * The page hands us whatever the server sent. Quotex (and its mirrors)
 * push socket.io packets that are either UTF-8 JSON or opaque binary.
 * This module never throws and never guesses silently: every extraction
 * path is reported through `provenance` so the UI can show exactly how a
 * tick was found, and unparsed payloads are kept as samples for the
 * Protocol Lab.
 * ----------------------------------------------------------------*/

export const SYMBOL_RE = /^[A-Z]{2,6}(?:\/[A-Z]{2,6})?(?:_OTC)?$/;
const SYMBOL_KEY_RE = /^(s|sym|symbol|name|asset|pair|instrument|ticker|id)$/i;
const PRICE_KEY_RE = /^(p|px|price|rate|quote|last|close|bid|ask|c|value)$/i;
const TIME_KEY_RE = /^(t|ts|time|timestamp|at|dt|date)$/i;
const PAYOUT_KEY_RE = /^(payout|profit|percent|yield|rtng)$/i;

const MAX_FRAME = 262_144; // 256 KB — anything bigger is not a tick
const MIN_TS = 946_684_800_000; // 2000-01-01
const MAX_TS_SKEW = 365 * 24 * 3600 * 1000;

export function isSymbol(s) {
  if (typeof s !== 'string') return false;
  const u = s.trim().toUpperCase();
  return u.length > 3 && SYMBOL_RE.test(u);
}

export function normalizeSymbol(s) {
  if (typeof s !== 'string') return '';
  return s.trim().toUpperCase().replace(/\s+/g, '');
}

export function prettySymbol(sym) {
  const u = normalizeSymbol(sym);
  if (!u) return '—';
  const otc = u.endsWith('_OTC');
  const core = u.replace('_OTC', '').replace('/', '');
  const slash = core.length === 6 ? `${core.slice(0, 3)}/${core.slice(3)}` : core;
  return otc ? `${slash} OTC` : slash;
}

export function isOtc(sym) {
  return normalizeSymbol(sym).endsWith('_OTC');
}

/* --------------------------- frame decoding -------------------------- */

/**
 * Decode one WebSocket payload into text we can reason about.
 * Accepts a string, an ArrayBuffer/TypedArray, or a base64 string that the
 * content-script bridge produced from binary data.
 */
export function decodeFrame(payload, { isBinary = false } = {}) {
  if (payload == null) return '';
  if (typeof payload === 'string') {
    if (!isBinary) return payload.length > MAX_FRAME ? payload.slice(0, MAX_FRAME) : payload;
    return base64ToText(payload);
  }
  if (payload instanceof ArrayBuffer) return bytesToText(new Uint8Array(payload));
  if (ArrayBuffer.isView(payload)) return bytesToText(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
  return '';
}

export function base64ToText(b64) {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytesToText(bytes);
  } catch {
    return '';
  }
}

export function bytesToText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

/**
 * socket.io / engine.io wrap payloads in numeric prefixes ("42[...]",
 * "40", "2probe"). Strip them so JSON.parse has a chance.
 */
export function stripEnvelope(s) {
  let out = String(s);
  let guard = 0;
  while (guard++ < 4) {
    const m = /^(\d{1,3})(?:-(\d{1,3}))?\s*/.exec(out);
    if (!m) break;
    const rest = out.slice(m[0].length);
    if (!rest) break;
    if (/[[{"\[]/.test(rest[0])) {
      out = rest;
      break;
    }
    out = rest;
  }
  return out.trim();
}

/* ---------------------------- extraction ----------------------------- */

/**
 * @returns {{
 *   ticks:  Array<{sym:string, price:number, ts:number|null}>,
 *   history:Array<{sym:string, rows:Array<{t:number,o:number,h:number,l:number,c:number}>}>,
 *   payouts:Array<{sym:string, payout:number}>,
 *   json: boolean,
 *   methods: string[]
 * }}
 */
export function extract(text) {
  const result = { ticks: [], history: [], payouts: [], json: false, methods: [] };
  if (typeof text !== 'string' || !text.length || text.length > MAX_FRAME) return result;

  const body = stripEnvelope(text);

  let parsed = null;
  try {
    parsed = JSON.parse(body);
    result.json = true;
  } catch {
    parsed = null;
  }

  if (parsed != null) {
    walk(parsed, null, result);
    if (result.ticks.length || result.history.length) result.methods.push('json-walk');
  }
  if (!result.ticks.length) {
    const n = regexTicks(body, result);
    if (n) result.methods.push('regex');
  }
  if (result.history.length) result.methods.push('history');
  if (result.payouts.length) result.methods.push('payout');
  return result;
}

function emitTick(res, sym, price, ts) {
  const s = normalizeSymbol(sym);
  if (!isSymbol(s)) return false;
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0 || p > 1e9) return false;
  const t = ts == null ? null : normaliseMs(ts);
  if (t != null && (t < MIN_TS || t > Date.now() + MAX_TS_SKEW)) return null;
  res.ticks.push({ sym: s, price: p, ts: t });
  return true;
}

function normaliseMs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return null;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

function walk(node, inherited, res, depth = 0) {
  if (node == null || depth > 12) return;

  if (Array.isArray(node)) {
    // ['EURUSD_otc', 1789690148.68, 1.41746, 1]
    const tickRow = tryTickRow(node);
    if (tickRow) {
      emitTick(res, tickRow.sym, tickRow.price, tickRow.ts);
      return;
    }
    // [[t,o,h,l,c], ...] history block
    if (node.length >= 8 && node.every((r) => Array.isArray(r) && r.length >= 5)) {
      const rows = node.map(rowToCandle).filter(Boolean);
      if (rows.length >= 5) {
        const sym = inherited ? normalizeSymbol(inherited) : null;
        if (sym && isSymbol(sym)) res.history.push({ sym, rows });
        return;
      }
    }
    for (const item of node) walk(item, inherited, res, depth + 1);
    return;
  }

  if (typeof node !== 'object') return;

  let sym = inherited;
  let price = null;
  let ts = null;
  let payout = null;

  for (const key of Object.keys(node)) {
    const v = node[key];
    if (typeof v === 'string') {
      if (SYMBOL_KEY_RE.test(key) && isSymbol(v)) sym = normalizeSymbol(v);
      else if (!sym && isSymbol(v) && v.length > 4) sym = normalizeSymbol(v);
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      if (price == null && PRICE_KEY_RE.test(key)) price = v;
      if (ts == null && TIME_KEY_RE.test(key)) ts = v;
      if (payout == null && PAYOUT_KEY_RE.test(key)) payout = v;
    }
  }

  if (sym && price != null) {
    emitTick(res, sym, price, ts);
    if (payout != null && payout > 0 && payout <= 200) res.payouts.push({ sym: normalizeSymbol(sym), payout });
    return;
  }

  for (const key of Object.keys(node)) {
    const v = node[key];
    if (v && typeof v === 'object') walk(v, sym, res, depth + 1);
  }
}

/**
 * Match the Quotex array-tick shape: [symbol, epochSeconds, price, flag].
 *
 * An epoch timestamp is *required*. Without it a row like
 * ["EURUSD_otc", 20, 1.08, 1] is ambiguous — 20 could be a price or a
 * flag — so we refuse to guess and let the other parsers have a go.
 */
export function tryTickRow(arr) {
  if (!Array.isArray(arr) || arr.length < 3) return null;
  const symIdx = arr.findIndex((v) => typeof v === 'string' && isSymbol(v));
  if (symIdx < 0) return null;
  const tsIdx = arr.findIndex(
    (v, i) => i !== symIdx && typeof v === 'number' && Number.isFinite(v) && v > 1e9 && v < 1e11
  );
  if (tsIdx < 0) return null;
  const okPrice = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e7;

  // Canonical layout is [symbol, timestamp, price, flag]. When the row
  // matches it positionally, take the price from that exact slot — never
  // scan forward, or the trailing flag would be mistaken for a price.
  if (tsIdx === symIdx + 1) {
    const p = arr[tsIdx + 1];
    return okPrice(p) ? { sym: arr[symIdx], price: p, ts: arr[tsIdx] } : null;
  }
  // Otherwise the clock must still precede the price.
  let priceIdx = -1;
  for (let i = tsIdx + 1; i < arr.length; i++) {
    if (i === symIdx) continue;
    if (okPrice(arr[i])) {
      priceIdx = i;
      break;
    }
  }
  if (priceIdx < 0) return null;
  return { sym: arr[symIdx], price: arr[priceIdx], ts: arr[tsIdx] };
}

/**
 * Rows arrive in a few orders. Decide deterministically instead of
 * guessing: the high must dominate open/close and the low must sit under
 * both. [t,o,h,l,c] is checked first because it is what Quotex sends.
 */
export function rowToCandle(row) {
  if (!Array.isArray(row) || row.length < 5) return null;
  const t = Number(row[0]);
  if (!Number.isFinite(t) || t <= 0) return null;
  const a = Number(row[1]);
  const b = Number(row[2]);
  const x = Number(row[3]);
  const y = Number(row[4]);
  if (![a, b, x, y].every((v) => Number.isFinite(v) && v > 0)) return null;

  const orders = [
    { o: a, h: b, l: x, c: y }, // [t,o,h,l,c]
    { o: a, h: x, l: y, c: b }, // [t,o,c,h,l]  -> o,h=x,l=y,c=b
    { o: a, h: x, l: b, c: y }, // [t,o,h,l,c] variant with swapped h/l
  ];
  for (const cand of orders) {
    if (cand.h >= Math.max(cand.o, cand.c) && cand.l <= Math.min(cand.o, cand.c)) {
      return { t: normaliseMs(t), o: cand.o, h: cand.h, l: cand.l, c: cand.c };
    }
  }
  // Two-column [t, close] style is handled by the caller, not here.
  return null;
}

/* --------------------------- regex fallback -------------------------- */

const RE_OBJ_TICK =
  /([A-Za-z]{2,6}(?:\/[A-Za-z]{2,6})?(?:_otc)?)["']?\s*:\s*\{[^{}]{0,250}?"(?:price|rate|quote|last|close|bid|ask)"\s*:\s*([0-9]+(?:\.[0-9]+)?)/gi;

const RE_ARR_TICK =
  /['"]?([A-Za-z]{2,6}(?:\/[A-Za-z]{2,6})?(?:_otc)?)['"]?\s*[,:]\s*(1[0-9]{9}(?:\.[0-9]+)?)\s*[,:]\s*([0-9]+(?:\.[0-9]+)?)/gi;

export function regexTicks(s, res) {
  let found = 0;
  RE_ARR_TICK.lastIndex = 0;
  let m;
  while ((m = RE_ARR_TICK.exec(s)) !== null) {
    if (emitTick(res, m[1], +m[3], +m[2])) found++;
  }
  if (found) return found;
  RE_OBJ_TICK.lastIndex = 0;
  while ((m = RE_OBJ_TICK.exec(s)) !== null) {
    if (emitTick(res, m[1], +m[2], null)) found++;
  }
  return found;
}

/* --------------------------- diagnostics ----------------------------- */

/**
 * A short, de-duplicated fingerprint of a payload we could not parse, so
 * the Protocol Lab can show the user what the server actually sends.
 */
export function sampleOf(text, len = 160) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const printable = s.replace(/[^\x20-\x7e]/g, '·');
  return {
    text: printable.slice(0, len),
    len: s.length,
    at: Date.now(),
    looksJson: /^[[{]/.test(stripEnvelope(s)),
    looksBinary: /[·]{3,}/.test(printable) || (s.length > 8 && /[^\x20-\x7e]/.test(s)),
  };
}
