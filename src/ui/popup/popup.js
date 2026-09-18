import { formatPrice, TF_MS } from '../../background/candles.js';

const $ = (id) => document.getElementById(id);
const LABEL = { up: '▲ CALL / UP', down: '▼ PUT / DOWN', veto: '⛔ BLOCKED', none: '— NO EDGE', wait: '⏳ WARMING UP' };

const pretty = (s) => {
  if (!s) return '—';
  const u = String(s).toUpperCase();
  const otc = u.endsWith('_OTC');
  const core = u.replace('_OTC', '').replace('/', '');
  const nice = core.length === 6 ? `${core.slice(0, 3)}/${core.slice(3)}` : core;
  return nice + (otc ? ' OTC' : '');
};

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
  conn.textContent = '● ' + (!sym ? 'no feed' : sym.stale ? 'idle' : src === 'quotex' ? 'quotex' : src);
  conn.className = 'conn ' + (!sym ? '' : sym.stale ? 'idle' : 'live');

  const cat = d.catalog || {};
  const groups = [
    ['Quotex live', cat.quotex || []],
    ['Crypto', cat.crypto || []],
    ['FX proxy', cat.fx || []],
  ];
  const html = groups
    .filter(([, l]) => l.length)
    .map(([n, l]) => `<optgroup label="${n}">${l.map((s) => `<option value="${s}">${pretty(s)}</option>`).join('')}</optgroup>`)
    .join('');
  const sel = $('pair');
  if (sel.dataset.sig !== html) {
    sel.innerHTML = html || '<option value="">no instruments</option>';
    sel.dataset.sig = html;
  }
  if (d.selectedSym && sel.value !== d.selectedSym) sel.value = d.selectedSym;
  if ($('tf').value !== (d.settings?.tf || 'm1')) $('tf').value = d.settings?.tf || 'm1';

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
