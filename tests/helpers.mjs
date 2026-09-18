/* Shared fixtures for the test suite. */

export function bar(t, o, h, l, c) {
  return { t, o, h, l, c };
}

/**
 * Deterministic pseudo-random generator so every test run is identical.
 */
export function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/**
 * Build an m1 series. `drift` is the per-bar trend, `amp` the oscillation
 * amplitude (needed so swing pivots actually exist), `noise` the jitter.
 */
export function series({ n = 200, start = 100, drift = 0.03, amp = 0.12, noise = 0.02, seed = 7, t0 = 1_700_000_000_000 } = {}) {
  const r = rng(seed);
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const wave = amp * Math.sin(i / 3);
    const mid = p + wave + (r() - 0.5) * noise;
    const o = mid;
    const c = mid + drift + (r() - 0.5) * noise;
    const h = Math.max(o, c) + r() * noise;
    const l = Math.min(o, c) - r() * noise;
    out.push(bar(t0 + i * 60_000, round(o), round(h), round(l), round(c)));
    p += drift;
  }
  return out;
}

/** A series that oscillates around a flat mean — no trend either way. */
export function flatSeries({ n = 200, start = 100, amp = 0.3, seed = 11, t0 = 1_700_000_000_000 } = {}) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const mid = start + amp * Math.sin(i / 2.5) + (r() - 0.5) * 0.05;
    const o = mid;
    const c = mid + (r() - 0.5) * 0.1;
    const h = Math.max(o, c) + r() * 0.05;
    const l = Math.min(o, c) - r() * 0.05;
    out.push(bar(t0 + i * 60_000, round(o), round(h), round(l), round(c)));
  }
  return out;
}

const round = (v) => Math.round(v * 1e5) / 1e5;
