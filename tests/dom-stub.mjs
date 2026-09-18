/* A deliberately dumb DOM, just enough to import src/ui/panel/panel.js and
 * drive its renderers.
 *
 * panel.js is the surface the user reads before risking real money, and it had
 * no tests at all: a mistyped element id, a banner that never renders, or a
 * template that throws on an unexpected payload all ship invisibly, because
 * the service worker keeps computing correct numbers that nobody ever sees.
 * This is not a browser — unknown methods are no-ops and unknown ids
 * auto-vivify — but it does execute the real render path and captures the HTML
 * each element was given, which is enough to assert what actually appears.
 */

const CTX_METHODS = [
  'setTransform', 'clearRect', 'fillRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill',
  'closePath', 'save', 'restore', 'setLineDash', 'fillText', 'arc', 'rect', 'translate', 'scale',
  'measureText', 'createLinearGradient', 'quadraticCurveTo', 'bezierCurveTo', 'ellipse', 'clip',
  'drawImage', 'putImageData', 'getImageData', 'createImageData', 'arcTo', 'roundRect',
];

export function ctx2d() {
  const c = {};
  for (const m of CTX_METHODS) {
    c[m] = m === 'measureText' ? () => ({ width: 10 })
      : m === 'createLinearGradient' ? () => ({ addColorStop: () => {} })
      : m === 'getImageData' ? () => ({ data: new Uint8ClampedArray(4) })
      : m === 'createImageData' ? () => ({ data: new Uint8ClampedArray(4) })
      : () => {};
  }
  return Object.assign(c, {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    globalAlpha: 1, lineJoin: '', lineCap: '', shadowBlur: 0, shadowColor: '', imageSmoothingEnabled: true,
  });
}

export class El {
  constructor(id = '', tag = 'div') {
    this.id = id;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.classList = {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) {
        if (on === undefined) return this._s.has(c) ? this._s.delete(c) : this._s.add(c);
        return on ? this._s.add(c) : this._s.delete(c);
      },
      contains(c) { return this._s.has(c); },
    };
    this.listeners = {};
    this._html = '';
    this.textContent = '';
    this.className = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.width = 600;
    this.height = 120;
    this.options = [];
    this.selectedIndex = -1;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.parentNode = null;
  }

  /** Every innerHTML assignment is captured so tests can assert on it. */
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    const l = this.listeners[type];
    if (l) this.listeners[type] = l.filter((f) => f !== fn);
  }
  /** Fire a captured listener the way the browser would. */
  emit(type, ev = {}) {
    for (const fn of this.listeners[type] || []) fn({ type, preventDefault() {}, stopPropagation() {}, target: this, ...ev });
  }

  getContext() { return (this._ctx ||= ctx2d()); }
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: this.width, bottom: this.height, width: this.width, height: this.height }; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  appendChild(c) { this.children.push(c); return c; }
  append(...c) { this.children.push(...c); }
  insertBefore(c) { this.children.unshift(c); return c; }
  insertAdjacentHTML(_pos, html) { this._html += String(html); }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  remove() { this.children = []; }
  setAttribute(k, v) { this.dataset[k] = v; }
  getAttribute(k) { return this.dataset[k] ?? null; }
  hasAttribute(k) { return k in this.dataset; }
  removeAttribute(k) { delete this.dataset[k]; }
  focus() {}
  blur() {}
  click() {}
  scrollIntoView() {}
  closest() { return null; }
  contains() { return false; }
  matches() { return false; }
}

export function installDom() {
  const byId = new Map();
  const get = (id, tag = 'div') => {
    if (!byId.has(id)) byId.set(id, new El(id, tag));
    return byId.get(id);
  };

  globalThis.document = {
    getElementById: (id) => get(id),
    createElement: (tag) => new El('', tag),
    createTextNode: (t) => ({ textContent: t }),
    querySelector: (sel) => get(sel),
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    activeElement: null,
    body: get('body'),
    documentElement: get('html'),
    hidden: false,
    visibilityState: 'visible',
  };

  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    devicePixelRatio: 1,
    innerWidth: 400,
    innerHeight: 800,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (fn) => { fn(0); return 1; },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
  // panel.js uses CSS.escape() to keep a symbol name out of a selector.
  globalThis.CSS = globalThis.CSS || {
    escape: (v) => String(v).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch),
  };
  globalThis.MutationObserver = globalThis.MutationObserver ||
    class { observe() {} disconnect() {} takeRecords() { return []; } };
  // Node 22 exposes navigator as a getter-only global; only define it if absent.
  if (typeof globalThis.navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'node', clipboard: { writeText: async () => {} } },
      configurable: true,
    });
  }

  return { get, byId };
}
