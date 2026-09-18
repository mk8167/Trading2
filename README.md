# ⚡ Q-Sync Pro — Market Signal Studio (v6.0.0)

A Chrome MV3 extension that reads live market ticks straight from a broker page's own
WebSocket, builds candles, scores multi-timeframe confluence signals, and keeps a
paper-trading journal with real expectancy maths.

**It never clicks, never places an order, never touches your account.** It is a charting
and statistics tool.

---

## Install (no build step)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this `qsync/` folder
4. Open a broker chart tab — the feed hook starts on its own

Requires **Chrome 116+** (`world: "MAIN"` content scripts, `sidePanel`, `sidePanel.open()`).

**Keyboard:** `Alt+Shift+Q` toggles the floating HUD · `Alt+Shift+D` opens the dashboard.

### Running it on a mirror domain

Quotex changes domain often. Instead of asking for `<all_urls>`, open
**extension options → Site access → Use current tab → Grant & install hook**. That calls
`chrome.permissions.request()` for exactly that origin and registers the content scripts
with `chrome.scripting.registerContentScripts()`. Reload the tab afterwards.

---

## What changed from v5.2.1

| Area | v5.2.1 | v6.0.0 |
|---|---|---|
| **Feed capture** | `chrome.debugger` attached to the tab → shows the *"started debugging this browser"* banner and is rejected by the Chrome Web Store | MAIN-world `WebSocket` proxy at `document_start`. No banner, no debugger permission, sees text + binary + Blob frames |
| **Worker lifecycle** | `setInterval` polling inside a service worker that Chrome kills after ~30s of idle → polling silently stopped | 1s heartbeat **+ `chrome.alarms` every 30s** that restarts it |
| **State survival** | Live `QX` data lived in memory only; a worker restart wiped the chart | Snapshot to `chrome.storage.session` every 10s, rebuilt on boot |
| **Parsing** | Regex + a guess about OHLC column order | JSON walk → typed-array probe → regex fallback. Column order is *decided*, not guessed. Undecodable frames are shown in a Protocol Lab instead of dropped |
| **Settings** | `localStorage` — different settings on every website | `chrome.storage.local`, shared everywhere |
| **Permissions** | `<all_urls>` + `debugger` + content script on every page | Named broker origins + two data hosts; everything else is opt-in per origin |
| **Strategy** | 4 hard-coded rules, best one wins | 27 weighted directional rules, net-score confluence, MTF confirmation, volatility/payout vetoes |
| **Journal** | Last 20 wins/losses | Full ledger: expectancy, profit factor, drawdown, streaks, per-setup / per-pair / per-direction breakdown, CSV export |
| **Backtester** | none | Replays the identical strategy with next-bar-open entry (no look-ahead) |
| **Chart** | 60 hand-drawn bars, blurry on HiDPI | DPR-aware canvas, EMA overlays, S/R lines, trade markers, crosshair, wheel zoom, drag pan |
| **UI** | One floating div on every page | Floating HUD (shadow DOM) + side-panel dashboard + popup + options page |
| **Tests** | none | **119 automated tests**, `npm test` |

---

## Architecture

```
manifest.json                     MV3, no <all_urls>, no debugger permission
icons/
src/
  content/
    bridge.js      MAIN world, document_start — wraps WebSocket/fetch/XHR,
                   relays frames to the isolated world via window.postMessage
    hud.js         ISOLATED world — batches frames to the worker, draws the
                   floating HUD inside a shadow root
  background/
    index.js       service worker: boot, heartbeat, alarms, snapshotting
    api.js         the single message surface every UI talks to
    engine.js      one evaluation per closed bar; cached, so all UIs agree
    strategy.js    weighted confluence engine + risk gate
    patterns.js    candle anatomy, swing pivots, structure, S/R, break+retest
    indicators.js  sma ema rsi atr macd bollinger stochastic adx slope
    candles.js     timeframe aggregation, ring buffers, compact storage format
    store.js       symbol registry + serialize/deserialize snapshot
    ledger.js      paper-trading ledger on chrome.storage.local
    journal.js     expectancy, profit factor, drawdown, breakdowns, CSV
    backtest.js    replay engine (entry = next bar open)
    settings.js    deep-merged defaults
    parsers/quotex.js   frame decoding + extraction, never throws
    feeds/quotex.js     frame intake
    feeds/binance.js    public klines fallback (crypto)
    feeds/yahoo.js      FX fallback (delayed, rotated, labelled)
  ui/
    chart.js       DPR-aware canvas candlestick chart
    panel/         side-panel dashboard (Chart · Signal · Journal · Backtest · Feed · Settings)
    popup/         compact status
    options/       site access, data export/import, docs
tests/             119 tests — run with `npm test`
```

### How the feed works

1. `bridge.js` runs in the page's **main world** at `document_start` and replaces
   `window.WebSocket` with a `Proxy`. Every socket the page opens is wrapped, so inbound
   frames are captured in the **capture phase** (before the page can stop propagation) and
   outbound frames are captured too, which makes the protocol inspectable.
2. Frames cross into the isolated world with `window.postMessage` — the one channel that
   crosses the world boundary. `CustomEvent.detail` does not.
3. `hud.js` queues them and flushes every 400 ms or every 60 frames, so a chatty socket
   cannot flood the message channel.
4. `parsers/quotex.js` decodes: socket.io envelope stripped → `JSON.parse` and a recursive
   walk → regex fallback. Binary payloads are base64-relayed and UTF-8 decoded.
5. Ticks land in `store.js`, which aggregates m1 and derives m5/m15/m30.

### Why the service worker survives

MV3 kills an idle worker after ~30 seconds, taking every `setInterval` with it. Q-Sync Pro
uses three layers:

- incoming frames and UI polls reset the idle timer while anything is live;
- `chrome.alarms` fires every 30 s and restarts the heartbeat;
- candles are snapshotted to `chrome.storage.session`, so a restart rebuilds the chart
  instead of starting from zero.

---

## The strategy

**27 directional rules** vote with a **weight** and a **direction** (19 in the engine plus
8 candlestick detectors); votes are summed and the *net* decides the call. Two detectors —
doji and inside bar — are reported but deliberately carry weight 0 because they only mean
"wait". Rules only ever see **closed** bars — the forming candle is dropped
before evaluation, and there is a test that proves a wild in-progress bar cannot change
the verdict.

| Group | Rules | Weight |
|---|---|---|
| Structure | HH+HL / LH+LL from swing pivots | 2 |
| Trend | price vs EMA21 vs EMA50 + slope | 2 |
| Momentum | RSI zones & turn, MACD histogram flip, Stochastic cross | 1 |
| Price action | pin bar, engulfing, fakey, 3-soldiers/crows, break+retest — bonus when at a level | 2–4 |
| Mean reversion | close back inside a Bollinger band | 1 |
| Multi-timeframe | 5m trend, 15m bias | 2 / 1 |

**Vetoes** (hard stop, no signal): volatility above the cap or below the floor, payout
under the break-even floor.
**Gates** (risk control): rolling win rate under break-even + margin, a losing streak over
the limit, or a same-direction cooldown.

`confidence = (net / 6) × 100 × (0.65 + 0.35 × agreement)` where agreement is how much the
rules concur. Six net points with every rule pointing the same way = 100%.

---

## Tests

```
npm test
```

119 tests across 7 files:

- `candles` — bucketing, aggregation, compact/expand round-trip
- `indicators` — correctness against hand-computed values, plus a budget check that a full
  indicator pass over 600 candles stays fast enough for a 1 s heartbeat
- `quotex-parser` — real payload shapes, socket.io envelopes, binary/base64, hostile input
- `strategy` — trend/flat behaviour, vetoes, gates, and the closed-bar guarantee
- `journal` — settlement, expectancy, drawdown, CSV escaping
- `backtest` — **no look-ahead** (entry must equal the next bar's open), determinism, cooldown
- `bridge` — the MAIN-world hook executed in a real `vm` context against a fake WebSocket
- `hud` — the content script executed against a fake DOM, asserting rendered output
- `integration` — frames pushed through the real message surface into the real worker
  modules with a stubbed `chrome.*`, ending in a settled paper trade

---

## Known limitations

- The hook covers sockets opened on the **main thread**, including inside iframes
  (`all_frames: true`). A broker that opens its WebSocket inside a **Web Worker** or a
  SharedWorker would not be seen — that needs a separate worker-world injection.
- If the feed is a binary protocol the decoder does not yet recognise, ticks will not
  appear. Open the dashboard → **Feed → Protocol Lab**: the real payload is printed there
  so the decoder in `src/background/parsers/quotex.js` can be extended. Outbound frames are
  captured too, so you can see what the page subscribes with.
- Binance and Yahoo are *proxies*. They are always labelled in the UI and are never mixed
  with live broker ticks for the same symbol.
- `chrome.storage.session` holds ~24 instruments × 150 candles; older instruments are
  pruned after two silent hours.

---

## Disclaimer

Q-Sync Pro is an analysis tool. It does not place orders, click buttons, or interact with a
broker in any way.

Binary options are a negative-expectation product for the overwhelming majority of
participants. At a typical 86% payout you need a **53.8% win rate simply to break even**,
and "OTC" instruments on these platforms are prices synthesised by the platform rather than
quotes from an exchange — which means the counterparty sets the number your trade settles
against. Use the journal and the backtester to measure the strategy honestly, on paper,
before risking anything.
