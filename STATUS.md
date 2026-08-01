# Reset — build status

**Live:** https://kleanthisx.github.io/house-reset/ — open on your phone, then **Add to Home Screen** to install.
**Stack:** vanilla HTML/CSS/JS PWA, no build step. Data in IndexedDB (photos as Blobs). Fully offline.

## What's built (v1 core, complete)
- **Home** — resume-in-progress card, start a session from any template, recent sessions.
- **Run** — one block at a time: Start / Pause / Resume / Finish / Skip, big derived timer
  (`M:SS` / `H:MM:SS`, amber past estimate), before/after photo slots, upcoming list with
  jump-to-block, auto-pause when starting another, auto-advance, wake lock, haptics,
  session break, end early.
- **Timers** — timestamp-derived (never tick-counted); survive background / lock / reload /
  force-quit. `>4h` forgot-to-stop dialog (finish now / clamp to estimate / keep running).
- **Photos** — native camera capture, Web-Worker resize (full ≤1600 @0.8, thumb ≤320 @0.7),
  blobs in IndexedDB, blob-URL lifecycle managed.
- **Wrap-up** — worked vs estimate, done/skipped counts, before/after strip, note, save /
  save-partial / discard.
- **History** — list grouped by month, per-session detail, **before/after comparison slider**,
  share/download a labelled side-by-side JPEG, reuse template, delete.
- **Templates** — create / edit / duplicate / delete, inline block editing, reorder, live total,
  **estimate-learning** ("update estimates to your actual times").
- **Settings** — theme, wake lock, haptics, auto-advance, default photo mode, storage meter
  (70% warn / 90% blocking guard), **export / import zip** (non-destructive, merges by newest).
- **PWA** — manifest (relative scope, installable), offline service worker, icons (SVG + 192/512
  + maskable + apple-touch).

## How to test locally
- `npm test` — timer transition unit tests (24 assertions).
- `node smoke.mjs` — headless-Chromium end-to-end (13 checks): seed → start → photo → timer
  survives reload → finish → save partial → detail → compare slider → export → **fresh-install
  import round-trip** → template editor. (Needs `npm i` first; playwright is a dev dep.)

## Acceptance (spec §9) — verified in tests vs. needs-a-real-phone
Verified headless/unit: 1 (seed, 2-tap start), 2 (camera opens, timer starts anyway),
4 (force-quit resume), 6 (forgot-to-stop logic), 7 (auto-pause), 9 (compare slider),
10 (template edit doesn't touch past sessions), 12 (export→import round-trip).
**Please confirm on your phone:** 3 & 5 (lock/background 10-30 min → time accurate),
8 (15 blocks/30 photos < 10 MB via Settings meter), 11 (airplane mode full session),
13 (installs full-screen), 14 (Lighthouse PWA + perf ≥90), 15 (one-handed reach on a 390px screen).

## Deferred (spec, explicitly post-v1)
Phase-2 sync (Supabase) — v1 already carries `id`/`updatedAt`/`deletedAt`/`syncedAt` + soft
deletes so it won't need a rewrite. Voice control, mid-block "progress" photos, household sharing.

## Open questions (spec §11) — for you to decide
Skipped blocks in completion %; a prominent global session timer; mid-block progress photos.
