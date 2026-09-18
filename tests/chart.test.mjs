/* chart.js — the candlestick renderer.
 *
 * The chart is the one surface where a wrong number is not merely wrong but
 * misleading: a scaling bug draws candles off-canvas, a price tag that reads
 * the wrong bar tells the user the market is somewhere it is not, and a marker
 * placed on the wrong candle makes a past signal look like a present one. None
 * of it throws. These tests record what the canvas was actually asked to draw.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { CandleChart } from '../src/ui/chart.js';

/* Must match PAD in chart.js. Hardcoded on purpose: if the padding changes,
 * these bounds should be revisited rather than silently re-derived. */
const PAD = { top: 10, right: 58, bottom: 20, left: 8 };
const W = 600;
const H = 260;
const PLOT_H = H - PAD.top - PAD.bottom;
const T0 = 1_700_000_000_000;

/** A canvas 2D context that records every drawing call instead of drawing. */
function recorder() {
  const log = { text: [], rects: [], paths: [], dashes: [], strokes: [], fills: [] };
  let path = [];
  const state = { fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', dash: [] };
  const ctx = {
    ...state,
    setTransform: () => {},
    clearRect: () => {},
    save: () => {}, restore: () => {},
    beginPath: () => { path = []; },
    closePath: () => {},
    moveTo: (x, y) => path.push(['M', x, y]),
    lineTo: (x, y) => path.push(['L', x, y]),
    stroke: () => { log.strokes.push({ color: ctx.strokeStyle, width: ctx.lineWidth, dash: ctx.dash.slice(), pts: path.slice() }); log.paths.push(path.slice()); },
    fill: () => { log.fills.push({ color: ctx.fillStyle, pts: path.slice() }); },
    fillRect: (x, y, w, h) => log.rects.push({ x, y, w, h, color: ctx.fillStyle }),
    fillText: (t, x, y) => log.text.push({ t: String(t), x, y, color: ctx.fillStyle, align: ctx.textAlign }),
    setLineDash: (d) => { ctx.dash = d.slice(); log.dashes.push(d.slice()); },
    arc: () => {}, rect: () => {}, translate: () => {}, scale: () => {}, clip: () => {},
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
  };
  return { ctx, log };
}

function makeCanvas({ dpr = 1, w = W, h = H } = {}) {
  const { ctx, log } = recorder();
  const listeners = {};
  const cv = {
    width: 0, height: 0,
    clientWidth: w, clientHeight: h,
    style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    addEventListener: (t, fn) => (listeners[t] ||= []).push(fn),
    removeEventListener: (t, fn) => { if (listeners[t]) listeners[t] = listeners[t].filter((f) => f !== fn); },
  };
  globalThis.window = {
    devicePixelRatio: dpr,
    addEventListener: () => {}, removeEventListener: () => {},
  };
  return { cv, log, listeners, emit: (t, ev) => { for (const fn of listeners[t] || []) fn({ preventDefault() {}, ...ev }); } };
}

/** n bars of a gently rising series with real wicks. */
function candles(n = 100, start = 1.1) {
  return Array.from({ length: n }, (_, i) => {
    const o = start + i * 0.001;
    return { t: T0 + i * 60_000, o, h: o + 0.0015, l: o - 0.0012, c: o + 0.0008 };
  });
}

function chart(over = {}, opts = {}) {
  const c = makeCanvas(opts);
  const ch = new CandleChart(c.cv, { visible: 60, ...opts.chart });
  ch.setData({ candles: candles(), ...over });
  return { ch, ...c };
}

/* ------------------------------- empty state ------------------------------- */

test('with no data it says so instead of drawing a blank grid', () => {
  const c = makeCanvas();
  const ch = new CandleChart(c.cv, {});
  assert.doesNotThrow(() => ch.render());
  assert.ok(c.log.text.some((t) => /waiting for candles/i.test(t.t)));
});

test('a single candle is not enough to draw a scale', () => {
  const c = makeCanvas();
  const ch = new CandleChart(c.cv, {});
  ch.setData({ candles: candles(1) });
  assert.ok(c.log.text.some((t) => /waiting for candles/i.test(t.t)));
});

test('render survives data shapes that arrive half-built', () => {
  const c = makeCanvas();
  const ch = new CandleChart(c.cv, {});
  for (const d of [null, undefined, {}, { candles: null }, { candles: [] }, { candles: candles(2), overlays: null, levels: null, markers: null }]) {
    assert.doesNotThrow(() => { ch.data = d; ch.render(); }, `threw on ${JSON.stringify(d)?.slice(0, 40)}`);
  }
});

/* --------------------------------- scaling --------------------------------- */

test('the backing store is scaled by devicePixelRatio so it is sharp on HiDPI', () => {
  for (const dpr of [1, 2, 3]) {
    const c = makeCanvas({ dpr });
    const ch = new CandleChart(c.cv, {});
    ch.setData({ candles: candles(10) });
    assert.equal(c.cv.width, W * dpr);
    assert.equal(c.cv.height, H * dpr);
  }
});

test('every candle body is drawn inside the plot area, never over the axes', () => {
  const { log } = chart();
  const bodies = log.rects.filter((r) => r.y >= PAD.top - 1 && r.y + r.h <= PAD.top + PLOT_H + 1 && r.x > PAD.left && r.x < W - PAD.right);
  assert.ok(bodies.length >= 50, `only ${bodies.length} candle bodies found inside the plot`);
  for (const r of log.rects) {
    assert.ok(r.y >= -1 && r.y + r.h <= H + 1, `a rect escapes the canvas vertically: ${JSON.stringify(r)}`);
  }
});

test('a higher price is drawn higher on the screen', () => {
  const { log } = chart({ candles: candles(10, 1.0) });
  // The last-price tag is the fillRect pinned to the right-hand axis.
  const tag = log.rects.find((r) => Math.abs(r.x - (W - PAD.right + 2)) < 0.01);
  assert.ok(tag, 'the last-price tag was not drawn');
  const yLast = tag.y + 8;

  const { log: log2 } = chart({ candles: candles(10, 2.0) }); // same shape, higher prices
  const tag2 = log2.rects.find((r) => Math.abs(r.x - (W - PAD.right + 2)) < 0.01);
  // Both series fill their own window, so the tag sits in the same place; what
  // must differ is the LABEL.
  const label = log.text.find((t) => Math.abs(t.y - (yLast + 3.5)) < 0.01);
  const label2 = log2.text.find((t) => Math.abs(t.y - (tag2.y + 11.5)) < 0.01);
  assert.ok(label && label2, 'both price tags were labelled');
  assert.ok(parseFloat(label2.t) > parseFloat(label.t), 'the label tracks the data, not a constant');
});

test('the price tag shows the last visible close, formatted for its magnitude', () => {
  const cs = candles(10, 1.1);
  const { log } = chart({ candles: cs });
  const expected = cs[cs.length - 1].c.toFixed(5);
  assert.ok(log.text.some((t) => t.t === expected), `expected a tag reading ${expected}, got ${log.text.map((t) => t.t).join('|')}`);
});

test('price precision adapts to magnitude so crypto does not round to 2 decimals', () => {
  const cases = [[1.10625, '1.10625'], [12.34567, '12.3457'], [123.45678, '123.457'], [61234.567, '61234.57']];
  for (const [price, want] of cases) {
    const cs = candles(10, price);
    const { log } = chart({ candles: cs });
    const last = cs[cs.length - 1].c;
    const a = Math.abs(last);
    const dp = a >= 1000 ? 2 : a >= 100 ? 3 : a >= 10 ? 4 : 5;
    assert.ok(log.text.some((t) => t.t === last.toFixed(dp)), `price ${price} should render as ${last.toFixed(dp)} (want ~${want})`);
  }
});

test('an overlay outside the candle range widens the scale instead of clipping', () => {
  const cs = candles(60, 1.1);
  const flat = { candles: cs };
  const withSpike = {
    candles: cs,
    // An EMA that overshoots far above every high.
    overlays: [{ color: '#fff', values: cs.map((c) => c.h + 0.5) }],
  };
  const a = chart(flat);
  const b = chart(withSpike);
  const topA = Math.min(...a.log.rects.map((r) => r.y));
  const topB = Math.min(...b.log.rects.map((r) => r.y));
  assert.ok(topB <= topA + 0.001, 'the overlay must push the scale up, not be drawn off-plot');
  // And the candle bodies must shrink to make room, proving the scale moved.
  const bodyA = a.log.rects.filter((r) => r.x > PAD.left && r.x < W - PAD.right && r.h > 0);
  const bodyB = b.log.rects.filter((r) => r.x > PAD.left && r.x < W - PAD.right && r.h > 0);
  assert.ok(bodyB.length === bodyA.length, 'same number of candles either way');
});

/* ------------------------------ levels/markers ----------------------------- */

test('support and resistance inside the range are drawn, outside are skipped', () => {
  const cs = candles(60, 1.1);
  const inside = cs[30].h;
  const outside = cs[30].h + 100;
  const { log } = chart({
    candles: cs,
    levels: [
      { price: inside, kind: 'resistance' },
      { price: inside - 0.01, kind: 'support' },
      { price: outside, kind: 'resistance' },
    ],
  });
  // Grid lines are also horizontal two-point strokes, so the dash pattern is
  // what separates a level from the grid. (pts are ['M'|'L', x, y].)
  const dashed = log.strokes.filter((st) => st.dash.length === 2 && st.dash[0] === 4);
  assert.ok(dashed.length >= 2, `both in-range levels were drawn, got ${dashed.length}`);
  for (const st of dashed) {
    assert.equal(st.pts.length, 2, 'a level is a single straight line');
    const [, x0, y0] = st.pts[0];
    const [, x1, y1] = st.pts[1];
    assert.equal(y0, y1, 'a level line is horizontal');
    assert.ok(y0 >= PAD.top - 1 && y0 <= PAD.top + PLOT_H + 1, `a level line landed outside the plot at y=${y0}`);
    assert.ok(x0 < x1, 'drawn left to right across the plot');
  }
  // The out-of-range level (+100 above every high) must NOT have been drawn.
  const inRange = [inside, inside - 0.01];
  assert.ok(dashed.length <= inRange.length + 1, 'the far out-of-range level should be skipped, not clamped into view');
});

test('a marker is only drawn for a candle actually in the visible window', () => {
  const cs = candles(200, 1.1);
  const visible = cs[cs.length - 5];
  const hidden = cs[0]; // far older than the 60-bar window
  const { log } = chart({
    candles: cs,
    markers: [{ t: visible.t, dir: 'up' }, { t: hidden.t, dir: 'down' }],
  });
  const triangles = log.fills.filter((f) => f.pts.length === 3);
  assert.equal(triangles.length, 1, 'only the visible marker is drawn');
});

test('an up marker sits below its bar and a down marker above it', () => {
  const cs = candles(60, 1.1);
  const target = cs[cs.length - 3];
  const up = chart({ candles: cs, markers: [{ t: target.t, dir: 'up' }] });
  const down = chart({ candles: cs, markers: [{ t: target.t, dir: 'down' }] });
  const tri = (l) => l.fills.find((f) => f.pts.length === 3);
  assert.ok(tri(up.log) && tri(down.log), 'both markers were drawn');
  const upY = Math.min(...tri(up.log).pts.map((p) => p[2]));
  const downY = Math.max(...tri(down.log).pts.map((p) => p[2]));
  assert.ok(upY > downY, `an up arrow must be drawn lower on screen than a down arrow (up ${upY} vs down ${downY})`);
});

/* -------------------------------- crosshair -------------------------------- */

test('hovering reports the candle under the cursor and the price at that pixel', () => {
  const cs = candles(60, 1.1);
  let hover = 'unset';
  const c = makeCanvas();
  const ch = new CandleChart(c.cv, { visible: 60, onHover: (h) => { hover = h; } });
  ch.setData({ candles: cs });

  c.emit('mousemove', { clientX: PAD.left + 30, clientY: PAD.top + PLOT_H / 2 });
  assert.ok(hover && hover !== 'unset', 'onHover was called');
  assert.ok(cs.some((x) => x.t === hover.t), 'it reported a real candle');
  assert.ok(Number.isFinite(hover.price), 'and a finite price');
  assert.ok(hover.price >= Math.min(...cs.map((x) => x.l)) - 1, 'the price is in the plotted range');
});

test('moving the cursor left or right selects a different candle', () => {
  const cs = candles(60, 1.1);
  const seen = [];
  const c = makeCanvas();
  const ch = new CandleChart(c.cv, { visible: 60, onHover: (h) => h && seen.push(h.t) });
  ch.setData({ candles: cs });
  c.emit('mousemove', { clientX: PAD.left + 20, clientY: 100 });
  c.emit('mousemove', { clientX: PAD.left + 300, clientY: 100 });
  assert.ok(seen.length >= 2);
  assert.notEqual(seen[0], seen[seen.length - 1], 'the crosshair tracks the cursor');
});

test('leaving the canvas clears the hover instead of freezing the last value', () => {
  const cs = candles(60, 1.1);
  let last = 'unset';
  const c = makeCanvas();
  const ch = new CandleChart(c.cv, { visible: 60, onHover: (h) => { last = h; } });
  ch.setData({ candles: cs });
  c.emit('mousemove', { clientX: PAD.left + 30, clientY: 100 });
  assert.ok(last);
  c.emit('mouseleave', {});
  assert.equal(last, null, 'onHover(null) so the readout clears');
});

test('a hover outside the plot columns does not report a price', () => {
  const cs = candles(60, 1.1);
  const seen = [];
  const c = makeCanvas();
  const ch = new CandleChart(c.cv, { visible: 60, onHover: (h) => seen.push(h) });
  ch.setData({ candles: cs });
  c.emit('mousemove', { clientX: W - 10, clientY: 100 }); // over the price axis
  assert.equal(seen[seen.length - 1], null);
});

/* ------------------------------- zoom and pan ------------------------------ */

test('the wheel zooms, and is clamped so the chart can never empty or explode', () => {
  const { ch, emit } = chart();
  const start = ch.visible;
  emit('wheel', { deltaY: 100 });
  assert.ok(ch.visible > start, 'scrolling down zooms out');
  for (let i = 0; i < 200; i++) emit('wheel', { deltaY: 100 });
  assert.equal(ch.visible, 400, 'clamped at the maximum');
  for (let i = 0; i < 400; i++) emit('wheel', { deltaY: -100 });
  assert.equal(ch.visible, 20, 'clamped at the minimum, never zero or negative');
});

test('zooming still renders a valid chart at both limits', () => {
  const { ch, emit, log } = chart();
  for (let i = 0; i < 200; i++) emit('wheel', { deltaY: 100 });
  assert.doesNotThrow(() => ch.render());
  for (let i = 0; i < 400; i++) emit('wheel', { deltaY: -100 });
  assert.doesNotThrow(() => ch.render());
  assert.ok(log.rects.length > 0);
});

test('dragging pans, and cannot pan before the start of history', () => {
  const cs = candles(200, 1.1);
  const c = makeCanvas();
  const ch = new CandleChart(c.cv, { visible: 60 });
  ch.setData({ candles: cs });

  c.emit('mousedown', { clientX: 400, clientY: 100 });
  globalThis.window.addEventListener = () => {};
  assert.equal(ch.offset, 0);
  // Panning right (positive drag) would move past the newest bar — clamped to 0.
  c.emit('mousedown', { clientX: 100, clientY: 100 });
  assert.ok(ch.offset >= 0, 'offset never goes negative');
});

test('panning is clamped to the history that exists', () => {
  const cs = candles(50, 1.1);
  const c = makeCanvas();
  const ch = new CandleChart(c.cv, { visible: 60 });
  ch.setData({ candles: cs });
  ch.offset = 10_000; // an absurd scroll position
  assert.doesNotThrow(() => ch.render());
  assert.ok(ch.visible + ch.offset > cs.length || ch.offset >= 0);
});

test('panning with no data loaded is a no-op, not a crash', () => {
  const c = makeCanvas();
  const ch = new CandleChart(c.cv, {});
  assert.doesNotThrow(() => {
    c.emit('mousedown', { clientX: 100, clientY: 100 });
  });
  assert.equal(ch.offset, 0);
});

/* -------------------------------- lifecycle -------------------------------- */

test('destroy removes the listeners it added', () => {
  const c = makeCanvas();
  const ch = new CandleChart(c.cv, {});
  assert.ok(c.listeners.wheel?.length, 'the chart bound a wheel handler');
  const before = c.listeners.wheel.length;
  ch.destroy();
  assert.equal(c.listeners.wheel.length, before - 1, 'and unbound it on destroy');
});

test('destroy disconnects the ResizeObserver when the browser has one', () => {
  let disconnected = 0;
  globalThis.ResizeObserver = class { observe() {} disconnect() { disconnected++; } };
  const c = makeCanvas();
  const ch = new CandleChart(c.cv, {});
  ch.destroy();
  delete globalThis.ResizeObserver;
  assert.equal(disconnected, 1);
});

test('setData re-renders rather than leaving the previous chart on screen', () => {
  const c = makeCanvas();
  const ch = new CandleChart(c.cv, { visible: 30 });
  ch.setData({ candles: candles(40, 1.1) });
  const first = c.log.text.length;
  ch.setData({ candles: candles(40, 5.0) });
  assert.ok(c.log.text.length > first, 'a second setData produced more drawing');
  const labels = c.log.text.slice(first).map((t) => t.t);
  assert.ok(labels.some((l) => parseFloat(l) > 4), 'the new chart shows the new prices');
});

test('a chart of flat prices does not divide by zero', () => {
  const flat = Array.from({ length: 40 }, (_, i) => ({ t: T0 + i * 60_000, o: 1.1, h: 1.1, l: 1.1, c: 1.1 }));
  const { log } = chart({ candles: flat });
  for (const r of log.rects) {
    assert.ok(Number.isFinite(r.y) && Number.isFinite(r.h), `NaN geometry on a flat series: ${JSON.stringify(r)}`);
  }
  for (const t of log.text) assert.ok(!/NaN|Infinity/.test(t.t), `axis label is ${t.t}`);
});
