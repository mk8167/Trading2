import { formatPrice, TF_MS } from '../../background/candles.js';
import { pretty } from '../../background/symbols.js';

const $ = (id) => document.getElementById(id);
const LABEL = { up: '▲ CALL / UP', down: '▼ PUT / DOWN', veto: '⛔ BLOCKED', none: '— NO EDGE', wait: '⏳ WARMING UP' };

/** Picker markers, mirroring panel.js: a pair that cannot be fed here has to
 *  look different from one that is about to be fetched. */
const MARK = { live: '●', idle: '○', fetch: '↓', site: '⚠' };

function markOf(info, siteGroup) {
  if (info) {
    if (info.bars > 0) return info.stale ? 'idle' : 'live';
    return info.source === 'quotex' ? 'site' : 'fetch';
  }
  return siteGroup ? 'site' : 'fetch';
}

const send = (cmd, payload = {}) =>
  new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ cmd, ...payload }, (res) => {
        void chrome.runtime.lastError;
        resolve(res || { ok: false });
      });
    } catch (e) {
      resolve({ ok: false });
    }
  });

function render(d) {
  if (!d?.ok) return;
  const sym = d.symbol;
  const conn = $('conn');
  const src = sym?.source;
  // A fetch started by picking this pair is not "no feed" — it is on its way.
  const fetching = !sym && !!d.selection?.pending;
  conn.textContent = (fetching ? '↓ fetching…' : '● ' + (!sym ? 'no feed' : sym.stale ? 'idle' : src === 'quotex' ? 'quotex' : src));
  conn.className = 'conn ' + (fetching ? 'idle' : !sym ? '' : sym.stale ? 'idle' : 'live');

  const cat = d.catalog || {};
  const bySym = new Map((d.symbols || []).map((s) => [s.sym, s]));
  const groups = [
    ['Quotex (site feed)', cat.quotex || [], true],
    ['Crypto', cat.crypto || [], false],
    ['FX proxy', cat.fx || [], false],
  ];
  const html = groups
    .filter(([, l]) => l.length)
    .map(([n, l, site]) => `<optgroup label="${n}">${l
      .map((s) => `<option value="${s}">${MARK[markOf(bySym.get(s), site)]} ${pretty(s)}</option>`)
      .join('')}</optgroup>`)
    .join('');
  const sel = $('pair');
  if (sel.dataset.sig !== html) {
    sel.innerHTML = html || '<option value="">no instruments</option>';
    sel.dataset.sig = html;
  }
  if (d.selectedSym && sel.value !== d.selectedSym) sel.value = d.selectedSym;
  if ($('tf').value !== (d.settings?.tf || 'm1')) $('tf').value = d.settings?.tf || 'm1';

  const note = $('pairNote');
  const sn = d.selection;
  if (note) {
    if (!sn || !sn.text) {
      note.textContent = '';
      note.className = 'pnote';
    } else {
      const good = sn.reason === 'broker-live' || sn.reason === 'proxy-live';
      note.className = 'pnote ' + (sn.pending ? 'wait' : good ? 'ok' : 'warn');
      note.textContent = (sn.pending ? '⏳ ' : good ? '' : '⚠ ') + sn.text;
    }
  }

  const sig = d.signal || { dir: 'wait', summary: 'no data', confidence: 0 };
  const box = $('sig');
  box.className = 'sig ' + (['up', 'down', 'veto'].includes(sig.dir) ? sig.dir : '');
  $('dir').textContent = LABEL[sig.dir] || '—';
  $('why').textContent = sig.summary || '';
  $('conf').style.width = Math.min(100, sig.confidence || 0) + '%';
  $('conf').style.background = sig.dir === 'up' ? '#2fbf71' : sig.dir === 'down' ? '#e04b5b' : '#f5c33b';

  $('px').textContent = sym?.price ? formatPrice(sym.price) : '—';
  const tf = d.settings?.tf || 'm1';
  const cs = d.candles?.[tf] || [];
  const last = cs[cs.length - 1];
  const ms = TF_MS[tf] || TF_MS.m1;
  $('clk').textContent = last ? `${Math.max(0, Math.ceil((last.t + ms - d.now) / 1000))}s` : '--';

  const j = d.journal || {};
  $('wl').textContent = j.decided ? `${j.wins}/${j.losses}` : '—';
  $('edge').textContent = j.decided ? `${j.edge >= 0 ? '+' : ''}${(j.edge * 100).toFixed(1)}pp` : '—';
  $('feed').textContent = d.diag?.ticks ? String(d.diag.ticks) : '0';
}

$('pair').addEventListener('change', (e) => send('symbols.select', { sym: e.target.value }));
$('tf').addEventListener('change', (e) => send('settings.patch', { patch: { tf: e.target.value } }));
$('dash').addEventListener('click', async () => {
  // sidePanel.open() must run inside the user gesture, so call it here
  // rather than round-tripping through the service worker.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId });
    window.close();
  } catch (e) {
    send('ui.openPanel');
  }
});
$('hud').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { cmd: 'hud.toggle' }).catch(() => {});
  window.close();
});

send('state.get').then(render);
setInterval(() => send('state.get').then(render), 1000);
