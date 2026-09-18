/* symbols.js — the single authority on instrument identity.
 *
 * These tests exist because the bugs they cover were invisible at
 * runtime: a pair stored under two keys still draws a chart, it just
 * draws it from half the data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isKnownBase,
  canonical,
  isSymbol,
  classify,
  classifyWith,
  splitPair,
  stripSuffix,
  suffixOf,
  isOtc,
  prettyOf,
  pretty,
  marketOpen,
  closedReason,
  volBand,
  classPayout,
  normaliseClass,
  WEEKEND_CLOSED,
} from '../src/background/symbols.js';

/* ----------------------------- canonical ----------------------------- */

test('canonical collapses every spelling of one instrument onto one key', () => {
  // The real collision from production: Quotex sends both shapes.
  assert.equal(canonical('EURUSD_otc'), 'EURUSD_OTC');
  assert.equal(canonical('eur/usd_otc'), 'EURUSD_OTC');
  assert.equal(canonical(' EUR/USD_OTC '), 'EURUSD_OTC');
  assert.equal(canonical('EURUSD_OTC'), 'EURUSD_OTC');

  assert.equal(canonical('USD/CAD_otc'), 'USDCAD_OTC');
  assert.equal(canonical('usdcad otc'), 'USDCAD_OTC');
  assert.equal(canonical('USDCAD'), 'USDCAD');

  assert.equal(canonical('BTC/USD'), 'BTCUSD');
  assert.equal(canonical('btc-usd'), 'BTCUSD');
  assert.equal(canonical('BTC USD'), 'BTCUSD');
  assert.equal(canonical('BTC.USD'), 'BTCUSD');
});

test('canonical is idempotent — re-canonicalising a key changes nothing', () => {
  for (const s of ['EURUSD_OTC', 'USDCAD_OTC', 'BTCUSDT', 'XAUUSD', '1000SHIBUSD']) {
    assert.equal(canonical(canonical(s)), canonical(s), s);
  }
});

test('canonical handles crypto names with digits and dashes', () => {
  assert.equal(canonical('1000SHIB/USDT'), '1000SHIBUSDT');
  assert.equal(canonical('BTC-USD'), 'BTCUSD');
  assert.equal(canonical('btcusdt'), 'BTCUSDT');
});

test('canonical returns an empty string for junk instead of throwing', () => {
  for (const bad of [null, undefined, 42, {}, [], '', '   ', '///', '---']) {
    assert.equal(canonical(bad), '', JSON.stringify(bad));
  }
});

test('canonical moves a broker suffix to the end and keeps only one', () => {
  assert.equal(canonical('EUR_OTC_USD'), 'EURUSD_OTC');
  assert.equal(canonical('XAUUSD_L'), 'XAUUSD_L');
  assert.equal(stripSuffix('EURUSD_OTC'), 'EURUSD');
  assert.equal(suffixOf('EURUSD_OTC'), '_OTC');
  assert.equal(suffixOf('EURUSD'), '');
});

/* ------------------------------ isSymbol ------------------------------ */

test('isSymbol accepts forex, metals, OTC and digit-bearing crypto names', () => {
  for (const good of [
    'EURUSD', 'EURUSD_OTC', 'USD/CAD_otc', 'XAUUSD', 'XAUUSD_otc',
    'BTCUSD', 'BTC/USD', 'BTCUSDT', '1000SHIBUSD', 'BTC-USD', 'GBPJPY_OTC',
  ]) {
    assert.ok(isSymbol(good), `should accept ${good}`);
  }
});

test('isSymbol rejects socket.io noise, bare numbers and non-strings', () => {
  for (const bad of [
    '2probe', '3', '42', '0', '12345', '1789690148', 'US', 'ABC',
    '', '   ', null, undefined, 7, {}, [], true,
  ]) {
    assert.ok(!isSymbol(bad), `should reject ${JSON.stringify(bad)}`);
  }
});

test('isSymbol rejects strings that still contain punctuation after cleaning', () => {
  assert.ok(!isSymbol('EU,USD'));
  assert.ok(!isSymbol('EUR{USD'));
  assert.ok(!isSymbol('"EURUSD"'));
});

/* ---------------------------- classification --------------------------- */

test('classify: OTC is synthetic no matter what it is named', () => {
  assert.equal(classify('EURUSD_OTC').assetClass, 'synthetic');
  assert.equal(classify('BTCUSD_OTC').assetClass, 'synthetic');
  assert.equal(classify('XAUUSD_otc').assetClass, 'synthetic');
  assert.ok(classify('EURUSD_OTC').otc);
});

test('classify: real forex pairs', () => {
  for (const s of ['EURUSD', 'GBPJPY', 'USD/CAD', 'AUDNZD', 'EUR/GBP']) {
    assert.equal(classify(s).assetClass, 'forex', s);
  }
});

test('classify: crypto — both USD-quoted and stablecoin-quoted', () => {
  assert.equal(classify('BTCUSD').assetClass, 'crypto');
  assert.equal(classify('BTC/USD').assetClass, 'crypto');
  assert.equal(classify('BTCUSDT').assetClass, 'crypto');
  assert.equal(classify('ETHUSDC').assetClass, 'crypto');
  assert.equal(classify('ETHBTC').assetClass, 'crypto'); // crypto-quoted crypto
  assert.equal(classify('1000SHIBUSDT').assetClass, 'crypto');
});

test('classify: metals are commodities, not forex', () => {
  assert.equal(classify('XAUUSD').assetClass, 'commodity');
  assert.equal(classify('XAGUSD').assetClass, 'commodity');
  assert.equal(classify('XAUUSD_otc').assetClass, 'synthetic'); // OTC still wins
});

test('classify: an unrecognisable name is "unknown", never a confident lie', () => {
  assert.equal(classify('QQQQQQ').assetClass, 'unknown');
  assert.equal(classify('ZZZZZZ').assetClass, 'unknown');
  assert.equal(classify('').assetClass, 'unknown');
});

test('splitPair uses longest-match-first so BTCUSDT is BTC/USDT not BTCU/SDT', () => {
  assert.deepEqual(splitPair('BTCUSDT'), { base: 'BTC', quote: 'USDT' });
  assert.deepEqual(splitPair('BTCUSD'), { base: 'BTC', quote: 'USD' });
  assert.deepEqual(splitPair('EURUSD'), { base: 'EUR', quote: 'USD' });
  assert.deepEqual(splitPair('USDJPY'), { base: 'USD', quote: 'JPY' });
  assert.equal(splitPair('QQQQQQ'), null);
});

test('ambiguous splits are resolved by whether the base is a real asset', () => {
  // BUSD matches before USD by length alone — but 1000SHI is not a coin.
  assert.deepEqual(splitPair('1000SHIBUSD'), { base: '1000SHIB', quote: 'USD' });
  // ...and here USD matches before BUSD by length alone, but BTCB is not one either.
  assert.deepEqual(splitPair('BTCBUSD'), { base: 'BTC', quote: 'BUSD' });
  assert.deepEqual(splitPair('ETHBTC'), { base: 'ETH', quote: 'BTC' });
  assert.deepEqual(splitPair('LTCBTC'), { base: 'LTC', quote: 'BTC' });
  // Ordinary pairs are unaffected by the extra care.
  assert.deepEqual(splitPair('EURUSD'), { base: 'EUR', quote: 'USD' });
  assert.deepEqual(splitPair('BTCUSDT'), { base: 'BTC', quote: 'USDT' });
  assert.deepEqual(splitPair('XAUUSD'), { base: 'XAU', quote: 'USD' });
});

test('isKnownBase understands Binance-style scaled tickers', () => {
  for (const b of ['BTC', 'EUR', 'XAU', 'SHIB', '1000SHIB', '1000PEPE', '10000LTC', '1000BONK']) {
    assert.ok(isKnownBase(b), b);
  }
  for (const b of ['1000SHI', 'BTCB', 'QQQQ', '', null]) assert.ok(!isKnownBase(b), String(b));
});

test('scaled-ticker names display readably and classify as crypto', () => {
  assert.equal(prettyOf('1000SHIBUSD'), '1000SHIB/USD');
  assert.equal(prettyOf('1000SHIBUSDT'), '1000SHIB/USDT');
  assert.equal(classify('1000SHIBUSD').assetClass, 'crypto');
  assert.equal(classify('BTCBUSD').assetClass, 'crypto');
});

test('a broker-declared asset type beats the name heuristic', () => {
  // The name says "forex" (USD quote); the broker says it is crypto.
  assert.equal(classifyWith('XYZUSD', { type: 'crypto' }).assetClass, 'crypto');
  assert.equal(classifyWith('BTCUSD', { type: 'forex' }).assetClass, 'forex');
  assert.equal(classifyWith('EURUSD', { type: 'otc' }).assetClass, 'synthetic');
  assert.equal(classifyWith('EURUSD', { type: 'currencies' }).assetClass, 'forex');
  // A declared otc flag marks a name with no suffix.
  assert.equal(classifyWith('EURUSD', { otc: true }).assetClass, 'synthetic');
  assert.ok(classifyWith('EURUSD', { otc: true }).otc);
});

test('normaliseClass maps broker vocabulary onto our classes', () => {
  assert.equal(normaliseClass('CURRENCY'), 'forex');
  assert.equal(normaliseClass('currencies'), 'forex');
  assert.equal(normaliseClass('CRYPTO'), 'crypto');
  assert.equal(normaliseClass('otc'), 'synthetic');
  assert.equal(normaliseClass('COMMODITY'), 'commodity');
  assert.equal(normaliseClass('nonsense'), '');
  assert.equal(normaliseClass(null), '');
});

/* ------------------------------- display ------------------------------ */

test('prettyOf renders every class readably, including long crypto names', () => {
  assert.equal(prettyOf('EURUSD_OTC'), 'EUR/USD OTC');
  assert.equal(prettyOf('USD/CAD_otc'), 'USD/CAD OTC');
  assert.equal(prettyOf('BTCUSD'), 'BTC/USD');
  assert.equal(prettyOf('BTCUSDT'), 'BTC/USDT');
  assert.equal(prettyOf('XAUUSD'), 'XAU/USD');
  assert.equal(prettyOf('1000SHIBUSDT'), '1000SHIB/USDT');
});

test('prettyOf falls back to the core for a name it cannot split', () => {
  assert.equal(prettyOf('QQQQQQ'), 'QQQQQQ');
  assert.equal(prettyOf(''), '—');
});

test('pretty never blanks out a value it was handed', () => {
  assert.equal(pretty('EURUSD_OTC'), 'EUR/USD OTC');
  assert.equal(pretty('something-odd'), 'something-odd');
  assert.equal(pretty(''), '—');
  assert.equal(pretty(null), '—');
});

/* ------------------------------- sessions ----------------------------- */

// A known week: Fri 2026-09-18, Sat 19, Sun 20, Mon 21 (all UTC).
const FRI_12 = Date.UTC(2026, 8, 18, 12, 0, 0);
const FRI_23 = Date.UTC(2026, 8, 18, 23, 0, 0);
const SAT_12 = Date.UTC(2026, 8, 19, 12, 0, 0);
const SUN_12 = Date.UTC(2026, 8, 20, 12, 0, 0);
const SUN_23 = Date.UTC(2026, 8, 20, 23, 0, 0);
const MON_09 = Date.UTC(2026, 8, 21, 9, 0, 0);

test('marketOpen: crypto and synthetic never close', () => {
  for (const cls of ['crypto', 'synthetic', 'unknown']) {
    for (const at of [FRI_23, SAT_12, SUN_12]) assert.ok(marketOpen(cls, at), `${cls} @ ${new Date(at).toUTCString()}`);
  }
});

test('marketOpen: forex and commodities close for the weekend', () => {
  for (const cls of ['forex', 'commodity']) {
    assert.ok(marketOpen(cls, FRI_12), 'Friday midday is open');
    assert.ok(!marketOpen(cls, FRI_23), 'Friday 23:00 UTC is closed');
    assert.ok(!marketOpen(cls, SAT_12), 'Saturday is closed');
    assert.ok(!marketOpen(cls, SUN_12), 'Sunday midday is closed');
    assert.ok(marketOpen(cls, SUN_23), 'Sunday 23:00 UTC has reopened');
    assert.ok(marketOpen(cls, MON_09), 'Monday is open');
  }
  assert.deepEqual([...WEEKEND_CLOSED].sort(), ['commodity', 'forex']);
});

test('marketOpen accepts a Date or a number and never throws on junk', () => {
  assert.ok(marketOpen('forex', new Date(FRI_12)));
  assert.ok(marketOpen('forex', FRI_12));
  assert.ok(marketOpen('forex', NaN) === marketOpen('forex')); // falls back to now
  assert.ok(marketOpen(null, FRI_12)); // unknown class is always open
});

test('closedReason explains a closure and is null when open', () => {
  assert.equal(closedReason('forex', SAT_12), 'Forex market is closed for the weekend — prices are frozen');
  assert.equal(closedReason('commodity', SAT_12), 'Metals market is closed for the weekend — prices are frozen');
  assert.equal(closedReason('crypto', SAT_12), null);
  assert.equal(closedReason('forex', MON_09), null);
});

/* ------------------------------ parameters ---------------------------- */

test('each asset class gets its own volatility band', () => {
  assert.deepEqual(volBand('forex'), { min: 0.00008, max: 0.012 });
  assert.deepEqual(volBand('crypto'), { min: 0.0002, max: 0.03 });
  assert.deepEqual(volBand('synthetic'), { min: 0.00003, max: 0.008 });
  // crypto is allowed to be wilder than forex — that is the whole point
  assert.ok(volBand('crypto').max > volBand('forex').max);
  // an unknown class falls back rather than returning undefined
  assert.deepEqual(volBand('nonsense'), volBand('unknown'));
  assert.deepEqual(volBand(undefined), volBand('unknown'));
});

test('each band is sane: positive, ordered, and inside (0,1)', () => {
  for (const cls of ['forex', 'crypto', 'commodity', 'synthetic', 'unknown']) {
    const b = volBand(cls);
    assert.ok(b.min > 0 && b.max > b.min && b.max < 1, cls);
  }
});

test('class payout defaults sit below the break-even maths they feed', () => {
  assert.equal(classPayout('forex'), 85);
  assert.equal(classPayout('crypto'), 75);
  assert.equal(classPayout('synthetic'), 80);
  assert.equal(classPayout('nonsense'), classPayout('unknown'));
  for (const cls of ['forex', 'crypto', 'commodity', 'synthetic', 'unknown']) {
    const p = classPayout(cls);
    assert.ok(p > 0 && p <= 200, cls);
  }
});

test('a lower payout really does demand a higher win rate (the reason 4 above matters)', () => {
  const be = (p) => 100 / (100 + p);
  assert.ok(be(classPayout('crypto')) > be(classPayout('forex')));
  assert.ok(Math.abs(be(86) - 0.5376) < 0.001);
  assert.ok(Math.abs(be(75) - 0.5714) < 0.001);
});
