/* ------------------------------------------------------------------
 * bridge.js — runs in the PAGE's MAIN world at document_start.
 *
 * This replaces the old chrome.debugger approach. Instead of attaching a
 * debugger to the tab (which shows the "started debugging this browser"
 * banner and is rejected by the Chrome Web Store), we wrap the page's own
 * WebSocket constructor and listen to the frames it already receives.
 *
 * No chrome.* API is available here, so everything is relayed to the
 * ISOLATED-world content script through window.postMessage, which is the
 * one channel that crosses the world boundary.
 * ----------------------------------------------------------------*/
(() => {
  if (window.__QSYNC_BRIDGE_V6__) return;
  window.__QSYNC_BRIDGE_V6__ = true;

  const NS = '__qsync_v6';
  const MAX_TEXT = 200 * 1024; // never relay a megabyte-sized frame
  const MAX_BODY = 512 * 1024;
  // Binary frames are base64'd before they cross the world boundary, so a 4 MB
  // buffer becomes a 5.3 MB string — copied into the page's message queue and
  // then into an extension message. The parser refuses anything over 256 KB
  // anyway, so relaying it would be pure waste; drop it here instead.
  const MAX_BINARY = 256 * 1024;
  const HISTORY_URL = /histor|candle|chart|quote|instrument|asset/i;

  const post = (kind, payload) => {
    try {
      window.postMessage(Object.assign({ [NS]: 1, kind, at: Date.now() }, payload), '*');
    } catch (e) {
      /* structured-clone failure — drop the frame, never break the page */
    }
  };

  function toBase64(bytes) {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function relay(data, url, dir) {
    try {
      if (typeof data === 'string') {
        post('frame', { text: data.length > MAX_TEXT ? data.slice(0, MAX_TEXT) : data, url, binary: false, dir });
        return;
      }
      if (data instanceof ArrayBuffer) {
        if (data.byteLength > MAX_BINARY) return; // not a tick; see MAX_BINARY
        post('frame', { b64: toBase64(new Uint8Array(data)), url, binary: true, len: data.byteLength, dir });
        return;
      }
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        // Blob payloads arrive asynchronously; resolve then relay.
        data.arrayBuffer().then((ab) => relay(ab, url, dir)).catch(() => {});
        return;
      }
      if (ArrayBuffer.isView(data)) {
        if (data.byteLength > MAX_BINARY) return;
        const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        post('frame', { b64: toBase64(view), url, binary: true, len: view.byteLength, dir });
      }
    } catch (e) {
      /* ignore */
    }
  }

  /* ------------------------- WebSocket hook ------------------------- */

  const RealWebSocket = window.WebSocket;

  if (typeof RealWebSocket === 'function') {
    try {
      window.WebSocket = new Proxy(RealWebSocket, {
        construct(target, args, newTarget) {
          const ws = Reflect.construct(target, args, newTarget);
          const url = String(args && args[0] ? args[0] : '');
          post('socket', { url, state: 'opening' });
          try {
            // capture phase so we see the frame even if the page stops
            // propagation in its own handler
            ws.addEventListener(
              'message',
              (ev) => relay(ev.data, url, 'in'),
              true
            );
            const nativeSend = ws.send.bind(ws);
            ws.send = function (data) {
              relay(data, url, 'out');
              return nativeSend(data);
            };
          } catch (e) {
            /* read-only instance — inbound capture is the important half */
          }
          return ws;
        },
      });
    } catch (e) {
      post('error', { where: 'ws-hook', message: String((e && e.message) || e) });
    }
  }

  /* ---------------------- REST history capture ----------------------- */
  /* The chart history usually rides the same WebSocket, but some mirrors
   * fetch it over HTTP first. Capturing those responses gives the engine
   * an instant warm-up instead of waiting 40 candles. */

  const wantBody = (url) => typeof url === 'string' && HISTORY_URL.test(url) && url.length < 500;

  const RealFetch = window.fetch;
  if (typeof RealFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const p = RealFetch.apply(this, arguments);
      if (!wantBody(url)) return p;
      return p.then((res) => {
        try {
          const clone = res.clone();
          clone.text().then((txt) => {
            if (txt && txt.length <= MAX_BODY) post('frame', { text: txt, url, binary: false, dir: 'rest' });
          }).catch(() => {});
        } catch (e) {}
        return res;
      });
    };
  }

  const RealOpen = XMLHttpRequest.prototype.open;
  const RealSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__qsyncUrl = String(url || '');
    return RealOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const url = this.__qsyncUrl;
    if (wantBody(url)) {
      this.addEventListener('load', function () {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            const txt = this.responseText;
            if (txt && txt.length <= MAX_BODY) post('frame', { text: txt, url, binary: false, dir: 'rest' });
          }
        } catch (e) {}
      });
    }
    return RealSend.apply(this, arguments);
  };

  post('hello', { href: location.href, ua: navigator.userAgent.slice(0, 80) });
})();
