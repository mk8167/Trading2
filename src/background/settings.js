/* ------------------------------------------------------------------
 * settings.js — persisted user configuration with deep-merge defaults.
 * ----------------------------------------------------------------*/

export const DEFAULTS = {
  version: 6,
  selectedSym: null,
  tf: 'm1',
  expiryMinutes: 1,
  balance: 100,
  riskPct: 1,
  payout: 86,
  autoPaperTrade: true,
  alerts: { sound: false, desktop: true, minConfidence: 60, onlyDirectional: true },
  strategy: {
    minScore: 3,
    minPayout: 70,
    maxVolatility: 0.02,
    minVolatility: 0.0002,
    useMtf: true,
    usePatterns: true,
    useLevels: true,
    cooldownMs: 180_000,
    gateEnabled: true,
    gateLookback: 20,
    gateMargin: 0.03,
    maxLossStreak: 5,
  },
  hud: { enabled: true, side: 'right', compact: false, showChart: true },
  feeds: { binance: true, yahoo: true, binanceMs: 30_000, yahooMs: 60_000 },
  chart: { ema: [9, 21], levels: true, markers: true, candles: 90 },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function merge(base, patch) {
  if (!isObj(base)) return patch === undefined ? base : patch;
  if (!isObj(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    if (patch[k] === undefined) continue;
    out[k] = isObj(base[k]) ? merge(base[k], patch[k]) : patch[k];
  }
  return out;
}

let cache = null;

export async function load() {
  if (cache) return cache;
  try {
    const got = await chrome.storage.local.get('settings');
    cache = merge(DEFAULTS, got?.settings || {});
  } catch {
    cache = structuredClone(DEFAULTS);
  }
  return cache;
}

export async function get() {
  return cache || load();
}

export async function patch(p) {
  const cur = await load();
  cache = merge(cur, p);
  try {
    await chrome.storage.local.set({ settings: cache });
  } catch {
    /* storage may be unavailable in tests */
  }
  return cache;
}

export async function reset() {
  cache = structuredClone(DEFAULTS);
  try {
    await chrome.storage.local.set({ settings: cache });
  } catch {}
  return cache;
}

export function peek() {
  return cache || DEFAULTS;
}
