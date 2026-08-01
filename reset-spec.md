# Reset — Design & Technical Spec

**Working name:** Reset (rename freely)
**One line:** A phone-first checklist app for timed, photo-documented work sessions — built for house cleaning, usable for any repeatable list.
**Status:** v1 spec, ready to build
**Target reader:** a coding agent or developer implementing this from scratch

---

## 1. Problem & goal

Long cleaning sessions fail in three ways: you lose track of where you are, you underestimate how long things take, and you can't see that you actually accomplished anything. Reset fixes all three by making the list the app: each task is a block with a start/stop timer and a before/after photo pair.

**The core loop, in the user's hand, mid-chore:**

1. Open the app. The next block is already on screen.
2. Tap **Start** → shutter opens for the "before" photo (skippable).
3. Timer runs. Phone goes in pocket.
4. Come back, tap **Finish** → shutter opens for the "after" photo (skippable).
5. Block is marked done with elapsed time recorded. Next block slides up.

Everything else in the app serves that loop.

### Success criteria

- A user can complete a 15-block session start to finish without ever navigating a menu.
- Timers are accurate to the second across app backgrounding, screen lock, and page reload.
- No photo is ever lost, and storage never silently fills up.
- Session history shows before/after pairs side by side, which is the payoff that makes people use it again.

### Non-goals for v1

- Multi-user / household assignment (spec'd as future, not built)
- Notifications, reminders, or scheduling
- Native app store distribution
- Social sharing, gamification, streaks
- Any AI features

---

## 2. Platform & stack

**Build as an installable PWA.** Phone browser, add-to-home-screen, works offline, camera via `<input capture>`. No app store, no accounts in v1.

Recommended stack (substitute equivalents freely, but keep the storage decisions):

| Layer | Choice | Why |
|---|---|---|
| Framework | React + TypeScript + Vite | Fast, boring, agent-friendly |
| Routing | React Router (hash or browser) | 5 screens, minimal |
| State | Zustand (or Context + reducer) | Small surface, no Redux ceremony |
| Styling | Tailwind CSS | Fast iteration, dark mode built in |
| Local DB | **IndexedDB via Dexie.js** | Required — must store image Blobs |
| PWA | `vite-plugin-pwa` (Workbox) | Manifest + service worker, offline shell |
| Dates | `date-fns` | Formatting only |

### Hard requirements

- **Do not use `localStorage` for photos.** Blobs go in IndexedDB. `localStorage` is capped around 5 MB and stores strings only; base64 in `localStorage` will break this app on the first session.
- **Mobile-first layout.** Design at 390×844. Desktop is a centered column, max-width 480px. Nothing about this app needs a wide layout.
- **Thumb-reachable primary action.** The Start/Finish button lives in the bottom third of the screen, minimum 56px tall, full width minus gutters.
- **Dark mode by default**, respecting `prefers-color-scheme`. People clean at night.

---

## 3. Data model

```ts
// ---------- Templates: the reusable definition of a list ----------

interface Template {
  id: string;                 // uuid
  name: string;               // "Full House Reset"
  description?: string;
  blocks: TemplateBlock[];    // ordered
  createdAt: number;          // epoch ms
  updatedAt: number;
  deletedAt: number | null;   // soft delete, for future sync
  isBuiltIn: boolean;         // seeded templates can be copied but not destroyed
}

interface TemplateBlock {
  id: string;
  title: string;              // "Kitchen counters"
  detail?: string;            // the checklist prose for this block
  estimatedMinutes: number;   // used for the session-total estimate
  order: number;              // 0-based, contiguous
  photoMode: 'both' | 'before' | 'after' | 'none';  // default 'both'
  tags?: string[];            // "kitchen", "outdoor" — future filtering
}

// ---------- Sessions: one run through a template ----------

interface Session {
  id: string;
  templateId: string;
  templateName: string;       // denormalized — template may change or be deleted later
  startedAt: number;
  completedAt: number | null; // set when user ends the session
  status: 'active' | 'completed' | 'abandoned';
  blocks: SessionBlock[];     // snapshot of template blocks at session start
  note?: string;              // free text, written at wrap-up
  updatedAt: number;
  deletedAt: number | null;
}

interface SessionBlock {
  id: string;
  templateBlockId: string;
  title: string;
  detail?: string;
  estimatedMinutes: number;
  order: number;
  photoMode: 'both' | 'before' | 'after' | 'none';

  status: 'pending' | 'running' | 'paused' | 'done' | 'skipped';

  // --- Timer state. Read section 4 before implementing. ---
  accumulatedMs: number;      // total elapsed from all prior runs of this block
  runningSince: number | null;// epoch ms of current run start; null when not running
  firstStartedAt: number | null;
  finishedAt: number | null;

  beforePhotoId: string | null;
  afterPhotoId: string | null;
  note?: string;
}

// ---------- Photos: stored separately so blobs never bloat session records ----------

interface Photo {
  id: string;
  sessionId: string;
  sessionBlockId: string;
  kind: 'before' | 'after';
  full: Blob;                 // JPEG, longest edge ≤ 1600px
  thumb: Blob;                // JPEG, longest edge ≤ 320px
  width: number;              // of `full`
  height: number;
  bytes: number;              // full.size, for the storage meter
  createdAt: number;
  syncedAt: number | null;    // future
  remoteUrl: string | null;   // future
}
```

### Dexie schema

```ts
db.version(1).stores({
  templates: 'id, updatedAt, deletedAt',
  sessions:  'id, templateId, status, startedAt, updatedAt, deletedAt',
  photos:    'id, sessionId, sessionBlockId, [sessionBlockId+kind], createdAt',
  meta:      'key',   // schemaVersion, activeSessionId, settings blob
});
```

### Model rules

- **Sessions snapshot their blocks.** Editing a template must never alter a past session's record. This is why `SessionBlock` duplicates `title`/`detail` rather than referencing.
- **Exactly one session may have `status: 'active'`** at a time. Enforce on create; if an active session exists, prompt to resume or abandon it.
- **Exactly one block may have `status: 'running'`** within a session. Starting block B while block A runs auto-pauses A (see 4.4).
- **Soft deletes only.** Never hard-delete a session, template, or photo record from the user-facing path — set `deletedAt`. This keeps phase-2 sync tractable. A separate "empty trash" action does the real removal.

---

## 4. Timer semantics

This is the part that gets built wrong. Read it fully.

### 4.1 Never count ticks

Do not maintain elapsed time by incrementing a counter in `setInterval`. Timers throttle in background tabs, stop entirely on screen lock, and reset on reload — a tick counter loses time in all three cases.

**Store timestamps, derive elapsed:**

```ts
function elapsedMs(b: SessionBlock, now = Date.now()): number {
  return b.accumulatedMs + (b.runningSince ? now - b.runningSince : 0);
}
```

`setInterval(..., 1000)` exists only to trigger a re-render so the displayed number updates. It never mutates state. If the interval is throttled to once every 60s in the background, the next render still shows the correct time, because the value is computed from wall-clock timestamps.

### 4.2 Transitions

| Action | Effect |
|---|---|
| **Start** (pending → running) | `runningSince = Date.now()`; `firstStartedAt ??= runningSince`; persist immediately |
| **Pause** (running → paused) | `accumulatedMs += Date.now() - runningSince`; `runningSince = null`; persist |
| **Resume** (paused → running) | `runningSince = Date.now()`; persist |
| **Finish** (running/paused → done) | Flush as in Pause; `finishedAt = Date.now()`; persist |
| **Skip** (any → skipped) | Flush if running; `finishedAt = Date.now()`; elapsed stays whatever it was |
| **Reopen** (done/skipped → paused) | `finishedAt = null`; keeps `accumulatedMs` so resuming adds to it |

Every transition writes to IndexedDB **synchronously with the UI update** — not debounced, not on an interval. A block transition is a handful of bytes; the cost is irrelevant next to the cost of losing a session to a tab crash.

### 4.3 Recovery on load

On app start, if an active session exists with a `running` block, elapsed is recomputed from `runningSince` and simply keeps counting. Nothing special is needed — this falls out of the timestamp design.

**One guard:** if a running block's derived elapsed exceeds **4 hours**, assume the user forgot to stop it. Don't silently record it. Show a dialog: *"Kitchen counters has been running for 6h 12m. Did you finish it?"* with options **Finish now** (records full elapsed), **I finished around ___** (time picker, clamps `finishedAt`), and **Discard the extra time** (clamps elapsed to `estimatedMinutes`). Same check runs on `visibilitychange` when the tab becomes visible again.

### 4.4 Session-level rules

- Starting a block while another runs: auto-pause the running one, show a brief toast (*"Paused: Fridge"*), start the new one. Never block the action with a confirm dialog.
- A **session-level pause** ("Taking a break") pauses the running block and marks the session paused. Resuming restores the same block to running.
- Session total elapsed = sum of block elapsed, **not** wall-clock since `startedAt`. Breaks shouldn't count as work. Display both if useful: "3h 40m worked · 5h 10m since start."

### 4.5 Display

- Under 1 hour: `M:SS` (`24:31`)
- 1 hour and over: `H:MM:SS` (`1:04:22`)
- In history and summaries: rounded human form (`25 min`, `1h 4m`)
- While running, show the estimate alongside: `24:31 / ~30m`. Past the estimate, the number turns amber rather than red — going over is normal, not a failure.

---

## 5. Photo capture

### 5.1 Capture

Use a plain file input, which triggers the native camera on mobile and is far more reliable than `getUserMedia`:

```html
<input type="file" accept="image/*" capture="environment" />
```

Trigger it programmatically from the Start/Finish handler. If the user cancels the picker, **the transition still proceeds** — photos are never mandatory. A block with `photoMode: 'none'` skips the picker entirely.

Allow adding or replacing a photo later from the block detail view, including for blocks already marked done.

### 5.2 Processing pipeline

Every captured image runs through this before storage:

1. Read the `File` into an `ImageBitmap` (`createImageBitmap`, which handles EXIF orientation correctly in modern browsers).
2. Draw to an `OffscreenCanvas` scaled so the **longest edge ≤ 1600px**, preserving aspect ratio. Never upscale.
3. Export as JPEG at **quality 0.8** → this is `full`.
4. Repeat at **longest edge ≤ 320px**, quality 0.7 → this is `thumb`.
5. Store both Blobs in the `photos` table with dimensions and byte size.

Expected result: roughly 150–350 KB per full image, 10–20 KB per thumb. A 15-block session with both photos ≈ **5–10 MB**. That is the number every storage decision below is sized against.

Do the resizing in a **Web Worker** — on older phones, decoding and scaling a 12 MP photo on the main thread visibly janks the UI at exactly the moment the user is waiting.

### 5.3 Rendering

Lists and grids render `thumb` only. `full` loads on demand in the viewer. Always create object URLs with `URL.createObjectURL` and **revoke them on unmount** — leaked blob URLs are the top memory bug in apps like this.

The before/after viewer supports:

- Side-by-side on wide screens, stacked on narrow
- Tap to toggle full-screen single image, pinch to zoom
- A **swipe comparison slider** when both photos exist and share an aspect ratio — this is the payoff moment of the whole app, worth the extra effort
- Export a single side-by-side JPEG for sharing (canvas composite, labels "Before"/"After", block title, elapsed time)

### 5.4 Storage management

Request persistent storage once, on first session start:

```ts
if (navigator.storage?.persist) await navigator.storage.persist();
```

Check quota via `navigator.storage.estimate()` on app load and after each session:

- Over **70%** used → passive banner in Settings with a link to storage management
- Over **90%** → blocking prompt before starting a new session, offering: export sessions to a zip, or bulk-delete photos from sessions older than a chosen date (keeping timing data, which is tiny)

Settings shows a **storage breakdown**: total used, count of photos, largest sessions, with per-session delete.

---

## 6. Screens

Five screens. Numbered by navigation priority.

### 6.1 Home

The app's entry point, and the screen a user sees most often.

- **If a session is active:** a large resume card showing template name, progress (`7 / 15`), a progress bar, total elapsed, and a **Continue** button that jumps straight to the Run screen. Nothing else competes with it.
- **If no session is active:** a **Start a session** button, followed by the template list (name, block count, total estimate, last-used date). Tapping a template shows a preview sheet with all blocks and a confirm button.
- Below: last 3 completed sessions as compact cards (date, template, duration, a 3-thumbnail strip), and a link to full History.

### 6.2 Run — the main screen

This is where 90% of app time is spent. It must work one-handed, at arm's length, with wet hands.

**Layout, top to bottom:**

- **Header bar:** session name, `7 / 15`, thin progress bar, overflow menu (pause session, reorder remaining, end session, settings)
- **Current block card**, dominant, roughly half the viewport:
  - Block title, large
  - `detail` text, readable — this is the actual instruction set, don't shrink it to a caption
  - Big timer readout, monospaced, with `/ ~30m` estimate beside it
  - Before/after thumbnail slots, tappable to view, replace, or add
- **Primary action button**, bottom, full width, 56px+:
  - `pending` → **Start** (accent color)
  - `running` → **Finish** (accent) with a secondary **Pause** beside it
  - `paused` → **Resume** / **Finish**
  - `done` → auto-advances to next pending block after ~1.5s with an undo toast
- **Upcoming blocks**, a compact scrollable list below the fold: title, estimate, status dot. Tap to jump (auto-pauses current). Long-press to drag-reorder remaining blocks.

**Details that matter:**

- Keep the screen awake while a block runs — `navigator.wakeLock.request('screen')`, released on pause/finish. Re-acquire on `visibilitychange`. Fail silently if unsupported.
- Haptic feedback on start and finish: `navigator.vibrate([40])` and `navigator.vibrate([40, 60, 40])`.
- When all blocks are done or skipped, slide up the wrap-up sheet (6.3) rather than dropping the user on an empty screen.

### 6.3 Session wrap-up

Shown when the last block completes or the user ends the session early.

- Total worked time vs. total estimate, plus per-block over/under
- Blocks completed / skipped counts
- A scrollable strip of every before/after pair
- Free-text note field
- **Save session** → status `completed`, navigate to the session's History detail
- If ended early with blocks remaining: **Save partial** (completed, remaining stay `pending` in the record) or **Discard session** (confirm — this is destructive)

### 6.4 History

- Reverse-chronological session list, grouped by month
- Each card: date, template name, duration, blocks done, thumbnail strip
- Tap → session detail: full block list with per-block times and photo pairs, session note, and actions (export, delete, **start a new session from this one** — which reuses the template)
- Header stats: sessions this month, total time, average session length
- Per-template stat, shown in the template editor: **average actual time per block** vs. its estimate, with a one-tap *"Update estimates to match your actual times"* action. This makes the app's estimates get better the more you use it, which is the strongest reason to come back.

### 6.5 Templates & settings

**Template list** → create, duplicate, edit, delete (built-ins duplicate rather than edit).

**Template editor:** name, description, and a drag-reorderable block list. Each block edits inline: title, detail (multiline), estimated minutes, photo mode. Add block, delete block, duplicate block. Total estimate updates live in the header.

**Settings:**

- Theme: system / light / dark
- Keep screen awake during blocks (on by default)
- Haptics (on by default)
- Default photo mode for new blocks
- Auto-advance after finishing a block (on by default)
- Storage: usage meter, breakdown, cleanup tools
- **Export all data** → zip: `data.json` (templates + sessions) plus `photos/{sessionId}/{blockId}-{before|after}.jpg`
- **Import** → merges by id, newest `updatedAt` wins, never destructive
- About / version

---

## 7. Seed data

Ship one built-in template, `isBuiltIn: true`, so the app is useful in the first 10 seconds without any setup.

**Template: "Full House Reset"** — 15 blocks, ~6h 15m estimated. Ordered on three rules: start the machines first so they run in the background, tidy before vacuuming, vacuum before mopping.

| # | Title | Est. | Detail |
|---|---|---|---|
| 1 | Launch | 25 | Open all windows. Start laundry load 1. Load and run the dishwasher. Walk the house with a bin bag — all trash out, bins to the curb. |
| 2 | Gather the burn pile | 25 | Rake leaves, drag trimmings, build the pile. Clear anything flammable within a few metres. |
| 3 | Light the fire | 60 | Blocks 4 and 5 happen while this burns, so you stay outside with it. Check the wind first — if it's gusty, skip and do 4–5 anyway. |
| 4 | Balcony, yard & storage | 25 | Sweep the balcony, wipe the railing, tidy the storage area, put stray tools back. |
| 5 | Hang laundry 1 | 20 | Hang load 1, start load 2. You're already outside. |
| 6 | Litter trays | 20 | Empty fully, scrub with hot water, dry, refill. Sweep the scattered litter around them. |
| 7 | Kitchen counters | 30 | Clear everything off, wipe down, degrease the hob and backsplash. Unload the dishwasher, hand-wash the rest. |
| 8 | Fridge | 30 | Shelf by shelf. Toss expired, wipe each shelf and the door seals, wipe the freezer front. Skip the full freezer today. |
| 9 | Kitchen finish | 25 | Scrub the sink and tap, microwave inside, appliance fronts, wipe the bin inside and out. |
| 10 | Bathrooms | 30 | Toilet, shower/tub, sink, mirror, fixtures. Fresh towels. Split the time if there's a second bathroom. |
| 11 | Bedrooms 1 & 2 | 25 | Strip and remake beds, clothes into drawers or the wash, clear nightstands and dressers. |
| 12 | Bedroom 3 & hallway | 25 | Same treatment. Hallway: shoes lined up, surfaces cleared, cobwebs off the corners. |
| 13 | Living room | 25 | Cushions straightened, surfaces cleared, dust top-down — shelves, TV, tables, skirting last. |
| 14 | Vacuum everything | 30 | Furthest room back toward the door. Under furniture where you can reach, corners, edges. |
| 15 | Mop & finish | 30 | All hard floors, same back-to-front path. Hang laundry 2 while floors dry. Close windows. |

All blocks default to `photoMode: 'both'` except #3 and #5, which are `'none'`.

---

## 8. Phase 2 — sync (spec only, do not build in v1)

Build v1 fully local. These decisions exist now so phase 2 doesn't require a rewrite.

**Backend:** Supabase — Postgres, Auth, and Storage in one, with row-level security that maps cleanly onto per-user data.

**What v1 must already do to make this possible:**

- Every record has `id` (client-generated UUID), `updatedAt`, `deletedAt`, and a nullable `syncedAt`
- All deletes are soft
- No auto-increment ids, no server-dependent fields
- `Photo` already carries `remoteUrl: string | null`

**Sync design when built:**

- Optional account. Anonymous local use stays fully supported forever — signing in uploads existing local data rather than replacing it.
- **Last-write-wins per record** on `updatedAt`. Sessions are effectively single-device (you clean in one house on one phone), so real conflicts are rare; per-field merge is not worth the complexity.
- Photos upload to a Storage bucket at `{userId}/{sessionId}/{blockId}-{kind}.jpg`, set `remoteUrl`, and become evictable from local IndexedDB under storage pressure — thumbs stay local, fulls re-fetch on demand.
- Sync runs on app foreground, on session completion, and manually from Settings. Queue writes while offline, flush on reconnect.
- **Household sharing** rides on this: a `households` table, sessions optionally carry `householdId`, blocks gain `assignedTo`. Explicitly out of scope until sync ships and works.

---

## 9. Acceptance criteria

The build is done when all of these pass on a real phone:

1. Fresh install shows the seeded "Full House Reset" template and can start a session with two taps.
2. Starting a block opens the camera; cancelling the camera still starts the timer.
3. With a block running: lock the phone for 10 minutes, reopen — the timer reads 10 minutes higher, not frozen, not reset.
4. With a block running: force-quit the browser, reopen the app — the session resumes on the correct block with correct elapsed time.
5. Switch to another app for 30+ minutes with a block running, return — time is accurate, no drift.
6. A block left running for 5+ hours triggers the forgot-to-stop dialog, and each of its three options produces the described result.
7. Starting block B while block A runs pauses A, preserves A's elapsed, and shows a toast.
8. A full 15-block session with 30 photos completes and consumes under 10 MB, verified via `navigator.storage.estimate()`.
9. Session history shows before/after pairs, and the comparison slider works with two photos of matching aspect ratio.
10. Editing a template after completing a session leaves that session's record unchanged.
11. Airplane mode: the app loads, runs a full session, and saves everything — no network dependency anywhere in v1.
12. Export produces a zip that a fresh install can import, reproducing all sessions and photos.
13. Installed to home screen, the app opens full-screen with no browser chrome.
14. Lighthouse PWA audit passes; performance ≥ 90 on mid-tier mobile.
15. Every interactive target is ≥ 44×44px and reachable one-handed on a 390px-wide screen.

---

## 10. Build order

Ship each step working before starting the next.

1. **Skeleton** — Vite + React + TS + Tailwind + Dexie, routing, dark theme, PWA manifest and service worker
2. **Data layer** — schema, seed template, CRUD, `useSession` / `useTimer` hooks. Unit-test the timer transitions in isolation before any UI touches them.
3. **Run screen with timers, no photos** — this alone is a usable app; dogfood it on a real cleaning session before continuing
4. **Photos** — capture, worker-based resize pipeline, thumbnails, blob URL lifecycle
5. **Wrap-up + History** — session summary, list, detail, before/after viewer
6. **Templates editor** — create, edit, reorder, duplicate
7. **Settings** — storage meter, cleanup, export/import
8. **Polish** — wake lock, haptics, comparison slider, share-image export, estimate learning
9. **Harden** — run the full acceptance list on a real phone, fix what breaks

Steps 1–3 are the minimum viable product. Everything after is additive.

---

## 11. Open questions

- Should skipped blocks count against session completion percentage, or be excluded from the denominator?
- Is a global session timer worth displaying prominently, or does it just create pressure? (Suggest: available in the header menu, not on the main surface.)
- Should photos be capturable mid-block, not just at start/finish — e.g. a "progress" photo? (Suggest: defer; `Photo.kind` is already an enum, so adding `'progress'` later is non-breaking.)
- Voice control for hands-free start/stop — genuinely useful with wet hands, but a large scope addition. Defer past v1.
