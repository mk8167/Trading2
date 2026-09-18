/* ------------------------------------------------------------------
 * symbols.js — the one authority on what an instrument IS.
 *
 * Every other module used to make its own guess about a symbol string:
 * the parser upper-cased it, the store used the raw string as a map key,
 * the feeds used slash-separated names, and the UI re-formatted it for
 * display. The result was that one asset could live under two or three
 * different keys ("EURUSD", "EUR/USD", "USD/CAD_OTC" vs "USDCAD_OTC"),
 * splitting its candle history and silently corrupting every number
 * derived from it.
 *
 * So there is now exactly ONE canonical key per instrument, produced
 * here, and everything else — store keys, journal entries, settings,
 * UI values — uses it. Classification (forex / crypto / commodity /
 * synthetic) is derived once and carried alongside, because the maths
 * that decides whether a pair is tradeable is not the same for a
 * 24/7 crypto market and a forex pair that closes on Saturday.
 *
 * Design rules for this file:
 *   - Pure. No imports, no I/O, no state. Trivially testable.
 *   - Never throws. Bad input produces `null` / 'unknown', not a crash.
 *   - Never guesses silently: when a name is ambiguous the class comes
 *     back 'unknown' and the caller decides, rather than being told a
 *     confident lie.
 * ----------------------------------------------------------------*/

/* ----------------------------- alphabets ---------------------------- */

/** Fiat + stablecoin quotes. Longest first: USDT must be tried before USD.
 *  Crypto quotes (BTC, ETH...) are deliberately NOT here — see splitPair. */
const QUOTES = [
  'USDT', 'USDC', 'BUSD', 'TUSD', 'FDUSD', 'USDP', 'DAI',
  'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD',
  'SEK', 'NOK', 'TRY', 'ZAR', 'MXN', 'SGD', 'HKD', 'PLN',
];

/**
 * Strings a socket.io/engine.io transport produces that are shaped like
 * a symbol but are not one. "2probe" is the one that matters: it has six
 * characters and five letters, so a purely structural test accepts it,
 * and it then pollutes the store with a phantom instrument.
 */
const NOT_SYMBOLS = new Set(['2PROBE', 'PROBE', 'PING', 'PONG', 'NULL', 'UNDEFINED', 'TRUE', 'FALSE', 'OBJECT', 'STRING', 'NUMBER']);

/** Currencies that are themselves a crypto asset (so BTC/ETH is crypto, not FX). */
const CRYPTO_CURRENCIES = new Set([
  'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'DOT', 'LTC', 'BCH',
  'TRX', 'LINK', 'AVAX', 'MATIC', 'SHIB', 'UNI', 'ATOM', 'XLM', 'NEAR',
  'APT', 'ARB', 'OP', 'FIL', 'ETC', 'XMR', 'ALGO', 'AAVE', 'SAND', 'MANA',
  // Commonly seen with an exchange scale prefix (1000SHIB, 1000PEPE, ...).
  'PEPE', 'BONK', 'FLOKI', 'WIF', 'LUNC', 'XEC', 'SATS', 'MEME', 'ORDI',
]);

/** Stablecoins: a crypto-quoted pair (BTC/USDT) is still crypto. */
const STABLES = new Set(['USDT', 'USDC', 'BUSD', 'TUSD', 'FDUSD', 'USDP', 'DAI']);

/** Fiat money: quoting against one of these makes it an FX-style pair. */
const FIATS = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD',
  'SEK', 'NOK', 'TRY', 'ZAR', 'MXN', 'SGD', 'HKD', 'PLN',
]);

/** Precious/industrial metals — traded like FX but with different hours. */
const METALS = new Set(['XAU', 'XAG', 'XPT', 'XPD']);

/** Suffixes a broker may hang off a symbol to mark a variant. */
const SUFFIXES = ['_OTC', '_L', '_T', '_M'];

/**
 * Volatility band per asset class, as ATR(14)/price on the m1 series.
 *
 * These are deliberately NOT one shared pair of numbers. A crypto pair
 * routinely moves 0.4% a minute, which the old single 2% cap treated as
 * normal but the old 0.02% floor never rejected — while the same bands
 * let a dead OTC pair through. Each class gets its own window so the
 * veto means "abnormal for THIS market", not "abnormal for an average
 * of markets that behave nothing alike".
 */
export const VOL_BANDS = {
  forex: { min: 0.00008, max: 0.012 },
  crypto: { min: 0.0002, max: 0.03 },
  commodity: { min: 0.00008, max: 0.015 },
  synthetic: { min: 0.00003, max: 0.008 },
  unknown: { min: 0.0002, max: 0.02 },
};

/**
 * Payout assumed when the broker has not told us one for this pair.
 * Getting this wrong is not cosmetic: it moves the break-even win rate
 * that the risk gate is built on (86% -> 53.8%, 75% -> 57.1%), so an
 * optimistic default quietly lets through trades that cannot pay.
 */
export const CLASS_PAYOUT_DEFAULT = {
  forex: 85,
  crypto: 75,
  commodity: 82,
  synthetic: 80,
  unknown: 82,
};

/** Markets that stop streaming real prices over the weekend. */
export const WEEKEND_CLOSED = new Set(['forex', 'commodity']);

const MAX_KEY = 24;
/**
 * Longest instrument name we accept, suffix excluded.
 * '1000SHIBUSDT' is 12 and is a real pair; 'TOOLONGSYMBOLXYZ' is 16 and is
 * a fragment of some unrelated JSON. The bound is what keeps the widened
 * pattern (digits and dashes are now allowed, for crypto names) from
 * swallowing arbitrary text.
 */
const MAX_CORE = 12;

/* --------------------------- normalisation -------------------------- */

/**
 * The canonical store key for a symbol.
 *
 * Collapses every spelling variant of one instrument onto one string:
 * separators are dropped, a broker suffix is moved to the end in upper
 * case, and the remainder is upper-cased. Idempotent — canonicalising a
 * canonical key returns it unchanged.
 *
 *   ' eur/usd_otc ' -> 'EURUSD_OTC'
 *   'USD/CAD_otc'   -> 'USDCAD_OTC'
 *   'BTC/USD'       -> 'BTCUSD'
 *   'BTC-USD'       -> 'BTCUSD'
 *   'btcusdt'       -> 'BTCUSDT'
 *
 * @param {unknown} s
 * @returns {string} '' when nothing usable can be made
 */
export function canonical(s) {
  if (typeof s !== 'string') return '';
  // \u00b7 is the middle dot the Protocol Lab substitutes for
  // non-printable bytes; it must never become part of a key.
  let u = s.trim().toUpperCase().replace(/[\-.\u00b7]/g, '');
  if (!u) return '';

  // A suffix written with a space ("USDCAD otc", "EUR/USD otc") must be
  // folded onto the underscore form BEFORE spaces are removed, otherwise
  // the marker is lost and two spellings of one pair stop colliding.
  u = u.replace(/\s+(_?)(OTC|[LTM])\b/g, '_$2');

  let suffix = '';
  for (const sfx of SUFFIXES) {
    const at = u.indexOf(sfx);
    if (at > 0) {
      suffix = sfx;
      u = u.slice(0, at) + u.slice(at + sfx.length);
      break;
    }
  }
  // Remaining separators are formatting, not identity.
  u = u.replace(/[\s/_]/g, '');
  if (!u) return '';
  return (u + suffix).slice(0, MAX_KEY);
}

/**
 * Is this string plausibly an instrument name?
 *
 * Deliberately wider than a fixed `[A-Z]{2,6}` pattern: crypto names on
 * broker feeds carry digits and dashes (1000SHIBUSD, BTC-USD), and the
 * old pattern rejected those outright, so their ticks were dropped
 * without a trace. The guard against junk is a letter count instead —
 * a socket.io heartbeat like "2probe" has too few letters to pass, and
 * a bare number cannot either.
 */
export function isSymbol(s) {
  if (typeof s !== 'string') return false;
  const key = canonical(s);
  if (key.length < 5 || key.length > MAX_KEY) return false;
  if (NOT_SYMBOLS.has(key)) return false;
  const core = stripSuffix(key);
  if (core.length < 4 || core.length > MAX_CORE) return false;
  if ((core.match(/[A-Z]/g) || []).length < 4) return false; // need real letters
  return /^[A-Z0-9]+$/.test(core); // no punctuation survived
}

/** Drop the broker suffix: 'EURUSD_OTC' -> 'EURUSD'. */
export function stripSuffix(key) {
  const u = String(key || '');
  for (const sfx of SUFFIXES) if (u.endsWith(sfx)) return u.slice(0, -sfx.length);
  return u;
}

/** The broker suffix in upper case, or '' when there is none. */
export function suffixOf(key) {
  const u = String(key || '');
  for (const sfx of SUFFIXES) if (u.endsWith(sfx)) return sfx;
  return '';
}

/** True for platform-synthesised (OTC) instruments. */
export function isOtc(key) {
  return suffixOf(key) === '_OTC';
}

/**
 * Split a symbol into base and quote.
 *
 * Uses the longest-match-first quote table, so BTCUSDT resolves as
 * BTC/USDT and not BTCU/SDT. Returns null when no known quote is found
 * — callers must treat that as "unclassified", never as forex.
 */
/**
 * Is this a base asset we recognise?
 *
 * Handles Binance's scaled tickers (1000SHIB, 1000PEPE, 1000000MOG) by
 * stripping the multiplier before the lookup — without it, "1000SHIBUSD"
 * splits as 1000SHI/BUSD, which is a coin that does not exist quoted
 * against one that is not on the pair.
 */
/** Multipliers exchanges prefix onto small-cap tickers. */
const SCALE_PREFIXES = ['1000000', '10000', '1000'];

/** Strip an exchange scale prefix: '1000SHIB' -> 'SHIB'. */
function unscaled(b) {
  for (const p of SCALE_PREFIXES) {
    if (b.startsWith(p) && b.length > p.length + 1) return b.slice(p.length);
  }
  return b;
}

/** Is this a crypto base asset (allowing for a scale prefix)? */
export function isCryptoBase(b) {
  if (!b) return false;
  return CRYPTO_CURRENCIES.has(b) || CRYPTO_CURRENCIES.has(unscaled(b));
}

export function isKnownBase(b) {
  if (!b) return false;
  return isCryptoBase(b) || FIATS.has(b) || METALS.has(b) || FIATS.has(unscaled(b)) || METALS.has(unscaled(b));
}

export function splitPair(key) {
  const core = stripSuffix(canonical(key));
  if (!core) return null;

  // Collect every suffix that could be the quote, longest first, then prefer
  // a split whose BASE is a recognised asset. Longest-match alone is not
  // enough: "1000SHIBUSD" matches BUSD before USD, and "BTCBUSD" matches USD
  // before BUSD — only the base tells you which reading is real.
  const candidates = [];
  for (const q of QUOTES) {
    if (core.length > q.length + 1 && core.endsWith(q)) candidates.push({ base: core.slice(0, -q.length), quote: q });
  }
  // Crypto-quoted crypto (ETHBTC, LTCBTC) comes after fiat and stablecoin
  // quotes, so EURUSD can never be read as EUR/USDT-style nonsense.
  for (const q of [...CRYPTO_CURRENCIES].sort((a, b) => b.length - a.length)) {
    if (core.length > q.length + 1 && core.endsWith(q)) candidates.push({ base: core.slice(0, -q.length), quote: q });
  }
  if (!candidates.length) return null;
  return candidates.find((c) => isKnownBase(c.base)) || candidates[0];
}

/* --------------------------- classification -------------------------- */

/**
 * Classify an instrument.
 *
 * `otc` is checked FIRST and wins over everything: an OTC pair is
 * generated by the platform, so whatever it is named, it is not a real
 * market and its volatility/payout behaviour is the platform's, not the
 * exchange's.
 *
 * @param {string} key
 * @param {{type?:string, otc?:boolean}} [hint] optional broker-declared truth
 * @returns {{key:string, pretty:string, otc:boolean, assetClass:string, base:string|null, quote:string|null}}
 */
export function classify(key) {
  return classifyWith(key, null);
}

/**
 * The real implementation. `hint` is what the broker itself declared
 * (from its asset list) and always beats a guess made from the name,
 * because the name is a heuristic and the broker is the source of truth.
 */
export function classifyWith(key, hint = null) {
  const k = canonical(key);
  if (!k) return { key: '', pretty: '—', otc: false, assetClass: 'unknown', base: null, quote: null };

  const otcHint = hint && typeof hint.otc === 'boolean' ? hint.otc : null;
  const otc = otcHint != null ? otcHint : isOtc(k);
  const pair = splitPair(k);
  const base = pair ? pair.base : null;
  const quote = pair ? pair.quote : null;

  // Broker-declared type wins outright.
  let assetClass = hint && typeof hint.type === 'string' ? normaliseClass(hint.type) : '';

  if (!assetClass) {
    if (otc) assetClass = 'synthetic';
    else if (base && METALS.has(base)) assetClass = 'commodity';
    else if (quote && STABLES.has(quote)) assetClass = 'crypto';
    else if (quote && FIATS.has(quote)) assetClass = isCryptoBase(base) ? 'crypto' : 'forex';
    else if (isCryptoBase(base)) assetClass = 'crypto';
    else assetClass = 'unknown';
  }

  return { key: k, pretty: prettyOf(k), otc, assetClass, base, quote };
}

/** Map a broker's own asset-type string onto our classes. */
export function normaliseClass(t) {
  const s = String(t || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!s) return '';
  if (/^(otc|synthetic|demo|practice)$/.test(s)) return 'synthetic';
  if (/^(currency|forex|fx|currencies|money)$/.test(s)) return 'forex';
  if (/^(crypto|cryptocurrency|digital|coin)$/.test(s)) return 'crypto';
  if (/^(commodity|commodities|metal|metals)$/.test(s)) return 'commodity';
  if (/^(stock|stocks|equity|share)$/.test(s)) return 'stock';
  if (/^(index|indices)$/.test(s)) return 'index';
  return '';
}

/* ------------------------------ display ----------------------------- */

/**
 * Human-readable name. 'EURUSD_OTC' -> 'EUR/USD OTC'.
 *
 * The split is driven by the quote table, not by "is it six characters",
 * so crypto names of any length come out right (BTCUSDT -> BTC/USDT).
 */
export function prettyOf(key) {
  const raw = symbolish(key).trim();
  const k = canonical(raw);
  if (!k) return '—';
  const otc = isOtc(k);
  const pair = splitPair(stripSuffix(k));
  // When the pair cannot be split we hand back the caller's own spelling
  // rather than a canonicalised mangling of it — display should never
  // invent formatting it cannot justify. Only the OTC marker is removed,
  // and only when it is actually there, so a name that merely ends in
  // "L" or "T" is left alone.
  let body;
  if (pair && pair.base) body = `${pair.base}/${pair.quote}`;
  else body = (otc ? raw.replace(/[\s_-]*OTC$/i, '').trim() : raw) || stripSuffix(k);
  return otc ? `${body} OTC` : body;
}

/**
 * Pretty for something that may not be a symbol at all.
 * Falls back to the raw string rather than '—' so a UI never blanks out
 * a value it was given.
 */
export function symbolish(s) {
  return typeof s === 'string' && s.trim() ? s : '';
}

/** Safe display helper: never returns an empty string. */
export function pretty(key) {
  const p = prettyOf(key);
  return p && p !== '—' ? p : String(symbolish(key) || '—');
}

/* ------------------------------ sessions ---------------------------- */

/**
 * Is the real market for this class open right now?
 *
 * Crypto never closes. FX and metals close for the weekend (Friday ~22:00
 * UTC to Sunday ~22:00 UTC), and a "signal" produced from a frozen chart
 * over that window is fiction. Evaluated in UTC so it does not depend on
 * the trader's timezone; the ±2h boundary is approximate on purpose —
 * being slightly conservative at the edges costs nothing, being wrong on
 * Saturday costs everything.
 *
 * 'synthetic' and 'unknown' always report open: an OTC feed is generated
 * by the platform and genuinely runs 24/7, and for an unclassified name
 * we refuse to invent a closure.
 *
 * @param {string} assetClass
 * @param {number|Date} [at]
 */
export function marketOpen(assetClass, at = Date.now()) {
  const cls = assetClass || 'unknown';
  if (!WEEKEND_CLOSED.has(cls)) return true;
  const d = at instanceof Date ? at : new Date(Number(at) || Date.now());
  const day = d.getUTCDay();
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (day === 6) return false; // all Saturday
  if (day === 0) return hour >= 22; // Sunday reopens ~22:00 UTC
  if (day === 5) return hour < 22; // Friday closes ~22:00 UTC
  return true;
}

/** A short human reason for a closure, or null when open. */
export function closedReason(assetClass, at = Date.now()) {
  if (marketOpen(assetClass, at)) return null;
  return closureText(assetClass);
}

/**
 * The wording for a closure, without consulting the clock.
 *
 * Callers that have already decided a market is closed (the live engine
 * from the current time, a backtester from a bar timestamp) need the
 * explanation, not a second opinion — re-checking the clock here made the
 * veto message depend on which day the test happened to run.
 */
export function closureText(assetClass) {
  const label = assetClass === 'commodity' ? 'Metals' : assetClass === 'forex' ? 'Forex' : 'This market';
  return `${label} market is closed for the weekend — prices are frozen`;
}

/* ------------------------------ lookup ------------------------------ */

/** Volatility band for a class, always returning a usable object. */
export function volBand(assetClass) {
  return VOL_BANDS[assetClass] || VOL_BANDS.unknown;
}

/** Assumed payout for a class when the broker has not supplied one. */
export function classPayout(assetClass) {
  const p = CLASS_PAYOUT_DEFAULT[assetClass];
  return Number.isFinite(p) ? p : CLASS_PAYOUT_DEFAULT.unknown;
}
