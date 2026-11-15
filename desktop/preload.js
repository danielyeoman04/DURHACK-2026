/*
 * Runs inside the hosted Pulse page. The page itself is not modified: this script only watches
 * its DOM (ids from pulse1/index.html: #listen, #resUrl, #auto) and talks to main.js.
 * If those ids ever change, the app still opens; it just stops saving links (a warning is logged).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pulseDesktop', { retry: () => ipcRenderer.send('app:retry') });

const $ = id => document.getElementById(id);
const DUPLICATE_MS = 60000;          // the sender plays 5 times; count a repeat once
let lastText = '', lastAt = 0, links = [];

function start() {
  const listen = $('listen'), resUrl = $('resUrl');
  if (!listen || !resUrl) return;     // offline.html or an unknown page

  // desktop never opens links by itself: the user clicks a notification or a saved link
  const auto = $('auto');
  if (auto) { auto.checked = false; auto.disabled = true; if (auto.parentElement) auto.parentElement.hidden = true; }

  const isOn = () => listen.classList.contains('on');
  const report = () => ipcRenderer.send('listening:state', isOn());
  new MutationObserver(report).observe(listen, { attributes: true, attributeFilter: ['class'] });
  report();

  new MutationObserver(() => {
    const text = resUrl.textContent.trim();
    if (!text) return;
    if (text === lastText && Date.now() - lastAt < DUPLICATE_MS) return;
    lastText = text; lastAt = Date.now();
    ipcRenderer.invoke('links:add', text);
  }).observe(resUrl, { childList: true, characterData: true, subtree: true });

  ipcRenderer.on('listening:toggle', () => listen.click());
  setTimeout(() => { if (!isOn()) listen.click(); }, 600);   // start listening at launch
  buildPanel();
}

// ---------- saved links panel (own Shadow DOM, so page styles can't touch it) ----------
function buildPanel() {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .btn { position: fixed; right: 14px; bottom: 14px; z-index: 2147483647; font: 600 13px system-ui, sans-serif;
             background: #111; color: #fff; border: 1px solid #555; border-radius: 999px; padding: 8px 14px; cursor: pointer; }
      .box { position: fixed; right: 14px; bottom: 56px; z-index: 2147483647; width: min(420px, calc(100vw - 28px));
             max-height: 60vh; overflow: auto; background: #111; color: #eee; border: 1px solid #555; border-radius: 12px;
             font: 13px system-ui, sans-serif; padding: 8px; }
      .box[hidden] { display: none; }
      .row { display: flex; gap: 6px; align-items: center; padding: 6px; border-bottom: 1px solid #333; }
      .row:last-child { border: 0; }
      .u { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .t { color: #999; font-size: 11px; }
      button.s { background: #333; color: #fff; border: 0; border-radius: 6px; padding: 4px 8px; cursor: pointer; }
      .empty { padding: 10px; color: #999; }
    </style>
    <button class="btn" id="b"></button>
    <div class="box" id="x" hidden></div>`;
  const btn = root.getElementById('b'), box = root.getElementById('x');
  btn.onclick = () => { box.hidden = !box.hidden; };
  function render() {
    btn.textContent = `Saved links (${links.length})`;
    box.replaceChildren();
    if (!links.length) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = 'Nothing heard yet.'; box.append(d); return; }
    for (const l of links) {
      const row = document.createElement('div'); row.className = 'row';
      const u = document.createElement('div'); u.className = 'u'; u.textContent = l.url; u.title = l.url;
      const t = document.createElement('span'); t.className = 't'; t.textContent = new Date(l.at).toLocaleTimeString();
      const o = document.createElement('button'); o.className = 's'; o.textContent = 'Open'; o.onclick = () => ipcRenderer.invoke('links:open', l.url);
      const r = document.createElement('button'); r.className = 's'; r.textContent = 'Remove'; r.onclick = () => ipcRenderer.invoke('links:remove', l.url);
      row.append(u, t, o, r); box.append(row);
    }
  }
  ipcRenderer.on('links:changed', (_e, list) => { links = list; render(); });
  ipcRenderer.invoke('links:list').then(list => { links = list; render(); });
  document.body.append(host);
}

window.addEventListener('DOMContentLoaded', () => {
  try { start(); } catch (e) { console.warn('Pulse desktop: could not attach to the page:', e); }
});
