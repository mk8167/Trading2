/* ------------------------------------------------------------------
 * index.js — MV3 service worker entry point.
 *
 * Lifecycle is the hard part of MV3, so it is handled explicitly:
 *   1. A 1-second heartbeat drives the strategy engine and settles trades.
 *   2. chrome.alarms re-wakes the worker every 30s and restarts the
 *      heartbeat, because a worker killed for idleness loses every timer.
 *   3. Market state is snapshotted to chrome.storage.session so a restart
 *      rebuilds the candles instead of starting from an empty chart.
 * ----------------------------------------------------------------*/

import * as store from './store.js';
import * as ledger from './ledger.js';
import * as settings from './settings.js';
import * as engine from './engine.js';
import { handleMessage } from './api.js';
import { candidatesToScore } from './recommend.js';
import { setSiteChartHandler } from './feeds/quotex.js';
import { setSelectionNotifier } from './feeds/select.js';
import { decideFollow } from './sync.js';
import * as binance from './feeds/binance.js';
import * as yahoo from './feeds/yahoo.js';
import { canonical } from './symbols.js';

const HEARTBEAT_MS = 1000;
const SNAPSHOT_KEY = 'market.snapshot.v6';

/**
 * How many pairs beyond the one on screen the heartbeat scores.
 *
 * The "best pair right now" board ranks on four components, the largest of
 * which (40 of 100 points) is the live signal. With only the selected symbol
 * ever evaluated, every other pair scored 0 there and was captioned "No
 * directional signal right now" — a statement about the engine, not about the
 * market — so the ranker could only ever justify the pair the user was already
 * looking at. Scoring a bounded set costs little: the signal itself is cached
 * per closed bar, so on a quiet bar this is a timestamp comparison.
 */
const CANDIDATE_LIMIT = 6;
/** Closed candles a pair needs before the strategy can say anything about it. */
const CANDIDATE_MIN_BARS = 40;

let heartbeat = null;
let last = { snapshot: 0, binance: 0, yahoo: 0, housekeep: 0, boot: 0 };
let booted = false;

/* ------------------------------ boot ------------------------------- */

async function boot() {
  if (booted) return;
  booted = true;
  last.boot = Date.now();

  const s = await settings.load();
  // Protect the watched pair BEFORE the snapshot is restored, so nothing can
  // evict it while state is being rebuilt.
  store.setSelected(s.selectedSym);
  await restoreSnapshot();
  await ledger.load();
  store.protectOpen(ledger.openSymbols());

  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch {}

  try {
    chrome.alarms.create('qs-heartbeat', { periodInMinutes: 0.5 });
  } catch {}

  if (s.feeds?.binance) await seedRest();

  /* Follow the site.
   *
   * The broker sends candles for the chart the user has open, so a history
   * block names the pair AND the timeframe the page is showing. Until now the
   * extension ignored both: it kept its own pair and its own timeframe, which
   * is why the site and the side panel could display two different charts of
   * two different markets and neither was wrong. With settings.syncSite on
   * (the default) the extension moves to what the page is showing.
   *
   * The decision itself is pure (sync.decideFollow) and rate-limited, so a
   * burst of history frames cannot make the selection jump around. */
  setSiteChartHandler(async (site) => {
    try {
      const cur = settings.peek();
      const want = decideFollow({
        site,
        selected: cur?.selectedSym || null,
        tf: cur?.tf || 'm1',
        enabled: cur?.syncSite !== false,
        lastFollowAt,
        now: Date.now(),
      });
      if (!want) return;
      lastFollowAt = Date.now();
      // decideFollow speaks in the short names (sym/tf); the settings schema
      // has its own. Passing the decision object straight to patch() would
      // have written a `sym` key that no reader ever looks at — a silent
      // no-op that looks exactly like "the feature does nothing".
      const patch = {};
      if (want.sym) patch.selectedSym = want.sym;
      if (want.tf) patch.tf = want.tf;
      await settings.patch(patch);
      if (want.sym) {
        store.setSelected(want.sym);
        store.protectOpen(ledger.openSymbols());
        engine.invalidate(want.sym);
      }
      notifyData();
    } catch (e) {
      store.noteError(`follow-site: ${e?.message || e}`);
    }
  });

  /* A pair the user picks is fetched straight away (feeds/select.js), and when
   * that request lands the chart has to fill in rather than wait for the next
   * scheduled port push. Injected instead of imported: select.js is reached
   * through api.js, which this file already imports, so importing notifyData
   * back the other way would be a cycle through the worker's own entry point. */
  setSelectionNotifier(() => notifyData());

  startHeartbeat();
}

/** Last time the selection moved to follow the site (rate limit). */
let lastFollowAt = 0;

/**
 * Backfill 1m history for crypto the broker told us about but sent no candles
 * for. We deliberately do not seed the whole fallback list at boot: that is
 * 30+ sequential 500-bar requests every time the worker wakes, and it would
 * manufacture symbols for pairs the user never opened. A pair the broker owns
 * is never seeded either — see store.ensureSymbol's source authority.
 */
async function seedRest() {
  const targets = [];
  for (const pair of Object.keys(binance.CRYPTO)) {
    const st = store.getSymbol(pair);
    if (st && !st.tf.m1.length && st.source !== 'quotex') targets.push(pair);
  }
  const sel = store.selected;
  if (sel) {
    const pair = Object.keys(binance.CRYPTO).find((p) => canonical(p) === sel);
    if (pair && !targets.includes(pair)) targets.unshift(pair);
  }
  for (const pair of targets) {
    await binance.seed(pair).catch((e) => store.noteError(`seed ${pair}: ${e?.message || e}`));
  }
}

async function restoreSnapshot() {
  try {
    const got = await chrome.storage.session.get(SNAPSHOT_KEY);
    const snap = got?.[SNAPSHOT_KEY];
    if (snap?.symbols) {
      const n = store.deserialize(snap);
      if (n) console.info(`[qsync] restored ${n} symbols from session snapshot`);
    }
  } catch (e) {
    store.noteError(`restore: ${e?.message || e}`);
  }
}

async function saveSnapshot() {
  try {
    await chrome.storage.session.set({ [SNAPSHOT_KEY]: store.serialize() });
  } catch (e) {
    store.noteError(`snapshot: ${e?.message || e}`);
  }
}

/* ---------------------------- heartbeat ----------------------------- */

function startHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(tick, HEARTBEAT_MS);
  tick().catch((e) => store.noteError(`tick: ${e?.message || e}`));
}

async function tick() {
  const now = Date.now();
  const s = settings.peek();

  // Refresh the protection set every beat: the watched pair plus anything
  // holding an unsettled trade. Without this, eviction and the stale-prune
  // could delete a symbol's candle history out from under an open trade,
  // which also wedged that pair permanently (an open trade blocks new ones).
  store.setSelected(s.selectedSym);
  store.protectOpen(ledger.openSymbols());

  const sym = store.selected || store.listSymbols()[0]?.sym || null;
  if (sym) {
    try {
      engine.evaluate(sym, s);
    } catch (e) {
      store.noteError(`evaluate: ${e?.message || e}`);
    }
  }

  // Signal-only pass over the strongest other pairs, so "which pair should I
  // trade" is answered with evidence rather than with a blank where the
  // signal component should be. trade:false means these can never open a paper
  // trade, never write a journal event and never run the ledger sweep.
  for (const cand of candidates(sym)) {
    try {
      engine.evaluate(cand, s, { trade: false, preview: false, settle: false });
    } catch (e) {
      store.noteError(`evaluate ${cand}: ${e?.message || e}`);
    }
  }

  // Both fallbacks are told which pair is on screen. Without that they served
  // their own agendas — Binance a six-pair discovery rotation, Yahoo a single
  // oldest-first pick out of 37 — so the pair the user had just selected could
  // wait minutes for a top-up while pairs nobody had opened were refreshed.
  const watching = store.selected;

  if (s.feeds?.binance && now - last.binance >= (s.feeds.binanceMs || 30_000)) {
    last.binance = now;
    for (const pair of binance.pairsToPoll(watching)) binance.poll(pair);
  }

  if (s.feeds?.yahoo && now - last.yahoo >= (s.feeds.yahooMs || 60_000)) {
    last.yahoo = now;
    const pair = yahoo.nextPair(lastYahooStamp, watching);
    lastYahooStamp[pair] = now;
    yahoo.poll(pair);
  }

  if (now - last.snapshot >= 10_000) {
    last.snapshot = now;
    saveSnapshot();
  }

  if (now - last.housekeep >= 60_000) {
    last.housekeep = now;
    store.housekeep();
    store.pruneStale(2 * 60 * 60 * 1000);
    // engine.prune() existed but nothing ever called it, so its signal cache
    // and its per-symbol bar stamp grew without bound across a long session —
    // every symbol the store ever saw, including ones evicted hours ago.
    engine.prune(store.listSymbols().map((x) => x.sym));
  }
}

const lastYahooStamp = {};

/**
 * Pairs worth scoring beyond `exclude` — live, with enough closed candles to
 * compute on, most-ticked first. Selection lives in recommend.js so it can be
 * tested on its own; this is just the store lookup.
 */
function candidates(exclude = null) {
  return candidatesToScore(store.listSymbols(), {
    exclude,
    limit: CANDIDATE_LIMIT,
    minBars: CANDIDATE_MIN_BARS,
  });
}

/* ---------------------------- messaging ----------------------------- */

/** Side-panel / popup connections that want a live payload. */
const livePorts = new Set();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((r) => {
      sendResponse(r);
      // Market data just landed: push it out now rather than waiting for the
      // next tick of a timer. The UI lagging behind the site by up to a second
      // is half of what "it does not sync" means in practice.
      if (msg?.cmd === 'feed.batch' && (r?.ticks || r?.history)) notifyData();
    })
    .catch((e) => sendResponse({ ok: false, err: String(e?.message || e) }));
  return true; // keep the channel open for the async reply
});

chrome.runtime.onConnect.addListener((port) => {
  // Long-lived port used by the side panel for low-latency updates.
  if (port.name !== 'qsync') return;
  livePorts.add(port);
  const push = async () => {
    try {
      const r = await handleMessage({ cmd: 'state.get' }, null);
      port.postMessage(r);
    } catch {}
  };
  push();
  const iv = setInterval(push, 1000);
  port.onDisconnect.addListener(() => {
    clearInterval(iv);
    livePorts.delete(port);
  });
});

/**
 * Push fresh state to everything that draws it, instead of waiting for a poll.
 *
 * Coalesced to one push per 250 ms: a busy socket delivers frames every few
 * milliseconds, and rebuilding the payload (candles, indicators, ranker,
 * journal) once per frame would cost more than the freshness is worth.
 */
let notifyTimer = null;
export function notifyData() {
  if (notifyTimer) return notifyTimer;
  notifyTimer = setTimeout(async () => {
    notifyTimer = null;
    try {
      if (livePorts.size) {
        const r = await handleMessage({ cmd: 'state.get' }, null);
        for (const p of livePorts) {
          try {
            p.postMessage(r);
          } catch {
            livePorts.delete(p);
          }
        }
      }
      // Content scripts do not receive runtime.sendMessage, so the HUD — which
      // lives inside the page — is woken tab by tab, and only in the tabs we
      // have actually heard a frame from.
      for (const id of store.diag.bridges) {
        try {
          chrome.tabs.sendMessage(id, { cmd: 'feed.new' }).catch?.(() => {});
        } catch {}
      }
    } catch {}
  }, 250);
  return notifyTimer;
}

/* ------------------------------ events ------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await settings.load();
  }
  await boot();
});

chrome.runtime.onStartup.addListener(() => boot());

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'qs-heartbeat') return;
  await boot();
  startHeartbeat();
  await tick();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-hud') await broadcast({ cmd: 'hud.toggle' });
  if (command === 'open-dashboard') await openPanel();
});

/* --------------------------- broadcasting --------------------------- */

/** Extension pages listen on runtime.onMessage; content scripts do not,
 *  so a real broadcast needs one tabs.sendMessage per tab. */
export async function broadcast(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch?.(() => {});
  } catch {}
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.id) continue;
      chrome.tabs.sendMessage(t.id, msg).catch?.(() => {});
    }
  } catch {}
}

async function openPanel() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch {}
}

boot().catch((e) => console.error('[qsync] boot failed', e));
