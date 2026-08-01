// Reset — small shared helpers (no dependencies).

export const now = () => Date.now();

export const uid = () =>
  (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2, 10);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Escape text destined for innerHTML.
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Running-clock display: M:SS under an hour, H:MM:SS at/over an hour.
export function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Rounded human form for summaries: "25 min", "1h 4m", "0 min".
export function fmtHuman(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
export function monthKey(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function vibrate(pattern) {
  if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (_) {} }
}

// Lightweight toast with an optional action button. Returns a dismiss fn.
let toastTimer = null;
export function toast(msg, { actionLabel, onAction, ms = 3000 } = {}) {
  let host = $('#toast');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast';
    document.body.appendChild(host);
  }
  host.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  host.appendChild(span);
  if (actionLabel && onAction) {
    const btn = document.createElement('button');
    btn.textContent = actionLabel;
    btn.className = 'toast-action';
    btn.addEventListener('click', () => { hide(); onAction(); });
    host.appendChild(btn);
  }
  host.classList.add('show');
  clearTimeout(toastTimer);
  const hide = () => { host.classList.remove('show'); };
  toastTimer = setTimeout(hide, ms);
  return hide;
}
