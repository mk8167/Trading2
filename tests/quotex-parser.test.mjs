import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extract, isSymbol, normalizeSymbol, prettySymbol, isOtc,
  stripEnvelope, rowToCandle, tryTickRow, sampleOf, decodeFrame, base64ToText,
} from '../src/background/parsers/quotex.js';

const TS = 1_789_690_148; // epoch seconds, the shape Quotex sends

test('symbol validation and formatting', () => {
  assert.ok(isSymbol('EURUSD_OTC'));
  assert.ok(isSymbol('USD/CAD_OTC'));
  assert.ok(isSymbol('BTC/USD'));
  assert.ok(!isSymbol('TOOLONGSYMBOL/XYZ'));
  assert.ok(!isSymbol('abc'));
  assert.equal(normalizeSymbol(' eur/usd_otc '), 'EUR/USD_OTC');
  assert.equal(prettySymbol('EURUSD_OTC'), 'EUR/USD OTC');
  assert.equal(prettySymbol('BTC/USD'), 'BTC/USD');
  assert.ok(isOtc('XAUUSD_otc'));
  assert.ok(!isOtc('XAU/USD'));
});

test('parses the real Quotex array tick shape', () => {
  const r = extract('["USD/CAD_otc",' + TS + '.68,1.41746,1]');
  assert.equal(r.ticks.length, 1);
  assert.equal(r.ticks[0].sym, 'USD/CAD_OTC');
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
  assert.equal(r.ticks[0].sym, 'USD/CAD_OTC');
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
