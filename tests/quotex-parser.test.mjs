import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extract, isSymbol, normalizeSymbol, prettySymbol, isOtc,
  stripEnvelope, rowToCandle, tryTickRow, sampleOf, decodeFrame, base64ToText,
  asNumber, eventKind, singleCandleRow, singleTickRow,
} from '../src/background/parsers/quotex.js';

const TS = 1_789_690_148; // epoch seconds, the shape Quotex sends

test('symbol validation and formatting', () => {
  assert.ok(isSymbol('EURUSD_OTC'));
  assert.ok(isSymbol('USD/CAD_OTC'));
  assert.ok(isSymbol('BTC/USD'));
  assert.ok(!isSymbol('TOOLONGSYMBOL/XYZ'));
  assert.ok(!isSymbol('abc'));
  // Canonicalisation is the point: every spelling of one instrument must
  // collapse onto ONE key, or its candle history splits in two and every
  // number derived from it is computed from half the data.
  assert.equal(normalizeSymbol(' eur/usd_otc '), 'EURUSD_OTC');
  assert.equal(normalizeSymbol('EURUSD_otc'), normalizeSymbol('eur/usd_otc'));
  assert.equal(normalizeSymbol('USD/CAD_otc'), normalizeSymbol('USDCAD_OTC'));
  assert.equal(normalizeSymbol('BTC/USD'), normalizeSymbol('btc-usd'));
  assert.equal(prettySymbol('EURUSD_OTC'), 'EUR/USD OTC');
  assert.equal(prettySymbol('BTC/USD'), 'BTC/USD');
  assert.ok(isOtc('XAUUSD_otc'));
  assert.ok(!isOtc('XAU/USD'));
});

test('crypto names carrying digits or dashes are no longer dropped', () => {
  // The old `[A-Z]{2,6}` pattern rejected all of these, silently.
  assert.ok(isSymbol('BTCUSDT'));
  assert.ok(isSymbol('1000SHIBUSD'));
  assert.ok(isSymbol('BTC-USD'));
  assert.equal(normalizeSymbol('1000SHIB/USDT'), '1000SHIBUSDT');
  const r = extract(JSON.stringify({ symbol: 'BTCUSDT', price: 65432.1, t: TS }));
  assert.equal(r.ticks.length, 1);
  assert.equal(r.ticks[0].sym, 'BTCUSDT');
});

test('a payout is captured even when the frame carries no price', () => {
  // This is the shape of the broker's asset list, and it is the ONLY place
  // the real payout is ever announced.
  const r = extract(JSON.stringify({ symbol: 'PLAT/USD_otc', payout: 79 }));
  assert.equal(r.payouts.length, 1, 'an asset-list frame must yield its payout');
  assert.equal(r.payouts[0].sym, 'PLATUSD_OTC');
  assert.equal(r.payouts[0].payout, 79);
  assert.equal(r.ticks.length, 0, 'and no tick is invented from it');

  // A whole asset list in one frame.
  const list = extract(JSON.stringify({ assets: [
    { s: 'EURUSD_otc', payout: 92 },
    { s: 'BTCUSD', payout: 76 },
    { s: 'XAUUSD', payout: 84 },
  ] }));
  assert.equal(list.payouts.length, 3);
  assert.deepEqual(list.payouts.map((p) => p.sym), ['EURUSD_OTC', 'BTCUSD', 'XAUUSD']);

  // Out-of-range payouts are still refused.
  assert.equal(extract(JSON.stringify({ symbol: 'EURUSD_otc', payout: 0 })).payouts.length, 0);
  assert.equal(extract(JSON.stringify({ symbol: 'EURUSD_otc', payout: 500 })).payouts.length, 0);
});

test('price and payout together still produce both, exactly once each', () => {
  const r = extract(JSON.stringify({ symbol: 'EURUSD_otc', price: 1.08, payout: 92, t: TS }));
  assert.equal(r.ticks.length, 1);
  assert.equal(r.payouts.length, 1, 'no duplicate payout entry');
});

test('a broker-declared asset type is captured as authoritative metadata', () => {
  const r = extract(JSON.stringify({ symbol: 'XYZUSD', type: 'crypto', price: 1.5, t: TS }));
  assert.equal(r.meta.length, 1);
  assert.equal(r.meta[0].sym, 'XYZUSD');
  assert.equal(r.meta[0].type, 'crypto');
  assert.ok(r.methods.includes('asset-type'));

  const r2 = extract(JSON.stringify({ symbol: 'EURUSD', otc: true, price: 1.1, t: TS }));
  assert.equal(r2.meta[0].otc, true);

  // No type field -> no metadata, and nothing crashes.
  assert.equal(extract(JSON.stringify({ symbol: 'EURUSD', price: 1.1, t: TS })).meta.length, 0);
});

test('parses the real Quotex array tick shape', () => {
  const r = extract('["USD/CAD_otc",' + TS + '.68,1.41746,1]');
  assert.equal(r.ticks.length, 1);
  assert.equal(r.ticks[0].sym, 'USDCAD_OTC', 'slash form collapses onto the canonical key');
  assert.equal(r.ticks[0].price, 1.41746);
  assert.equal(r.ticks[0].ts, 1_789_690_148_680, 'fractional seconds are preserved');
  assert.ok(r.methods.includes('json-walk'));
});

test('parses a socket.io envelope around a batch of ticks', () => {
  const payload = '42["quotes",[{"s":"EURUSD_otc","p":1.08432,"t":' + TS + '},{"s":"GBPJPY_otc","p":189.421,"t":' + TS + '}]]';
  const r = extract(payload);
  assert.equal(r.ticks.length, 2);
  assert.deepEqual(r.ticks.map((t) => t.sym), ['EURUSD_OTC', 'GBPJPY_OTC']);
  assert.equal(r.ticks[0].price, 1.08432);
});

test('stripEnvelope removes engine.io framing', () => {
  assert.equal(stripEnvelope('42["a",1]'), '["a",1]');
  assert.equal(stripEnvelope('40{"sid":"x"}'), '{"sid":"x"}');
  assert.equal(stripEnvelope('2probe'), 'probe');
  assert.equal(stripEnvelope('{"a":1}'), '{"a":1}');
});

test('parses object-style quotes with alternate key names', () => {
  const r = extract(JSON.stringify({ data: { asset: 'XAUUSD_otc', rate: 2331.55, timestamp: TS } }));
  assert.equal(r.ticks.length, 1);
  assert.equal(r.ticks[0].sym, 'XAUUSD_OTC');
  assert.equal(r.ticks[0].price, 2331.55);
});

test('picks up payout alongside a quote', () => {
  const r = extract(JSON.stringify({ symbol: 'EURUSD_otc', price: 1.08, payout: 92 }));
  assert.equal(r.payouts.length, 1);
  assert.equal(r.payouts[0].payout, 92);
});

test('falls back to regex when the payload is not valid JSON', () => {
  const broken = 'garbage-prefix 42["tick","USD/CAD_otc",' + TS + '.5,1.41746,1 truncated-json';
  const r = extract(broken);
  assert.equal(r.ticks.length >= 1, true, 'regex fallback should still find the tick');
  assert.equal(r.ticks[0].sym, 'USDCAD_OTC');
  assert.ok(r.methods.includes('regex'));
});

test('refuses to guess when a row has no epoch timestamp', () => {
  // 20 could be a price or a flag; without a clock we must not pick one.
  assert.equal(extract('["EURUSD_otc",20,1.08,1]').ticks.length, 0);
});

test('never mistakes the trailing flag for a price', () => {
  assert.equal(extract('["EURUSD_otc",' + TS + ',-1.08,1]').ticks.length, 0, 'negative price rejected');
  assert.equal(extract('["EURUSD_otc",' + TS + ',0,1]').ticks.length, 0, 'zero price rejected');
  const r = extract('["EURUSD_otc",' + TS + ',1.08,1]');
  assert.equal(r.ticks.length, 1);
  assert.equal(r.ticks[0].price, 1.08, 'price comes from the slot after the timestamp');
  assert.equal(r.ticks[0].ts, TS * 1000);
});

test('rejects impossible prices', () => {
  assert.equal(extract('["EURUSD_otc",1,0,1]').ticks.length, 0, 'zero price');
});

test('parses history rows in [t,o,h,l,c] order', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push([TS + i * 60, 1.1 + i * 0.001, 1.11 + i * 0.001, 1.09 + i * 0.001, 1.105 + i * 0.001]);
  const r = extract(JSON.stringify({ symbol: 'EURUSD_otc', candles: rows }));
  assert.equal(r.history.length, 1);
  assert.equal(r.history[0].sym, 'EURUSD_OTC');
  assert.equal(r.history[0].rows.length, 10);
  const c = r.history[0].rows[0];
  assert.equal(c.t, TS * 1000);
  assert.ok(c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c));
});

test('rowToCandle picks the only self-consistent column order', () => {
  const t = 1_700_000_000_000;
  const ohlc = rowToCandle([t, 1.1, 1.2, 1.0, 1.15]);
  assert.deepEqual(ohlc, { t, o: 1.1, h: 1.2, l: 1.0, c: 1.15 });
  const oclh = rowToCandle([t, 1.1, 1.15, 1.2, 1.0]); // [t,o,c,h,l]
  assert.equal(oclh.o, 1.1);
  assert.equal(oclh.c, 1.15);
  assert.equal(oclh.h, 1.2);
  assert.equal(oclh.l, 1.0);
  assert.equal(rowToCandle([t, 1, 2]), null, 'too short');
  assert.equal(rowToCandle([t, NaN, 1, 1, 1]), null);
});

test('tryTickRow needs both a symbol and a price', () => {
  assert.deepEqual(tryTickRow(['EURUSD_otc', TS, 1.08, 1]), { sym: 'EURUSD_otc', price: 1.08, ts: TS });
  assert.equal(tryTickRow([1, 2, 3]), null);
  assert.equal(tryTickRow(['EURUSD_otc', 1]), null);
  assert.equal(tryTickRow(null), null);
});

test('decodeFrame handles strings, base64 and typed arrays', () => {
  assert.equal(decodeFrame('hello'), 'hello');
  assert.equal(decodeFrame(base64Of('hello world'), { isBinary: true }), 'hello world');
  assert.equal(decodeFrame(new TextEncoder().encode('bytes here')), 'bytes here');
  assert.equal(decodeFrame(null), '');
});

function base64Of(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

test('sampleOf fingerprints unparsed payloads for the Protocol Lab', () => {
  const s = sampleOf('some   binary-ish   payload');
  assert.equal(s.looksJson, false);
  assert.ok(s.len > 0);
  assert.ok(s.at > 0);
  assert.equal(sampleOf(''), null);
  assert.equal(sampleOf('{"a":1}').looksJson, true);
});

test('extract never throws on hostile input', () => {
  for (const bad of [null, undefined, 123, {}, [], '{{{', '"', 'x'.repeat(300_000), '\u0000\u0001\u0002']) {
    assert.doesNotThrow(() => extract(bad));
  }
});

/* ------------------- shapes a live socket actually sends ------------- */

/* The frames below are what a socket.io broker page sends. Each one used to
 * fall through every extraction path: the payloads parse, but nothing was
 * read out of them, so the site's chart moved while the extension sat still
 * and the only trace was a Protocol Lab sample. */

test('a price that arrives as a string is a price', () => {
  const r = extract('42["quote",{"s":"EURUSD_otc","p":"1.0845","t":"1789690148"}]');
  assert.equal(r.ticks.length, 1);
  assert.equal(r.ticks[0].price, 1.0845);
  assert.equal(r.ticks[0].ts, 1_789_690_148_000);
  assert.equal(asNumber('1.0845'), 1.0845);
  assert.equal(asNumber(' 2 '), 2);
  assert.equal(asNumber('EURUSD'), null, 'a symbol is not a number');
  assert.equal(asNumber('1.08.45'), null);
});

test('the regex fallback reads quoted numbers too', () => {
  const r = extract('{"EURUSD_otc":{"price":"1.0845"}}'.replace(/"/g, '"') + '  ');
  assert.equal(r.ticks.length, 1);
  assert.equal(r.ticks[0].price, 1.0845);
});

test('a named socket.io event tells the parser what its numbers mean', () => {
  assert.equal(eventKind('history'), 'candles');
  assert.equal(eventKind('candles.update'), 'candles');
  assert.equal(eventKind('quote'), 'tick');
  assert.equal(eventKind('tick'), 'tick');
  assert.equal(eventKind('balance'), null);
});

test('a candle sent on its own is stored, not ignored', () => {
  const r = extract(`42["candle",{"s":"EURUSD_otc","data":[${TS},1.0840,1.0852,1.0838,1.0849]}]`);
  assert.equal(r.history.length, 1);
  assert.equal(r.history[0].sym, 'EURUSD_OTC');
  assert.equal(r.history[0].rows[0].o, 1.084);
  assert.equal(r.history[0].rows[0].c, 1.0849);
});

test('a one-off candle row with no event name is refused, not guessed', () => {
  // No label and no parent symbol: [t,o,h,l,c] here is indistinguishable from
  // any other list of five numbers, so it must not become a candle.
  assert.equal(singleCandleRow([TS, 1, 2, 0.5, 1.5]) !== null, true);
  const r = extract(`{"x":[${TS},1.0840,1.0852,1.0838,1.0849]}`);
  assert.equal(r.history.length, 0, 'no symbol anywhere -> nothing to file it under');

  // A flat row is a tick repeated, not a candle.
  assert.equal(singleCandleRow([TS, 1.0845, 1.0845, 1.0845, 1.0845]), null);
  // An array of five prices is not a candle either (no clock).
  assert.equal(singleCandleRow([1.08, 1.09, 1.07, 1.085, 1.086]), null);
});

test('a bare [timestamp, price] pair from a quote event is a tick', () => {
  assert.deepEqual(singleTickRow([TS, 1.0845]), { ts: TS, price: 1.0845 });
  assert.deepEqual(singleTickRow([1.0845, TS]), { ts: TS, price: 1.0845 });
  assert.equal(singleTickRow([1.0845, 1.0855]), null, 'two prices have no clock');
  const r = extract(`42["quote",{"s":"EURUSD_otc","data":[[${TS},1.0845]]}]`);
  assert.equal(r.ticks.length, 1);
  assert.equal(r.ticks[0].price, 1.0845);
});
