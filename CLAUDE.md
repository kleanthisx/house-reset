# Claude Code — House Reset

**Project:** Reset — a phone-first PWA for timed, photo-documented work sessions (built for house cleaning, usable for any repeatable list).
**Status:** MVP build in progress (vanilla static PWA).
**Source of truth:** [`reset-spec.md`](reset-spec.md) — the full design & technical spec. Authoritative on WHAT to build (data model, timer/photo/storage rules, screens, acceptance §9). This file overrides it only on the stack/hosting choice below.

## Stack — vanilla static PWA (DELIBERATE deviation from spec's *recommended* React/Vite)
The spec §2 stack table is prefixed "Recommended stack (**substitute equivalents freely**, but keep the storage decisions)." We substitute — no framework, no build step — to match the user's proven pattern (`aqua-crystal`: plain HTML/CSS/JS PWA on Pages) and KISS/MVP working style. Adversarially reviewed & cleared before building.
- **Plain HTML + CSS + vanilla ES modules.** No React, no Vite, no bundler, no npm build. The repo files *are* the deployed site.
- **Raw IndexedDB** (hand-rolled wrapper in `js/db.js`) for all records incl. photo Blobs — NOT localStorage (note: aqua-crystal's `store.js` uses localStorage; do NOT copy that — Reset stores image blobs and must use IDB).
- **Web Worker** (`js/photo-worker.js`) for photo resize via `createImageBitmap` + `OffscreenCanvas`.
- Installable PWA, phone-first (390×844, desktop = centered column max 480px). Dark by default. No accounts/backend in v1 — fully local & offline.
- File layout: `index.html`, `manifest.webmanifest`, `sw.js`, `.nojekyll`, `icon.svg` + PNG icons, `css/`, `js/`.

## Hosting — GitHub Pages, no build (push = live, once Pages is enabled)
- **Repo:** `house-reset` (public) → **https://kleanthisx.github.io/house-reset/**. Pages source = branch **`main`, folder `/ (root)`**. No Actions, no `dist/`.
- **Sub-path, not root:** served at `/house-reset/`. Handle it by using **relative paths everywhere** — manifest `start_url:"."`/`scope:"."`, relative `<link>`/`<script src>`, and **`navigator.serviceWorker.register('./sw.js')`** (absolute `/sw.js` → 404). No base config needed; this is why vanilla+relative sidesteps the Vite base gotcha entirely.
- **`.nojekyll`** at root (Pages runs Jekyll by default and drops `_`-prefixed paths).
- Icons: ship **192 & 512 PNG + maskable + `apple-touch-icon`** (iOS ignores SVG home-screen icons; Lighthouse PWA wants PNG), plus `icon.svg` for crisp Android.
- **Enabling Pages is a required manual/API step — do not assume push = live until confirmed.**

## Non-negotiable rules (spec has the detail — don't paraphrase from memory)
- **Never put photos in `localStorage`.** Blobs → IndexedDB only.
- **Timers store timestamps, never tick-count.** Elapsed is *derived* from wall-clock (`accumulatedMs + now - runningSince`); `setInterval` only triggers re-render, never mutates state. See §4 in full — this is the part that gets built wrong.
- **Every timer transition persists to IndexedDB synchronously** with the UI update — not debounced, not on an interval.
- **Sessions snapshot their blocks** — editing a template must never alter a past session.
- **Soft deletes only** (`deletedAt`), client-generated UUIDs, `updatedAt`/`syncedAt` on every record — phase-2 sync depends on it. Don't build sync in v1.
- **Photo pipeline in a Web Worker:** full ≤1600px longest edge @0.8, thumb ≤320px @0.7. Lists render thumbs only; revoke blob URLs on unmount.
- Exactly one `active` session; exactly one `running` block per session (starting another auto-pauses).

## Build order (spec §10 — ship each step working before the next)
Skeleton → Data layer (**unit-test timer transitions before any UI**) → Run screen w/ timers (no photos, dogfood it) → Photos → Wrap-up + History → Templates editor → Settings → Polish → Harden against §9 acceptance list.
**Steps 1–3 are the MVP.** Everything after is additive.

## Done = §9 acceptance criteria pass on a real phone
Especially: lock/force-quit/background survival with correct elapsed (3–5), forgot-to-stop dialog (6), full 15-block/30-photo session under 10 MB (8), airplane-mode end-to-end (11), export→import round-trip (12), Lighthouse PWA + perf ≥90 (14).

## Working agreement (from ~/CLAUDE.md — applies here)
- Build mode is **concept/build-and-refine**: keep it runnable, refine in place. Work the change list; don't freelance scope.
- Follow the spec's stated methods exactly (esp. §3–5 storage/timer/photo decisions). If you see a better way, propose in one line and wait.
- Run the done-criteria yourself before declaring done.

## Open questions (spec §11) — decide with the user, don't silently pick
Skipped blocks in completion %; prominent global session timer; mid-block progress photos; voice control (all deferred/suggested-defer in spec).
