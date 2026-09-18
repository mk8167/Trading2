/* ------------------------------------------------------------------
 * strategy.js — weighted confluence engine.
 *
 * Every rule votes with a weight and a direction. Votes are summed per
 * direction; the net score decides the call and the confidence. Rules
 * never fire on the forming candle — `analyze()` drops the last bar of
 * each series first, so a signal is only ever produced on closed data.
 *
 * Score scale: 6 net points == "strong" == 100% confidence.
 * ----------------------------------------------------------------*/

import * as I from './indicators.js';
import {
  detectPatterns,
  levels,
  nearestLevel,
  structure,
  breakAndRetest,
  body,
  range,
} from './patterns.js';
import { closes } from './candles.js';
import { volBand, closureText } from './symbols.js';

export const DEFAULT_OPTS = {
  minScore: 3, // net points required before we show a direction
  minPayout: 70, // below this the maths is hopeless
  maxVolatility: 0.02, // ATR/price above this = too wild to trade
  minVolatility: 0.0002, // dead market = no movement to capture
  // When the asset class is known, its own volatility band replaces the two
  // numbers above: one shared band judged a crypto pair by forex standards
  // (vetoing almost everything) and an OTC pair by crypto standards
  // (vetoing almost nothing). Set useClassBands false to force the manual
  // numbers regardless of class.
  useClassBands: true,
  // Refuse to signal on a market that is not actually trading.
  respectMarketHours: true,
  useMtf: true, // let m5/m15 add weight
  usePatterns: true,
  useLevels: true,
  cooldownMs: 180_000,
  gateEnabled: true,
  gateLookback: 20,
  gateMargin: 0.03, // stop trading 3pp below break-even win rate
  maxLossStreak: 5,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * @param {{m1?:Array,m5?:Array,m15?:Array, payout?:number, price?:number}} data
 * @param {object} opts merged over DEFAULT_OPTS
 * @returns {{
 *  dir:'up'|'down'|'none'|'wait'|'veto',
 *  score:number, confidence:number, confidenceRaw:number,
 *  signals:Array, vetoes:Array, ctx:object, summary:string
 * }}
 */
export function analyze(data, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const m1All = data.m1 || [];
  const m5All = data.m5 || [];
  const m15All = data.m15 || [];

  // Closed-bar decision by default (reliable). `preview` includes the still
  // forming bar so the UI can warn a few seconds early — it is explicitly
  // NOT used for the executed trade because it repaints.
  const m1 = o.preview ? m1All.slice() : m1All.slice(0, -1);
  const m5 = o.preview ? m5All.slice() : m5All.slice(0, -1);
  const m15 = o.preview ? m15All.slice() : m15All.slice(0, -1);

  if (m1.length < 40) return wait(`Warming up — ${m1.length}/40 closed candles`);

  const c = closes(m1);
  const last = m1[m1.length - 1];
  const price = Number.isFinite(data.price) ? data.price : last.c;

  const A = I.last(I.atr(m1, 14)) || 0;
  if (!A) return wait('ATR not ready');

  const vol = A / (price || 1);
  const vetoes = [];
  const signals = [];

  const assetClass = data.assetClass || 'unknown';
  const band = o.useClassBands && data.assetClass ? volBand(assetClass) : { min: o.minVolatility, max: o.maxVolatility };

  // A frozen market produces no information, so a "signal" read off it is
  // noise with a confident label on it. The caller decides openness (from
  // the live clock, or per-bar when backtesting) and tells us the answer.
  if (o.respectMarketHours && data.marketOpen === false) {
    // The caller has already established closure (from the live clock, or
    // from the bar timestamp when backtesting), so take its word for it and
    // explain — re-checking the clock here would make the message depend on
    // which day it happens to be.
    vetoes.push(closureText(assetClass));
  }

  if (vol > band.max) vetoes.push(`Volatility ${pct(vol)} > ${pct(band.max)} cap for ${assetClass} — news/spike risk`);
  if (vol < band.min) vetoes.push(`Volatility ${pct(vol)} < ${pct(band.min)} floor for ${assetClass} — market is dead`);
  if (o.minPayout && Number.isFinite(data.payout) && data.payout < o.minPayout) {
    vetoes.push(`Payout ${data.payout}% < ${o.minPayout}% break-even floor`);
  }

  const st = structure(m1, A);
  const e9 = I.ema(c, 9);
  const e21 = I.ema(c, 21);
  const e50 = I.ema(c, 50);
  const r = I.rsi(c, 14);
  const rNow = I.last(r);
  const rPrev = I.prev(r, 1);
  const macd = I.macd(c);
  const stoch = I.stochastic(m1, 14, 3);
  const boll = I.bollinger(c, 20, 2);
  const lvls = o.useLevels ? levels(m1, A) : [];

  const add = (dir, weight, name, note) => {
    if (!dir || weight <= 0) return;
    signals.push({ dir, weight, name, note: note || '' });
  };

  /* --- 1. market structure ---------------------------------------- */
  if (st === 'up') add('up', 2, 'Structure: higher highs + higher lows');
  if (st === 'down') add('down', 2, 'Structure: lower highs + lower lows');

  /* --- 2. trend (EMA stack + slope) -------------------------------- */
  const e21Now = I.last(e21);
  const e50Now = I.last(e50);
  const slope21 = I.slope(e21.map((v) => (v == null ? last.c : v)), 5);
  if (e21Now != null && e50Now != null) {
    if (last.c > e21Now && e21Now > e50Now && slope21 > 0) add('up', 2, 'Trend: price > EMA21 > EMA50, rising');
    if (last.c < e21Now && e21Now < e50Now && slope21 < 0) add('down', 2, 'Trend: price < EMA21 < EMA50, falling');
  }

  /* --- 3. momentum -------------------------------------------------- */
  if (rNow != null) {
    if (rNow < 30 && rNow > (rPrev ?? 0)) add('up', 1, `RSI ${rNow.toFixed(0)} curling up from oversold`);
    if (rNow > 70 && rNow < (rPrev ?? 100)) add('down', 1, `RSI ${rNow.toFixed(0)} curling down from overbought`);
    if (rNow >= 45 && rNow <= 65) {
      if (rNow > (rPrev ?? rNow)) add('up', 1, `RSI ${rNow.toFixed(0)} rising through the mid band`);
      else if (rNow < (rPrev ?? rNow)) add('down', 1, `RSI ${rNow.toFixed(0)} falling through the mid band`);
    }
  }
  const hNow = I.last(macd.hist);
  const hPrev = I.prev(macd.hist, 1);
  if (hNow != null && hPrev != null) {
    if (hPrev <= 0 && hNow > 0) add('up', 1, 'MACD histogram flipped positive');
    if (hPrev >= 0 && hNow < 0) add('down', 1, 'MACD histogram flipped negative');
  }
  const kNow = I.last(stoch.k);
  const dNow = I.last(stoch.d);
  const kPrev = I.prev(stoch.k, 1);
  const dPrev = I.prev(stoch.d, 1);
  if ([kNow, dNow, kPrev, dPrev].every((v) => v != null)) {
    if (kPrev <= dPrev && kNow > dNow && kNow < 35) add('up', 1, 'Stochastic bullish cross below 35');
    if (kPrev >= dPrev && kNow < dNow && kNow > 65) add('down', 1, 'Stochastic bearish cross above 65');
  }

  /* --- 4. price action at levels ------------------------------------ */
  if (o.usePatterns) {
    const atLow = nearestLevel(Math.min(last.o, last.c, last.l), lvls, 0.6 * A);
    const atHigh = nearestLevel(Math.max(last.o, last.c, last.h), lvls, 0.6 * A);
    for (const p of detectPatterns(m1)) {
      if (!p.dir) continue;
      let w = p.weight;
      let where = '';
      if (p.dir === 'up' && atLow && atLow.level.kind !== 'resistance') {
        w += 1;
        where = ' at support';
      }
      if (p.dir === 'down' && atHigh && atHigh.level.kind !== 'support') {
        w += 1;
        where = ' at resistance';
      }
      // A pin bar pointing against a strong trend is a weaker vote.
      if (p.weight === 3 && ((p.dir === 'up' && st === 'down') || (p.dir === 'down' && st === 'up'))) w -= 1;
      add(p.dir, Math.max(0, w), `${p.name}${where}`);
    }
    if (o.useLevels) {
      // Only the strongest retest counts — several levels cannot all be
      // "the" retest, and stacking them would swamp every other rule.
      for (const lv of lvls.slice(0, 6)) {
        const br = breakAndRetest(m1, lv.price, A);
        if (br) {
          add(br, 3, `Break + retest ${br === 'up' ? 'of resistance' : 'of support'}`);
          break;
        }
      }
    }
  }

  /* --- 4b. ADX trend-strength confirmation --------------------------- */
  const adxRes = I.adx(m1, 14);
  const adxNow = I.last(adxRes.adx);
  const pdiNow = I.last(adxRes.pdi);
  const mdiNow = I.last(adxRes.mdi);
  if (adxNow != null && adxNow > 25 && pdiNow != null && mdiNow != null) {
    add(pdiNow > mdiNow ? 'up' : 'down', 1, `ADX ${adxNow.toFixed(0)} confirms trend strength`);
  }

  /* --- 5. Bollinger mean reversion ---------------------------------- */
  const pctB = I.last(boll.pctB);
  if (pctB != null) {
    if (pctB < 0.02 && body(last) / range(last) > 0.4 && last.c > last.o) add('up', 1, 'Closed back inside the lower band');
    if (pctB > 0.98 && body(last) / range(last) > 0.4 && last.c < last.o) add('down', 1, 'Closed back inside the upper band');
  }

  /* --- 6. multi-timeframe confirmation ------------------------------ */
  let mtf = { m5: 'warming', m15: 'warming' };
  if (o.useMtf) {
    if (m5.length >= 40) {
      mtf.m5 = structure(m5, I.last(I.atr(m5, 14)) || 0);
      const c5 = closes(m5);
      const e21_5 = I.last(I.ema(c5, 21));
      const lastClose5 = c5[c5.length - 1];
      if (e21_5 != null) {
        if (mtf.m5 === 'up' && lastClose5 > e21_5) add('up', 2, 'MTF: 5m trend up');
        if (mtf.m5 === 'down' && lastClose5 < e21_5) add('down', 2, 'MTF: 5m trend down');
      }
    }
    if (m15.length >= 40) {
      mtf.m15 = structure(m15, I.last(I.atr(m15, 14)) || 0);
      if (mtf.m15 === 'up') add('up', 1, 'MTF: 15m bias up');
      if (mtf.m15 === 'down') add('down', 1, 'MTF: 15m bias down');
    }
  }

  /* --- tally -------------------------------------------------------- */
  let up = 0;
  let down = 0;
  for (const s of signals) {
    if (s.dir === 'up') up += s.weight;
    else if (s.dir === 'down') down += s.weight;
  }
  const net = up - down;
  const gross = up + down;
  const dir = net > 0 ? 'up' : net < 0 ? 'down' : 'none';
  const score = Math.abs(net);
  const agreement = gross ? Math.abs(net) / gross : 0; // 1 = every rule agrees
  const confidenceRaw = clamp((score / 6) * 100, 0, 100);
  const confidence = Math.round(confidenceRaw * (0.65 + 0.35 * agreement));

  const ctx = {
    price,
    atr: A,
    volatility: vol,
    assetClass,
    band,
    marketOpen: data.marketOpen !== false,
    rsi: rNow,
    stochK: kNow,
    stochD: dNow,
    macdHist: hNow,
    ema9: I.last(e9),
    ema21: e21Now,
    ema50: e50Now,
    bollPctB: pctB,
    adx: adxNow,
    pdi: pdiNow,
    mdi: mdiNow,
    structure: st,
    mtf,
    levels: lvls.slice(0, 8),
    upVotes: up,
    downVotes: down,
    candles: m1.length,
    at: last.t,
  };

  const sorted = signals.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));

  if (vetoes.length) {
    return {
      dir: 'veto',
      score,
      confidence,
      confidenceRaw: Math.round(confidenceRaw),
      signals: sorted,
      vetoes,
      ctx,
      summary: `BLOCKED — ${vetoes[0]}`,
    };
  }

  if (dir === 'none' || score < o.minScore) {
    return {
      dir: 'none',
      score,
      confidence,
      confidenceRaw: Math.round(confidenceRaw),
      signals: sorted,
      vetoes,
      ctx,
      summary: sorted.length
        ? `No edge — net ${net} (${up} up / ${down} down), needs ${o.minScore}`
        : `Nothing set up (structure ${st})`,
    };
  }

  const top = sorted.filter((s) => s.dir === dir).slice(0, 3).map((s) => s.name);
  return {
    dir,
    score,
    confidence,
    confidenceRaw: Math.round(confidenceRaw),
    signals: sorted,
    vetoes,
    ctx,
    summary: `${dir.toUpperCase()} · net ${net} · ${top.join(' · ')}`,
  };
}

function wait(why) {
  return { dir: 'wait', score: 0, confidence: 0, confidenceRaw: 0, signals: [], vetoes: [], ctx: null, summary: why };
}

const pct = (v) => `${(v * 100).toFixed(3)}%`;

/* --------------------- trade gating (risk control) ------------------- */

/**
 * Binary-options break-even win rate for a given payout.
 * At 86% payout you need 53.8% wins just to stand still.
 */
export function breakEvenWinRate(payoutPct) {
  const p = Number(payoutPct);
  if (!Number.isFinite(p) || p <= 0) return 1;
  return 100 / (100 + p);
}

/**
 * Did this trade actually decide anything?
 *
 * Only 'win' and 'loss' carry evidence. An open trade has not finished, a
 * 'void' never obtained a settlement price, and a 'tie' returned the stake —
 * counting any of them in a denominator turns the win rate into a function of
 * how many trades happen to be in flight rather than of how often the strategy
 * is right.
 *
 * journal.isDecided() is the same rule. It is repeated here (four words) rather
 * than imported because journal.js already imports breakEvenWinRate() from
 * this module, and an import cycle between the two would be a worse trade than
 * the duplication. tests/strategy.test.mjs asserts the two agree.
 */
export const isDecided = (t) => !!t && (t.result === 'win' || t.result === 'loss');

/**
 * Decide whether a fresh signal is allowed to become a paper trade.
 * @returns {{ok:boolean, reason?:string}}
 */
export function gate({ signal, trades = [], payout, now = Date.now(), opts = {} }) {
  const o = { ...DEFAULT_OPTS, ...opts };
  if (!signal || (signal.dir !== 'up' && signal.dir !== 'down')) {
    return { ok: false, reason: signal?.dir === 'veto' ? `Vetoed: ${signal.vetoes[0]}` : 'No directional signal' };
  }
  if (signal.score < o.minScore) return { ok: false, reason: `Score ${signal.score} < ${o.minScore}` };

  const rows = trades || [];
  const be = breakEvenWinRate(payout);
  if (o.gateEnabled) {
    // The window is the last N *decided* trades, not the last N rows. Counting
    // every row meant trades that had not finished — or that were voided, or
    // that returned their stake — landed in the denominator, so 9 wins and 3
    // losses alongside 8 just-opened trades read as 45% and the gate stopped
    // trading a strategy that was comfortably above break-even. The journal
    // already excluded these (journal.isDecided); the live gate did not.
    const recent = rows.filter(isDecided).slice(-o.gateLookback);
    if (recent.length >= Math.max(8, o.gateLookback / 2)) {
      const wr = recent.filter((t) => t.result === 'win').length / recent.length;
      if (wr < be + o.gateMargin) {
        return { ok: false, reason: `GATE — win rate ${(wr * 100).toFixed(0)}% < ${((be + o.gateMargin) * 100).toFixed(0)}% break-even+margin` };
      }
    }
    const streak = lossStreak(rows);
    if (o.maxLossStreak && streak >= o.maxLossStreak) {
      return { ok: false, reason: `GATE — ${streak} losses in a row, stop and review` };
    }
  }

  const lastSameDir = [...rows].reverse().find((t) => t.dir === signal.dir);
  if (lastSameDir && now - lastSameDir.openedAt < o.cooldownMs) {
    const mins = Math.max(1, Math.round((o.cooldownMs - (now - lastSameDir.openedAt)) / 60000));
    return { ok: false, reason: `Cooldown — last ${signal.dir} signal ${mins}m ago` };
  }
  return { ok: true };
}

/**
 * Consecutive losses at the end of the journal.
 *
 * Undecided rows are skipped rather than allowed to break the run: a void (or
 * a tie, or a trade opened seconds ago) is not evidence that the losing streak
 * ended, and letting it terminate the count would make "5 losses in a row,
 * stop and review" disappear exactly when a pair's feed went quiet.
 */
export function lossStreak(trades) {
  let n = 0;
  const rows = trades || [];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!isDecided(rows[i])) continue;
    if (rows[i].result === 'loss') n++;
    else break;
  }
  return n;
}

export function winStreak(trades) {
  let n = 0;
  const rows = trades || [];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!isDecided(rows[i])) continue;
    if (rows[i].result === 'win') n++;
    else break;
  }
  return n;
}
