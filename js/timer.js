// Reset — timer semantics. Pure functions over a SessionBlock. No DOM, no IDB.
// THE RULE: store timestamps, DERIVE elapsed. Never count ticks. See spec §4.
//
// A tick counter loses time when the tab backgrounds, the screen locks, or the
// page reloads. Deriving from wall-clock timestamps survives all three.

// Total elapsed = time banked from prior runs + time since the current run began.
export function elapsedMs(b, nowMs = Date.now()) {
  return b.accumulatedMs + (b.runningSince ? nowMs - b.runningSince : 0);
}

// pending -> running
export function startBlock(b, nowMs = Date.now()) {
  b.runningSince = nowMs;
  if (b.firstStartedAt == null) b.firstStartedAt = nowMs;
  b.status = 'running';
  return b;
}

// running -> paused  (flush the live run into the bank)
export function pauseBlock(b, nowMs = Date.now()) {
  if (b.runningSince) {
    b.accumulatedMs += nowMs - b.runningSince;
    b.runningSince = null;
  }
  b.status = 'paused';
  return b;
}

// paused -> running
export function resumeBlock(b, nowMs = Date.now()) {
  b.runningSince = nowMs;
  b.status = 'running';
  return b;
}

// running/paused -> done  (flush, then stamp finished)
export function finishBlock(b, nowMs = Date.now()) {
  if (b.runningSince) {
    b.accumulatedMs += nowMs - b.runningSince;
    b.runningSince = null;
  }
  b.finishedAt = nowMs;
  b.status = 'done';
  return b;
}

// any -> skipped  (flush if it was running; elapsed stays whatever it was)
export function skipBlock(b, nowMs = Date.now()) {
  if (b.runningSince) {
    b.accumulatedMs += nowMs - b.runningSince;
    b.runningSince = null;
  }
  b.finishedAt = nowMs;
  b.status = 'skipped';
  return b;
}

// done/skipped -> paused  (reopen; keeps accumulatedMs so resuming adds to it)
export function reopenBlock(b) {
  b.finishedAt = null;
  b.status = 'paused';
  return b;
}

// Clamp a finished block's elapsed to a target (used by the forgot-to-stop dialog).
export function clampElapsedTo(b, targetMs, nowMs = Date.now()) {
  if (b.runningSince) { // fold any live run first
    b.accumulatedMs += nowMs - b.runningSince;
    b.runningSince = null;
  }
  b.accumulatedMs = Math.max(0, Math.min(b.accumulatedMs, targetMs));
  return b;
}

// Session total counts WORK time (sum of block elapsed), not wall-clock since start —
// breaks shouldn't count as work.
export function sessionWorkedMs(session, nowMs = Date.now()) {
  return session.blocks.reduce((sum, b) => sum + elapsedMs(b, nowMs), 0);
}

export const FORGOT_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

// A running block whose derived elapsed exceeds the threshold => probably forgotten.
export function isForgotten(b, nowMs = Date.now()) {
  return b.status === 'running' && elapsedMs(b, nowMs) > FORGOT_THRESHOLD_MS;
}
