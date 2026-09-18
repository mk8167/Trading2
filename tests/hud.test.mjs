import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const CODE = fs.readFileSync(new URL('../src/content/hud.js', import.meta.url), 'utf8');

/* A deliberately dumb DOM. It is not a browser — it exists so the HUD's
 * build()/render() path actually executes, which catches the class of bug
 * (a mistyped element id, an unhandled signal branch) that a syntax check
 * cannot see. */

const CTX_METHODS = [
  'setTransform', 'clearRect', 'fillRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill',
  'closePath', 'save', 'restore', 'setLineDash', 'fillText', 'arc', 'rect', 'translate', 'scale',
];

function ctx2d() {
  const c = {};
  for (const m of CTX_METHODS) c[m] = () => {};
  return Object.assign(c, { fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '' });
}

class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = new Proxy({}, { get: (t, k) => t[k] ?? '', set: (t, k, v) => ((t[k] = v), true) });
    this._classes = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => this._classes.add(x)),
      remove: (...c) => c.forEach((x) => this._classes.delete(x)),
      toggle: (c, on) =>
        on === undefined
          ? this._classes.has(c) ? this._classes.delete(c) : this._classes.add(c)
          : on ? this._classes.add(c) : this._classes.delete(c),
      contains: (c) => this._classes.has(c),
    };
    this._byId = new Map();
    this.textContent = '';
    this.innerHTML = '';
    this.width = 300;
    this.height = 120;
    this.clientWidth = 280;
    this.clientHeight = 62;
    this.className = '';
  }
  get firstElementChild() {
    return (this._child ||= new El());
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  remove() {}
  setAttribute() {}
  setPointerCapture() {}
  getBoundingClientRect() {
    return { left: 10, top: 10, width: 296, height: 300 };
  }
  addEventListener() {}
  removeEventListener() {}
  getContext() {
    return (this._ctx ||= ctx2d());
  }
  getElementById(id) {
    if (!this._byId.has(id)) this._byId.set(id, new El());
    return this._byId.get(id);
  }
  querySelector() {
    return (this._q ||= new El());
  }
  attachShadow() {
    return (this._shadow ||= new El('shadow'));
  }
}

/** Boot the content script in a fresh fake page. */
function makePage({ settings = { hud: { enabled: true, side: 'right' } }, state = null, boot = true } = {}) {
  const sent = [];
  const doc = new El('body');
  doc.body = doc;
  doc.documentElement = doc;
  doc.createElement = (t) => new El(t);

  const sandbox = {
    document: doc,
    navigator: { userAgent: 'node' },
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    chrome: {
      runtime: {
        lastError: null,
        sendMessage: (msg, cb) => {
          sent.push(msg);
          if (!cb) return;
          if (msg.cmd === 'settings.get') cb({ ok: true, settings });
          if (msg.cmd === 'state.get' && state) cb(state);
        },
        onMessage: { addListener: (fn) => (sandbox.__onMsg = fn) },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.innerWidth = 1200;
  sandbox.innerHeight = 900;
  sandbox.devicePixelRatio = 2;
  sandbox.__listeners = [];
  sandbox.addEventListener = (t, fn) => sandbox.__listeners.push([t, fn]);
  sandbox.postMessage = () => {};
  vm.createContext(sandbox);
  if (boot) vm.runInContext(CODE, sandbox);

  // Inside a vm context the guest's `window` is a wrapper around the host
  // sandbox object, so identity comparisons must use the guest's own view.
  const guestWindow = vm.runInContext('window', sandbox);
  const fire = (data, source = guestWindow) => {
    for (const [t, fn] of sandbox.__listeners) if (t === 'message') fn({ source, data });
  };
  const shadow = () => doc.children[0]?._shadow;
  return { sandbox, doc, sent, fire, shadow, guestWindow };
}

const candles = (n = 80, base = 1.08) =>
  Array.from({ length: n }, (_, i) => ({
    t: 1_700_000_000_000 + i * 60_000,
    o: base + i * 0.0002,
    h: base + 0.001 + i * 0.0002,
    l: base - 0.001 + i * 0.0002,
    c: base + 0.0005 + i * 0.0002,
  }));

function liveState(dir = 'up') {
  const cs = candles();
  return {
    ok: true,
    now: Date.now(),
    settings: { tf: 'm1', payout: 86, hud: { side: 'right' } },
    selectedSym: 'EURUSD_OTC',
    symbol: { sym: 'EURUSD_OTC', source: 'quotex', price: 1.0965, ts: Date.now(), payout: 92, stale: false, bars: { m1: 80, m5: 16, m15: 5 } },
    candles: { m1: cs, m5: cs.slice(-16), m15: cs.slice(-5) },
    signal: {
      dir, summary: `${dir.toUpperCase()} · net 5 · Bullish engulfing`, confidence: 74, score: 5, vetoes: [],
      signals: [{ dir, weight: 3, name: 'Bullish engulfing' }],
      ctx: { upVotes: 6, downVotes: 1, levels: [] },
    },
    openTrades: [{ dir, entry: 1.0965, stake: 1, expiresAt: Date.now() + 30_000 }],
    journal: { decided: 12, wins: 7, losses: 5, winRate: 0.583, edge: 0.045, expectancy: 0.42 },
    diag: { frames: 400, ticks: 320 },
  };
}

test('boots, builds the widget and polls for state', () => {
  const { sent, doc, shadow } = makePage({ state: liveState() });
  assert.ok(sent.some((m) => m.cmd === 'settings.get'), 'should read settings first');
  assert.ok(sent.some((m) => m.cmd === 'state.get'), 'should poll for state');
  assert.ok(doc.children.length, 'the widget should be attached to the page');
  assert.ok(shadow(), 'the widget should live in a shadow root');
});

test('a live UP signal renders end to end', () => {
  const { shadow } = makePage({ state: liveState('up') });
  const sh = shadow();
  assert.equal(sh.getElementById('sigd').textContent, '▲ CALL / UP');
  assert.match(sh.getElementById('sigw').textContent, /Bullish engulfing/);
  assert.equal(sh.getElementById('pair').textContent, 'EUR/USD · OTC · m1');
  assert.equal(sh.getElementById('srcb').textContent, 'QUOTEX LIVE');
  assert.equal(sh.getElementById('px').textContent, '1.09650');
  assert.equal(sh.getElementById('conf').style.width, '74%');
  assert.equal(sh.getElementById('wl').textContent, '7/5 · 58%');
  assert.match(sh.getElementById('ticket').textContent, /UP @ 1\.09650/);
});

test('every signal state has its own label and colour', () => {
  const cases = [
    ['up', '▲ CALL / UP'],
    ['down', '▼ PUT / DOWN'],
    ['veto', '⛔ BLOCKED'],
    ['none', '— NO EDGE'],
    ['wait', '⏳ WARMING UP'],
  ];
  for (const [dir, label] of cases) {
    const { shadow } = makePage({ state: liveState(dir) });
    assert.equal(shadow().getElementById('sigd').textContent, label, `dir=${dir}`);
  }
});

test('with no feed it shows guidance instead of a broken panel', () => {
  const { shadow } = makePage({ state: { ok: true, now: Date.now(), settings: {}, symbol: null, candles: {}, diag: { frames: 0, sockets: 0, ticks: 0 } } });
  const sh = shadow();
  assert.match(sh.getElementById('warn').textContent, /No socket seen/, 'zero sockets should say the hook is missing');

  // Frames but no ticks -> decoder has not recognised the payload yet.
  const s2 = makePage({ state: { ok: true, now: Date.now(), settings: {}, symbol: null, candles: {}, diag: { frames: 50, sockets: 3, ticks: 0 } } });
  assert.match(s2.shadow().getElementById('warn').textContent, /not decoded/, 'frames-but-no-ticks should point to the Protocol Lab');
});

test('a stale feed is labelled idle, not live', () => {
  const s = liveState();
  s.symbol.stale = true;
  const { shadow } = makePage({ state: s });
  assert.equal(shadow().getElementById('srcb').textContent, 'IDLE');
});

test('bridge frames are queued and flushed as one batch', () => {
  const { sent, fire } = makePage({ state: liveState() });
  const before = sent.filter((m) => m.cmd === 'feed.batch').length;
  for (let i = 0; i < 25; i++) fire({ __qsync_v6: 1, kind: 'frame', text: `42["t",${i}]` });
  assert.equal(sent.filter((m) => m.cmd === 'feed.batch').length, before, 'must wait for the batch window');

  for (let i = 0; i < 40; i++) fire({ __qsync_v6: 1, kind: 'frame', text: `42["t",${i}]` });
  const batches = sent.filter((m) => m.cmd === 'feed.batch');
  assert.equal(batches.length, before + 1, `expected one flush, got ${batches.length - before}`);
  assert.equal(batches[batches.length - 1].frames.length, 60, 'the batch cap bounds the payload');
});

test('socket opens are reported so "no hook" vs "no frames" is distinguishable', () => {
  const { sent, fire } = makePage({ state: liveState() });
  fire({ __qsync_v6: 1, kind: 'socket', url: 'wss://broker.example/socket.io/' });
  assert.ok(sent.some((m) => m.cmd === 'feed.socket' && m.url === 'wss://broker.example/socket.io/'));
});

test('messages from other sources or with the wrong shape are ignored', () => {
  const { sent, fire } = makePage({ state: liveState() });
  const before = sent.length;
  fire({ __qsync_v6: 1, kind: 'frame', text: 'x' }, {}); // wrong source
  fire({ other: 1 });
  fire(null);
  assert.equal(sent.length, before, 'nothing should have been sent');
});

test('the HUD can be turned off through settings', () => {
  const { doc, sent } = makePage({ settings: { hud: { enabled: false } }, state: liveState() });
  assert.equal(doc.children.length, 0, 'widget must not be built when disabled');
  assert.ok(!sent.some((m) => m.cmd === 'state.get'), 'must not poll while hidden');
});

test('hud.toggle from the worker shows and hides the widget', () => {
  const { sandbox, doc } = makePage({ settings: { hud: { enabled: false } } });
  assert.equal(doc.children.length, 0);
  sandbox.__onMsg({ cmd: 'hud.toggle' }, null, () => {});
  assert.equal(doc.children.length, 1, 'toggle should build and show the widget');
  assert.equal(doc.children[0].style.display, '', 'visible');
  sandbox.__onMsg({ cmd: 'hud.toggle' }, null, () => {});
  assert.equal(doc.children[0].style.display, 'none', 'hidden');
});
