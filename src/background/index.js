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
import * as binance from './feeds/binance.js';
import * as yahoo from './feeds/yahoo.js';

const HEARTBEAT_MS = 1000;
const SNAPSHOT_KEY = 'market.snapshot.v6';

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
  startHeartbeat();
}

async function seedRest() {
  for (const pair of Object.keys(binance.CRYPTO)) {
    const st = store.getSymbol(pair);
    if (!st || !st.tf.m1.length) {
      await binance.seed(pair).catch((e) => store.noteError(`seed ${pair}: ${e?.message || e}`));
    }
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

  if (s.feeds?.binance && now - last.binance >= (s.feeds.binanceMs || 30_000)) {
    last.binance = now;
    for (const pair of Object.keys(binance.CRYPTO)) binance.poll(pair);
  }

  if (s.feeds?.yahoo && now - last.yahoo >= (s.feeds.yahooMs || 60_000)) {
    last.yahoo = now;
    const pair = yahoo.nextPair(lastYahooStamp);
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

/* ---------------------------- messaging ----------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ ok: false, err: String(e?.message || e) }));
  return true; // keep the channel open for the async reply
});

chrome.runtime.onConnect.addListener((port) => {
  // Long-lived port used by the side panel for low-latency updates.
  if (port.name !== 'qsync') return;
  const push = async () => {
    try {
      const r = await handleMessage({ cmd: 'state.get' }, null);
      port.postMessage(r);
    } catch {}
  };
  push();
  const iv = setInterval(push, 1000);
  port.onDisconnect.addListener(() => clearInterval(iv));
});

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
