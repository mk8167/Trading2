import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

/* The bridge runs in a page, not in Node, so it is executed inside a fresh
 * vm context with a hand-rolled DOM/WebSocket. That is the closest we can
 * get to a real tab here, and it is enough to prove the hook actually
 * intercepts frames rather than just parsing cleanly. */

const CODE = fs.readFileSync(new URL('../src/content/bridge.js', import.meta.url), 'utf8');

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this._l = {};
  }
  addEventListener(type, fn) {
    (this._l[type] ||= []).push(fn);
  }
  send(data) {
    this.sent = data;
  }
  dispatch(type, ev) {
    for (const fn of this._l[type] || []) fn(ev);
  }
}

class FakeXHR {
  constructor() {
    this._l = {};
    this.responseType = '';
    this.responseText = '';
  }
  addEventListener(type, fn) {
    (this._l[type] ||= []).push(fn);
  }
  open(method, url) {
    this.__url = url;
  }
  send() {}
  dispatch(type) {
    for (const fn of this._l[type] || []) fn.call(this);
  }
}

function makePage({ fetch: fetchImpl } = {}) {
  const posted = [];
  // In a real page `window === globalThis`, so the sandbox IS the window.
  const sandbox = {
    WebSocket: FakeWebSocket,
    XMLHttpRequest: FakeXHR,
    location: { href: 'https://broker.example/chart' },
    navigator: { userAgent: 'node-test' },
    Blob,
    ArrayBuffer,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    btoa,
    atob,
    console,
    setTimeout,
    postMessage: (msg) => posted.push(msg),
    addEventListener() {},
  };
  // Define fetch before the hook runs, exactly as a page would have it.
  if (fetchImpl) sandbox.fetch = fetchImpl;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox);
  return { context: sandbox, win: sandbox, posted };
}

test('the hook wraps window.WebSocket and announces the connection', () => {
  const { context, win, posted } = makePage();
  assert.notEqual(win.WebSocket, FakeWebSocket, 'constructor should be replaced');
  const ws = new win.WebSocket('wss://broker.example/socket.io/');
  assert.ok(ws instanceof FakeWebSocket, 'instanceof must still work');
  assert.equal(ws.url, 'wss://broker.example/socket.io/');
  const hello = posted.find((m) => m.kind === 'hello');
  const socket = posted.find((m) => m.kind === 'socket');
  assert.ok(hello, 'hello frame missing');
  assert.equal(hello.href, 'https://broker.example/chart');
  assert.equal(socket.url, 'wss://broker.example/socket.io/');
});

test('inbound text frames are relayed verbatim', () => {
  const { win, posted } = makePage();
  const ws = new win.WebSocket('wss://x/');
  const payload = '42["tick",["EURUSD_otc",1700000000,1.08432,1]]';
  ws.dispatch('message', { data: payload });
  const f = posted.filter((m) => m.kind === 'frame');
  assert.equal(f.length, 1);
  assert.equal(f[0].text, payload);
  assert.equal(f[0].binary, false);
  assert.equal(f[0].dir, 'in');
});

test('inbound binary frames are relayed as base64 and round-trip', () => {
  const { win, posted } = makePage();
  const ws = new win.WebSocket('wss://x/');
  const bytes = new TextEncoder().encode('42["q",["XAUUSD_otc",1700000000,2331.5,1]]');
  ws.dispatch('message', { data: bytes.buffer });
  const f = posted.find((m) => m.kind === 'frame');
  assert.equal(f.binary, true);
  assert.equal(f.len, bytes.length);
  assert.equal(Buffer.from(f.b64, 'base64').toString('utf8'), '42["q",["XAUUSD_otc",1700000000,2331.5,1]]');
});

test('typed-array frames are relayed too', () => {
  const { win, posted } = makePage();
  const ws = new win.WebSocket('wss://x/');
  ws.dispatch('message', { data: new TextEncoder().encode('hello') });
  const f = posted.find((m) => m.kind === 'frame');
  assert.equal(Buffer.from(f.b64, 'base64').toString('utf8'), 'hello');
});

test('outbound frames are captured so the protocol can be inspected', () => {
  const { win, posted } = makePage();
  const ws = new win.WebSocket('wss://x/');
  ws.send('42["subscribe",{"asset":"EURUSD_otc"}]');
  assert.equal(ws.sent, '42["subscribe",{"asset":"EURUSD_otc"}]', 'the real send must still run');
  const out = posted.filter((m) => m.kind === 'frame' && m.dir === 'out');
  assert.equal(out.length, 1);
  assert.match(out[0].text, /subscribe/);
});

test('the hook installs itself only once per page', () => {
  const { context, win, posted } = makePage();
  const first = win.WebSocket;
  vm.runInContext(CODE, context);
  assert.equal(win.WebSocket, first, 'second run must not re-wrap');
  assert.equal(posted.filter((m) => m.kind === 'hello').length, 1);
});

test('oversized frames are truncated rather than dropped or frozen', () => {
  const { win, posted } = makePage();
  const ws = new win.WebSocket('wss://x/');
  ws.dispatch('message', { data: 'x'.repeat(400_000) });
  const f = posted.find((m) => m.kind === 'frame');
  assert.equal(f.text.length, 200 * 1024);
});

test('fetch responses for history endpoints are captured', async () => {
  const body = JSON.stringify({ candles: [[1, 2, 3, 4, 5]] });
  const { win, posted } = makePage({
    fetch: async () => ({ clone: () => ({ text: async () => body }) }),
  });
  await win.fetch('https://broker.example/api/history?asset=EURUSD_otc');
  await new Promise((r) => setTimeout(r, 10));
  const f = posted.filter((m) => m.kind === 'frame' && m.dir === 'rest');
  assert.equal(f.length, 1, `expected one rest frame, got ${posted.map((m) => m.kind).join(',')}`);
  assert.match(f[0].text, /candles/);
});

test('non-history fetches are left completely alone', async () => {
  let calls = 0;
  const { win, posted } = makePage({
    fetch: async () => {
      calls++;
      return { clone: () => ({ text: async () => 'secret' }) };
    },
  });
  await win.fetch('https://broker.example/api/account/balance');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1, 'the original fetch must still be called');
  assert.equal(posted.filter((m) => m.kind === 'frame' && m.dir === 'rest').length, 0);
});

test('XHR history responses are captured', () => {
  const { context, posted } = makePage();
  const xhr = new context.XMLHttpRequest();
  xhr.open('GET', 'https://broker.example/api/candles?sym=EURUSD_otc');
  xhr.responseText = '{"candles":[]}';
  xhr.send();
  xhr.dispatch('load');
  const f = posted.filter((m) => m.kind === 'frame' && m.dir === 'rest');
  assert.equal(f.length, 1);
});

test('a broken payload never throws into the page', () => {
  const { win, posted } = makePage();
  const ws = new win.WebSocket('wss://x/');
  assert.doesNotThrow(() => ws.dispatch('message', { data: null }));
  assert.doesNotThrow(() => ws.dispatch('message', { data: 12345 }));
  assert.doesNotThrow(() => ws.dispatch('message', { data: {} }));
  assert.equal(posted.filter((m) => m.kind === 'frame').length, 0);
});
