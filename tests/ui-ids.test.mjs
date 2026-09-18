/* Every element id the UI reaches for must actually exist.
 *
 * The DOM stub in dom-stub.mjs auto-vivifies unknown ids, which is what makes
 * it possible to run panel.js at all — but it also means that stub can never
 * catch a typo'd id. In a real browser `$('sBalanse')` returns null, the next
 * property access throws, and because these are top-level statements in a
 * module the ENTIRE panel script dies: no chart, no signal, no journal, and
 * the only evidence is a console error nobody is looking at. This is the
 * static check that closes that hole.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, ROOT), 'utf8');

const PAGES = [
  { js: 'src/ui/panel/panel.js', html: 'src/ui/panel/index.html', name: 'panel' },
  { js: 'src/ui/popup/popup.js', html: 'src/ui/popup/index.html', name: 'popup' },
  { js: 'src/ui/options/options.js', html: 'src/ui/options/index.html', name: 'options' },
];

/** Ids a file looks up: `$('x')`, `getElementById('x')`, `querySelector('#x')`. */
function idsUsed(code) {
  const out = new Set();
  for (const m of code.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) out.add(m[1]);
  for (const m of code.matchAll(/\$\(\s*"([^"]+)"\s*\)/g)) out.add(m[1]);
  for (const m of code.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) out.add(m[1]);
  for (const m of code.matchAll(/querySelector\(\s*['"]#([\w-]+)['"]\s*\)/g)) out.add(m[1]);
  return out;
}

/** Ids declared in markup — including markup built by the JS itself. */
function idsDeclared(markup) {
  const out = new Set();
  for (const m of markup.matchAll(/\bid\s*=\s*"([^"]+)"/g)) out.add(m[1]);
  for (const m of markup.matchAll(/\bid\s*=\s*'([^']+)'/g)) out.add(m[1]);
  // Template literals interpolate ids too, e.g. `id="${x}"`; those cannot be
  // resolved statically, so they are noted and skipped rather than guessed.
  return out;
}

for (const page of PAGES) {
  test(`${page.name}: every id it looks up is declared somewhere`, () => {
    const code = read(page.js);
    const html = read(page.html);
    const used = idsUsed(code);
    const declared = new Set([...idsDeclared(html), ...idsDeclared(code)]);
    assert.ok(used.size > 5, `only ${used.size} ids found — the extractor is probably broken`);
    const missing = [...used].filter((id) => !declared.has(id)).sort();
    assert.deepEqual(missing, [], `these ids are looked up but never exist: ${missing.join(', ')}`);
  });

  test(`${page.name}: top-level element access is guarded or the id is static HTML`, () => {
    const code = read(page.js);
    const html = read(page.html);
    const staticIds = idsDeclared(html);
    // `$('x').addEventListener(...)` at the top level of a module runs at load
    // time. If 'x' is not in the HTML yet, that is a hard crash on open.
    const risky = [];
    for (const m of code.matchAll(/\$\(\s*'([^']+)'\s*\)\s*\.\s*(addEventListener|innerHTML|textContent|value|onclick)/g)) {
      if (!staticIds.has(m[1])) risky.push(`${m[1]}.${m[2]}`);
    }
    assert.deepEqual(risky, [], `direct access to a non-static id (crashes at load): ${risky.join(', ')}`);
  });

  test(`${page.name}: no id is declared twice`, () => {
    const html = read(page.html);
    const seen = new Map();
    const dupes = [];
    for (const m of html.matchAll(/\bid\s*=\s*"([^"]+)"/g)) {
      if (seen.has(m[1])) dupes.push(m[1]);
      seen.set(m[1], true);
    }
    assert.deepEqual(dupes, [], `duplicate ids make getElementById pick one at random: ${dupes.join(', ')}`);
  });

  test(`${page.name}: the page loads its script as a module when the script uses import`, () => {
    const code = read(page.js);
    const html = read(page.html);
    if (!/^\s*import\s/m.test(code)) return; // classic script, nothing to check
    const tag = html.match(/<script[^>]*src="[^"]*"[^>]*>/g) || [];
    assert.ok(tag.length, 'the HTML does not reference its script at all');
    for (const t of tag) {
      assert.match(t, /type\s*=\s*"module"/, `an ES-module script loaded without type="module" silently does nothing: ${t}`);
    }
  });
}

test('the side panel HTML declares the slots the renderers write into', () => {
  const html = read('src/ui/panel/index.html');
  const ids = idsDeclared(html);
  // These are the cards whose absence would silently hide risk information.
  for (const required of ['bankroll', 'jstats', 'sigCard', 'recCard', 'fdiag', 'trades', 'ctxGrid', 'vetoes', 'events', 'tabs', 'chart']) {
    assert.ok(ids.has(required), `#${required} is missing from panel/index.html`);
  }
});

test('the content scripts are self-contained — every id they use, they create', () => {
  for (const f of ['src/content/hud.js', 'src/content/bridge.js']) {
    const code = read(f);
    const used = idsUsed(code);
    const declared = idsDeclared(code);
    const missing = [...used].filter((id) => !declared.has(id)).sort();
    assert.deepEqual(missing, [], `${f} reaches for ids it never creates: ${missing.join(', ')}`);
  }
});

test('manifest paths all exist on disk', () => {
  const m = JSON.parse(read('manifest.json'));
  const paths = [
    m.background?.service_worker,
    m.action?.default_popup,
    m.side_panel?.default_path,
    m.options_page,
    ...(m.content_scripts || []).flatMap((cs) => cs.js),
    ...Object.values(m.icons || {}),
    ...Object.values(m.action?.default_icon || {}),
  ].filter(Boolean);
  assert.ok(paths.length >= 8, `only ${paths.length} paths in the manifest — the extractor is probably broken`);
  const missing = paths.filter((p) => !fs.existsSync(new URL(p, ROOT)));
  assert.deepEqual(missing, [], `manifest points at files that do not exist: ${missing.join(', ')}`);
});

test('manifest grants permission for every host the code fetches', () => {
  const m = JSON.parse(read('manifest.json'));
  const granted = (m.host_permissions || []).concat(m.optional_host_permissions || []);
  const hosts = new Set();
  for (const f of ['src/background/feeds/binance.js', 'src/background/feeds/yahoo.js']) {
    for (const u of read(f).matchAll(/https:\/\/[a-z0-9.-]+/g)) hosts.add(u[0]);
  }
  assert.ok(hosts.size >= 3, `only ${hosts.size} feed hosts found — the extractor is probably broken`);
  for (const h of hosts) {
    const ok = granted.some((g) => g.includes(h.replace('https://', '')));
    assert.ok(ok, `${h} is fetched but not in host_permissions — every fallback request would be blocked`);
  }
});

test('manifest version matches package.json version', () => {
  assert.equal(JSON.parse(read('manifest.json')).version, JSON.parse(read('package.json')).version,
    'a version mismatch means the store listing and the loaded extension disagree');
});

/* --------------------------- version drift ---------------------------- */

test('no page hardcodes a version number', () => {
  // The panel and the options page both shipped "v6.0.0" while the manifest
  // said 6.2.0, and nothing could notice: a version string is just text.
  for (const page of PAGES) {
    const html = read(page.html);
    assert.doesNotMatch(html, /\bv\d+\.\d+\.\d+\b/, `${page.name} must not hardcode a version`);
  }
});

test('every page that shows a version reads it from the manifest', () => {
  const shows = { panel: 'src/ui/panel/panel.js', options: 'src/ui/options/options.js' };
  for (const [name, js] of Object.entries(shows)) {
    const html = read(PAGES.find((p) => p.name === name).html);
    const code = read(js);
    assert.match(html, /id="ver"/, `${name} needs an element to put the version in`);
    assert.match(code, /getManifest\(\)\.version/, `${name} must read the manifest version`);
  }
  assert.doesNotMatch(read('src/ui/popup/popup.js'), /\bv\d+\.\d+\.\d+\b/);
});
