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

/*
 * Chrome only reveals a tab's address to an extension that already has host
 * access to it. On a mirror domain — the exact case this whole page exists for
 * — the URL comes back undefined, so auto-detection cannot work until the
 * permission has been granted once. The message below has to say that, or the
 * user is left typing an address and being told it is wrong.
 */
async function currentOrigin() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url) return '';
  try {
    return new URL(tab.url).origin;
  } catch {
    return '';
  }
}

const NO_URL_MSG =
  'Chrome hides the address of a page this extension cannot access yet — which is exactly what you are here to fix. Type the site address (e.g. https://broker.example) and press Grant.';

$('detect').addEventListener('click', async () => {
  const o = await currentOrigin();
  if (!o || o === 'null') return out(NO_URL_MSG, false);
  $('origin').value = o;
  out(`Detected ${o}`);
});

/**
 * Reload the tabs the hook was just installed on.
 *
 * The bridge runs at document_start, so a page that is already open will not
 * pick it up until it is reloaded. Telling the user to do it themselves is how
 * "granted, still no feed" reports happen; we have the permission now, so
 * matching tabs are visible and can be reloaded here.
 */
async function reloadMatching(pattern) {
  try {
    const tabs = await chrome.tabs.query({ url: pattern });
    for (const t of tabs) {
      try {
        await chrome.tabs.reload(t.id);
      } catch {
        /* a tab may close mid-loop; one failure must not stop the rest */
      }
    }
    return tabs.length;
  } catch {
    return 0;
  }
}

$('grant').addEventListener('click', async () => {
  let origin = $('origin').value.trim();
  if (!origin) origin = await currentOrigin();
  if (!/^https?:\/\/[^/]+$/.test(origin)) {
    return out(origin ? 'Enter a full origin such as https://example.com' : NO_URL_MSG, false);
  }

  out('Waiting for the permission prompt…');
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) return out('Permission declined — nothing was installed.', false);

  const r = await send('scripts.register', { origin });
  if (!r.ok) return out(`Installed the permission but the hook failed: ${r.err}`, false);
  const n = await reloadMatching(r.pattern);
  out(
    n
      ? `Hook installed on ${r.pattern} and ${n} open tab${n > 1 ? 's were' : ' was'} reloaded — the feed starts as soon as the chart loads.`
      : `Hook installed on ${r.pattern}. Reload that tab and the feed starts automatically.`,
    true
  );
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
