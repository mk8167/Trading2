# ⚡ Q-Sync Pro — Market Signal Studio (v6.2.0)

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
| **Tests** | none | **398 automated tests**, `npm test` |

---

## What changed from v6.1.0 → v6.2.0

v6.1.0 made the numbers right. v6.2.0 is about **not being quietly wrong when it matters** —
a delayed proxy feed mixing into a live chart, a trade settled at the wrong moment's price,
and a stake sized from a balance that losses had already spent.

| # | Problem | Fix |
|---|---|---|
| 1 | **Canonical keys let proxy feeds write into the broker's series.** v6.1.0 gave every spelling of an instrument one key — which also meant the Binance/Yahoo fallbacks (delayed, and for crypto a *different underlying*: `BTCUSDT` ≠ broker `BTC/USD`) could append their candles straight into a live broker series. Proven with a script: proxy prices of 9.99 appeared inside a live EURUSD chart. Every indicator, every signal, every backtest computed from that blend is fiction. | **Source authority** in `store.ensureSymbol()`. A proxy writing to a broker-owned key is refused and counted (`diag.proxyRefusals`); when the broker starts streaming a pair a proxy was standing in for, the proxy's candles are **discarded, not blended** (`diag.sourceTakeovers`). Both counters are shown on the Feed tab. |
| 2 | **Trades settled at the latest price, not the expiry price.** A binary option pays on the price *at expiry*. The worker settles on whatever heartbeat runs next — and MV3 kills idle workers, so that can be minutes later. Settle three minutes late on a pair that has moved across your strike and the journal records the opposite of what the broker paid, with no error and no visible symptom. | `ledger.priceAtExpiry()` picks whichever observable price is *nearest in time to expiry*: the close of a completed 1 m bar, or the live price with its own feed timestamp. Each settlement records `settleBasis` and `settleLagMs`. Anything more than 90 s from expiry is **voided with the reason logged** rather than booked as a win or loss. |
| 3 | **Stakes were sized from a balance typed once.** `settings.balance` never moves, so after a losing run the engine kept risking a percentage of money that no longer existed — a paper account could go negative indefinitely while still reporting the strategy as viable. | `engine.bankroll()` = starting balance **+ realized P&L**. The stake is sized from that, and trading **halts** when it cannot cover even the minimum. The halt, the reason, and the running bankroll are shown at the top of the Journal tab. |
| 4 | **The panel did not say what it was.** Every figure came from our own feed, settled by our own rule — not the broker's. Nowhere on screen did it say so, and an OTC pair (prices generated by the broker, no exchange to check against) looked identical to a real one. | A permanent note on the Journal tab: paper ledger, our feed, not your broker's settlement. Extra warnings when the selected pair is **OTC** or when prices currently come from a **delayed proxy** (which for crypto also means a different underlying). The signal card repeats both. |
| 5 | **Widening the fallback lists made polling unbounded.** Crypto went from 6 to 31 pairs; the heartbeat then fired 31 concurrent REST calls every 30 s and manufactured a store symbol for every pair the user never opened — half the 64-symbol cap spent on charts nobody looked at, crowding out the ones on screen. Boot did the same with 31 sequential 500-bar requests. | `binance.pairsToPoll()` always refreshes pairs we hold and rotates 6 unseen ones per cycle; `seedRest()` only backfills pairs the broker already told us about. A blocked fallback (HTTP 451/418) is now **reported** in diagnostics instead of failing silently forever. |
| 6 | **Two crashes the DOM hid.** The Feed tab's *Last frame* row rendered the literal word `undefined`, and the Settings tab threw on any payload missing `settings.strategy` — which aborts the whole render frame and leaves every card showing the *previous* payload's numbers while looking perfectly live. | Both fixed, and a static test now checks every id the UI looks up actually exists — the fake DOM used to run `panel.js` auto-vivifies unknown ids, so it structurally cannot catch that class of typo. |
| + | Coverage: `patterns`, `feeds`, `settlement`, `bankroll`, `bootstrap`, `panel` and `ui-ids` had **no tests at all**. | **398 tests across 19 files** (was 234 across 11). Dead code removed: `candles.TFS`, `candles.makeCandle`, `journal.openExposure`, `journal.byHour`. |

### What this does *not* do

No code can make a binary option profitable. What v6.2.0 guarantees is **measurement
honesty**: the prices in your chart are from one source and labelled as such, a trade is
settled at the moment it expired or voided with a reason, the stake cannot exceed the
bankroll, and the journal cannot report a result the broker would not have produced. Read
the win rate as a measurement of a strategy on *this* feed — not as a promise about your
account.

---

## What changed from v6.0.0 → v6.1.0

Every item below was a bug that produced **no error and no visible symptom** — it just made
a number on screen quietly wrong.

| # | Problem | Fix |
|---|---|---|
| 1 | `setSelected()` was defined but **never called from anywhere**, so `store.selected` was permanently `null`. The guard `s.sym !== selected` in `pruneStale()` therefore protected nothing, and `evictOldest()` had no guard at all. The pair you were watching could be deleted along with its entire candle history — routinely, every weekend for a forex pair. | `store.setSelected()` is now called from boot, the heartbeat, `symbols.select`, `settings.patch` and `state.get`. Protection covers the watched pair **and** every pair holding an unsettled trade. Eviction prefers symbols with no candles over ones with real history, and `serialize()` always keeps protected symbols inside the snapshot limit. |
| 2 | `ledger.settleDue(sym)` only ran for the single symbol the heartbeat evaluated. Switch pairs after a trade opens and that trade **never settles** — which permanently blocks the pair, because `maybeTrade()` refuses to trade while `openOn(sym)` is non-empty. Unsettled trades were also missing from every statistic. | New `ledger.settleAllDue(priceOf)` settles across all symbols in one pass. A trade whose price feed is gone waits a 5-minute grace period, then is **voided** — never faked. Voids and ties are excluded from win rate, streaks and rolling average via a shared `isDecided()` predicate. |
| 3 | Store keys were the raw symbol string, so one instrument could live under `EURUSD_OTC` **and** `USD/CAD_OTC`-style slash spellings — splitting its candle history in two and computing every indicator from half the data. The Binance/Yahoo fallbacks used `BTC/USD` while the broker used `BTCUSD`, so the same asset never merged. | New `src/background/symbols.js` is the single authority. One canonical key per instrument, idempotent, used by the store, the journal, settings and the UI. Old snapshots and old journals are **merged/migrated on load** rather than duplicated. |
| 4 | `SYMBOL_RE = /^[A-Z]{2,6}(?:\/[A-Z]{2,6})?(?:_OTC)?$/` accepted letters only. Any crypto name with a digit or a dash (`1000SHIBUSD`, `BTC-USD`) was **rejected outright and dropped without a trace** — on a platform that lists crypto. | Symbol acceptance now allows digits and dashes, guarded by a letter-count minimum and an explicit deny-list (`2probe`, `ping`, …) so widening the pattern cannot invent phantom instruments. |
| 5 | Payouts were dropped two different ways: `setPayout()` returned silently if the symbol did not exist yet, and the parser only recorded a payout when the same node **also carried a price** — but the broker's asset list sends `{symbol, payout}` with no price. Net effect: the real payout was never captured, and a single global 86% was used for crypto and forex alike, making the break-even figure on screen wrong. | Payouts (and broker asset-type declarations) arriving early are **parked in an inbox** and applied the moment the instrument appears. The parser now records a payout with or without a price. `store.effectivePayout()` resolves live → class default → user setting, and reports which one it used so the UI can show it. |
| 6 | `isOtc()` was **dead code** — defined and tested, never called. OTC, real forex and crypto were all judged by one volatility band and one payout default, so crypto was vetoed for being normally volatile while a dead OTC feed sailed through. Weekend forex produced confident signals off a frozen chart. | Each instrument is classified (`forex` · `crypto` · `commodity` · `synthetic` · `unknown`) from the broker's own declaration when present, otherwise from its name. Each class gets its own volatility band and payout default. Signals and backtests refuse a closed market — per bar in a replay, since a replay can span a weekend. |
| + | `npm test` ran `node --test tests/`, which Node 22 resolves as a **module path**, not a test directory — so the suite failed before running a single test, and nothing could be verified. | `node --test`. The suite now runs, and covers all of the above: **231 tests**. |

### Choosing a pair

The Signal tab now opens with **BEST PAIR RIGHT NOW**. It is not a guess — it ranks every
instrument on evidence the extension already holds and refuses to list anything it cannot
justify:

- **hard filters** (a pair failing any of these is listed with the reason, never ranked):
  no live data · fewer than 40 closed candles · market closed for the weekend ·
  payout below the break-even floor for its class · a trade already open on it
- **scored 0–100**: current signal 40 · demonstrated edge 30 · data quality 20 ·
  volatility fit 10

Demonstrated edge uses a **Wilson 95% lower bound**, not a raw win rate: 2 wins from 2
trades scores below 30 from 40, because two trades are not evidence. Every ranked pair and
every rejection carries the reasons it was scored that way, printed in the UI.

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
    symbols.js     ONE authority on instrument identity: canonical key,
                   asset class, volatility band, payout default, market hours
    recommend.js   ranks the tradeable pairs and says which to trade, with reasons
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
tests/             398 tests — run with `npm test`
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

398 tests across 19 files:

- `settlement` — **expiry-accurate settlement**: the price nearest expiry wins, a bar still
  forming is never a close, a late worker settles on the expiry bar not the current price,
  and anything too far from expiry is voided rather than fabricated
- `bankroll` — stake sizing off realized P&L, the halt at zero, and an end-to-end refusal
  through the real message surface
- `feeds` — Binance/Yahoo parsing, host failover, malformed payloads, rotation bounds, and
  **source authority** (a proxy may not write into a broker-owned series)
- `bootstrap` — a worker restart from a persisted snapshot: selection restored, open trades
  protected, derived timeframes rebuilt, stale signal cache pruned, polling bounded
- `panel` — the side panel rendered against a fake DOM: the bankroll card, the stop banner,
  the OTC/proxy warnings, and no card ever rendering `undefined` or `NaN`
- `ui-ids` — every element id the UI looks up exists, top-level access is static HTML, the
  manifest's paths exist and its `host_permissions` cover every host the code fetches
- `patterns` — candle anatomy, every pattern geometry, pivots, S/R clustering, structure,
  break-and-retest, VWAP
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
- `symbols` — canonical keys, asset classification, per-class bands, weekend sessions
- `recommend` — every hard filter, the Wilson lower bound, ranking determinism
- `lifecycle` — eviction/prune protection, the payout inbox, settlement and voiding

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
  pruned after two silent hours. The pair you are watching, and any pair holding an
  unsettled trade, are exempt from both pruning and eviction.
- Weekend closure is evaluated in **UTC** against the broker-independent convention of
  Friday 22:00 → Sunday 22:00. Brokers in other timezones may open slightly earlier or
  later; the guard is deliberately conservative.
- Asset class is inferred from the instrument name unless the broker declares one in the
  payload. A name that matches nothing is classified `unknown` and falls back to your own
  payout setting rather than being silently treated as forex.

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
