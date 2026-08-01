// Reset — timer transition tests. Run with: node test/timer.test.js
// Verifies the spec §4 invariants in isolation, before any UI touches them.

import {
  elapsedMs, startBlock, pauseBlock, resumeBlock, finishBlock,
  skipBlock, reopenBlock, clampElapsedTo, sessionWorkedMs, isForgotten,
  FORGOT_THRESHOLD_MS,
} from '../js/timer.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ FAIL:', msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (got ${a}, want ${b})`); }

function newBlock() {
  return {
    status: 'pending', accumulatedMs: 0, runningSince: null,
    firstStartedAt: null, finishedAt: null,
  };
}

const T0 = 1_000_000_000_000; // fixed epoch base so tests are deterministic

// 1. Fresh block reads zero.
{
  const b = newBlock();
  eq(elapsedMs(b, T0), 0, 'fresh block is 0ms');
}

// 2. Start then read 30s later — DERIVED from timestamps, not ticks.
{
  const b = newBlock();
  startBlock(b, T0);
  eq(b.status, 'running', 'start -> running');
  eq(b.firstStartedAt, T0, 'firstStartedAt stamped');
  eq(elapsedMs(b, T0 + 30_000), 30_000, 'elapsed derived 30s after start');
}

// 3. Background/lock survival: no interval ran, yet a 10-minute gap reads 10 min.
{
  const b = newBlock();
  startBlock(b, T0);
  eq(elapsedMs(b, T0 + 10 * 60_000), 10 * 60_000, 'survives a 10-min lock (no ticks)');
}

// 4. Pause banks time; clock does not advance while paused.
{
  const b = newBlock();
  startBlock(b, T0);
  pauseBlock(b, T0 + 60_000);
  eq(b.accumulatedMs, 60_000, 'pause banks 60s');
  eq(b.runningSince, null, 'pause clears runningSince');
  eq(elapsedMs(b, T0 + 5 * 60_000), 60_000, 'paused clock frozen at 60s');
}

// 5. Resume adds to the bank.
{
  const b = newBlock();
  startBlock(b, T0);
  pauseBlock(b, T0 + 60_000);
  resumeBlock(b, T0 + 120_000);
  eq(elapsedMs(b, T0 + 150_000), 90_000, 'resume adds: 60s + 30s = 90s');
}

// 6. Finish flushes the live run and stamps finishedAt.
{
  const b = newBlock();
  startBlock(b, T0);
  finishBlock(b, T0 + 45_000);
  eq(b.status, 'done', 'finish -> done');
  eq(b.finishedAt, T0 + 45_000, 'finishedAt stamped');
  eq(elapsedMs(b, T0 + 999_999), 45_000, 'finished elapsed is frozen at 45s');
}

// 7. firstStartedAt is preserved across pause/resume.
{
  const b = newBlock();
  startBlock(b, T0);
  pauseBlock(b, T0 + 10_000);
  resumeBlock(b, T0 + 20_000);
  eq(b.firstStartedAt, T0, 'firstStartedAt unchanged after resume');
}

// 8. Skip while running flushes elapsed; skip while pending keeps 0.
{
  const running = newBlock();
  startBlock(running, T0);
  skipBlock(running, T0 + 12_000);
  eq(running.status, 'skipped', 'skip -> skipped');
  eq(elapsedMs(running, T0 + 99_000), 12_000, 'skip-while-running keeps 12s');

  const pending = newBlock();
  skipBlock(pending, T0);
  eq(elapsedMs(pending, T0), 0, 'skip-while-pending keeps 0');
}

// 9. Reopen a done block keeps accumulated time; resuming adds to it.
{
  const b = newBlock();
  startBlock(b, T0);
  finishBlock(b, T0 + 60_000);
  reopenBlock(b);
  eq(b.status, 'paused', 'reopen -> paused');
  eq(b.finishedAt, null, 'reopen clears finishedAt');
  resumeBlock(b, T0 + 100_000);
  eq(elapsedMs(b, T0 + 130_000), 90_000, 'reopen+resume adds: 60s + 30s');
}

// 10. Forgot-to-stop: >4h running trips the guard; clamp brings it down.
{
  const b = newBlock();
  startBlock(b, T0);
  const sixHours = T0 + 6 * 60 * 60_000;
  ok(isForgotten(b, sixHours), '6h running is flagged forgotten');
  ok(!isForgotten(b, T0 + FORGOT_THRESHOLD_MS - 1), 'just under 4h is not flagged');
  clampElapsedTo(b, 30 * 60_000, sixHours); // clamp to 30 min estimate
  eq(elapsedMs(b, sixHours + 5000), 30 * 60_000, 'clamp reduces 6h to 30 min');
}

// 11. Session worked-time = sum of block elapsed (breaks excluded by construction).
{
  const a = newBlock(); startBlock(a, T0); finishBlock(a, T0 + 60_000);
  const c = newBlock(); startBlock(c, T0); finishBlock(c, T0 + 120_000);
  const session = { blocks: [a, c] };
  eq(sessionWorkedMs(session, T0 + 999_999), 180_000, 'worked = 60s + 120s = 180s');
}

// 12. Restart-after-reload simulation: a persisted running block keeps counting.
{
  const b = newBlock();
  startBlock(b, T0);                 // persisted
  const reloaded = JSON.parse(JSON.stringify(b)); // survives a reload as plain JSON
  eq(elapsedMs(reloaded, T0 + 8 * 60_000), 8 * 60_000, 'reloaded running block keeps counting');
}

console.log(`\ntimer.test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
