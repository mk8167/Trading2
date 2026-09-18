/* ------------------------------------------------------------------
 * api.js — the single message surface every UI talks to.
 *
 * Returning a promise here means index.js can use one listener with
 * `return true` and never accidentally close the message channel early
 * (the classic MV3 "message port closed before a response was received").
 * ----------------------------------------------------------------*/

import * as store from './store.js';
import * as ledger from './ledger.js';
import * as settings from './settings.js';
import * as engine from './engine.js';
import { handleBatch } from './feeds/quotex.js';
import { runBacktest, summarise, walkForward } from './backtest.js';
import { toCSV, bySetup, bySymbol, byTimeframe, byDirection, byClass, voidTrade } from './journal.js';
import { CRYPTO } from './feeds/binance.js';
import { FX } from './feeds/yahoo.js';
import { bucketOf, TF_MS } from './candles.js';
import { canonical } from './symbols.js';
import { recommend } from './recommend.js';

const BRIDGE_IDS = ['qsync-bridge-main', 'qsync-hud'];

export async function handleMessage(msg, sender) {
  if (!msg || typeof msg.cmd !== 'string') return { ok: false, err: 'bad message' };
  try {
    switch (msg.cmd) {
      /* ---------------- live data ---------------- */
      case 'state.get':
        return await stateGet(msg);

      case 'symbols.select': {
        // Store the canonical key, and protect it immediately: selecting a
        // pair is exactly the moment its history becomes worth keeping.
        const key = msg.sym ? canonical(msg.sym) : null;
        const s = await settings.patch({ selectedSym: key });
        store.setSelected(key);
        store.protectOpen(ledger.openSymbols());
        engine.invalidate(key);
        return { ok: true, selectedSym: s.selectedSym };
      }

      case 'symbols.list':
        return { ok: true, symbols: store.listSymbols() };

      /* ---------------- settings ---------------- */
      case 'settings.get':
        return { ok: true, settings: await settings.load() };

      case 'settings.patch': {
        const patch = { ...(msg.patch || {}) };
        if (patch.selectedSym !== undefined) patch.selectedSym = patch.selectedSym ? canonical(patch.selectedSym) : null;
        const next = await settings.patch(patch);
        if (patch.selectedSym !== undefined) {
          store.setSelected(next.selectedSym);
          store.protectOpen(ledger.openSymbols());
          engine.invalidate(next.selectedSym);
        }
        return { ok: true, settings: next };
      }

      case 'settings.reset':
        return { ok: true, settings: await settings.reset() };

      /* ---------------- journal ---------------- */
      case 'journal.summary':
        return { ok: true, journal: journalPayload(await settings.load()) };

      case 'journal.reset':
        ledger.reset();
        return { ok: true };

      case 'journal.csv':
        return { ok: true, csv: toCSV(ledger.trades) };

      case 'journal.trade.close': {
        const t = ledger.trades.find((x) => x.id === msg.id && !x.result);
        if (!t) return { ok: false, err: 'not found' };
        // Settling at `t.entry` when no price is supplied used to guarantee a
        // tie, silently erasing the trade's real result. Use the last known
        // price; if there genuinely is none, void it rather than invent one.
        const st = store.getSymbol(t.sym);
        const price = Number.isFinite(msg.price) && msg.price > 0
          ? msg.price
          : (st && Number.isFinite(st.price) && st.price > 0 ? st.price : null);
        if (price == null) {
          voidTrade(t, 'closed manually with no price available');
          ledger.logEvent('void', `VOID ${t.sym} ${t.dir} — closed with no settlement price`, { tradeId: t.id });
        } else {
          ledger.settleTrade(t, price);
        }
        ledger.persist();
        return { ok: true, result: t.result, pnl: t.pnl };
      }

      /* ---------------- feed intake ---------------- */
      case 'feed.frame':
      case 'feed.batch': {
        // `[msg.frame || msg]` counted a command envelope with no payload as a
        // frame, which inflated the frame counter the UI uses to decide
        // "frames are arriving but not decoding". Only real payloads count.
        const frames = (Array.isArray(msg.frames) ? msg.frames : msg.frame ? [msg.frame] : []).filter(
          (f) => f && (typeof f.text === 'string' || typeof f.b64 === 'string')
        );
        const r = handleBatch(frames);
        if (sender?.tab?.id) store.diag.bridges.add(sender.tab.id);
        return { ok: true, ...r };
      }

      case 'feed.ping': {
        if (sender?.tab?.id) store.diag.bridges.add(sender.tab.id);
        return { ok: true, frames: store.diag.frames, ticks: store.diag.ticks, pairs: store.symbols.size };
      }

      case 'feed.socket': {
        // A WebSocket was opened on a hooked page. Lets the UI tell the
        // difference between "hook not injected" (0 sockets) and "socket
        // opened but its frames live somewhere we cannot see" (>0 sockets).
        store.diag.sockets++;
        if (sender?.tab?.id) store.diag.bridges.add(sender.tab.id);
        return { ok: true, sockets: store.diag.sockets };
      }

      case 'feed.samples':
        return { ok: true, samples: store.diag.samples, errors: store.diag.errors };

      case 'feed.clearSamples':
        store.diag.samples = [];
        store.diag.unparsed = 0;
        return { ok: true };

      case 'diag.reset':
        store.resetDiag();
        return { ok: true };

      case 'ui.openPanel': {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
        return { ok: true };
      }

      /* ---------------- backtest ---------------- */
      case 'backtest.run': {
        const s = await settings.load();
        const sym = msg.sym || s.selectedSym;
        const st = store.getSymbol(sym);
        if (!st) return { ok: false, err: `No data for ${sym}` };
        store.refreshDerived(sym);
        const base = msg.tf === 'm5' ? st.tf.m5 : st.tf.m1;
        const result = runBacktest(base, {
          sym,
          tf: msg.tf === 'm5' ? 'm5' : 'm1',
          assetClass: st.assetClass || null,
          payout: msg.payout ?? store.effectivePayout(sym, s.payout).payout,
          stake: msg.stake ?? Math.max(0.01, ((s.balance || 100) * (s.riskPct || 1)) / 100),
          expiryBars: msg.expiryBars ?? s.expiryMinutes,
          warmup: msg.warmup ?? 60,
          strategy: { ...s.strategy, ...(msg.strategy || {}) },
        });
        if (!result.ok) return result;
        return {
          ok: true,
          summary: summarise(result),
          stats: result.stats,
          bars: result.bars,
          evaluated: result.evaluated,
          skipped: result.skipped,
          trades: result.trades.slice(-120),
          equity: result.equity.slice(-200),
        };
      }

      case 'backtest.walk': {
        const s = await settings.load();
        const sym = msg.sym || s.selectedSym;
        const st = store.getSymbol(sym);
        if (!st) return { ok: false, err: `No data for ${sym}` };
        store.refreshDerived(sym);
        const base = msg.tf === 'm5' ? st.tf.m5 : st.tf.m1;
        const wf = walkForward(base, {
          sym,
          tf: msg.tf === 'm5' ? 'm5' : 'm1',
          assetClass: st.assetClass || null,
          payout: msg.payout ?? store.effectivePayout(sym, s.payout).payout,
          stake: msg.stake ?? 1,
          expiryBars: msg.expiryBars ?? s.expiryMinutes,
          warmup: msg.warmup ?? 60,
          strategy: { ...s.strategy, ...(msg.strategy || {}) },
        }, msg.folds || 4);
        return wf;
      }

      /* ---------------- dynamic script registration ---------------- */
      case 'scripts.register': {
        const origin = msg.origin;
        if (!/^https?:\/\/[^/]+/.test(origin || '')) return { ok: false, err: 'bad origin' };
        const pattern = `${origin}/*`;
        const granted = await hasPermission(pattern);
        if (!granted) return { ok: false, err: 'permission not granted' };
        await chrome.scripting.unregisterContentScripts({ ids: BRIDGE_IDS }).catch(() => {});
        await chrome.scripting.registerContentScripts([
          { id: BRIDGE_IDS[0], matches: [pattern], js: ['src/content/bridge.js'], runAt: 'document_start', world: 'MAIN', allFrames: true },
          { id: BRIDGE_IDS[1], matches: [pattern], js: ['src/content/hud.js'], runAt: 'document_idle', allFrames: false },
        ]);
        return { ok: true, pattern };
      }

      case 'scripts.unregister':
        await chrome.scripting.unregisterContentScripts({ ids: BRIDGE_IDS }).catch(() => {});
        return { ok: true };

      case 'scripts.list': {
        const list = await chrome.scripting.getRegisteredContentScripts({ ids: BRIDGE_IDS }).catch(() => []);
        return { ok: true, scripts: list.map((s) => ({ id: s.id, matches: s.matches })) };
      }

      default:
        return { ok: false, err: `unknown cmd ${msg.cmd}` };
    }
  } catch (e) {
    store.noteError(`${msg.cmd}: ${e?.message || e}`);
    return { ok: false, err: String(e?.message || e) };
  }
}

async function hasPermission(pattern) {
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

async function stateGet(msg) {
  const s = await settings.load();
  const wanted = msg.sym ? canonical(msg.sym) : s.selectedSym ? canonical(s.selectedSym) : null;
  const sym = wanted || autoSelect();
  if (sym && sym !== s.selectedSym) await settings.patch({ selectedSym: sym });
  // Marking it selected is what keeps this pair's candle history alive
  // through eviction and the stale-prune.
  store.setSelected(sym);

  const ev = sym ? engine.evaluate(sym, s) : { signal: null, open: [], settled: [], newBar: false };
  const st = sym ? store.getSymbol(sym) : null;

  const want = Math.min(Math.max(msg.candles || 120, 30), 400);
  const payload = {
    ok: true,
    now: Date.now(),
    settings: s,
    selectedSym: sym,
    symbol: st
      ? {
          sym: st.sym,
          pretty: st.pretty,
          assetClass: st.assetClass,
          otc: !!st.otc,
          source: st.source,
          price: Number.isFinite(st.price) ? st.price : null,
          ts: st.ts,
          payout: st.payout,
          ticks: st.tickCount,
          stale: store.isStale(st),
          bars: { m1: st.tf.m1.length, m5: st.tf.m5.length, m15: st.tf.m15.length },
          // Candles the broker itself sent, per timeframe, and how many
          // history rows we have ever stored. "The site draws candles and we
          // draw none" is answered by these two numbers.
          brokerTf: st.brokerLastTf || null,
          brokerBars: Object.values(st.broker || {}).reduce((a, l) => a + (l ? l.length : 0), 0),
          historyRows: st.historyRows || 0,
          historyAt: st.historyAt || 0,
        }
      : null,
    candles: st
      ? {
          m1: st.tf.m1.slice(-want),
          m5: st.tf.m5.slice(-Math.round(want * 0.7)),
          m15: st.tf.m15.slice(-Math.round(want * 0.5)),
        }
      : { m1: [], m5: [], m15: [] },
    signal: ev.signal,
    preview: ev.preview || null,
    effectivePayout: Number.isFinite(ev.payout) ? { payout: ev.payout, origin: ev.payoutOrigin || 'setting' } : null,
    assetClass: ev.assetClass || null,
    marketOpen: ev.marketOpen !== false,
    secondsToClose: ev.secondsToClose ?? null,
    sync: buildSync(st, ev.tf, msg.now || Date.now(), s),
    openTrades: ev.open,
    // Starting balance plus realized P&L, and whether it can still cover a
    // stake. The panel shows this so a losing run is visible before it is
    // catastrophic rather than after.
    bankroll: engine.bankroll(s),
    journal: journalPayload(s),
    symbols: store.listSymbols(),
    catalog: buildCatalog(),
    recommend: recommendPairs(s),
    diag: {
      frames: store.diag.frames,
      ticks: store.diag.ticks,
      historyRows: store.diag.historyRows,
      // History blocks and the candles the BROKER itself sent for its chart.
      // A pair with ticks but no broker bars is a pair whose page was never
      // charted while the extension was listening, which is a completely
      // different problem from a feed that is not arriving at all.
      historyBlocks: store.diag.historyBlocks || 0,
      brokerRows: store.diag.brokerRows || 0,
      tfSwitches: store.diag.tfSwitches || 0,
      oddBlocks: store.diag.oddBlocks || 0,
      repaired: store.diag.repaired || 0,
      // Which extraction path resolved a frame: json-walk, regex, history,
      // named-event, single-candle, single-tick, payout, asset-type.
      methods: { ...(store.diag.methods || {}) },
      binaryFrames: store.diag.binaryFrames,
      unparsed: store.diag.unparsed,
      sockets: store.diag.sockets,
      restPolls: store.diag.restPolls,
      // Data provenance: how often a delayed proxy was refused entry to a
      // broker-owned series, and how often the broker took a series back.
      proxyRefusals: store.diag.proxyRefusals || 0,
      sourceTakeovers: store.diag.sourceTakeovers || 0,
      // Pairs scored beyond the one on screen. Without this the "best pair"
      // board would rank on a signal it never computed.
      candidates: store.diag.candidates || 0,
      bridges: store.diag.bridges.size,
      pairs: store.symbols.size,
      lastFrameAge: store.diag.lastFrameAt ? Date.now() - store.diag.lastFrameAt : null,
      uptime: Date.now() - store.diag.startedAt,
      errors: store.diag.errors,
      samples: store.diag.samples.slice(0, 6),
    },
  };
  return payload;
}

function buildSync(st, tf, now, settings) {
  if (!st) return null;
  const t = tf || 'm1';
  const tfMs = TF_MS[t] || TF_MS.m1;
  const series = st.tf?.[t] || [];
  const formingOpen = series.length ? series[series.length - 1].t : null;
  const own = st.broker?.[t] || null;
  return {
    source: st.source,
    formingOpen,
    expectedOpen: bucketOf(now, tfMs),
    aligned: formingOpen != null ? formingOpen === bucketOf(now, tfMs) : null,
    tickAgeSec: st.ts ? Math.max(0, Math.round((now - st.ts) / 1000)) : null,
    bars: series.length,
    /** Where the series we are about to draw came from. */
    barsFrom: own && own.length ? 'broker' : 'ticks',
    brokerTf: st.brokerLastTf || null,
    brokerBars: Object.values(st.broker || {}).reduce((a, l) => a + (l ? l.length : 0), 0),
    /**
     * The strategy always runs on 1-minute closes (engine.evaluate reads
     * s.tf.m1), so when the chart on screen is a coarser timeframe the UI has
     * to say so rather than let the user assume the signal was computed on
     * what they are looking at.
     */
    signalTf: 'm1',
    followSite: settings ? settings.syncSite !== false : true,
  };
}

function journalPayload(s) {
  // Break-even has to come from the payouts the ledger actually traded at, not
  // from whatever number happens to sit in Settings. A run settled at a 75%
  // payout needs 57.1% wins; printing the 86% default's 53.8% hands the user a
  // 3.3-point "edge" that the trades never had. stats() falls back to the mean
  // payout of the decided trades when it is not told one, so the setting is
  // only passed in when there is nothing to average yet.
  const hasDecided = ledger.trades.some((t) => t.result === 'win' || t.result === 'loss');
  const fallbackPayout = hasDecided ? undefined : Number.isFinite(s.payout) ? s.payout : 86;
  return {
    ...ledger.summary(fallbackPayout),
    recent: ledger.trades.slice(-40).reverse(),
    events: ledger.events.slice(0, 30),
    breakdown: {
      setup: bySetup(ledger.trades).slice(0, 10),
      symbol: bySymbol(ledger.trades).slice(0, 10),
      timeframe: byTimeframe(ledger.trades),
      direction: byDirection(ledger.trades),
      assetClass: byClass(ledger.trades),
    },
  };
}

/**
 * The selectable universe, as canonical keys.
 *
 * A pair the broker streams live is listed once, under Quotex; the REST
 * fallbacks only offer it when the live feed does not, so the same
 * instrument can never appear twice in the picker and be stored twice.
 */
function buildCatalog() {
  const all = store.listSymbols();
  const have = new Set(all.map((x) => x.sym));
  const quotex = all.filter((x) => x.source === 'quotex').map((x) => x.sym);
  const crypto = Object.keys(CRYPTO).map(canonical).filter((k) => !have.has(k));
  const fx = Object.keys(FX).map(canonical).filter((k) => !have.has(k) && !crypto.includes(k));
  return { quotex, crypto, fx };
}

/**
 * Rank the tradeable pairs and say which one to trade right now.
 * Delegates to recommend.js so the scoring can be unit-tested on its own.
 */
function recommendPairs(settings) {
  try {
    // settings.recommend was documented ("how many pairs the list shows", "how
    // many closed candles a pair needs") but never handed to the ranker, so the
    // numbers in the Settings schema were decorative.
    const cfg = settings.recommend || {};
    return recommend(store.listSymbols(), ledger.trades, {
      settings,
      signalOf: (sym) => engine.currentSignal(sym),
      payoutOf: (sym) => store.effectivePayout(sym, settings.payout),
      openSymbols: ledger.openSymbols(),
      limit: cfg.limit ?? 8,
      minBars: cfg.minBars ?? 40,
      fallbackPayout: settings.payout,
    });
  } catch (e) {
    store.noteError(`recommend: ${e?.message || e}`);
    return { best: null, ranked: [], why: String(e?.message || e) };
  }
}

/** Prefer a live Quotex pair, then anything live, then the first known symbol. */
function autoSelect() {
  const list = store.listSymbols();
  if (!list.length) return null;
  const live = list.filter((x) => !x.stale);
  const pool = live.length ? live : list;
  return (pool.find((x) => x.source === 'quotex') || pool[0]).sym;
}
