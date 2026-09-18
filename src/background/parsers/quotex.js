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

import {
  canonical,
  isSymbol as isInstrument,
  pretty as prettyName,
  isOtc as otcOf,
  classify,
} from '../symbols.js';

const SYMBOL_KEY_RE = /^(s|sym|symbol|name|asset|pair|instrument|ticker|id)$/i;
const PRICE_KEY_RE = /^(p|px|price|rate|quote|last|close|bid|ask|c|value)$/i;
const TIME_KEY_RE = /^(t|ts|time|timestamp|at|dt|date)$/i;
const PAYOUT_KEY_RE = /^(payout|profit|percent|yield|rtng)$/i;
/** A broker's own asset-type field, when the payload carries one. */
const TYPE_KEY_RE = /^(type|asset_?type|class|category|kind|group)$/i;
const OTC_KEY_RE = /^(otc|is_?otc|synthetic|demo)$/i;

const MAX_FRAME = 262_144; // 256 KB — anything bigger is not a tick
const MIN_TS = 946_684_800_000; // 2000-01-01
const MAX_TS_SKEW = 365 * 24 * 3600 * 1000;

/* Symbol identity lives in symbols.js — one authority, one canonical key.
 * These re-exports keep the parser's public surface stable for callers. */
export const isSymbol = isInstrument;

/** The canonical store key for a symbol (' eur/usd_otc ' -> 'EURUSD_OTC'). */
export const normalizeSymbol = canonical;

export function prettySymbol(sym) {
  return prettyName(sym);
}

export function isOtc(sym) {
  return otcOf(canonical(sym));
}

export { classify };

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
  const result = { ticks: [], history: [], payouts: [], meta: [], json: false, methods: [] };
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
  if (result.meta.length) result.methods.push('asset-type');
  return result;
}

/**
 * Read a number that may have been sent as a string.
 *
 * JSON from a broker mirror is not typed consistently: the same field can be
 * `1.0845` on one mirror and `"1.0845"` on the next, and a tick that arrives
 * as a string used to be dropped without a word — the payload parsed, the
 * price was simply never extracted, so the pair appeared silent while the
 * broker's own chart was moving. Only plain decimal strings are accepted, so
 * a timestamp or a symbol can never be mistaken for a price.
 */
export function asNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > 24 || !/^-?\d+(?:\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function emitTick(res, sym, price, ts) {
  const s = normalizeSymbol(sym);
  if (!isSymbol(s)) return false;
  const p = asNumber(price);
  if (p == null || p <= 0 || p > 1e9) return false;
  const t = ts == null ? null : normaliseMs(ts);
  if (t != null && (t < MIN_TS || t > Date.now() + MAX_TS_SKEW)) return null;
  res.ticks.push({ sym: s, price: p, ts: t });
  return true;
}

/* ------------------------- named socket.io events -------------------- */

/** A socket.io frame's first element can be the event name: ["quote", {...}]. */
const EVENT_NAME_RE = /^[a-z][a-z0-9_:-]{0,46}$/i;

/**
 * Name → what the numbers in that event mean.
 *
 * The broker labels its own frames, and the label is the only thing that makes
 * a bare array of numbers unambiguous. `["history", [...]]` and
 * `["candle", [...]]` are candles; `["quote", [...]]` is a price. Without the
 * label the parser had to guess, and the safe guess was to ignore the frame —
 * which is why a site chart could be perfectly live while the extension showed
 * nothing at all.
 */
export function eventKind(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return null;
  if (/histor|ohlc|candle|\bbar/.test(n)) return 'candles';
  if (/\b(tick|quote|price|rate|update|feed|trade)s?\b/.test(n)) return 'tick';
  return null;
}

/**
 * One candle sent on its own: [t,o,h,l,c] (the shape rowToCandle already
 * understands). Returns null unless the numbers can only be a candle.
 */
export function singleCandleRow(arr) {
  if (!Array.isArray(arr) || arr.length < 5 || arr.length > 6) return null;
  const nums = arr.slice(0, 5).map(asNumber);
  if (nums.some((v) => v == null)) return null;
  const [t, a, b, x, y] = nums;
  if (t < 1e9) return null; // not an epoch seconds/ms clock
  const ms = t < 1e12 ? t * 1000 : t;
  if (ms < MIN_TS || ms > Date.now() + MAX_TS_SKEW) return null;
  if (![a, b, x, y].every((v) => v > 0 && v < 1e7)) return null;
  // o === h === l === c is a tick repeated four times, not a candle.
  if (a === b && b === x && x === y) return null;
  return rowToCandle([t, a, b, x, y]);
}

/** One tick sent on its own: [t, price] or [price, t]. */
export function singleTickRow(arr) {
  if (!Array.isArray(arr) || arr.length !== 2) return null;
  const a = asNumber(arr[0]);
  const b = asNumber(arr[1]);
  if (a == null || b == null) return null;
  const isClock = (v) => v >= 1e9 && v < 1e11;
  if (isClock(a) && !isClock(b) && b > 0) return { ts: a, price: b };
  if (isClock(b) && !isClock(a) && a > 0) return { ts: b, price: a };
  return null;
}

function normaliseMs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return null;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

function walk(node, inherited, res, depth = 0, event = null) {
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
        if (sym && isSymbol(sym)) {
          res.history.push({ sym, rows, from: event || 'block' });
          if (event) res.methods.push('named-event');
          return;
        }
      }
    }

    /* socket.io wraps every frame as [eventName, payload]. The name is the
     * only thing that tells a bare array of numbers apart, so it is carried
     * down instead of being thrown away — a ["history", [...]] frame used to
     * be unroutable and simply vanished. */
    let ev = event;
    let items = node;
    const first = typeof node[0] === 'string' ? node[0] : null;
    // An event name, not an instrument. "candle" and "quote" are six letters
    // and four letters, which is also the shape of "AUDCAD" — so a label is
    // only treated as one when it names a kind of data (eventKind) or when it
    // cannot be an instrument at all. A real tick row starts with a symbol
    // followed by a number, so it can never take this branch.
    const isEventName = !!first && EVENT_NAME_RE.test(first) && (eventKind(first) || !isSymbol(first)) && node.length >= 2;
    if (isEventName) {
      ev = first.toLowerCase();
      items = node.slice(1);
    }
    const kind = eventKind(ev);

    // Candles sent one at a time, for the pair this event is about. The frame
    // itself is scanned too: ["candle", [t,o,h,l,c]] carries the row inline,
    // while ["candle", {data: [t,o,h,l,c]}] reaches it through the object.
    if (kind === 'candles' || inherited) {
      const scan = [];
      for (const item of [node, ...items]) if (Array.isArray(item) && !scan.includes(item)) scan.push(item);
      const rows = scan.map(singleCandleRow).filter(Boolean);
      const sym = inherited ? normalizeSymbol(inherited) : null;
      if (rows.length && sym && isSymbol(sym)) {
        res.history.push({ sym, rows, from: ev || 'single' });
        res.methods.push('single-candle');
        return;
      }
    }

    // Bare prices for a pair we already know, from an event that says so.
    if (kind === 'tick' && inherited) {
      let n = 0;
      for (const item of items) {
        if (!Array.isArray(item) || item === node) continue;
        const t = singleTickRow(item);
        if (t && emitTick(res, inherited, t.price, t.ts)) n++;
      }
      if (n) {
        res.methods.push('single-tick');
        return;
      }
    }

    for (const item of items) walk(item, inherited, res, depth + 1, ev);
    return;
  }

  if (typeof node !== 'object') return;

  let sym = inherited;
  let price = null;
  let ts = null;
  let payout = null;
  let type = null;
  let otcHint = null;

  for (const key of Object.keys(node)) {
    const v = node[key];
    if (typeof v === 'string') {
      if (SYMBOL_KEY_RE.test(key) && isSymbol(v)) sym = normalizeSymbol(v);
      else if (!sym && isSymbol(v) && v.length > 4) sym = normalizeSymbol(v);
      if (type == null && TYPE_KEY_RE.test(key) && v.trim()) type = v.trim();
      // Numbers arrive as strings on some mirrors; the key decides what the
      // string means, exactly as it does for a real number.
      const n = asNumber(v);
      if (n != null) {
        if (price == null && PRICE_KEY_RE.test(key)) price = n;
        if (ts == null && TIME_KEY_RE.test(key)) ts = n;
        if (payout == null && PAYOUT_KEY_RE.test(key)) payout = n;
      }
    } else if (typeof v === 'boolean') {
      if (otcHint == null && OTC_KEY_RE.test(key)) otcHint = v;
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      if (price == null && PRICE_KEY_RE.test(key)) price = v;
      if (ts == null && TIME_KEY_RE.test(key)) ts = v;
      if (payout == null && PAYOUT_KEY_RE.test(key)) payout = v;
    }
  }

  // The broker declaring what an instrument IS outranks anything we could
  // infer from its name, so record it whenever both halves are present.
  if (sym && (type || otcHint != null)) {
    res.meta.push({ sym: normalizeSymbol(sym), type: type || null, otc: otcHint });
  }

  // A payout is recorded whether or not this node also carries a price.
  // The broker's asset list sends {symbol, payout} with NO price, and this
  // used to sit inside the price branch — so the real payout for every pair
  // was discarded on exactly the frame that announced it, and the maths fell
  // back to a global default.
  if (sym && payout != null && payout > 0 && payout <= 200) {
    res.payouts.push({ sym: normalizeSymbol(sym), payout });
  }

  if (sym && price != null) {
    emitTick(res, sym, price, ts);
    return;
  }

  for (const key of Object.keys(node)) {
    const v = node[key];
    if (v && typeof v === 'object') walk(v, sym, res, depth + 1, event);
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
  const tsIdx = arr.findIndex((v, i) => {
    if (i === symIdx) return false;
    const n = asNumber(v);
    return n != null && n > 1e9 && n < 1e11;
  });
  if (tsIdx < 0) return null;
  const okPrice = (v) => {
    const n = asNumber(v);
    return n != null && n > 0 && n < 1e7;
  };

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

/* Regex fallbacks. The symbol part allows digits and dashes because crypto
 * names carry them (1000SHIBUSD, BTC-USD); the old `[A-Za-z]{2,6}` pattern
 * rejected those outright, so their ticks vanished with no error anywhere.
 * Junk that sneaks through is stopped downstream by isSymbol()'s
 * letter-count guard, so widening here cannot invent a phantom instrument. */
const SYM_PART = String.raw`[A-Za-z0-9]{2,10}(?:[-/.][A-Za-z0-9]{2,10})?(?:[\s_-]?otc)?`;

/* Numbers may be quoted on the wire ("price":"1.0845"). Every numeric group
 * below therefore tolerates quotes: a quoted price used to require a digit
 * immediately after the colon, so those frames fell through both extraction
 * paths and survived only as a Protocol Lab sample. */
const RE_OBJ_TICK = new RegExp(
  `(${SYM_PART})["']?\\s*:\\s*\\{[^{}]{0,250}?"(?:price|rate|quote|last|close|bid|ask)"\\s*:\\s*["']?([0-9]+(?:\\.[0-9]+)?)`,
  'gi'
);

const RE_ARR_TICK = new RegExp(
  `['"]?(${SYM_PART})['"]?\\s*[,:]\\s*["']?(1[0-9]{9}(?:\\.[0-9]+)?)["']?\\s*[,:]\\s*["']?([0-9]+(?:\\.[0-9]+)?)`,
  'gi'
);

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
