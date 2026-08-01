# Claude Code — House Reset

**Project:** Reset — a phone-first PWA for timed, photo-documented work sessions (built for house cleaning, usable for any repeatable list).
**Status:** v1 spec complete, ready to build. Nothing built yet.
**Source of truth:** [`reset-spec.md`](reset-spec.md) — the full design & technical spec. Read it before implementing anything; it is authoritative over this file.

## Stack (from spec §2)
- React + TypeScript + Vite
- React Router · Zustand (or Context+reducer) · Tailwind (dark by default)
- **IndexedDB via Dexie.js** — required, stores image Blobs
- `vite-plugin-pwa` (Workbox) · `date-fns`
- Installable PWA, phone-first (design at 390×844, desktop = centered column max 480px). No accounts, no backend in v1 — fully local & offline.

## Hosting — GitHub Pages (installable web app)
Ship as a static PWA on GitHub Pages; users "Add to Home Screen" to install. Local reference for the `vite-plugin-pwa` setup: `../gymos/vite.config.ts` (copy the VitePWA block, not its paths).
- **Repo:** `house-reset` (public). **Live URL:** `https://<user>.github.io/house-reset/`. **Vite `base`: `/house-reset/`**.
- **Project page gotcha:** served from `/house-reset/`, not root. `base: '/house-reset/'` in `vite.config`, and the PWA manifest `start_url`/`scope`/`id` + icon paths must live under that base (gymos uses `start_url: '/'` with no base — that only works for a root/user page; don't copy it verbatim).
- **Routing:** use React Router **hash** history on Pages (no server rewrites, so browser-history deep links 404). Or add a `404.html` SPA fallback.
- **Deploy:** GitHub Actions building `dist/` to Pages is the clean path (no local git remote here yet — `git init` + create the repo when we start). `git init` on request only.

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
