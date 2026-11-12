import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runLoop, classifyCycle, resolveMaxConsecutiveCycleFailures, runSinglePass, runContinuousMonitor } from '../src/action-runner.mjs';
import { checkNewReleases } from '../src/feed-monitor.mjs';
import { runCheckCycle, reportCycleVerdict } from '../src/index.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_URL = pathToFileURL(path.join(REPO_ROOT, 'src', 'action-runner.mjs')).href;

/** Run a snippet in a child process (an isolated cwd + env). */
function runSnippet(code, { cwd, env } = {}) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd, env: env || process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: res.status ?? 1, stdout: res.stdout || '', stderr: res.stderr || '' };
}

test('runLoop: does not start a trailing cycle when remaining window is less than cycleBudgetMs', async () => {
  let t = 0;
  const now = () => t;
  const sleep = async (ms) => { t += ms; };
  // Each check cycle takes 4.5 minutes
  const check = async () => { t += 4.5 * 60 * 1000; };

  const windowMs = 25 * 60 * 1000;      // 25 minutes
  const cycleBudgetMs = 6 * 60 * 1000;  // 6 minutes safety budget
  const checkIntervalMs = 60 * 1000;    // 1 minute sleep interval

  const result = await runLoop({
    windowMs,
    cycleBudgetMs,
    checkIntervalMs,
    check,
    now,
    sleep,
    log: () => {}
  });

  // The total elapsed time MUST NOT exceed the window!
  assert.ok(
    result.elapsed <= windowMs,
    `Run overran window! Elapsed: ${result.elapsed / 60000}m, Window: ${windowMs / 60000}m (started trailing cycle at t=${(result.elapsed - 4.5 * 60 * 1000) / 60000}m)`
  );
  assert.equal(result.cycles, 4, 'Should execute exactly 4 cycles and stop before cycle 5');
});

test('runLoop: exits immediately without sleeping when remaining window is less than cycleBudgetMs', async () => {
  let t = 0;
  let sleeps = 0;
  const now = () => t;
  const sleep = async (ms) => { sleeps++; t += ms; };
  // Check takes 20 minutes
  const check = async () => { t += 20 * 60 * 1000; };

  const windowMs = 25 * 60 * 1000;
  const cycleBudgetMs = 6 * 60 * 1000;
  const checkIntervalMs = 60 * 1000;

  const result = await runLoop({
    windowMs,
    cycleBudgetMs,
    checkIntervalMs,
    check,
    now,
    sleep,
    log: () => {}
  });

  // After 1 cycle, t = 20m, remaining = 5m < 6m budget.
  // It should NOT sleep and should exit immediately.
  assert.equal(sleeps, 0, `Should not sleep when remaining time is less than budget, but slept ${sleeps} times`);
  assert.equal(result.elapsed, 20 * 60 * 1000);
});

test('runLoop: aborts a hanging cycle with cycleTimeoutMs, recovers, and finishes window', { timeout: 1000 }, async () => {
  let t = 0;
  let teardowns = 0;
  const now = () => t;
  const sleep = async (ms) => { t += ms; };
  // Check hangs forever
  const check = async () => new Promise(() => {});

  const windowMs = 25 * 60 * 1000;
  const cycleBudgetMs = 6 * 60 * 1000;
  const checkIntervalMs = 60 * 1000;
  const cycleTimeoutMs = 20; // 20ms real-time timeout in test

  const onCycleTimeout = async (cycle) => {
    teardowns++;
    // Advance virtual time by 10 minutes when timeout occurs
    t += 10 * 60 * 1000;
  };

  const result = await runLoop({
    windowMs,
    cycleBudgetMs,
    checkIntervalMs,
    cycleTimeoutMs,
    check,
    now,
    sleep,
    onCycleTimeout,
    log: () => {}
  });

  // 1. Hanging cycle was cut and timeouts tracked
  assert.ok(result.timeouts >= 1, `Expected at least 1 timeout, got ${result.timeouts}`);
  assert.equal(teardowns, result.timeouts, 'Teardown should be called on each timeout');

  // 2. Loop recovered and completed multiple cycles (didn't abort whole window on first timeout)
  assert.equal(result.cycles, 2, 'Should have survived cycle 1 and proceeded to cycle 2');

  // 3. Window finished cleanly within duration
  assert.ok(result.elapsed <= windowMs, `Window overran! ${result.elapsed / 60000}m`);
});

// ===========================================================================
// P0-3 — success contract (execution spec §4 / §7)
// ===========================================================================

const GREEN = { attempted: 1, published: 1, failed: 0, deferred: 0, skipped: 0, sourceErrors: 0 };
const RED = { attempted: 1, published: 0, failed: 1, deferred: 0, skipped: 0, sourceErrors: 0 };

// The production geometry: a 25 minute window with a 6 minute cycle budget
// and 4.5 minute cycles -> exactly 4 cycles per window.
const WINDOW_MS = 25 * 60 * 1000;
const CYCLE_BUDGET_MS = 6 * 60 * 1000;
const CYCLE_MS = 4.5 * 60 * 1000;

function virtualClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    tick: (ms) => { t += ms; },
  };
}

/** Run a window whose cycles return the given summaries in order. */
async function runWithOutcomes(outcomes, extra = {}) {
  const clock = virtualClock();
  const logs = [];
  let i = 0;
  const result = await runLoop({
    windowMs: WINDOW_MS,
    cycleBudgetMs: CYCLE_BUDGET_MS,
    checkIntervalMs: 60 * 1000,
    check: async () => {
      clock.tick(CYCLE_MS);
      return outcomes[Math.min(i++, outcomes.length - 1)];
    },
    now: clock.now,
    sleep: clock.sleep,
    log: (m) => logs.push(String(m)),
    ...extra
  });
  return { result, logs };
}

test('classifyCycle: red predicate table (owner policy)', () => {
  const v = (s, streak = 0, max = 3) => classifyCycle(s, streak, { maxConsecutiveCycleFailures: max });

  // attempted=1, published=0, failed=1 -> red
  assert.equal(v(RED).red, true, 'nothing published + a failure must be red');
  assert.equal(v(RED).status, 'red');

  // failed=2, published=1 -> red (failed > published)
  assert.equal(v({ attempted: 3, published: 1, failed: 2 }).red, true, 'failed > published must be red');

  // failed=1, published=1 -> warning only, never red
  const warn = v({ attempted: 2, published: 1, failed: 1 });
  assert.equal(warn.red, false, '1 failure next to a success is a warning, not a red');
  assert.equal(warn.status, 'warn');

  // attempted=0 -> idle
  const idle = v({ attempted: 0 });
  assert.equal(idle.status, 'idle');
  assert.equal(idle.red, false, 'an idle window is never red');

  // deferred=1, failed=0, published=0, attempted=1 -> NOT red (a deferral is
  // not a failure) but it IS a stall.
  const deferredOnly = v({ attempted: 1, published: 0, failed: 0, deferred: 1 });
  assert.equal(deferredOnly.red, false, 'a deferral must never be counted as a failure');
  assert.equal(deferredOnly.stall, true, 'a deferred-only cycle is a stall');
  assert.equal(deferredOnly.failedCycle, false, 'a deferral must not count toward the failure streak');

  // failed=3, published=5 -> red (F-13: this class was silently green)
  assert.equal(v({ attempted: 8, published: 5, failed: 3 }).red, true, 'failed >= MAX must be red even with successes');

  // sourceErrors=1, published=0 -> red (F-08)
  assert.equal(v({ attempted: 0, published: 0, failed: 0, sourceErrors: 1 }).red, true, 'an unreadable source with nothing published must be red');

  // attempted=2, published=0, failed=0, skipped=2 -> stall
  const stall = v({ attempted: 2, published: 0, failed: 0, skipped: 2 });
  assert.equal(stall.stall, true, 'everything skipped and nothing published is a stall');
  assert.equal(stall.red, false, 'a stall is not a failure');
});

test('classifyCycle: the consecutive-failure streak only trips at the threshold', () => {
  const s = { attempted: 1, published: 0, failed: 1 };
  assert.equal(
    classifyCycle(s, 2, { maxConsecutiveCycleFailures: 3 }).reasons.includes('consecutive-failures'),
    false,
    'the streak must not trip before the threshold'
  );
  assert.equal(
    classifyCycle(s, 3, { maxConsecutiveCycleFailures: 3 }).reasons.includes('consecutive-failures'),
    true,
    'the streak must trip at the threshold'
  );
  // The threshold is injectable (F-24).
  assert.equal(
    classifyCycle(s, 2, { maxConsecutiveCycleFailures: 2 }).reasons.includes('consecutive-failures'),
    true,
    'an injected threshold must be honoured'
  );
  assert.equal(
    classifyCycle(s, 1, { maxConsecutiveCycleFailures: 2 }).reasons.includes('consecutive-failures'),
    false,
    'an injected threshold must not trip early'
  );
});

test('runLoop: the failure streak increments on red and resets on idle/warn', async () => {
  const { result } = await runWithOutcomes([RED, RED, GREEN, GREEN]);
  assert.equal(result.cycles, 4, 'the virtual window must run exactly 4 cycles');
  assert.equal(result.consecutiveFailedCycles, 0, 'a green cycle must reset the failure streak');
});

test('runLoop: a typed fatal is rethrown, not swallowed as a cycle error', async () => {
  const fatal = new Error('no source channels');
  fatal.isFatal = true;
  fatal.fatalCode = 'CHANNELS_ZERO';

  const clock = virtualClock();
  let cycles = 0;
  await assert.rejects(
    runLoop({
      windowMs: WINDOW_MS,
      cycleBudgetMs: CYCLE_BUDGET_MS,
      checkIntervalMs: 60 * 1000,
      check: async () => { cycles++; clock.tick(CYCLE_MS); throw fatal; },
      now: clock.now,
      sleep: clock.sleep,
      log: () => {}
    }),
    (err) => {
      assert.equal(err, fatal, 'the very same fatal error must be rethrown');
      assert.equal(err.isFatal, true);
      assert.equal(err.fatalCode, 'CHANNELS_ZERO');
      return true;
    }
  );
  assert.equal(cycles, 1, 'a fatal must abort the window immediately');
});

test('runLoop: a red cycle does NOT abort the window — the remaining cycles run and the window ends red', async () => {
  const { result, logs } = await runWithOutcomes([GREEN, RED, GREEN, GREEN]);
  assert.equal(result.cycles, 4, 'the window must keep cycling after a red cycle');
  assert.ok(logs.some(l => l.includes('🔴 cycle red:')), 'the red cycle must be reported');
  assert.equal(result.red, true, 'the window must still end red');
  assert.ok(logs.some(l => l.includes('🔴 window red:')), 'the window red line must be printed');
});

test('runLoop: a window with only warnings (1-2 failures next to successes) stays green', async () => {
  const warn = { attempted: 2, published: 1, failed: 1, deferred: 0, skipped: 0, sourceErrors: 0 };
  const { result } = await runWithOutcomes([warn, GREEN, GREEN, GREEN]);
  assert.equal(result.red, false, 'a warning cycle must not fail the window');
});

test('runLoop: syncFailed is reported and does not by itself make the cycle red', async () => {
  const summary = { attempted: 0, published: 0, failed: 0, deferred: 0, skipped: 0, sourceErrors: 0, syncFailed: true };
  const { result, logs } = await runWithOutcomes([summary, summary, summary, summary]);
  assert.equal(result.lastSummary.syncFailed, true, 'syncFailed must be part of the summary');
  assert.equal(result.red, false, 'syncFailed alone must not make the window red');
  assert.ok(logs.some(l => l.includes('sync failed')), 'the failed sync must be visible');
});

test('resolveMaxConsecutiveCycleFailures: an invalid value is clamped to 3 with a warning (F13)', () => {
  for (const bad of ['0', 'abc', '-1', '2.5']) {
    const warnings = [];
    const value = resolveMaxConsecutiveCycleFailures({
      env: { MAX_CONSECUTIVE_CYCLE_FAILURES: bad },
      warn: (m) => warnings.push(String(m))
    });
    assert.equal(value, 3, `MAX_CONSECUTIVE_CYCLE_FAILURES=${bad} must fall back to 3`);
    assert.equal(warnings.length, 1, `a warning must be emitted for ${bad}`);
    assert.match(warnings[0], /MAX_CONSECUTIVE_CYCLE_FAILURES/);
  }
  // A valid value is honoured.
  assert.equal(resolveMaxConsecutiveCycleFailures({ env: { MAX_CONSECUTIVE_CYCLE_FAILURES: '5' }, warn: () => {} }), 5);
  // The default is 3.
  assert.equal(resolveMaxConsecutiveCycleFailures({ env: {}, warn: () => {} }), 3);
});

test('runLoop: an invalid MAX_CONSECUTIVE_CYCLE_FAILURES never disables the red line (F13)', async () => {
  const { result } = await runWithOutcomes([RED, RED, RED, RED], { env: { MAX_CONSECUTIVE_CYCLE_FAILURES: '0' } });
  assert.equal(result.red, true, 'the red line must stay enabled');
});

test('runLoop: the cycle summary line carries every counter', async () => {
  const summary = { attempted: 3, published: 1, failed: 1, deferred: 1, skipped: 2, sourceErrors: 1 };
  const { logs } = await runWithOutcomes([summary, summary, summary, summary]);
  assert.ok(
    logs.some(l => l.includes('📊 cycle summary: attempted=3 published=1 failed=1 deferred=1 skipped=2 sourceErrors=1')),
    `the pinned summary line is missing: ${JSON.stringify(logs)}`
  );
});

// ===========================================================================
// FIX ROUND 1 — M-01 / M-02 / M-05 / M-07 / M-09 / M-10
// ===========================================================================

test('feed-monitor: a non-fatal error returns a FAILED summary, never null (M-01)', async () => {
  const summary = await checkNewReleases(null, {
    check: async () => { throw new Error('source unreachable'); },
  });
  assert.ok(summary, 'the summary must not be null');
  assert.ok(summary.failed >= 1, `a failed check must be a failed cycle: ${JSON.stringify(summary)}`);
  assert.equal(summary.published, 0);
  assert.equal(summary.attempted, 0);
  const verdict = classifyCycle(summary);
  assert.equal(verdict.status, 'red', 'a failed check must never be idle');
  assert.equal(verdict.red, true);
});

test('feed-monitor: a typed fatal is rethrown, never turned into a failed summary (M-01)', async () => {
  const fatal = new Error('no session');
  fatal.isFatal = true;
  fatal.fatalCode = 'AUTH_SESSION_CONFIG';
  await assert.rejects(
    checkNewReleases(null, { check: async () => { throw fatal; } }),
    (err) => { assert.equal(err, fatal, 'the very same fatal must be rethrown'); return true; }
  );
});

test('runLoop: a missing or malformed cycle summary is a FAILED cycle, never an idle one (M-02)', async () => {
  for (const bad of [null, undefined, {}, 'nonsense', 42, []]) {
    const { result, logs } = await runWithOutcomes([bad]);
    assert.equal(result.red, true, `a summary that was never reported (${JSON.stringify(bad)}) must end the window red`);
    assert.ok(
      logs.some(l => l.includes('📊 cycle summary: attempted=0 published=0 failed=1')),
      `the failed cycle must be visible in the summary line: ${JSON.stringify(logs)}`
    );
    assert.ok(logs.some(l => l.includes('🔴 cycle red:')), 'the failed cycle must be red');
    assert.ok(result.consecutiveFailedCycles >= 1, 'the failure streak must grow');
  }
});

test('runLoop: a genuine idle cycle (attempted === 0) is still idle, not failed (M-02)', async () => {
  const idle = { attempted: 0, published: 0, failed: 0, deferred: 0, skipped: 0, sourceErrors: 0 };
  const { result } = await runWithOutcomes([idle]);
  assert.equal(result.red, false, 'a check that ran and found nothing must stay green');
  assert.equal(result.consecutiveFailedCycles, 0, 'an idle cycle must not count as a failure');
});

test('runLoop: a check that throws a non-fatal error is a failed cycle, not a silent idle', async () => {
  const clock = virtualClock();
  const logs = [];
  const result = await runLoop({
    windowMs: WINDOW_MS,
    cycleBudgetMs: CYCLE_BUDGET_MS,
    checkIntervalMs: 60 * 1000,
    check: async () => { clock.tick(CYCLE_MS); throw new Error('boom'); },
    now: clock.now,
    sleep: clock.sleep,
    onCycleError: async () => {},
    log: (m) => logs.push(String(m)),
  });
  assert.equal(result.red, true, 'a thrown error must not end the window green');
  assert.ok(
    logs.some(l => l.includes('📊 cycle summary: attempted=0 published=0 failed=1')),
    `the failed cycle must be visible in the summary line: ${JSON.stringify(logs)}`
  );
  assert.ok(logs.some(l => l.includes('🔴 cycle red:')), 'the failed cycle must be red');
  assert.ok(result.consecutiveFailedCycles >= 1, 'the failure streak must grow');
});

test('runLoop: the window red reason carries the per-cycle cause (M-09)', async () => {
  const { logs } = await runWithOutcomes([GREEN, RED, GREEN, GREEN]);
  const redLine = logs.find(l => l.includes('🔴 window red:'));
  assert.ok(redLine, 'the window red line must be printed');
  assert.ok(redLine.includes('cycle-red['), `the per-cycle cause must travel with the window verdict: ${redLine}`);
  assert.ok(
    redLine.includes('attempted>0 && published==0 && failed>0'),
    `the actual cause must be visible, not a generic label: ${redLine}`
  );
});

test('runLoop: the missing tools are printed next to the counters (M-07)', async () => {
  const { logs } = await runWithOutcomes([GREEN, GREEN, GREEN, GREEN], { env: { TOOLS_MISSING: 'aria2c,mkvextract' } });
  assert.ok(
    logs.some(l => l.includes('⚠️ tools missing: aria2c,mkvextract')),
    `the missing tools must be visible in the window summary: ${JSON.stringify(logs)}`
  );
});

test('runLoop: nothing is printed about tools when none are missing (M-07)', async () => {
  const { logs } = await runWithOutcomes([GREEN, GREEN, GREEN, GREEN], { env: {} });
  assert.equal(logs.some(l => l.includes('tools missing')), false, 'no tool warning without missing tools');
});

test('the fatal code is logged exactly once, at the runner boundary (M-05)', async () => {
  const logs = [];
  const fatal = new Error('no source channels');
  fatal.isFatal = true;
  fatal.fatalCode = 'CHANNELS_ZERO';

  const clock = virtualClock();
  await assert.rejects(runLoop({
    windowMs: WINDOW_MS,
    cycleBudgetMs: CYCLE_BUDGET_MS,
    checkIntervalMs: 60 * 1000,
    check: async () => { clock.tick(CYCLE_MS); throw fatal; },
    now: clock.now,
    sleep: clock.sleep,
    log: (m) => logs.push(String(m)),
  }));

  const fatalLines = logs.filter(l => l.includes('🔴 fatal:'));
  assert.equal(fatalLines.length, 1, `the fatal code must be logged exactly once: ${JSON.stringify(logs)}`);
  assert.ok(fatalLines[0].includes('CHANNELS_ZERO'), 'the logged line must carry the fatal code');
});

test('single-pass mode: a red pass prints the red verdict and sets a non-zero exit code (M-10)', async () => {
  const logs = [];
  let exitCode = null;
  const result = await runSinglePass({
    check: async () => ({ attempted: 1, published: 0, failed: 1, deferred: 0, skipped: 0, sourceErrors: 0 }),
    log: (m) => logs.push(String(m)),
    env: {},
    setExitCode: (code) => { exitCode = code; },
  });
  assert.equal(result.verdict.red, true, 'the one-shot pass must classify the cycle');
  assert.equal(exitCode, 1, 'a red pass must set a non-zero exit code');
  assert.ok(logs.some(l => l.includes('📊 cycle summary:')), 'the pass must print the summary line');
  assert.ok(logs.some(l => l.includes('🔴 cycle red:')), 'the pass must print the red verdict');
});

test('single-pass mode: a green pass stays green and sets no exit code (M-10)', async () => {
  const logs = [];
  let exitCode = null;
  const result = await runSinglePass({
    check: async () => ({ attempted: 1, published: 1, failed: 0, deferred: 0, skipped: 0, sourceErrors: 0 }),
    log: (m) => logs.push(String(m)),
    env: {},
    setExitCode: (code) => { exitCode = code; },
  });
  assert.equal(result.verdict.red, false);
  assert.equal(exitCode, null, 'a green pass must not fail the run');
  assert.ok(logs.some(l => l.includes('🟢 cycle green')), 'the pass must print the green verdict');
});

test('single-pass mode: a missing summary is a failed pass, not a green one (M-02 + M-10)', async () => {
  const logs = [];
  let exitCode = null;
  await runSinglePass({
    check: async () => null,
    log: (m) => logs.push(String(m)),
    env: {},
    setExitCode: (code) => { exitCode = code; },
  });
  assert.equal(exitCode, 1, 'a pass that never reported must fail the run');
  assert.ok(logs.some(l => l.includes('🔴 cycle red:')), 'the pass must print the red verdict');
});

// ===========================================================================
// FIX ROUND 2 — P-5: one apt transaction first, per-package fallback
// ===========================================================================

test('P-5: the install step tries one apt transaction first and keeps the per-package fallback', () => {
  const wf = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'bot-monitor.yml'), 'utf8');
  assert.ok(
    wf.includes('if ! sudo apt-get install -y --no-install-recommends mkvtoolnix aria2 megatools zip p7zip-full unrar; then'),
    'the six multimedia packages must be installed in ONE apt transaction first'
  );
  assert.ok(wf.includes('for pkg in mkvtoolnix aria2 megatools zip p7zip-full unrar; do'), 'the per-package fallback loop must remain as the safety net');
  assert.ok(wf.includes('::warning::failed to install $pkg'), 'the fallback must warn and continue with the remaining packages');
});

// ===========================================================================
// FIX ROUND 3 — F-3 / F-4 / F-6 / F-7 / F-8 / F-9 / F-10 / F-11
// ===========================================================================

test('F-4: the per-cycle failure floor is FIXED at 3, independent of the streak threshold', () => {
  const v = classifyCycle({ attempted: 8, published: 5, failed: 3 }, 0, { maxConsecutiveCycleFailures: 5 });
  assert.equal(v.red, true, 'failed=3 next to 5 publications must be red even with a threshold of 5');
  assert.ok(v.reasons.includes('failed-threshold'), JSON.stringify(v.reasons));
  // The streak threshold itself stays configurable.
  const warn = classifyCycle({ attempted: 8, published: 8, failed: 2 }, 0, { maxConsecutiveCycleFailures: 5 });
  assert.equal(warn.red, false, 'two failures next to eight successes stay a warning');
  assert.equal(warn.status, 'warn');
  // The floor is not raised by a bigger threshold either.
  const still = classifyCycle({ attempted: 8, published: 5, failed: 3 }, 0, { maxConsecutiveCycleFailures: 9 });
  assert.equal(still.red, true, 'the floor does not follow the threshold');
});

test('F-6: a partially malformed summary is a failed cycle, never an idle one', () => {
  const bad = classifyCycle({ attempted: 0, published: 'x', failed: 'y' }, 0, { maxConsecutiveCycleFailures: 3 });
  assert.equal(bad.red, true, `a malformed counter must never be idle: ${JSON.stringify(bad)}`);
  assert.equal(bad.status, 'red');
  assert.equal(bad.summary.failed, 1, 'a malformed summary is a failed cycle (failed: 1)');
  // A genuinely idle cycle (all counters valid, nothing attempted) is still idle.
  const idle = classifyCycle({ attempted: 0, published: 0, failed: 0 }, 0, { maxConsecutiveCycleFailures: 3 });
  assert.equal(idle.status, 'idle');
  assert.equal(idle.red, false);
  // A negative counter is malformed as well: it is a failed cycle and it is
  // never idle (the colour follows the owner policy).
  const negative = classifyCycle({ attempted: 2, published: 2, failed: -1 }, 0, { maxConsecutiveCycleFailures: 3 });
  assert.notEqual(negative.status, 'idle', 'a negative counter must never be idle');
  assert.equal(negative.summary.failed, 1, 'a malformed summary is a failed cycle (failed: 1)');
});

test('F-9: a stall between two red cycles preserves the failure streak', () => {
  const STALL = { attempted: 2, published: 0, failed: 0, deferred: 0, skipped: 2, sourceErrors: 0 };
  const first = classifyCycle(RED, 0, { maxConsecutiveCycleFailures: 3 });
  assert.equal(first.nextStreak, 1);
  const stall = classifyCycle(STALL, first.nextStreak, { maxConsecutiveCycleFailures: 3 });
  assert.equal(stall.stall, true, 'a deferral/skip only cycle is a stall');
  assert.equal(stall.nextStreak, 1, 'a stall must neither increment nor reset the streak');
  const second = classifyCycle(RED, stall.nextStreak, { maxConsecutiveCycleFailures: 3 });
  assert.equal(second.nextStreak, 2, 'the streak must survive the stall');
});

test('F-9: the runner keeps the streak across a stall (red -> stall -> red)', async () => {
  const STALL = { attempted: 2, published: 0, failed: 0, deferred: 0, skipped: 2, sourceErrors: 0 };
  const clock = virtualClock();
  const outcomes = [RED, STALL, RED];
  let i = 0;
  // A 20 minute window with a 6 minute budget runs exactly three cycles.
  const result = await runLoop({
    windowMs: 20 * 60 * 1000,
    cycleBudgetMs: CYCLE_BUDGET_MS,
    checkIntervalMs: 60 * 1000,
    check: async () => { clock.tick(CYCLE_MS); return outcomes[Math.min(i++, outcomes.length - 1)]; },
    now: clock.now,
    sleep: clock.sleep,
    log: () => {},
  });
  assert.equal(result.cycles, 3, `the window must run exactly three cycles, got ${result.cycles}`);
  assert.equal(result.consecutiveFailedCycles, 2, `the streak must be 2 (the stall must not reset it), got ${result.consecutiveFailedCycles}`);
});

test('F-8: a check() that rejects AFTER the cycle timeout does not crash the process and is logged', async () => {
  const logs = [];
  let rejectLate = null;
  const clock = virtualClock();
  const result = await runLoop({
    windowMs: WINDOW_MS,
    cycleBudgetMs: CYCLE_BUDGET_MS,
    checkIntervalMs: 60 * 1000,
    cycleTimeoutMs: 20,
    check: async () => {
      clock.tick(CYCLE_MS);
      await new Promise((_, rej) => { rejectLate = rej; });
    },
    now: clock.now,
    sleep: clock.sleep,
    log: (m) => logs.push(String(m)),
  });
  assert.ok(result.timeouts >= 1, 'the cycle must have timed out');
  // The rejection arrives AFTER the timeout won the race: it must be handled
  // (an unhandled rejection would crash the test process).
  rejectLate(new Error('late boom'));
  await new Promise(r => setTimeout(r, 50));
  assert.ok(
    logs.some(l => l.includes('late cycle error after the timeout')),
    `the late rejection must be logged: ${JSON.stringify(logs)}`
  );
});

test('F-8: a late typed FATAL is surfaced as a fatal instead of vanishing', async () => {
  const logs = [];
  let rejectLate = null;
  const clock = virtualClock();
  await runLoop({
    windowMs: WINDOW_MS,
    cycleBudgetMs: CYCLE_BUDGET_MS,
    checkIntervalMs: 60 * 1000,
    cycleTimeoutMs: 20,
    check: async () => {
      clock.tick(CYCLE_MS);
      await new Promise((_, rej) => { rejectLate = rej; });
    },
    now: clock.now,
    sleep: clock.sleep,
    log: (m) => logs.push(String(m)),
  });
  const fatal = new Error('no channels');
  fatal.isFatal = true;
  fatal.fatalCode = 'CHANNELS_ZERO';
  rejectLate(fatal);
  await new Promise(r => setTimeout(r, 50));
  assert.ok(
    logs.some(l => l.includes('🔴 fatal (after the cycle timeout): CHANNELS_ZERO')),
    `the late fatal must be surfaced: ${JSON.stringify(logs)}`
  );
});

test('F-11: the runner surfaces the counters of a typed fatal (err.summary)', async () => {
  const logs = [];
  const fatal = new Error('no channels');
  fatal.isFatal = true;
  fatal.fatalCode = 'CHANNELS_ZERO';
  fatal.summary = { attempted: 3, published: 1, failed: 2, deferred: 0, skipped: 0, sourceErrors: 0 };
  const clock = virtualClock();
  await assert.rejects(runLoop({
    windowMs: WINDOW_MS,
    cycleBudgetMs: CYCLE_BUDGET_MS,
    checkIntervalMs: 60 * 1000,
    check: async () => { clock.tick(CYCLE_MS); throw fatal; },
    now: clock.now,
    sleep: clock.sleep,
    log: (m) => logs.push(String(m)),
  }));
  assert.ok(
    logs.some(l => l.includes('📊 cycle summary: attempted=3 published=1 failed=2')),
    `the fatal's counters must be visible: ${JSON.stringify(logs)}`
  );
  // The fatal code is still logged exactly once.
  assert.equal(logs.filter(l => l.includes('🔴 fatal:')).length, 1, JSON.stringify(logs));
});

test('F-3: the entry point classifies the cycle summary and fails the run on a red verdict', async () => {
  const logs = [];
  let exitCode = null;
  const result = await runCheckCycle({
    check: async () => ({ attempted: 1, published: 0, failed: 1, deferred: 0, skipped: 0, sourceErrors: 0 }),
    log: (m) => logs.push(String(m)),
    setExitCode: (code) => { exitCode = code; },
  });
  assert.equal(result.verdict.red, true, 'the 24/7 path must classify the cycle like the Actions path');
  assert.equal(exitCode, 1, 'a red verdict must set a non-zero exit code');
  assert.ok(logs.some(l => l.includes('📊 cycle summary:')), 'the summary line must be printed');
  assert.ok(logs.some(l => l.includes('🔴 cycle red:')), 'the red verdict must be printed');
});

test('F-3: the entry point never swallows a typed fatal', async () => {
  const fatal = new Error('no session');
  fatal.isFatal = true;
  fatal.fatalCode = 'AUTH_SESSION_CONFIG';
  await assert.rejects(
    runCheckCycle({ check: async () => { throw fatal; } }),
    (err) => { assert.equal(err, fatal, 'the very same fatal must propagate'); return true; }
  );
});

test('F-3: the entry point prints the green verdict for a healthy cycle', () => {
  const logs = [];
  const verdict = reportCycleVerdict({ attempted: 1, published: 1, failed: 0, deferred: 0, skipped: 0, sourceErrors: 0 }, { log: (m) => logs.push(String(m)) });
  assert.equal(verdict.red, false);
  assert.ok(logs.some(l => l.includes('🟢 cycle green')), JSON.stringify(logs));
});

test('F-7/F-10: a fatal fails the run from the LIBRARY path and the entry never calls process.exit()', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-exit-'));
  try {
    // No TELEGRAM_SESSION (and no .env / SESSION_STRING.txt in the temp cwd)
    // -> the pre-flight throws a typed fatal.
    const code = `
const m = await import(${JSON.stringify(RUNNER_URL)});
try { await m.runContinuousMonitor(); console.log('NO_THROW'); }
catch (e) { console.log('THROWN=' + (e && e.fatalCode)); }
console.log('EXITCODE=' + process.exitCode);
`;
    const res = runSnippet(code, { cwd: dir, env: { ...process.env, TELEGRAM_SESSION: '' } });
    assert.equal(res.status, 1, `the library path must fail the process: ${res.stderr}`);
    assert.match(res.stdout, /THROWN=AUTH_SESSION_CONFIG/, res.stdout);
    assert.match(res.stdout, /EXITCODE=1/, `the library path must set the exit code: ${res.stdout}`);
    assert.equal((res.stderr.match(/🔴 fatal:/g) || []).length, 1, `the fatal must be logged once: ${res.stderr}`);

    // F-10: `process.exit()` truncates the pending stdout writes when stdout
    // is a pipe (GitHub Actions) — the final verdict line would be lost.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'action-runner.mjs'), 'utf8');
    const withoutComments = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    assert.equal(/process\.exit\(/.test(withoutComments), false, 'the runner must never call process.exit()');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


