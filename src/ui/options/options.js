const $ = (id) => document.getElementById(id);
const out = (msg, ok = null) => {
  $('out').textContent = msg;
  $('out').className = ok === null ? 'muted' : ok ? 'muted ok' : 'muted bad';
};

const send = (cmd, payload = {}) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage({ cmd, ...payload }, (res) => {
      void chrome.runtime.lastError;
      resolve(res || { ok: false, err: chrome.runtime.lastError?.message });
    });
  });

/* --------------------------- installed hooks -------------------------- */

async function refreshHooks() {
  const r = await send('scripts.list');
  const rows = r.scripts || [];
  $('hooks').innerHTML = rows.length
    ? '<tr><th>Script id</th><th>Matches</th></tr>' +
      rows.map((s) => `<tr><td><code>${s.id}</code></td><td>${(s.matches || []).map((m) => `<code>${m}</code>`).join(' ')}</td></tr>`).join('')
    : '<tr><td class="muted">No dynamic hook installed — the built-in Quotex domains are covered by the manifest.</td></tr>';
}

async function currentOrigin() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url) return '';
  try {
    return new URL(tab.url).origin;
  } catch {
    return '';
  }
}

$('detect').addEventListener('click', async () => {
  const o = await currentOrigin();
  if (!o || o === 'null') return out('The active tab has no usable origin (is it a chrome:// page?).', false);
  $('origin').value = o;
  out(`Detected ${o}`);
});

$('grant').addEventListener('click', async () => {
  let origin = $('origin').value.trim();
  if (!origin) origin = await currentOrigin();
  if (!/^https?:\/\/[^/]+$/.test(origin)) return out('Enter a full origin such as https://example.com', false);

  out('Waiting for the permission prompt…');
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) return out('Permission declined — nothing was installed.', false);

  const r = await send('scripts.register', { origin });
  if (!r.ok) return out(`Installed the permission but the hook failed: ${r.err}`, false);
  out(`Hook installed on ${r.pattern}. Reload that tab and the feed starts automatically.`, true);
  refreshHooks();
});

$('uninstall').addEventListener('click', async () => {
  await send('scripts.unregister');
  out('Dynamic hook removed.', true);
  refreshHooks();
});

$('permList').addEventListener('click', async () => {
  const all = await chrome.permissions.getAll();
  $('perms').textContent = JSON.stringify(all, null, 2);
});

/* -------------------------------- data -------------------------------- */

$('csv').addEventListener('click', async () => {
  const r = await send('journal.csv');
  if (!r.ok) return out('No journal to export.', false);
  download(r.csv, `qsync-journal-${stamp()}.csv`, 'text/csv');
  out('Journal exported.', true);
});

$('exportAll').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  download(JSON.stringify(all, null, 2), `qsync-backup-${stamp()}.json`, 'application/json');
  out('Full backup written.', true);
});

$('importAll').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data || typeof data !== 'object') throw new Error('not a Q-Sync backup');
    await chrome.storage.local.set(data);
    out('Backup restored. Reload the extension for the service worker to pick it up.', true);
  } catch (err) {
    out(`Import failed: ${err.message}`, false);
  }
});

$('wipe').addEventListener('click', async () => {
  if (!confirm('Erase settings, journal and cached candles? This cannot be undone.')) return;
  await chrome.storage.local.clear();
  await chrome.storage.session.clear().catch(() => {});
  out('All extension data erased. Reload the extension.', true);
  refreshHooks();
});

function download(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

/* The page used to hardcode a version string and had been two releases behind.
 * The manifest is the one place a version is defined. */
try {
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
} catch {
  /* no manifest in a test stub — the page simply shows no version */
}

currentOrigin().then((o) => {
  if (o) $('origin').placeholder = o;
});
refreshHooks();
