// Reset — app controller: state, session lifecycle, screen rendering, interactions.
import { $, $$, uid, now, esc, fmtClock, fmtHuman, fmtDate, fmtTime, monthKey, vibrate, toast } from './util.js';
import * as db from './db.js';
import { buildSeedTemplate } from './seed.js';
import * as T from './timer.js';
import * as photos from './photos.js';
import { zipCreate, zipRead } from './zip.js';

// ---------------- State ----------------
const S = {
  screen: 'home',       // home | run | wrap | history | detail | templates | settings
  templates: [],
  sessions: [],         // completed/abandoned, for history & home recents
  session: null,        // the active session (null if none)
  detailId: null,
  draft: null,          // template being edited/created
  settings: { theme: 'system', wakeLock: true, haptics: true, autoAdvance: true, defaultPhotoMode: 'both' },
};

const app = () => $('#app');
let tickTimer = null;

// ---------------- Boot ----------------
async function boot() {
  await db.openDB();
  S.settings = { ...S.settings, ...(await db.metaGet('settings', {})) };
  applyTheme();
  await ensureSeed();
  await reloadData();

  // Resume an active session if one exists.
  const activeId = await db.metaGet('activeSessionId', null);
  if (activeId) {
    const s = await db.get('sessions', activeId);
    if (s && s.status === 'active' && !s.deletedAt) S.session = s;
  }

  render();
  await checkForgotten();

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      await checkForgotten();
      if (S.screen === 'run') { reacquireWake(); }
    }
  });

  registerSW();
}

async function ensureSeed() {
  const seeded = await db.metaGet('seededAt', null);
  const existing = await db.listTemplates();
  if (!seeded && existing.length === 0) {
    await db.put('templates', buildSeedTemplate());
    await db.metaSet('seededAt', now());
  }
}

async function reloadData() {
  S.templates = (await db.listTemplates()).sort((a, b) => a.name.localeCompare(b.name));
  S.sessions = (await db.listSessions())
    .filter((s) => s.status !== 'active')
    .sort((a, b) => (b.completedAt || b.startedAt) - (a.completedAt || a.startedAt));
}

// ---------------- Session lifecycle ----------------
function snapshotBlocks(template) {
  return template.blocks
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((tb, i) => ({
      id: uid(),
      templateBlockId: tb.id,
      title: tb.title,
      detail: tb.detail || '',
      estimatedMinutes: tb.estimatedMinutes,
      order: i,
      photoMode: tb.photoMode || 'both',
      status: 'pending',
      accumulatedMs: 0,
      runningSince: null,
      firstStartedAt: null,
      finishedAt: null,
      beforePhotoId: null,
      afterPhotoId: null,
      note: '',
    }));
}

async function startSession(template) {
  if (!(await quotaGuard())) return; // blocked at >90% full unless user opts in
  const ts = now();
  S.session = {
    id: uid(),
    templateId: template.id,
    templateName: template.name,        // denormalized — template may change/vanish later
    startedAt: ts,
    completedAt: null,
    status: 'active',
    onBreak: false,
    breakBlockId: null,
    currentBlockId: null,   // explicit selection so "jump to block" works past order
    note: '',
    blocks: snapshotBlocks(template),
    updatedAt: ts,
    deletedAt: null,
    syncedAt: null,
  };
  await persist();
  await db.metaSet('activeSessionId', S.session.id);
  if (navigator.storage?.persist) { try { await navigator.storage.persist(); } catch (_) {} }
  go('run');
}

async function persist() {
  if (!S.session) return;
  S.session.updatedAt = now();
  await db.put('sessions', S.session);        // synchronous with the UI update (spec §4.2)
}

function runningBlock() { return S.session?.blocks.find((b) => b.status === 'running') || null; }
function isOpen(b) { return b && (b.status === 'pending' || b.status === 'paused'); }
function currentBlock() {
  if (!S.session) return null;
  const running = runningBlock();
  if (running) return running;                 // a running block is always what you're looking at
  const sel = S.session.currentBlockId && S.session.blocks.find((b) => b.id === S.session.currentBlockId);
  if (isOpen(sel)) return sel;                 // honour an explicit jump target
  return S.session.blocks.find((b) => isOpen(b)) || null; // else earliest remaining
}
function progress() {
  const bs = S.session.blocks;
  const done = bs.filter((b) => b.status === 'done' || b.status === 'skipped').length;
  return { done, total: bs.length };
}

// ---------------- Block transitions ----------------
async function doStart(block) {
  // Auto-pause any other running block first (spec §4.4).
  const r = runningBlock();
  if (r && r.id !== block.id) { T.pauseBlock(r); toast(`Paused: ${r.title}`); }
  T.startBlock(block);
  await persist();
  render();
  acquireWake();
  vibrateIf([40]);
  if (block.photoMode === 'both' || block.photoMode === 'before') {
    openCamera((file) => attachPhoto(block, 'before', file));
  }
}

async function doPause(block) {
  T.pauseBlock(block);
  await persist();
  render();
  releaseWake();
}

async function doResume(block) {
  const r = runningBlock();
  if (r && r.id !== block.id) { T.pauseBlock(r); toast(`Paused: ${r.title}`); }
  T.resumeBlock(block);
  await persist();
  render();
  acquireWake();
}

async function doFinish(block) {
  T.finishBlock(block);
  await persist();
  releaseWake();
  vibrateIf([40, 60, 40]);
  const after = () => afterFinish(block);
  if (block.photoMode === 'both' || block.photoMode === 'after') {
    openCamera((file) => attachPhoto(block, 'after', file));
  }
  render();
  after();
}

function afterFinish(block) {
  const remaining = S.session.blocks.some((b) => b.status === 'pending' || b.status === 'paused');
  if (!remaining) { go('wrap'); return; }
  if (S.settings.autoAdvance) {
    toast(`Done: ${block.title}`, {
      actionLabel: 'Undo',
      onAction: async () => { T.reopenBlock(block); await persist(); render(); },
    });
  }
}

async function doSkip(block) {
  T.skipBlock(block);
  await persist();
  render();
  releaseWake();
  const remaining = S.session.blocks.some((b) => b.status === 'pending' || b.status === 'paused');
  if (!remaining) go('wrap');
}

async function doReopen(block) {
  T.reopenBlock(block);
  await persist();
  render();
}

// Jump to a specific block (auto-pauses current, then selects the target).
async function jumpTo(block) {
  const r = runningBlock();
  if (r && r.id !== block.id) T.pauseBlock(r);
  S.session.currentBlockId = block.id;
  await persist();
  if (r && r.id !== block.id) toast(`Paused: ${r.title}`);
  render();
}

// ---------------- Session-level ----------------
async function toggleBreak() {
  if (!S.session) return;
  if (!S.session.onBreak) {
    const r = runningBlock();
    S.session.breakBlockId = r ? r.id : null;
    if (r) T.pauseBlock(r);
    S.session.onBreak = true;
    releaseWake();
    toast('Session paused — taking a break');
  } else {
    S.session.onBreak = false;
    const b = S.session.blocks.find((x) => x.id === S.session.breakBlockId);
    if (b && (b.status === 'paused')) { T.resumeBlock(b); acquireWake(); }
    S.session.breakBlockId = null;
    toast('Back to it');
  }
  await persist();
  render();
}

async function endSessionEarly() {
  go('wrap');
}

// ---------------- Photos ----------------
async function attachPhoto(block, kind, file) {
  try {
    toast('Processing photo…', { ms: 1500 });
    const photo = await photos.capturePhoto(file, {
      sessionId: S.session.id, sessionBlockId: block.id, kind,
    });
    if (kind === 'before') block.beforePhotoId = photo.id;
    else block.afterPhotoId = photo.id;
    await persist();
    render();
  } catch (err) {
    toast('Photo failed — timer kept running');
    console.error(err);
  }
}

// One hidden capture input, re-targeted per use.
let _pendingCapture = null;
function openCamera(cb) {
  const input = $('#capture');
  _pendingCapture = cb;
  input.value = '';
  input.click();
}
function wireCamera() {
  const input = $('#capture');
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    const cb = _pendingCapture; _pendingCapture = null;
    input.value = '';
    if (file && cb) await cb(file);
  });
}

// ---------------- Wake lock ----------------
let _wakeLock = null;
async function acquireWake() {
  if (!S.settings.wakeLock || !navigator.wakeLock) return;
  try { _wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
}
async function releaseWake() {
  try { await _wakeLock?.release(); } catch (_) {}
  _wakeLock = null;
}
function reacquireWake() { if (runningBlock()) acquireWake(); }
function vibrateIf(p) { if (S.settings.haptics) vibrate(p); }

// ---------------- Forgot-to-stop guard ----------------
let _forgotOpen = false;
async function checkForgotten() {
  if (_forgotOpen || !S.session) return;
  const b = runningBlock();
  if (!b || !T.isForgotten(b)) return;
  _forgotOpen = true;
  const mins = Math.round(T.elapsedMs(b) / 60000);
  const human = fmtHuman(T.elapsedMs(b));
  openModal(`
    <h2>Still going?</h2>
    <p><strong>${esc(b.title)}</strong> has been running for ${human}. Did you finish it?</p>
    <div class="modal-actions col">
      <button class="btn primary" data-act="finish-now">Finish now (record ${human})</button>
      <button class="btn" data-act="finish-est">Discard the extra time (keep ~${b.estimatedMinutes}m)</button>
      <button class="btn ghost" data-act="dismiss">Keep it running</button>
    </div>
  `, (act) => {
    _forgotOpen = false;
    if (act === 'finish-now') { T.finishBlock(b); persist().then(render); }
    else if (act === 'finish-est') { T.clampElapsedTo(b, b.estimatedMinutes * 60000); T.finishBlock(b); persist().then(render); }
  });
}

// ---------------- Navigation ----------------
function go(screen, opts = {}) {
  S.screen = screen;
  if (opts.detailId !== undefined) S.detailId = opts.detailId;
  render();
}

// ---------------- Render ----------------
function render() {
  stopTick();
  photos.revokeAll();
  const c = app();
  if (S.screen === 'run' && S.session) c.innerHTML = renderRun();
  else if (S.screen === 'wrap' && S.session) c.innerHTML = renderWrap();
  else if (S.screen === 'history') c.innerHTML = renderHistory();
  else if (S.screen === 'detail') c.innerHTML = renderDetail();
  else if (S.screen === 'templates') c.innerHTML = renderTemplates();
  else if (S.screen === 'templateEdit' && S.draft) c.innerHTML = renderTemplateEdit();
  else if (S.screen === 'settings') c.innerHTML = renderSettings();
  else c.innerHTML = renderHome();
  wireScreen();
  hydrateImages();
  if (S.screen === 'run') startTick();
  window.scrollTo(0, 0);
}

// ---- Home ----
function renderHome() {
  const recents = S.sessions.slice(0, 3);
  let body = '';
  if (S.session) {
    const { done, total } = progress();
    const worked = T.sessionWorkedMs(S.session);
    body += `
      <section class="card resume">
        <div class="eyebrow">In progress</div>
        <h2>${esc(S.session.templateName)}</h2>
        <div class="progress"><div class="bar" style="width:${(done / total) * 100}%"></div></div>
        <div class="meta-row"><span>${done} / ${total} blocks</span><span>${fmtHuman(worked)} worked</span></div>
        <button class="btn primary big" data-act="continue">Continue</button>
      </section>`;
  } else {
    body += `<div class="section-title">Start a session</div><div class="list">`;
    for (const t of S.templates) {
      const est = t.blocks.reduce((s, b) => s + b.estimatedMinutes, 0);
      body += `
        <button class="row template" data-start="${t.id}">
          <div class="row-main">
            <div class="row-title">${esc(t.name)}</div>
            <div class="row-sub">${t.blocks.length} blocks · ~${fmtHuman(est * 60000)}</div>
          </div>
          <div class="chev">›</div>
        </button>`;
    }
    body += `</div><button class="btn ghost" data-nav="templates">Manage templates</button>`;
  }

  let recentHtml = '';
  if (recents.length) {
    recentHtml = `<div class="section-title">Recent</div><div class="list">`;
    for (const s of recents) {
      const worked = T.sessionWorkedMs(s);
      recentHtml += `
        <button class="row" data-detail="${s.id}">
          <div class="row-main">
            <div class="row-title">${esc(s.templateName)}</div>
            <div class="row-sub">${fmtDate(s.completedAt || s.startedAt)} · ${fmtHuman(worked)}</div>
          </div>
          <div class="thumbs" data-thumbs="${s.id}"></div>
        </button>`;
    }
    recentHtml += `</div><button class="btn ghost" data-act="history">All history</button>`;
  }

  return `
    ${header('Reset', { settings: true })}
    <main class="screen home">
      ${body}
      ${recentHtml}
    </main>`;
}

// ---- Run ----
function renderRun() {
  const b = currentBlock();
  const { done, total } = progress();
  const worked = T.sessionWorkedMs(S.session);

  if (!b) { // safety: nothing open -> wrap
    return renderWrap();
  }

  const est = b.estimatedMinutes * 60000;
  const over = T.elapsedMs(b) > est;
  const timerCls = over ? 'timer over' : 'timer';

  let actions = '';
  if (b.status === 'pending') {
    actions = `<button class="btn primary big" data-act="start">Start</button>`;
  } else if (b.status === 'running') {
    actions = `
      <div class="action-pair">
        <button class="btn big" data-act="pause">Pause</button>
        <button class="btn primary big" data-act="finish">Finish</button>
      </div>`;
  } else if (b.status === 'paused') {
    actions = `
      <div class="action-pair">
        <button class="btn big" data-act="resume">Resume</button>
        <button class="btn primary big" data-act="finish">Finish</button>
      </div>`;
  }

  const photoSlots = b.photoMode === 'none' ? '' : `
    <div class="slots">
      ${slot(b, 'before')}
      ${slot(b, 'after')}
    </div>`;

  // Remaining blocks (all still-open ones except the current), so nothing hides.
  const upcoming = S.session.blocks
    .filter((x) => x.id !== b.id && x.status !== 'done' && x.status !== 'skipped')
    .map((x) => `
      <button class="up-row" data-jump="${x.id}">
        <span class="dot ${x.status}"></span>
        <span class="up-title">${esc(x.title)}</span>
        <span class="up-est">~${x.estimatedMinutes}m</span>
      </button>`).join('');

  return `
    ${runHeader(done, total)}
    <main class="screen run">
      <section class="block-card">
        <h1 class="block-title">${esc(b.title)}</h1>
        ${b.detail ? `<p class="block-detail">${esc(b.detail)}</p>` : ''}
        <div class="${timerCls}">
          <span class="clock" data-elapsed="${b.id}">${fmtClock(T.elapsedMs(b))}</span>
          <span class="est">/ ~${b.estimatedMinutes}m</span>
        </div>
        ${photoSlots}
      </section>
      ${upcoming ? `<div class="section-title">Upcoming</div><div class="upcoming">${upcoming}</div>` : ''}
    </main>
    <div class="action-bar">${actions}</div>`;
}

function slot(block, kind) {
  const pid = kind === 'before' ? block.beforePhotoId : block.afterPhotoId;
  const label = kind === 'before' ? 'Before' : 'After';
  return `
    <button class="slot ${pid ? 'has' : ''}" data-shoot="${kind}">
      ${pid ? `<img data-photo="${pid}" data-variant="thumb" alt="${label}">`
            : `<span class="slot-label">＋ ${label}</span>`}
      ${pid ? `<span class="slot-tag">${label}</span>` : ''}
    </button>`;
}

// ---- Wrap-up ----
function renderWrap() {
  const s = S.session;
  const worked = T.sessionWorkedMs(s);
  const est = s.blocks.reduce((sum, b) => sum + b.estimatedMinutes * 60000, 0);
  const doneCount = s.blocks.filter((b) => b.status === 'done').length;
  const skipCount = s.blocks.filter((b) => b.status === 'skipped').length;
  const remaining = s.blocks.filter((b) => b.status === 'pending' || b.status === 'paused').length;

  const pairs = s.blocks.map((b) => {
    if (!b.beforePhotoId && !b.afterPhotoId) return '';
    return `<div class="pair-strip">
      ${b.beforePhotoId ? `<img data-photo="${b.beforePhotoId}" data-variant="thumb" alt="before">` : ''}
      ${b.afterPhotoId ? `<img data-photo="${b.afterPhotoId}" data-variant="thumb" alt="after">` : ''}
    </div>`;
  }).join('');

  return `
    ${header('Session wrap-up', { back: 'run' })}
    <main class="screen wrap">
      <section class="card">
        <div class="big-stat">${fmtHuman(worked)}<span>worked</span></div>
        <div class="meta-row"><span>Estimated ${fmtHuman(est)}</span><span>${doneCount} done · ${skipCount} skipped</span></div>
      </section>
      ${pairs ? `<div class="section-title">Before / after</div><div class="pairs">${pairs}</div>` : ''}
      <label class="field">Note
        <textarea id="session-note" rows="3" placeholder="How did it go? Anything to remember…">${esc(s.note || '')}</textarea>
      </label>
      <div class="action-col">
        <button class="btn primary big" data-act="save">${remaining ? 'Save partial' : 'Save session'}</button>
        <button class="btn ghost danger" data-act="discard">Discard session</button>
      </div>
    </main>`;
}

// ---- History ----
function renderHistory() {
  if (!S.sessions.length) {
    return `${header('History', { back: 'home' })}<main class="screen"><p class="empty">No sessions yet. Finish one and it shows up here.</p></main>`;
  }
  let html = '';
  let lastMonth = null;
  const totalMs = S.sessions.reduce((s, x) => s + T.sessionWorkedMs(x), 0);
  for (const s of S.sessions) {
    const mk = monthKey(s.completedAt || s.startedAt);
    if (mk !== lastMonth) { html += `<div class="month">${mk}</div>`; lastMonth = mk; }
    const worked = T.sessionWorkedMs(s);
    const done = s.blocks.filter((b) => b.status === 'done').length;
    html += `
      <button class="row" data-detail="${s.id}">
        <div class="row-main">
          <div class="row-title">${esc(s.templateName)}</div>
          <div class="row-sub">${fmtDate(s.completedAt || s.startedAt)} · ${fmtHuman(worked)} · ${done} blocks</div>
        </div>
        <div class="thumbs" data-thumbs="${s.id}"></div>
      </button>`;
  }
  return `
    ${header('History', { back: 'home' })}
    <main class="screen">
      <div class="card"><div class="meta-row"><span>${S.sessions.length} sessions</span><span>${fmtHuman(totalMs)} total</span></div></div>
      <div class="list">${html}</div>
    </main>`;
}

// ---- History detail ----
function renderDetail() {
  const s = S.sessions.find((x) => x.id === S.detailId);
  if (!s) return renderHistory();
  const worked = T.sessionWorkedMs(s);
  const blocks = s.blocks.map((b) => {
    const el = T.elapsedMs(b);
    const tag = b.status === 'skipped' ? '<span class="tag">skipped</span>' : '';
    const both = b.beforePhotoId && b.afterPhotoId;
    const pics = (b.beforePhotoId || b.afterPhotoId) ? `
      <div class="pair-strip" ${both ? `data-compare="${b.id}"` : ''}>
        ${b.beforePhotoId ? `<img data-photo="${b.beforePhotoId}" data-variant="thumb" ${both ? '' : `data-full="${b.beforePhotoId}"`} alt="before">` : ''}
        ${b.afterPhotoId ? `<img data-photo="${b.afterPhotoId}" data-variant="thumb" ${both ? '' : `data-full="${b.afterPhotoId}"`} alt="after">` : ''}
      </div>
      ${both ? `<button class="btn small compare-btn" data-compare="${b.id}">Compare before / after</button>` : ''}` : '';
    return `
      <div class="detail-block">
        <div class="row-main">
          <div class="row-title">${esc(b.title)} ${tag}</div>
          <div class="row-sub">${fmtHuman(el)} · est ~${b.estimatedMinutes}m</div>
        </div>
        ${pics}
      </div>`;
  }).join('');

  return `
    ${header(fmtDate(s.completedAt || s.startedAt), { back: 'history' })}
    <main class="screen detail">
      <section class="card">
        <h2>${esc(s.templateName)}</h2>
        <div class="meta-row"><span>${fmtHuman(worked)} worked</span><span>${fmtTime(s.startedAt)}</span></div>
        ${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}
      </section>
      <div class="blocks">${blocks}</div>
      <div class="action-col">
        <button class="btn" data-act="reuse">Start a new session from this</button>
        <button class="btn ghost danger" data-act="delete">Delete session</button>
      </div>
    </main>`;
}

// ---- Templates list ----
function renderTemplates() {
  const rows = S.templates.map((t) => {
    const est = t.blocks.reduce((s, b) => s + b.estimatedMinutes, 0);
    return `
      <div class="row static">
        <div class="row-main" ${t.isBuiltIn ? '' : `data-edit="${t.id}"`} style="${t.isBuiltIn ? '' : 'cursor:pointer'}">
          <div class="row-title">${esc(t.name)} ${t.isBuiltIn ? '<span class="tag">built-in</span>' : ''}</div>
          <div class="row-sub">${t.blocks.length} blocks · ~${fmtHuman(est * 60000)}</div>
        </div>
        <div class="row-actions">
          ${t.isBuiltIn ? '' : `<button class="btn small" data-edit="${t.id}">Edit</button>`}
          <button class="btn small ghost" data-dup="${t.id}">Duplicate</button>
        </div>
      </div>`;
  }).join('');
  return `
    ${header('Templates', { back: 'home' })}
    <main class="screen">
      <button class="btn primary" data-act="new">＋ New template</button>
      <div class="list">${rows}</div>
      <p class="hint">Built-in templates duplicate rather than edit, so the original stays intact.</p>
    </main>`;
}

// ---- Template editor ----
function renderTemplateEdit() {
  const d = S.draft;
  const total = d.blocks.reduce((s, b) => s + (Number(b.estimatedMinutes) || 0), 0);
  const modeOpt = (v, cur) => `<option value="${v}" ${v === cur ? 'selected' : ''}>`;
  const blocks = d.blocks.map((b, i) => `
    <div class="edit-block" data-i="${i}">
      <div class="edit-block-head">
        <span class="eb-num">${i + 1}</span>
        <input class="b-title" placeholder="Block title" value="${esc(b.title)}">
        <button class="icon-btn small" data-moveup="${i}" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="icon-btn small" data-movedown="${i}" ${i === d.blocks.length - 1 ? 'disabled' : ''}>▼</button>
      </div>
      <textarea class="b-detail" rows="2" placeholder="What to do in this block…">${esc(b.detail || '')}</textarea>
      <div class="edit-block-row">
        <label class="mini">Est (min)<input class="b-min" type="number" inputmode="numeric" min="0" value="${Number(b.estimatedMinutes) || 0}"></label>
        <label class="mini">Photos
          <select class="b-mode">
            ${modeOpt('both', b.photoMode)}Before &amp; after</option>
            ${modeOpt('before', b.photoMode)}Before</option>
            ${modeOpt('after', b.photoMode)}After</option>
            ${modeOpt('none', b.photoMode)}None</option>
          </select>
        </label>
        <button class="btn small ghost" data-dupblock="${i}">Duplicate</button>
        <button class="btn small ghost danger" data-delblock="${i}">Delete</button>
      </div>
    </div>`).join('');

  return `
    ${header(d._isNew ? 'New template' : 'Edit template', { back: 'templates' })}
    <main class="screen edit">
      <label class="field">Name<input id="tpl-name" placeholder="e.g. Quick Kitchen" value="${esc(d.name)}"></label>
      <label class="field">Description<input id="tpl-desc" placeholder="Optional" value="${esc(d.description || '')}"></label>
      <div class="section-title">Blocks · <span id="tpl-total">~${fmtHuman(total * 60000)}</span></div>
      <div class="edit-blocks">${blocks}</div>
      <button class="btn" data-act="addblock">＋ Add block</button>
      <div class="action-col">
        <button class="btn primary big" data-act="savetpl">Save template</button>
        <button class="btn ghost" data-nav="templates">Cancel</button>
        ${d._isNew ? '' : `<button class="btn ghost danger" data-act="deltpl">Delete template</button>`}
      </div>
    </main>`;
}

// ---- Settings (basic; storage meter + export land next) ----
function renderSettings() {
  const th = S.settings;
  const opt = (v, cur) => `${v === cur ? 'selected' : ''}`;
  return `
    ${header('Settings', { back: 'home' })}
    <main class="screen settings">
      <label class="field">Theme
        <select id="set-theme">
          <option value="system" ${opt('system', th.theme)}>System</option>
          <option value="light" ${opt('light', th.theme)}>Light</option>
          <option value="dark" ${opt('dark', th.theme)}>Dark</option>
        </select>
      </label>
      <label class="toggle"><input type="checkbox" id="set-wake" ${th.wakeLock ? 'checked' : ''}> Keep screen awake during blocks</label>
      <label class="toggle"><input type="checkbox" id="set-haptics" ${th.haptics ? 'checked' : ''}> Haptics</label>
      <label class="toggle"><input type="checkbox" id="set-auto" ${th.autoAdvance ? 'checked' : ''}> Auto-advance after finishing a block</label>
      <label class="field">Default photo mode for new blocks
        <select id="set-photo">
          <option value="both" ${opt('both', th.defaultPhotoMode)}>Before &amp; after</option>
          <option value="before" ${opt('before', th.defaultPhotoMode)}>Before only</option>
          <option value="after" ${opt('after', th.defaultPhotoMode)}>After only</option>
          <option value="none" ${opt('none', th.defaultPhotoMode)}>No photos</option>
        </select>
      </label>
      <div class="card"><div id="storage-meter" class="hint">Checking storage…</div></div>
      <div class="section-title">Your data</div>
      <div class="action-col">
        <button class="btn" data-act="export">Export all data (.zip)</button>
        <button class="btn" data-act="import">Import from backup</button>
        <input type="file" id="import-file" accept=".zip,application/zip" hidden>
      </div>
      <p class="hint">Everything is stored on this device only. Export makes a zip you can re-import on any device — merges by newest, never destructive.</p>
      <div class="version">Reset v0.2 · <a href="https://github.com/kleanthisx/house-reset" target="_blank" rel="noopener">source</a></div>
    </main>`;
}

// ---- Shared chrome ----
function header(title, opts = {}) {
  return `
    <header class="topbar">
      ${opts.back ? `<button class="icon-btn" data-nav="${opts.back}">‹</button>` : `<span class="icon-btn spacer"></span>`}
      <h1 class="topbar-title">${esc(title)}</h1>
      ${opts.settings ? `<button class="icon-btn" data-nav="settings" aria-label="Settings">⚙</button>` : `<span class="icon-btn spacer"></span>`}
    </header>`;
}
function runHeader(done, total) {
  return `
    <header class="topbar run-top">
      <button class="icon-btn" data-nav="home">‹</button>
      <div class="run-progress">
        <div class="run-count">${done} / ${total}</div>
        <div class="progress mini"><div class="bar" style="width:${(done / total) * 100}%"></div></div>
      </div>
      <button class="icon-btn" data-act="menu" aria-label="Session menu">⋯</button>
    </header>`;
}

// ---------------- Event wiring ----------------
function wireScreen() {
  const c = app();

  // Generic nav buttons.
  $$('[data-nav]', c).forEach((el) => el.addEventListener('click', () => go(el.dataset.nav)));

  // Home
  $$('[data-start]', c).forEach((el) => el.addEventListener('click', async () => {
    const t = S.templates.find((x) => x.id === el.dataset.start);
    if (t) await confirmStart(t);
  }));
  $$('[data-detail]', c).forEach((el) => el.addEventListener('click', () => go('detail', { detailId: el.dataset.detail })));
  bindAct(c, {
    continue: () => go('run'),
    pick: () => go('templates'),
    history: () => go('history'),
  });

  // Run
  const cur = currentBlock();
  bindAct(c, {
    start: () => cur && doStart(cur),
    pause: () => cur && doPause(cur),
    resume: () => cur && doResume(cur),
    finish: () => cur && doFinish(cur),
    menu: () => openSessionMenu(),
  });
  $$('[data-shoot]', c).forEach((el) => el.addEventListener('click', () => {
    if (cur) openCamera((file) => attachPhoto(cur, el.dataset.shoot, file));
  }));
  $$('[data-jump]', c).forEach((el) => el.addEventListener('click', () => {
    const b = S.session.blocks.find((x) => x.id === el.dataset.jump);
    if (b) jumpTo(b);
  }));

  // Wrap
  bindAct(c, {
    save: () => saveSession(),
    discard: () => confirmDiscard(),
  });

  // Detail
  bindAct(c, {
    reuse: () => reuseSession(),
    delete: () => confirmDeleteSession(),
  });
  $$('[data-full]', c).forEach((el) => el.addEventListener('click', () => openPhoto(el.dataset.full)));
  $$('[data-compare]', c).forEach((el) => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = S.sessions.find((x) => x.id === S.detailId);
    const b = s && s.blocks.find((x) => x.id === el.dataset.compare);
    if (b) openCompare(b);
  }));

  // Templates list
  $$('[data-dup]', c).forEach((el) => el.addEventListener('click', () => duplicateTemplate(el.dataset.dup)));
  $$('[data-edit]', c).forEach((el) => el.addEventListener('click', () => editTemplate(el.dataset.edit)));
  bindAct(c, { new: () => newTemplate() });

  // Template editor
  bindAct(c, {
    addblock: () => { syncDraftFromDom(); addBlock(); },
    savetpl: () => saveTemplate(),
    deltpl: () => confirmDeleteTemplate(),
  });
  $$('[data-moveup]', c).forEach((el) => el.addEventListener('click', () => { syncDraftFromDom(); moveBlock(+el.dataset.moveup, -1); }));
  $$('[data-movedown]', c).forEach((el) => el.addEventListener('click', () => { syncDraftFromDom(); moveBlock(+el.dataset.movedown, 1); }));
  $$('[data-dupblock]', c).forEach((el) => el.addEventListener('click', () => { syncDraftFromDom(); dupBlock(+el.dataset.dupblock); }));
  $$('[data-delblock]', c).forEach((el) => el.addEventListener('click', () => { syncDraftFromDom(); delBlock(+el.dataset.delblock); }));
  // live total as minutes change (no full re-render, keeps focus)
  $$('.b-min', c).forEach((el) => el.addEventListener('input', () => {
    const total = $$('.b-min', c).reduce((s, i) => s + (Number(i.value) || 0), 0);
    const t = $('#tpl-total', c); if (t) t.textContent = '~' + fmtHuman(total * 60000);
  }));

  // Settings
  const theme = $('#set-theme', c);
  if (theme) theme.addEventListener('change', () => setSetting('theme', theme.value, true));
  bindCheck(c, 'set-wake', 'wakeLock');
  bindCheck(c, 'set-haptics', 'haptics');
  bindCheck(c, 'set-auto', 'autoAdvance');
  const pm = $('#set-photo', c);
  if (pm) pm.addEventListener('change', () => setSetting('defaultPhotoMode', pm.value));
  bindAct(c, { export: () => exportAll(), import: () => $('#import-file', c).click() });
  const imp = $('#import-file', c);
  if (imp) imp.addEventListener('change', async () => {
    const f = imp.files && imp.files[0]; imp.value = '';
    if (f) await importFrom(f);
  });
  if ($('#storage-meter', c)) updateStorageMeter();
}

function bindAct(root, map) {
  $$('[data-act]', root).forEach((el) => {
    const fn = map[el.dataset.act];
    if (fn) el.addEventListener('click', fn);
  });
}
function bindCheck(root, id, key) {
  const el = $('#' + id, root);
  if (el) el.addEventListener('change', () => setSetting(key, el.checked));
}

// ---------------- Actions that mutate + persist ----------------
async function confirmStart(template) {
  if (S.session) {
    openModal(`
      <h2>A session is already active</h2>
      <p>Resume <strong>${esc(S.session.templateName)}</strong>, or abandon it and start fresh?</p>
      <div class="modal-actions col">
        <button class="btn primary" data-act="resume">Resume current</button>
        <button class="btn danger" data-act="abandon">Abandon &amp; start new</button>
        <button class="btn ghost" data-act="dismiss">Cancel</button>
      </div>`, async (act) => {
      if (act === 'resume') go('run');
      else if (act === 'abandon') { await abandonActive(); await startSession(template); }
    });
    return;
  }
  // Preview sheet.
  const est = template.blocks.reduce((s, b) => s + b.estimatedMinutes, 0);
  const list = template.blocks.slice().sort((a, b) => a.order - b.order)
    .map((b) => `<li>${esc(b.title)} <span>~${b.estimatedMinutes}m</span></li>`).join('');
  openModal(`
    <h2>${esc(template.name)}</h2>
    <p class="hint">${template.blocks.length} blocks · ~${fmtHuman(est * 60000)}</p>
    <ul class="preview">${list}</ul>
    <div class="modal-actions">
      <button class="btn ghost" data-act="dismiss">Cancel</button>
      <button class="btn primary" data-act="go">Start</button>
    </div>`, async (act) => { if (act === 'go') await startSession(template); });
}

async function abandonActive() {
  if (!S.session) return;
  S.session.status = 'abandoned';
  S.session.completedAt = now();
  await persist();
  await db.metaSet('activeSessionId', null);
  S.session = null;
  await reloadData();
}

async function saveSession() {
  const noteEl = $('#session-note');
  if (noteEl) S.session.note = noteEl.value;
  S.session.status = 'completed';
  S.session.completedAt = now();
  await persist();
  await db.metaSet('activeSessionId', null);
  const id = S.session.id;
  S.session = null;
  await reloadData();
  go('detail', { detailId: id });
}

function confirmDiscard() {
  openModal(`
    <h2>Discard this session?</h2>
    <p>This deletes the session and its photos. This can't be undone.</p>
    <div class="modal-actions">
      <button class="btn ghost" data-act="dismiss">Keep</button>
      <button class="btn danger" data-act="yes">Discard</button>
    </div>`, async (act) => {
    if (act !== 'yes') return;
    S.session.status = 'abandoned';
    S.session.deletedAt = now();
    await persist();
    await db.metaSet('activeSessionId', null);
    S.session = null;
    await reloadData();
    go('home');
  });
}

async function reuseSession() {
  const s = S.sessions.find((x) => x.id === S.detailId);
  if (!s) return;
  const template = S.templates.find((t) => t.id === s.templateId);
  if (template) await confirmStart(template);
  else toast('Original template was deleted');
}

function confirmDeleteSession() {
  openModal(`
    <h2>Delete this session?</h2>
    <p>Removes it from history along with its photos.</p>
    <div class="modal-actions">
      <button class="btn ghost" data-act="dismiss">Cancel</button>
      <button class="btn danger" data-act="yes">Delete</button>
    </div>`, async (act) => {
    if (act !== 'yes') return;
    const s = S.sessions.find((x) => x.id === S.detailId);
    if (s) { s.deletedAt = now(); s.updatedAt = now(); await db.put('sessions', s); }
    await reloadData();
    go('history');
  });
}

// ---- Template editor state + mutations ----
function blankBlock() {
  return { id: uid(), title: '', detail: '', estimatedMinutes: 15, order: 0, photoMode: S.settings.defaultPhotoMode, tags: [] };
}
function newTemplate() {
  const ts = now();
  S.draft = {
    id: uid(), name: '', description: '', isBuiltIn: false,
    createdAt: ts, updatedAt: ts, deletedAt: null, syncedAt: null,
    blocks: [blankBlock()], _isNew: true,
  };
  go('templateEdit');
}
function editTemplate(id) {
  const t = S.templates.find((x) => x.id === id);
  if (!t) return;
  S.draft = structuredClone(t);
  S.draft._isNew = false;
  go('templateEdit');
}
// Pull the current DOM field values into the draft (call before any structural change).
function syncDraftFromDom() {
  const c = app();
  const name = $('#tpl-name', c); if (name) S.draft.name = name.value;
  const desc = $('#tpl-desc', c); if (desc) S.draft.description = desc.value;
  $$('.edit-block', c).forEach((el) => {
    const i = +el.dataset.i;
    const b = S.draft.blocks[i];
    if (!b) return;
    b.title = $('.b-title', el).value;
    b.detail = $('.b-detail', el).value;
    b.estimatedMinutes = Number($('.b-min', el).value) || 0;
    b.photoMode = $('.b-mode', el).value;
  });
}
function addBlock() { S.draft.blocks.push(blankBlock()); render(); }
function delBlock(i) {
  if (S.draft.blocks.length <= 1) { toast('A template needs at least one block'); return; }
  S.draft.blocks.splice(i, 1); render();
}
function dupBlock(i) {
  const copy = { ...structuredClone(S.draft.blocks[i]), id: uid() };
  S.draft.blocks.splice(i + 1, 0, copy); render();
}
function moveBlock(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= S.draft.blocks.length) return;
  const bs = S.draft.blocks;
  [bs[i], bs[j]] = [bs[j], bs[i]];
  render();
}
async function saveTemplate() {
  syncDraftFromDom();
  const d = S.draft;
  if (!d.name.trim()) { toast('Give the template a name'); return; }
  d.blocks = d.blocks.map((b, i) => ({ ...b, order: i, estimatedMinutes: Number(b.estimatedMinutes) || 0 }));
  d.updatedAt = now();
  delete d._isNew;
  await db.put('templates', d);
  S.draft = null;
  await reloadData();
  go('templates');
  toast('Template saved');
}
function confirmDeleteTemplate() {
  openModal(`
    <h2>Delete this template?</h2>
    <p>Past sessions that used it are unaffected (they keep their own copy).</p>
    <div class="modal-actions">
      <button class="btn ghost" data-act="dismiss">Cancel</button>
      <button class="btn danger" data-act="yes">Delete</button>
    </div>`, async (act) => {
    if (act !== 'yes') return;
    S.draft.deletedAt = now();
    S.draft.updatedAt = now();
    delete S.draft._isNew;
    await db.put('templates', S.draft);
    S.draft = null;
    await reloadData();
    go('templates');
  });
}

async function duplicateTemplate(id) {
  const t = S.templates.find((x) => x.id === id);
  if (!t) return;
  const ts = now();
  const copy = {
    ...structuredClone(t),
    id: uid(),
    name: t.name + ' (copy)',
    isBuiltIn: false,
    createdAt: ts, updatedAt: ts, deletedAt: null, syncedAt: null,
  };
  copy.blocks = copy.blocks.map((b) => ({ ...b, id: uid() }));
  await db.put('templates', copy);
  await reloadData();
  render();
  toast('Template duplicated');
}

function openSessionMenu() {
  const onBreak = S.session.onBreak;
  openModal(`
    <h2>Session</h2>
    <div class="modal-actions col">
      <button class="btn" data-act="break">${onBreak ? 'Resume from break' : 'Take a break'}</button>
      <button class="btn" data-act="end">End session</button>
      <button class="btn ghost" data-act="dismiss">Cancel</button>
    </div>`, async (act) => {
    if (act === 'break') await toggleBreak();
    else if (act === 'end') await endSessionEarly();
  });
}

// ---------------- Settings helpers ----------------
async function setSetting(key, value, themeChange = false) {
  S.settings[key] = value;
  await db.metaSet('settings', S.settings);
  if (themeChange) applyTheme();
}
function applyTheme() {
  const t = S.settings.theme;
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}
async function storagePct() {
  if (!navigator.storage?.estimate) return 0;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return quota ? (usage / quota) * 100 : 0;
}
async function updateStorageMeter() {
  const el = $('#storage-meter');
  if (!el || !navigator.storage?.estimate) { if (el) el.textContent = 'Storage estimate unavailable'; return; }
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const pct = quota ? Math.round((usage / quota) * 100) : 0;
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  el.innerHTML = `Storage: ${mb(usage)} used${quota ? ` of ${mb(quota)} (${pct}%)` : ''}`;
  if (pct >= 70) el.innerHTML += ` <span class="warn">— getting full, consider exporting</span>`;
}

// Blocking prompt before starting a new session when storage is nearly full (spec §5.4).
function quotaGuard() {
  return new Promise(async (resolve) => {
    const pct = await storagePct();
    if (pct < 90) { resolve(true); return; }
    openModal(`
      <h2>Storage is nearly full</h2>
      <p>This device is ${Math.round(pct)}% full. New photos may fail to save. Export a backup and free space first, or start anyway.</p>
      <div class="modal-actions col">
        <button class="btn primary" data-act="export">Export a backup now</button>
        <button class="btn" data-act="anyway">Start anyway</button>
        <button class="btn ghost" data-act="dismiss">Cancel</button>
      </div>`, async (act) => {
      if (act === 'export') { await exportAll(); resolve(false); }
      else resolve(act === 'anyway');
    });
  });
}

// ---- Export / Import (zip: data.json + photos) ----
async function exportAll() {
  toast('Building export…', { ms: 2000 });
  const templates = await db.getAll('templates');
  const sessions = await db.getAll('sessions');
  const photoRecords = await db.getAll('photos');
  const files = [];
  const photoMeta = [];
  for (const p of photoRecords) {
    const fullBytes = new Uint8Array(await p.full.arrayBuffer());
    const thumbBytes = new Uint8Array(await p.thumb.arrayBuffer());
    files.push({ name: `photos/${p.id}-full.jpg`, data: fullBytes });
    files.push({ name: `photos/${p.id}-thumb.jpg`, data: thumbBytes });
    const { full, thumb, ...meta } = p; // strip blobs from the json
    photoMeta.push(meta);
  }
  const data = { app: 'reset', version: 1, exportedAt: now(), templates, sessions, photos: photoMeta };
  files.unshift({ name: 'data.json', data: new TextEncoder().encode(JSON.stringify(data)) });

  const blob = zipCreate(files);
  const stamp = new Date(now()).toISOString().slice(0, 10);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `reset-backup-${stamp}.zip`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('Backup downloaded');
}

async function importFrom(file) {
  try {
    toast('Reading backup…', { ms: 2000 });
    const entries = zipRead(await file.arrayBuffer());
    const byName = new Map(entries.map((e) => [e.name, e.data]));
    const dataEntry = byName.get('data.json');
    if (!dataEntry) throw new Error('No data.json in backup');
    const data = JSON.parse(new TextDecoder().decode(dataEntry));

    const mergeById = async (store, incoming) => {
      let added = 0;
      for (const rec of incoming || []) {
        const cur = await db.get(store, rec.id);
        if (!cur || (rec.updatedAt || 0) >= (cur.updatedAt || 0)) { await db.put(store, rec); added++; }
      }
      return added;
    };
    const t = await mergeById('templates', data.templates);
    const s = await mergeById('sessions', data.sessions);

    let photoCount = 0;
    for (const meta of data.photos || []) {
      if (await db.get('photos', meta.id)) continue; // photos are immutable
      const fullBytes = byName.get(`photos/${meta.id}-full.jpg`);
      const thumbBytes = byName.get(`photos/${meta.id}-thumb.jpg`);
      if (!fullBytes || !thumbBytes) continue;
      await db.put('photos', {
        ...meta,
        full: new Blob([fullBytes], { type: 'image/jpeg' }),
        thumb: new Blob([thumbBytes], { type: 'image/jpeg' }),
      });
      photoCount++;
    }
    await reloadData();
    render();
    toast(`Imported ${t} templates, ${s} sessions, ${photoCount} photos`);
  } catch (err) {
    console.error(err);
    toast('Import failed — is this a Reset backup?');
  }
}

// ---------------- Modal ----------------
function openModal(html, onAct) {
  closeModal();
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal">${html}</div>`;
  document.body.appendChild(back);
  const finish = (act) => { closeModal(); if (onAct) onAct(act); };
  $$('[data-act]', back).forEach((el) => el.addEventListener('click', () => finish(el.dataset.act)));
  back.addEventListener('click', (e) => { if (e.target === back) finish('dismiss'); });
}
function closeModal() { const m = $('.modal-back'); if (m) m.remove(); }

// Full-screen photo viewer.
async function openPhoto(photoId) {
  const url = await photos.urlFor(photoId, 'full');
  if (!url) return;
  openModal(`<div class="photo-view"><img src="${url}" alt="photo"></div>
    <div class="modal-actions"><button class="btn" data-act="dismiss">Close</button></div>`);
}

// Before/after comparison slider — the payoff moment (spec §5.3).
async function openCompare(block) {
  const beforeUrl = await photos.urlFor(block.beforePhotoId, 'full');
  const afterUrl = await photos.urlFor(block.afterPhotoId, 'full');
  if (!beforeUrl || !afterUrl) return;
  openModal(`
    <h2>${esc(block.title)}</h2>
    <div class="compare" id="compare">
      <img class="cmp-after" src="${afterUrl}" alt="after" draggable="false">
      <img class="cmp-before" id="cmp-before" src="${beforeUrl}" alt="before" draggable="false">
      <div class="cmp-handle" id="cmp-handle"><span>‹ ›</span></div>
      <span class="cmp-tag left">Before</span>
      <span class="cmp-tag right">After</span>
    </div>
    <div class="modal-actions">
      <button class="btn" data-act="dismiss">Close</button>
      <button class="btn primary" data-act="share">Share image</button>
    </div>`, async (act) => {
    if (act === 'share') await shareCompare(block);
  });

  // Wire the drag. The "before" layer is clip-pathed to the divider; both layers stay aligned.
  const wrap = $('#compare'); const before = $('#cmp-before'); const handle = $('#cmp-handle');
  const set = (pct) => {
    pct = Math.max(0, Math.min(100, pct));
    before.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    handle.style.left = pct + '%';
  };
  set(50);
  const onMove = (clientX) => {
    const r = wrap.getBoundingClientRect();
    set(((clientX - r.left) / r.width) * 100);
  };
  const down = (e) => {
    e.preventDefault();
    const move = (ev) => onMove((ev.touches ? ev.touches[0] : ev).clientX);
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };
  wrap.addEventListener('pointerdown', (e) => { onMove(e.clientX); down(e); });
}

// Compose a labelled side-by-side JPEG and share it (Web Share API) or download it.
async function shareCompare(block) {
  const bp = await photos.getPhoto(block.beforePhotoId);
  const ap = await photos.getPhoto(block.afterPhotoId);
  if (!bp || !ap) return;
  const [bImg, aImg] = await Promise.all([blobToImg(bp.full), blobToImg(ap.full)]);
  const h = 900;
  const bw = Math.round(bImg.width * (h / bImg.height));
  const aw = Math.round(aImg.width * (h / aImg.height));
  const pad = 24, labelH = 56;
  const canvas = document.createElement('canvas');
  canvas.width = bw + aw + pad * 3;
  canvas.height = h + labelH + pad * 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0c0e13'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bImg, pad, pad, bw, h);
  ctx.drawImage(aImg, pad * 2 + bw, pad, aw, h);
  ctx.fillStyle = '#eef1f7'; ctx.font = '600 30px system-ui, sans-serif'; ctx.textBaseline = 'middle';
  ctx.fillText('Before', pad + 6, pad + h + labelH / 2);
  ctx.fillText('After', pad * 2 + bw + 6, pad + h + labelH / 2);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#99a1b3';
  ctx.fillText(`${block.title} · ${fmtHuman(T.elapsedMs(block))}`, canvas.width - pad - 6, pad + h + labelH / 2);

  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
  const file = new File([blob], `reset-${block.title.replace(/\W+/g, '-').toLowerCase()}.jpg`, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: block.title }); return; } catch (_) {}
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function blobToImg(blob) {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => { res(img); };
    img.onerror = rej;
    img.src = url;
  });
}

// ---------------- Image hydration (thumbs, strips) ----------------
async function hydrateImages() {
  const c = app();
  // per-image thumbs
  for (const img of $$('img[data-photo]', c)) {
    const url = await photos.urlFor(img.dataset.photo, img.dataset.variant || 'thumb');
    if (url) img.src = url;
  }
  // session thumb strips (home/history rows)
  for (const strip of $$('[data-thumbs]', c)) {
    const s = S.sessions.find((x) => x.id === strip.dataset.thumbs);
    if (!s) continue;
    const ids = [];
    for (const b of s.blocks) {
      if (b.afterPhotoId) ids.push(b.afterPhotoId);
      else if (b.beforePhotoId) ids.push(b.beforePhotoId);
      if (ids.length >= 3) break;
    }
    for (const id of ids) {
      const url = await photos.urlFor(id, 'thumb');
      if (url) { const im = document.createElement('img'); im.src = url; strip.appendChild(im); }
    }
  }
}

// ---------------- Live tick (updates displayed time only; never mutates state) ----------------
function startTick() {
  stopTick();
  tickTimer = setInterval(() => {
    const b = currentBlock();
    if (!b) return;
    const el = $(`[data-elapsed="${b.id}"]`);
    if (el) {
      el.textContent = fmtClock(T.elapsedMs(b));
      const timer = el.closest('.timer');
      if (timer) timer.classList.toggle('over', T.elapsedMs(b) > b.estimatedMinutes * 60000);
    }
  }, 1000);
}
function stopTick() { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }

// ---------------- Service worker ----------------
function registerSW() {
  if ('serviceWorker' in navigator) {
    // Relative path is essential on the /house-reset/ sub-path (absolute /sw.js -> 404).
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW failed', e));
  }
}

// ---------------- Go ----------------
wireCamera();
boot();

// expose a little for console debugging / manual acceptance checks
window.Reset = { S, db, T };
