/* ------------------------------------------------------------------
 * sync.js — keeping the extension on the same page as the broker's chart.
 *
 * The broker's socket carries candles for the chart the USER is looking at.
 * If that chart is on 5 or 15 minutes, the candles arriving are 5 or 15
 * minute candles. Nothing in the old data path ever asked that question, so
 * every block was filed as 1-minute data: the m1 series ended up holding a
 * mix of real 1-minute bars (built from ticks) and 5/15-minute bars (sent
 * by the broker), and every indicator, every aggregate, the "last closed
 * bar" the strategy fires on and the chart itself were computed on a series
 * that was not what it claimed to be. Two charts, two sets of numbers.
 *
 * Everything here is pure and testable — no chrome.*, no store:
 *   detectTf()          what timeframe is this block of candles?
 *   decideFollow()      should the extension switch pair/timeframe to match?
 *   splitCoarseRuns()   unpick a series that was already polluted.
 * ----------------------------------------------------------------*/

import { TF_MS } from './candles.js';

/** Timeframes the UI can display. m30 is not one of them (see panel/index.html). */
export const DISPLAY_TFS = ['m1', 'm5', 'm15'];

const near = (d, ms, tol) => Math.abs(d - ms) <= ms * tol;

/**
 * Median spacing between consecutive bars, or null when there is nothing to
 * measure. The median is used (not the mean) so a single missing bar — a gap
 * in the history, which happens on illiquid pairs — cannot drag the answer up.
 */
export function medianGap(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1] && rows[i - 1].t;
    const b = rows[i] && rows[i].t;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const d = b - a;
    if (d > 0) gaps.push(d);
  }
  if (gaps.length < 2) return null;
  const sorted = gaps.sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Infer the timeframe of a block of broker candles from the spacing of their
 * open times.
 *
 * The median gap is used instead of the mean so a single missing bar (a gap in
 * the history, which happens on illiquid pairs) cannot drag the answer up.
 * The 80%-of-gaps-are-similar check is what stops a block that is genuinely
 * irregular from being labelled confidently.
 *
 * @returns {'m1'|'m5'|'m15'|null} null when the block cannot be called
 */
export function detectTf(rows, { minRows = 6, tolerance = 0.15 } = {}) {
  if (!Array.isArray(rows) || rows.length < minRows) return null;
  const ts = rows.map((r) => (r && Number.isFinite(r.t) ? r.t : NaN)).filter(Number.isFinite);
  if (ts.length < minRows) return null;

  const gaps = [];
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i] - ts[i - 1];
    if (d > 0) gaps.push(d);
  }
  if (gaps.length < minRows - 2) return null;

  const median = medianGap(rows);
  if (median == null) return null;

  // Most gaps must agree with the median, otherwise this is a mixed series
  // (i.e. exactly the pollution this module exists to prevent) and calling a
  // timeframe for it would only hide the problem.
  const agree = gaps.filter((d) => d <= median * 1.5 && d >= median * 0.5).length;
  if (agree < gaps.length * 0.8) return null;

  for (const tf of DISPLAY_TFS) {
    if (near(median, TF_MS[tf], tolerance)) return tf;
  }
  return null;
}

/**
 * Last resort for a block detectTf() refused: are these at least minute-spaced?
 *
 * A wilder tolerance on purpose. A broker that sends 1-minute candles with
 * bars missing (weekends, a quiet pair) has a median gap of exactly 60s but too
 * few gaps at exactly 60s to clear detectTf()'s 80% agreement rule — and those
 * bars are still perfectly good 1-minute candles. Anything coarser than that
 * has to match its own timeframe at detectTf()'s stricter tolerance, so this
 * can never wave a 5-minute block through as 1-minute data.
 */
export function minuteSpaced(rows, tolerance = 0.4) {
  const median = medianGap(rows);
  if (median == null) return rows.length <= 3; // too short to measure at all
  return near(median, TF_MS.m1, tolerance);
}

/**
 * Should the extension move its pair / timeframe to match the broker's chart?
 *
 * @param {object} state
 * @param {{sym?:string, tf?:string, at?:number}|null} state.site  the chart the
 *   broker just sent candles for (i.e. what the user is looking at)
 * @param {string|null} state.selected  currently displayed pair (canonical)
 * @param {string} state.tf             currently selected timeframe
 * @param {boolean} [state.enabled]     settings.syncSite
 * @param {number} [state.lastFollowAt] when we last switched (rate limit)
 * @param {number} [state.now]
 * @param {number} [state.maxAgeMs]     ignore anything older than this
 * @param {number} [state.minGapMs]     never switch twice inside this window
 * @returns {{sym?:string, tf?:string}|null} a patch to apply, or null
 */
export function decideFollow(state) {
  const {
    site,
    selected = null,
    tf = 'm1',
    enabled = true,
    lastFollowAt = 0,
    now = Date.now(),
    maxAgeMs = 120_000,
    minGapMs = 5000,
  } = state || {};

  if (!enabled || !site || !site.sym) return null;
  if (site.at && now - site.at > maxAgeMs) return null;
  if (lastFollowAt && now - lastFollowAt < minGapMs) return null;

  const out = {};
  if (site.sym !== selected) out.sym = site.sym;
  // Only follow a timeframe the UI can actually draw. A 30m chart on the site
  // leaves the extension on its own timeframe rather than switching to one the
  // panel has no option for.
  if (site.tf && site.tf !== tf && DISPLAY_TFS.includes(site.tf)) out.tf = site.tf;
  return Object.keys(out).length ? out : null;
}

/**
 * Split a candle series back into "real 1-minute bars" and runs that are
 * obviously something coarser.
 *
 * This exists to heal series built by an older build (or restored from its
 * session snapshot), where the broker's 5- and 15-minute candles were filed
 * as 1-minute ones. A bar is only moved when it is part of a run of at least
 * `minRun` consecutive bars on the same coarse grid — a genuine 1-minute
 * series that merely has gaps (weekends, a sleeping worker) has 1-minute
 * spacing, not repeated 5-minute spacing, so it is left alone.
 *
 * @returns {{m1:Array, coarse:{m5:Array, m15:Array}}}
 */
export function splitCoarseRuns(series, { minRun = 4, tolerance = 0.15 } = {}) {
  const arr = (Array.isArray(series) ? series : []).filter(
    (c) => c && Number.isFinite(c.t) && Number.isFinite(c.o)
  );
  const coarse = { m5: [], m15: [] };
  if (arr.length < minRun + 1) return { m1: arr.slice(), coarse };

  const taken = new Set();
  // Coarser first: a 15-minute run must not be recorded as three 5-minute gaps.
  for (const tf of ['m15', 'm5']) {
    const ms = TF_MS[tf];
    let start = -1;
    for (let i = 1; i <= arr.length; i++) {
      const d = i < arr.length ? arr[i].t - arr[i - 1].t : -1;
      const onGrid = d > 0 && near(d, ms, tolerance);
      if (onGrid && start < 0) start = i;
      if (!onGrid && start >= 0) {
        const from = start - 1; // the run covers the bar that started it too
        const to = i - 1;
        const len = to - from + 1;
        const dirty = Array.from({ length: len }, (_, k) => from + k).some((k) => taken.has(k));
        if (len >= minRun + 1 && !dirty) {
          for (let k = from; k <= to; k++) {
            taken.add(k);
            coarse[tf].push(arr[k]);
          }
        }
        start = -1;
      }
    }
  }
  const m1 = arr.filter((_, i) => !taken.has(i));
  return { m1, coarse };
}
