/* ------------------------------------------------------------------
 * chart.js — dependency-free candlestick chart on a 2D canvas.
 *
 * Deliberately not a library: an extension side panel cannot load a CDN
 * (CSP), and a purpose-built renderer stays sharp on HiDPI screens
 * because it re-scales to devicePixelRatio on every resize.
 * ----------------------------------------------------------------*/

const PAD = { top: 10, right: 58, bottom: 20, left: 8 };
const COL = {
  bg: '#080d13',
  grid: '#141d27',
  axis: '#5d6d7f',
  up: '#2fbf71',
  down: '#e04b5b',
  cross: '#4ea1ff',
  support: 'rgba(61,220,132,.55)',
  resistance: 'rgba(255,92,108,.55)',
};

export class CandleChart {
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.visible = opts.visible || 90;
    this.offset = 0; // bars scrolled in from the right edge
    this.data = null;
    this.hover = null;
    this.onHover = opts.onHover || null;

    this._bind();
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.render());
      this._ro.observe(canvas);
    }
  }

  destroy() {
    this._ro?.disconnect();
    this._unbound?.();
  }

  _bind() {
    const cv = this.cv;
    const onWheel = (e) => {
      e.preventDefault();
      const delta = Math.sign(e.deltaY) * Math.max(2, Math.round(this.visible * 0.1));
      this.visible = Math.max(20, Math.min(400, this.visible + delta));
      this.render();
    };
    const onMove = (e) => {
      const r = cv.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.render();
    };
    const onLeave = () => {
      this.hover = null;
      this.render();
    };
    let drag = null;
    const onDown = (e) => {
      drag = { x: e.clientX, offset: this.offset };
      cv.style.cursor = 'grabbing';
    };
    const onUp = () => {
      drag = null;
      cv.style.cursor = '';
    };
    const onDrag = (e) => {
      if (!drag || !this.data?.candles?.length) return;
      const w = cv.clientWidth - PAD.left - PAD.right;
      const bw = w / this.visible;
      const moved = Math.round((e.clientX - drag.x) / bw);
      this.offset = Math.max(0, Math.min(this.data.candles.length - 10, drag.offset + moved));
      this.render();
    };

    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('mousemove', onMove);
    cv.addEventListener('mouseleave', onLeave);
    cv.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('mousemove', onDrag);
    this._unbound = () => {
      cv.removeEventListener('wheel', onWheel);
      cv.removeEventListener('mousemove', onMove);
      cv.removeEventListener('mouseleave', onLeave);
      cv.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('mousemove', onDrag);
    };
  }

  setData(data) {
    this.data = data;
    this.render();
  }

  /** Resize the backing store to the device pixel ratio, then draw. */
  render() {
    const cv = this.cv;
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 600;
    const h = cv.clientHeight || 260;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, w, h);

    const all = this.data?.candles;
    if (!all || all.length < 2) {
      ctx.fillStyle = COL.axis;
      ctx.font = '12px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('waiting for candles…', w / 2, h / 2);
      return;
    }

    const count = Math.min(this.visible + this.offset, all.length);
    const cs = all.slice(all.length - count, all.length - this.offset || all.length);
    if (cs.length < 2) return;

    const plotW = w - PAD.left - PAD.right;
    const plotH = h - PAD.top - PAD.bottom;
    const bw = plotW / cs.length;

    let lo = Infinity;
    let hi = -Infinity;
    for (const c of cs) {
      if (c.l < lo) lo = c.l;
      if (c.h > hi) hi = c.h;
    }
    for (const o of this.data.overlays || []) {
      for (let i = 0; i < cs.length; i++) {
        const v = o.values?.[all.length - cs.length + i];
        if (v == null) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const padY = (hi - lo) * 0.08 || 1;
    lo -= padY;
    hi += padY;
    const span = hi - lo || 1;

    const x = (i) => PAD.left + i * bw + bw / 2;
    const y = (v) => PAD.top + plotH - ((v - lo) / span) * plotH;

    /* grid + price axis */
    ctx.strokeStyle = COL.grid;
    ctx.fillStyle = COL.axis;
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.lineWidth = 1;
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const v = lo + (span * i) / steps;
      const gy = Math.round(y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.left, gy);
      ctx.lineTo(w - PAD.right, gy);
      ctx.stroke();
      ctx.fillText(fmt(v), w - PAD.right + 6, gy + 3);
    }

    /* time axis */
    ctx.textAlign = 'center';
    const every = Math.max(1, Math.floor(cs.length / 6));
    for (let i = 0; i < cs.length; i += every) {
      ctx.fillText(clock(cs[i].t), x(i), h - 6);
    }

    /* candles */
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      const cx = x(i);
      const up = c.c >= c.o;
      ctx.strokeStyle = up ? COL.up : COL.down;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(cx, y(c.h));
      ctx.lineTo(cx, y(c.l));
      ctx.stroke();
      const top = y(Math.max(c.o, c.c));
      const bot = y(Math.min(c.o, c.c));
      ctx.fillRect(cx - bw * 0.32, top, Math.max(1, bw * 0.64), Math.max(1, bot - top));
    }

    /* overlays (EMAs) */
    for (const o of this.data.overlays || []) {
      if (!o.values) continue;
      ctx.strokeStyle = o.color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < cs.length; i++) {
        const v = o.values[all.length - cs.length + i];
        if (v == null) continue;
        const px = x(i);
        const py = y(v);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    /* support / resistance */
    for (const lv of this.data.levels || []) {
      if (lv.price < lo || lv.price > hi) continue;
      const ly = Math.round(y(lv.price)) + 0.5;
      ctx.strokeStyle = lv.kind === 'resistance' ? COL.resistance : COL.support;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(PAD.left, ly);
      ctx.lineTo(w - PAD.right, ly);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /* signal markers */
    for (const m of this.data.markers || []) {
      const idx = cs.findIndex((c) => c.t === m.t);
      if (idx < 0) continue;
      const cx = x(idx);
      const cy = m.dir === 'up' ? y(cs[idx].l) + 12 : y(cs[idx].h) - 12;
      ctx.fillStyle = m.dir === 'up' ? COL.up : COL.down;
      ctx.beginPath();
      if (m.dir === 'up') {
        ctx.moveTo(cx, cy - 6); ctx.lineTo(cx - 5, cy + 3); ctx.lineTo(cx + 5, cy + 3);
      } else {
        ctx.moveTo(cx, cy + 6); ctx.lineTo(cx - 5, cy - 3); ctx.lineTo(cx + 5, cy - 3);
      }
      ctx.closePath();
      ctx.fill();
    }

    /* last price tag */
    const lastC = cs[cs.length - 1];
    const ly = y(lastC.c);
    ctx.fillStyle = lastC.c >= lastC.o ? COL.up : COL.down;
    ctx.fillRect(w - PAD.right + 2, ly - 8, PAD.right - 4, 16);
    ctx.fillStyle = '#04070a';
    ctx.textAlign = 'left';
    ctx.font = '700 10px "Segoe UI", system-ui, sans-serif';
    ctx.fillText(fmt(lastC.c), w - PAD.right + 6, ly + 3.5);

    /* crosshair */
    if (this.hover && this.hover.x > PAD.left && this.hover.x < w - PAD.right) {
      const i = Math.max(0, Math.min(cs.length - 1, Math.floor((this.hover.x - PAD.left) / bw)));
      const c = cs[i];
      const cx = x(i);
      ctx.strokeStyle = 'rgba(78,161,255,.5)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, PAD.top);
      ctx.lineTo(cx, h - PAD.bottom);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(PAD.left, this.hover.y);
      ctx.lineTo(w - PAD.right, this.hover.y);
      ctx.stroke();
      ctx.setLineDash([]);
      this.onHover?.({
        t: c.t, o: c.o, h: c.h, l: c.l, c: c.c,
        price: lo + ((PAD.top + plotH - this.hover.y) / plotH) * span,
      });
    } else {
      this.onHover?.(null);
    }
  }
}

function fmt(v) {
  const a = Math.abs(v);
  return v.toFixed(a >= 1000 ? 2 : a >= 100 ? 3 : a >= 10 ? 4 : 5);
}

function clock(t) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
