# Q-Sync Pro — full extension audit (v6.2.0 → v6.3.0)

Scope: every file under `src/` plus `manifest.json`, all 23 test files and the three UI pages.
Method: read the whole pipeline, then **prove each suspicion with a script or a test before
changing anything**; afterwards revert each fix and check that the new test fails without it.
Nothing here is a style opinion — the entries below produced a wrong number, a control that
did not work, or an unhandled shape.

Result: **6 defects fixed, 7 findings left open (documented, not changed), 27 tests added
(423 → 450)**, `npm test` green.

---

## 1. Fixed defects

| # | Severity | Where | What was wrong | Evidence | Status |
|---|---|---|---|---|---|
| 1 | **high** | `strategy.js` `gate()` | The rolling win rate divided by every journal row in the lookback window, not by every *decided* trade. Open trades, voids and ties sat in the denominator. | 9W/3L (75%, break-even 53.8%) reported as **45%** with 8 trades still open → the gate silently stopped trading. `/tmp/audit/gate.mjs` | fixed + tested |
| 2 | **high** | `candles.js` `pushTick()` | A tick older than the newest bar but inside the store's 60 s tolerance was **appended** at the end of the series. `lastOf()` then returned a stale bar, the engine's "last closed bar" was wrong, and `aggregate()` produced a 5 m bucket running backwards. | `/tmp/audit/pushtick.mjs`: `-200000 o100 c101 · 100000 o102 c102 · -200000 o999 c999` | fixed + tested |
| 3 | **medium** | `api.js` `journalPayload()` | Break-even came from the *settings* payout (86% default) instead of the payouts the trades were settled at. A ledger at a real 75% payout showed a 53.8% break-even instead of 57.1% — a phantom 3.3-point edge. | `/tmp/audit/journal-be.mjs`: 53.8% / +6.2 pp vs 57.1% / +2.9 pp | fixed + tested |
| 4 | **medium** | `engine.js` + `index.js` | Only the selected symbol was ever evaluated, so the ranker's 40-point signal component was 0 for every other pair and they were captioned "No directional signal right now" — an artefact of the engine, not the market. "BEST PAIR RIGHT NOW" could only justify the pair already on screen. | any `state.get` payload: `currentSignal()` is `null` for every non-selected pair | fixed + tested |
| 5 | **medium** | `settings.js` + 5 consumers | Eight settings were declared, persisted, and mostly displayed — and read by nothing: `alerts.sound`, `hud.compact`, `hud.showChart`, `chart.candles`, `chart.levels`, `chart.markers`, `recommend.limit`, `recommend.minBars`. `alerts.onlyDirectional` could not change behaviour at all. | `grep` for each key across `src/` returned only the schema; the Settings tab has a "Play a sound on signal" checkbox | fixed + tested |
| 6 | **low** | `panel/index.html`, `options/index.html`, `hud.js`, `hud.js`, `bridge.js` | (a) two pages printed hardcoded **v6.0.0** while the manifest said 6.2.0; (b) the HUD header printed the selected timeframe while drawing 1 m candles and a 60 s clock; (c) the HUD queued the page's own **outbound** frames as market data; (d) binary frames were base64-encoded with no size cap. | (a) `grep -n "v6\." src/ui`; (b) header vs drawn series; (c)/(d) read of `hud.js`/`bridge.js` | fixed + tested |
| 7 | **low** | `recommend.js` `assess()` | `settings.payout` was referenced inside a function where `settings` was never in scope: any caller whose `payoutOf` returned nothing (or omitted it, as the default does) hit `ReferenceError: settings is not defined` the moment a row carried no payout. Masked in the app because `api.js` always passes `payoutOf`. | `/tmp/audit/rec-payout.mjs`: `THROWS: ReferenceError settings is not defined` | fixed + tested |

### What each fix does

1. `gate()` filters on `isDecided` (win/loss) before slicing the lookback window, and
   `lossStreak()`/`winStreak()` count *through* an undecided row instead of letting a void
   reset a losing run. `strategy.isDecided` is asserted equal to `journal.isDecided` by a test
   (they are duplicated deliberately — `journal.js` already imports from `strategy.js`).
2. A late tick folds its high/low into the bar that owns it when that bar is still buffered,
   is dropped otherwise, and never rewrites a finished bar's close. `store.ingestTick()` no
   longer drags `s.price`/`s.ts` backwards (which made a live pair look stale and pointed
   `ledger.priceAtExpiry` at the wrong timestamp).
3. Break-even is the mean payout of the decided trades; the user's setting is used only when
   there is nothing to average yet.
4. `engine.evaluate(sym, settings, { trade, preview, settle })` — the heartbeat now scores up
   to six other live pairs with ≥ 40 bars in a signal-only pass (`trade:false`), so no
   candidate can open a paper trade, write a journal event or run the ledger sweep. Selection
   is the pure, tested `recommend.candidatesToScore()`.
5. The HUD plays a two-tone blip once per new closed-bar signal (lazy `AudioContext`, silent
   no-op where unavailable or still suspended), restores `hud.compact`, honours
   `hud.showChart`; the panel honours `chart.candles`/`levels`/`markers`; the ranker takes
   `recommend.limit`/`minBars`. `alerts.onlyDirectional` is deleted.
6. Versions are read from the manifest at runtime (and a test forbids hardcoding one); the HUD
   charts the timeframe it names; only inbound and REST frames are queued; binary frames over
   256 KB are dropped in the bridge.
7. `recommend()` takes `minBars` and `fallbackPayout` as explicit deps (the latter wired from
   `settings.payout` in `api.js`).

---

## 2. Findings left open

These were read carefully and judged either intended, low-impact, or not safe to change
without a live broker page to observe. They are recorded rather than "fixed blind".

| Where | Observation | Assessment |
|---|---|---|
| `api.js` `feed.frame` | `[msg.frame \|\| msg]` — a `feed.frame` with no `frame` field parses the command envelope itself, counting a frame with no payload. | Harmless today (the HUD always batches). Worth a guard if a second producer ever appears. |
| `engine.js` `evaluate` | The cached signal is keyed by symbol + closed-bar time only, so editing strategy thresholds in Settings does not invalidate it until the next bar closes (up to one bar of staleness, ≤ 15 min on m15). | Intended (the alternative is re-running the strategy on every poll), but not obvious. |
| `hud.js` `build()` | `el[id] = root.getElementById(id) \|\| root.querySelector('.panel')` — a typo'd id silently writes into the panel div instead of throwing. | Deliberate belt-and-braces, and the id set is covered by a static test. Left alone. |
| `api.js` CSV / `journal.toCSV` | `settleBasis`, `settleLagMs`, `voidReason` and `assetClass` are not exported in the CSV (only `source`, `tf`, …). | The journal now records *how* each trade was settled; the export should probably carry it. |
| `options.js` import | A backup file is written straight into `chrome.storage.local` without validating its shape or version. | Restoring a foreign/corrupt file can put a settings object of the wrong shape into the worker. |
| `store.js` `persist()` | `ledger.persist()` debounces 1.2 s; a settlement made in the last instant before MV3 kills the worker can be lost and re-settled later (never double-counted, possibly voided instead of booked). | Acceptable trade-off; a same-tick write would cost more than it saves. |
| `parsers/quotex.js` | Prices/timestamps that arrive as **strings** (`{"price":"1.0845"}`) are not read: the JSON walk only accepts numbers, and the regex fallback requires a digit immediately after the colon. | Unproven without a real payload from a mirror that does this — the Protocol Lab is the place to confirm it first. |

---

## 3. What was checked and found sound

Not everything is a bug; recording what was verified stops this audit being re-done.

- **Settlement** — `ledger.priceAtExpiry()` refuses a still-forming bar, prefers the bar that
  closed at expiry over a later live price, and voids past 90 s of lag / 5 min of grace. The
  void paths keep the trade out of every statistic.
- **Source authority** — a proxy cannot write into a broker-owned key, and a broker takeover
  discards (not blends) proxy candles. Verified by test and by the refusal counter.
- **Bankroll** — stake sizing off realized P&L, halt at zero, visible reason.
- **Canonical keys** — every spelling of an instrument collapses to one key; old journals and
  snapshots are merged, not duplicated.
- **Closed-bar discipline** — the strategy only ever sees closed bars; the forming bar is used
  for the labelled preview only, and there is a test proving a wild in-progress bar cannot
  change the verdict.
- **Worker lifecycle** — 1 s heartbeat + 30 s `chrome.alarms` restart + session snapshot
  restored on boot; `boot()` is idempotent.
- **Polling bounds** — Binance rotates 6 unseen pairs per cycle, Yahoo polls one pair per
  cycle, seeding only covers pairs the broker already named.
- **UI honesty** — the paper-ledger note, OTC/proxy warnings, the trading-halted banner and
  the "no instrument is tradeable" explanation are all present on the surfaces a user reads
  before risking money.
- **Element ids** — every id the panel, popup, options and HUD look up exists; nothing is
  looked up at module load before the markup is there.

---

## 4. Verification

```
npm test                      # 450 tests, 0 failures
node /tmp/audit/gate.mjs      # risk gate with open/void trades present
node /tmp/audit/pushtick.mjs  # late tick vs series order
node /tmp/audit/journal-be.mjs# break-even from traded payouts
node /tmp/audit/rec-payout.mjs# ranker with a row that has no payout
```

Each fix was reverted (`git diff src > patch; git checkout -- src`) and the suite re-run to
confirm the new tests fail without it: **18 failures** with the fixes removed, **0** with
them applied. Two of those failures are whole-file (the new exports do not exist), the rest
are the specific regression tests.

---

## 5. Follow-up work: v6.4.0 — staying on the same chart as the site

Reported after the v6.3.0 audit, from live use:

> *"site-er sathe extension proper sync hoi na, candle and number gulo thik thake na,
> duijaigai duita chart dekhai"* — the site's chart and the extension's chart show
> different candles and different numbers.

Both charts were live and neither was internally broken. The extension was answering a
question nothing in the pipeline asked — **which timeframe is this block in?** — and
answering "1 minute" every time.

| # | Problem | Fix | Test |
|---|---|---|---|
| 1 | Every history block was filed into the `m1` series regardless of the timeframe the broker sent it in, so a user on a 5- or 15-minute chart got an `m1` series that was a mixture of 1-minute tick bars and 5-minute broker bars. Indicators, `aggregate()`, the strategy's "last closed bar" and the drawn chart all read that mixture as 1-minute data. | `sync.detectTf()` (median gap + 80% agreement) routes a block to the series it belongs to; broker candles are kept per timeframe and win over derived ones in `refreshDerived()`, with newer tick-built bars appended so the chart still reaches "now". An unreadable block is counted (`Unreadable blocks`) and kept out rather than guessed into `m1`. | `tests/sync.test.mjs` |
| 2 | A history block arriving newest-first left exactly one candle, because `upsertCandle` refuses to rewrite older history. | Rows are sorted before they are stored. | `tests/sync.test.mjs` |
| 3 | Nothing read which pair/timeframe the *page* was showing — and a history block is exactly that. | `sync.decideFollow()` moves the extension onto the site's chart (rate-limited, timeframe only when the UI can draw it), switchable with `settings.syncSite`. | `tests/sync.test.mjs`, `tests/bootstrap.test.mjs` |
| 4 | socket.io event names were ignored, a single candle row (`["candle", [t,o,h,l,c]]`) was not a block and so was dropped, and numeric strings (`"price":"1.0845"`) failed both the JSON walk and the regex path. | Event names are understood, single candle/tick rows are accepted with a name or parent symbol, numeric strings are read, each extraction path is counted per frame. A flat `[t,p,p,p,p]` row is refused so a repeated tick cannot invent a candle. | `tests/quotex-parser.test.mjs` |
| 5 | The UI refreshed only on a timer (panel 1 s, HUD poll 1 s). | Data arriving in the worker pushes immediately: the panel over its port, the HUD via `feed.new` with a 200 ms floor, coalesced to one push per 250 ms. The 1 s poll stays as the safety net. | `tests/hud.test.mjs` (relay), manual |
| 6 | A session restored from a pre-v6.4.0 snapshot could carry the polluted series back. | Snapshot v8 stores broker candles; on restore `sync.splitCoarseRuns()` moves same-spacing runs out of `m1` (a genuine 1-minute series with gaps is untouched), counted as `Series repaired`. | `tests/sync.test.mjs` |

Also fixed: `feed.batch` counted a payload-less command envelope as a frame, inflating the
"frames arrive but are not decoded" diagnosis; and the panel's candle-sync line now names the
timeframe it is aligned to and which series is drawn, so "site m5 candles" and "computed on
1m closes" cannot be read as the same thing.

Still open after this work:

- The strategy computes on 1-minute closes (`engine.evaluate` reads `s.tf.m1`) even when the
  chart on screen is m5/m15. That is now stated in the UI (`sync.signalTf`, and a note beside
  the chart) rather than changed: silently running the strategy on a different timeframe
  would change when trades are taken, which is a decision for the user, not a bug fix.
- socket.io binary attachments (`{"_placeholder":true,"num":0}` plus a separate binary frame)
  are still not reassembled. Nothing observed sends market data that way, and guessing at the
  correlation without a real payload is how the previous bugs happened.
- Realtime delivery is verified at the message boundary, not in a live browser: the push path
  is exercised by the HUD relay test and the worker tests, but the final leg (does the widget
  redraw within 200 ms of a tick) can only be confirmed on the running extension.

