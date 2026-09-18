/* Every setting the schema declares has to be read by something.
 *
 * A setting that nothing reads is worse than a missing one: it is persisted,
 * it is shown in the Settings tab, the user changes it, and nothing happens —
 * with no error anywhere. That is exactly what had happened here.
 *
 *   alerts.onlyDirectional  nothing read it (only a directional signal can
 *                           become a trade, so it could not change anything)
 *   alerts.sound            written by the Settings tab, read by nobody
 *   hud.compact             persisted by the fold button, read by nobody — so
 *                           a collapsed HUD came back expanded on every reload
 *   hud.showChart           never read by the HUD
 *   chart.candles/levels/markers
 *                           never read by the panel's chart
 *   recommend.limit/minBars documented as "how many pairs the list shows" and
 *                           "closed candles a pair needs", never passed to the
 *                           ranker that implements both
 *
 * This test walks the defaults tree and requires each leaf to appear as a
 * property access somewhere in src/ outside settings.js. Comments do not count:
 * the pattern needs a `.leaf`, `?.leaf` or `['leaf']` access.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const { DEFAULTS } = await import('../src/background/settings.js');

/** Keys that are deliberately not read, with the reason. */
const ALLOWED = new Map([
  ['version', 'schema tag written for future migrations; nothing branches on it yet'],
]);

/** Flatten a defaults tree into dotted leaf paths. */
function leaves(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...leaves(v, key));
    else out.push(key);
  }
  return out;
}

/** Every .js file under src/, except settings.js itself, as one blob. */
function sourceBlob() {
  const dir = new URL('src/', ROOT);
  const files = [];
  const walk = (u) => {
    for (const e of fs.readdirSync(u, { withFileTypes: true })) {
      const child = new URL(e.name + (e.isDirectory() ? '/' : ''), u);
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith('.js') && !(u.pathname.endsWith('/background/') && e.name === 'settings.js')) {
        files.push(fs.readFileSync(child, 'utf8'));
      }
    }
  };
  walk(dir);
  assert.ok(files.length > 15, `only ${files.length} source files found — the walk is probably wrong`);
  return files.join('\n');
}

const blob = sourceBlob();
const paths = leaves(DEFAULTS);

test('the defaults tree is actually being walked', () => {
  assert.ok(paths.length >= 30, `only ${paths.length} settings keys found`);
  assert.ok(paths.includes('alerts.sound'));
  assert.ok(paths.includes('strategy.gateLookback'));
  assert.ok(paths.includes('chart.candles'));
});

test('every setting is read by something', () => {
  const orphans = [];
  for (const path of paths) {
    if (ALLOWED.has(path)) continue;
    const leaf = path.split('.').pop();
    // A property access — `settings.payout`, `cfg?.candles`, `s['minBars']`.
    const access = new RegExp(`(?:\\?\\.|\\.|\\[\\s*['"])${leaf}(?:['"]\\s*\\])?\\b`);
    if (!access.test(blob)) orphans.push(path);
  }
  assert.deepEqual(orphans, [], `these settings are declared but never read: ${orphans.join(', ')}`);
});

test('the removed no-op switch stays removed', () => {
  assert.equal('onlyDirectional' in DEFAULTS.alerts, false);
  assert.doesNotMatch(blob, /onlyDirectional/);
});
