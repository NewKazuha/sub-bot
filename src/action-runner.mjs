import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNewReleases } from './feed-monitor.mjs';
import { createPersistentClient, createFatalError } from './telegram-client.mjs';
import { CONFIG } from './config.mjs';
import { closeBrowser } from './browser-fetch.mjs';

// Duration to keep the action worker alive checking continuously
const RUN_DURATION_MINUTES = parseInt(process.env.RUN_DURATION_MINUTES || '25', 10);
const CHECK_INTERVAL_SECONDS = parseInt(process.env.CHECK_INTERVAL_SECONDS || '60', 10);

// ---------------------------------------------------------------------------
// P0-3 success contract (F-03 / F-08 / F-13 / F-15)
// The classification is a PURE, exported function so the tests can assert on
// it without ever killing the runner process.
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_CONSECUTIVE_CYCLE_FAILURES = 3;

/**
 * The per-cycle failure floor (F-04).
 * It is FIXED at 3 and deliberately NOT bound to the configurable streak
 * threshold: with the threshold set to 5, `failed=3, published=5` was
 * silently green — the hole the reviewer found. The streak threshold stays
 * configurable; this floor does not move with it.
 */
export const FAILED_CYCLE_FLOOR = 3;

/**
 * Resolve the consecutive-failure threshold.
 * The value is injectable (runLoop option) and defaults to the env var.
 * An invalid value NEVER disables the red line: it falls back to 3 with a
 * warning (F13).
 */
export function resolveMaxConsecutiveCycleFailures({ value, env = process.env, warn = (m) => console.warn(m) } = {}) {
  const injected = value !== undefined && value !== null && value !== '';
  const raw = injected ? value : (env && env.MAX_CONSECUTIVE_CYCLE_FAILURES);
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_MAX_CONSECUTIVE_CYCLE_FAILURES;
  }
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    warn(`⚠️ invalid MAX_CONSECUTIVE_CYCLE_FAILURES (${raw}) — falling back to ${DEFAULT_MAX_CONSECUTIVE_CYCLE_FAILURES}`);
    return DEFAULT_MAX_CONSECUTIVE_CYCLE_FAILURES;
  }
  return n;
}

/**
 * The counters of a cycle summary. Every one of them is validated
 * INDIVIDUALLY (F-06): a single malformed counter makes the whole summary
 * malformed — a malformed summary is a FAILED cycle, never an idle one.
 */
export const SUMMARY_COUNTERS = ['attempted', 'published', 'failed', 'deferred', 'skipped', 'sourceErrors'];

/**
 * Did the check ACTUALLY report a summary?
 * A missing / malformed summary means "the check did not report" — it must
 * never be normalised into an idle cycle (M-02). Only a summary that is
 * genuinely present with `attempted === 0` is idle.
 */
function summaryReported(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return false;
  return SUMMARY_COUNTERS.some(k => {
    if (!(k in summary)) return false;
    const v = summary[k];
    if (v === null || v === undefined) return false;
    return Number.isFinite(Number(v));
  });
}

/**
 * Why is this counter value unusable? (null = usable)
 * An ABSENT counter is 0 (usable); a present-but-broken counter is not.
 */
export function counterProblem(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return 'not-a-number';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'not-finite';
  if (n < 0) return 'negative';
  return null;
}

/**
 * Is this summary MALFORMED (F-06)?
 * A summary that was never reported, or one that carries a non-finite /
 * negative / non-numeric counter, is malformed: it must be classified as a
 * failed cycle and never as an idle one.
 */
export function isMalformedSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return true;
  if (!summaryReported(summary)) return true;
  return SUMMARY_COUNTERS.some(k => counterProblem(summary[k]) !== null);
}

/**
 * Normalize a cycle summary into the full counter shape.
 * A missing or malformed summary is a FAILED cycle (`failed: 1`), never an
 * idle one — the difference between "the check ran and found nothing" and
 * "the check did not report" (M-02).
 */
export function normalizeSummary(summary) {
  const reported = summaryReported(summary);
  const s = reported ? summary : {};
  // F-06: every counter is validated on its own. One broken counter (e.g.
  // `published: 'x'`) makes the summary malformed — it must not be coerced
  // to 0 and then classified as an idle cycle.
  const malformed = isMalformedSummary(summary);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    attempted: num(s.attempted),
    published: num(s.published),
    failed: malformed ? 1 : num(s.failed),
    deferred: num(s.deferred),
    skipped: num(s.skipped),
    sourceErrors: num(s.sourceErrors),
    syncFailed: s.syncFailed === true,
  };
}

/**
 * A human-readable description of every red predicate. The window verdict
 * carries these so the operator sees the ACTUAL cause instead of a generic
 * label (M-09).
 */
export const RED_REASON_DESCRIPTIONS = {
  'source-errors': 'a source could not be read',
  'no-publish-with-failures': 'attempted>0 && published==0 && failed>0',
  'failed-exceeds-published': 'failed>published',
  'failed-threshold': `failed>=${FAILED_CYCLE_FLOOR} (fixed floor)`,
  'consecutive-failures': 'consecutive failed cycles>=max',
};

function describeReason(reason) {
  return RED_REASON_DESCRIPTIONS[reason] || reason;
}

/** The tools that the workflow found missing (M-07). */
function toolsMissingLine(env) {
  const missing = String((env && env.TOOLS_MISSING) || '').trim();
  return missing ? `⚠️ tools missing: ${missing}` : null;
}

/**
 * Classify a cycle (or a whole window — the same predicates apply to the
 * aggregate counters of the window).
 *
 * status:
 *   'red'   — a failure predicate held (the window ends non-zero)
 *   'stall' — everything attempted was skipped or deferred and nothing was
 *             published (a silent false success). A stall is NOT a failure:
 *             it does not count toward the consecutive-failure streak, and it
 *             does NOT redden the window either - "nothing new was published"
 *             is the normal state of a bot that polls every 60 s, and
 *             reddening it turned every quiet window into a failed run and an
 *             admin page. It stays loud in the log (a warning). F-09: it also
 *             does not RESET the streak - it is preserved.
 *   'idle'  — nothing was attempted
 *   'warn'  — 1..n failures next to successes (never fails)
 *   'green' — everything fine
 */
export function classifyCycle(summary, streak = 0, options = {}) {
  const max = Number.isInteger(options.maxConsecutiveCycleFailures) && options.maxConsecutiveCycleFailures >= 1
    ? options.maxConsecutiveCycleFailures
    : DEFAULT_MAX_CONSECUTIVE_CYCLE_FAILURES;
  const s = normalizeSummary(summary);
  // F-06: a malformed summary is never an idle cycle.
  const malformed = isMalformedSummary(summary);
  const reasons = [];
  let red = false;
  let stall = false;

  // --- failure predicates (evaluated at the end of the window) ---
  // A source that could not be read and nothing published.
  if (s.sourceErrors > 0 && s.published === 0) { reasons.push('source-errors'); red = true; }
  // Candidates were attempted, all of them failed and nothing was published.
  if (s.attempted > 0 && s.published === 0 && s.failed > 0) { reasons.push('no-publish-with-failures'); red = true; }
  // Owner policy: failed > succeeded.
  if (s.failed > s.published) { reasons.push('failed-exceeds-published'); red = true; }
  // F-04: the per-cycle floor is FIXED at 3 — it does not follow the
  // configurable streak threshold (`failed=3, published=5` must stay red
  // even when the threshold is 5).
  if (s.failed >= FAILED_CYCLE_FLOOR) { reasons.push('failed-threshold'); red = true; }
  // The consecutive-failure streak.
  if (streak >= max) { reasons.push('consecutive-failures'); red = true; }

  let status;
  if (red) {
    status = 'red';
  } else if (s.attempted === 0 && !malformed) {
    status = 'idle';
  } else if (s.attempted > 0 && s.published === 0 && s.failed === 0 && (s.skipped >= s.attempted || s.deferred > 0)) {
    stall = true;
    status = 'stall';
  } else if (s.failed > 0) {
    status = 'warn';
  } else {
    status = 'green';
  }

  return {
    status,
    red,
    stall,
    // Only a FAILURE counts toward the consecutive-failure streak: a deferral
    // is not a failure, and an idle/warning cycle resets the streak.
    failedCycle: red,
    // F-09: a STALL neither increments nor RESETS the streak — a deferral
    // only cycle between two red cycles must not wipe the streak.
    nextStreak: stall ? streak : (red ? streak + 1 : 0),
    reasons,
    maxConsecutiveCycleFailures: max,
    summary: s,
  };
}

/**
 * Core monitoring loop engine with injectable clock and sleep for deterministic testing.
 */
async function executeCycle(check, timeoutMs, log = console.log) {
  if (!timeoutMs || timeoutMs <= 0) {
    return await check();
  }

  let timerId;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      const err = new Error('cycle timeout');
      err.isCycleTimeout = true;
      reject(err);
    }, timeoutMs);
  });

  // F-08: the check promise outlives the timeout when the timeout wins the
  // race. Its rejection is handled HERE so it can never become an unhandled
  // rejection (Node's default would crash the process) — and a late typed
  // FATAL is surfaced instead of vanishing (it can no longer abort the
  // window, but it must not be lost).
  const checkPromise = (async () => check())();
  checkPromise.catch((err) => {
    if (err && err.isFatal === true) {
      log(`🔴 fatal (after the cycle timeout): ${err.fatalCode || 'UNKNOWN'}`);
    } else {
      log(`⚠️ late cycle error after the timeout: ${err && err.message ? err.message : err}`);
    }
  });

  try {
    return await Promise.race([checkPromise, timeoutPromise]);
  } finally {
    clearTimeout(timerId);
  }
}

/** A cycle that produced nothing at all (timeout / escaped exception). */
function failedCycleSummary() {
  return { attempted: 0, published: 0, failed: 1, deferred: 0, skipped: 0, sourceErrors: 0, syncFailed: false };
}

/**
 * Core monitoring loop engine with injectable clock and sleep for deterministic testing.
 */
export async function runLoop({
  windowMs,
  cycleBudgetMs = 0,
  cycleTimeoutMs = 10 * 60 * 1000,
  checkIntervalMs = 60 * 1000,
  check,
  now = () => Date.now(),
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
  onCycleError = null,
  onCycleTimeout = null,
  log = console.log,
  maxConsecutiveCycleFailures,
  env = process.env,
} = {}) {
  const maxFailures = resolveMaxConsecutiveCycleFailures({
    value: maxConsecutiveCycleFailures,
    env,
    warn: (m) => log(m),
  });

  const startTime = now();
  const endTime = startTime + windowMs;

  let cycle = 1;
  let timeouts = 0;
  let consecutiveFailedCycles = 0;
  let lastSummary = null;
  let fatal = null;
  let anyCycleRed = false;
  // The per-cycle red causes travel with the window verdict (M-09).
  const cycleRedReasons = [];
  const aggregate = {
    attempted: 0, published: 0, failed: 0, deferred: 0, skipped: 0, sourceErrors: 0, syncFailed: false,
  };

  while (now() + cycleBudgetMs <= endTime) {
    log(`\n🔄 [Cycle #${cycle} - ${new Date(now()).toISOString()}]`);
    let cycleSummary = null;
    try {
      cycleSummary = await executeCycle(check, cycleTimeoutMs, log);
    } catch (err) {
      // A typed fatal must NOT be demoted to an ordinary cycle error: it has
      // to abort the window (F-03).
      if (err && err.isFatal === true) {
        fatal = err;
        // The fatal code is logged ONCE, here at the runner boundary (M-05):
        // the creator (createFatalError) never prints it.
        if (err.fatalLogged !== true) {
          err.fatalLogged = true;
          log(`🔴 fatal: ${err.fatalCode || 'UNKNOWN'}`);
        }
        // F-11: the fatal carries the summary of the cycle it aborted — its
        // counters must be visible, not swallowed with the error.
        if (err.summary) {
          const fs2 = normalizeSummary(err.summary);
          log(`📊 cycle summary: attempted=${fs2.attempted} published=${fs2.published} failed=${fs2.failed} deferred=${fs2.deferred} skipped=${fs2.skipped} sourceErrors=${fs2.sourceErrors}`);
        }
        throw err;
      }
      if (err.isCycleTimeout) {
        timeouts++;
        log(`⚠️ [Cycle #${cycle}] Cycle timed out after ${Math.round(cycleTimeoutMs / 1000)}s!`);
        // A timeout published nothing — it counts as a failed cycle.
        cycleSummary = failedCycleSummary();
        if (onCycleTimeout) {
          try {
            await onCycleTimeout(cycle);
          } catch (teardownErr) {
            log(`⚠️ [Cycle #${cycle}] Teardown error:`, teardownErr.message);
          }
        }
      } else {
        cycleSummary = failedCycleSummary();
        if (onCycleError) await onCycleError(cycle, err);
        else console.error(`Cycle #${cycle} error:`, err.message);
      }
    }

    const s = normalizeSummary(cycleSummary);
    lastSummary = s;
    aggregate.attempted += s.attempted;
    aggregate.published += s.published;
    aggregate.failed += s.failed;
    aggregate.deferred += s.deferred;
    aggregate.skipped += s.skipped;
    aggregate.sourceErrors += s.sourceErrors;
    aggregate.syncFailed = aggregate.syncFailed || s.syncFailed;

    // The RAW summary is classified (not the normalized one): the
    // malformation of a counter must survive the normalization (F-06) —
    // otherwise a broken summary would be normalized into an idle cycle.
    const verdict = classifyCycle(cycleSummary, consecutiveFailedCycles, { maxConsecutiveCycleFailures: maxFailures });
    consecutiveFailedCycles = verdict.nextStreak;
    if (verdict.red) anyCycleRed = true;

    log(`📊 cycle summary: attempted=${s.attempted} published=${s.published} failed=${s.failed} deferred=${s.deferred} skipped=${s.skipped} sourceErrors=${s.sourceErrors}`);
    if (s.syncFailed) {
      // The duplicate-safety net was off for this cycle — it must be visible,
      // never silent (F-08).
      log(`⚠️ target channel history sync failed — the duplicate-safety net was disabled for this cycle`);
    }
    if (verdict.stall) {
      // A stall is a WARNING, not a failure: with a healthy bot most windows
      // publish nothing new (every candidate was already posted), and turning
      // that into a red run turned every quiet window into a failure + an admin
      // page. It stays loud in the log so it is never invisible.
      log(`⚠️ stall: ${s.attempted} candidates attempted, none published (skipped=${s.skipped} deferred=${s.deferred})`);
    }
    if (verdict.red) {
      anyCycleRed = true;
      // The cause of THIS cycle is kept for the window verdict (M-09).
      cycleRedReasons.push(`cycle #${cycle}: ${verdict.reasons.map(describeReason).join(', ')}`);
      log(`🔴 cycle red: ${verdict.reasons.join(',')}`);
    }

    const timeLeft = endTime - now();
    if (timeLeft < cycleBudgetMs) {
      break;
    }

    log(`⏳ Sleeping ${Math.round(checkIntervalMs / 1000)}s until next check... (Remaining window: ${Math.round(timeLeft / 60000)}m)`);
    await sleep(checkIntervalMs);
    cycle++;
  }

  // The verdict is evaluated at the END of the window: a red cycle never
  // aborted the window (F-15) — only an immediate fatal does.
  const windowVerdict = classifyCycle(aggregate, consecutiveFailedCycles, { maxConsecutiveCycleFailures: maxFailures });
  // A STALL is not a failure (owner policy: red needs a real failure - failed>0,
  // the failure streak, failed>published, source errors with nothing published,
  // or an immediate fatal). "Nothing new was published" is the NORMAL state of a
  // bot that polls every 60 s: reddening it turned every quiet window into a
  // failed run and an admin page. The stall stays visible as a warning below.
  const red = windowVerdict.red || anyCycleRed;

  log(`📊 cycle summary: attempted=${aggregate.attempted} published=${aggregate.published} failed=${aggregate.failed} deferred=${aggregate.deferred} skipped=${aggregate.skipped} sourceErrors=${aggregate.sourceErrors}`);
  // A missing tool is the root cause of the deferrals: it has to be visible
  // next to the counters (M-07).
  const toolsMissing = toolsMissingLine(env);
  if (toolsMissing) log(toolsMissing);
  if (red) {
    const reasons = windowVerdict.reasons.length
      ? windowVerdict.reasons.slice()
      : [];
    // The per-cycle causes travel with the window verdict: a window that is
    // red because of an earlier red cycle must NOT degrade to a generic
    // 'cycle-red' label (M-09).
    if (anyCycleRed) reasons.push(`cycle-red[${cycleRedReasons.join('; ')}]`);
    if (reasons.length === 0) reasons.push('cycle-red');
    if (aggregate.syncFailed && !reasons.includes('sync-failed')) reasons.push('sync-failed');
    log(`🔴 window red: ${reasons.join(',')}`);
  } else {
    if (windowVerdict.stall) {
      log(`⚠️ window: nothing published this window (no new releases) - not a failure`);
    }
    log(`🟢 window green`);
  }

  log(`\n🏁 Continuous monitor window finished after ${cycle} cycles.\n`);
  return { cycles: cycle, elapsed: now() - startTime, timeouts, consecutiveFailedCycles, lastSummary, red, fatal };
}

/**
 * The one-shot pass (`RUN_DURATION_MINUTES <= 0`): ONE cycle, but with the
 * SAME verdict as the window path (M-10).
 *
 * A single pass that ignored its summary always finished green — a red pass
 * in one-shot mode was a silent green, and a manual one-shot run is exactly
 * how an operator diagnoses a fault. The verdict is computed with the same
 * thresholds and the same counters as the window path; the caller decides
 * what to do with the exit code (the runner applies it after the teardown).
 *
 * → { summary, verdict }
 */
export async function runSinglePass({
  check,
  log = console.log,
  env = process.env,
  setExitCode = null,
  maxConsecutiveCycleFailures,
} = {}) {
  const max = resolveMaxConsecutiveCycleFailures({
    value: maxConsecutiveCycleFailures,
    env,
    warn: (m) => log(m),
  });

  let summary;
  try {
    summary = await check();
  } catch (err) {
    // A typed fatal is logged at the runner boundary (M-05) and its counters
    // are surfaced (F-11) — but it is NEVER swallowed: it propagates.
    if (err && err.isFatal === true) {
      if (err.fatalLogged !== true) {
        err.fatalLogged = true;
        log(`🔴 fatal: ${err.fatalCode || 'UNKNOWN'}`);
      }
      if (err.summary) {
        const fs2 = normalizeSummary(err.summary);
        log(`📊 cycle summary: attempted=${fs2.attempted} published=${fs2.published} failed=${fs2.failed} deferred=${fs2.deferred} skipped=${fs2.skipped} sourceErrors=${fs2.sourceErrors}`);
      }
    }
    throw err;
  }
  const s = normalizeSummary(summary);
  // The RAW summary is classified (F-06): a malformed counter must not be
  // normalized away into an idle pass.
  const verdict = classifyCycle(summary, 0, { maxConsecutiveCycleFailures: max });

  log(`📊 cycle summary: attempted=${s.attempted} published=${s.published} failed=${s.failed} deferred=${s.deferred} skipped=${s.skipped} sourceErrors=${s.sourceErrors}`);
  const toolsMissing = toolsMissingLine(env);
  if (toolsMissing) log(toolsMissing);

  if (verdict.red) {
    log(`🔴 cycle red: ${verdict.reasons.join(',')}`);
  } else if (verdict.stall) {
    log(`⚠️ stall: ${s.attempted} candidates attempted, none published (skipped=${s.skipped} deferred=${s.deferred})`);
  } else {
    log(`🟢 cycle green`);
  }

  // A stall is a WARNING, not a failure - exactly like the window path, which
  // ends green for "nothing new was published".
  const failed = verdict.red;
  if (failed && typeof setExitCode === 'function') setExitCode(1);

  return { summary: s, verdict, failed };
}

export async function runContinuousMonitor() {
  try {
    return await runContinuousMonitorInner();
  } catch (e) {
    // F-07: the exit code of a fatal does NOT depend on the caller any more:
    // the library sets it itself (the entry point only reports the error).
    if (e && e.isFatal === true && e.fatalLogged !== true) {
      e.fatalLogged = true;
      console.error(`🔴 fatal: ${e.fatalCode || 'UNKNOWN'}`);
    }
    process.exitCode = 1;
    throw e;
  }
}

async function runContinuousMonitorInner() {
  console.log(`\n======================================================`);
  console.log(`🤖 Starting Anime Sub Auto-Poster (Continuous Loop)`);
  console.log(`⏱️ Window Duration: ${RUN_DURATION_MINUTES} minutes`);
  console.log(`⏰ Polling Interval: Every ${CHECK_INTERVAL_SECONDS} seconds`);
  console.log(`======================================================\n`);

  // Pre-flight: verify credentials (read from CONFIG after env/.env/session-file fallback).
  const session = CONFIG.TELEGRAM.SESSION;
  if (!session) {
    console.error('❌ TELEGRAM_SESSION is missing (checked env and SESSION_STRING.txt). Aborting.');
    throw createFatalError('AUTH_SESSION_CONFIG', 'TELEGRAM_SESSION is missing (checked env and SESSION_STRING.txt).');
  }
  if (!CONFIG.TELEGRAM.API_ID || !CONFIG.TELEGRAM.API_HASH) {
    console.error('❌ TELEGRAM_API_ID and TELEGRAM_API_HASH are required together with TELEGRAM_SESSION. Aborting.');
    throw createFatalError('AUTH_SESSION_CONFIG', 'TELEGRAM_API_ID and TELEGRAM_API_HASH are required together with TELEGRAM_SESSION.');
  }
  if (!CONFIG.TELEGRAM.TARGET_CHANNEL) {
    console.error('❌ TELEGRAM_TARGET_CHANNEL is missing. Aborting.');
    throw createFatalError('AUTH_SESSION_CONFIG', 'TELEGRAM_TARGET_CHANNEL is missing.');
  }

  // Create a single persistent Telegram client for the entire monitoring window.
  // This avoids the expensive connect/disconnect overhead on every cycle.
  const client = createPersistentClient();
  if (client) {
    console.log(`📡 Establishing persistent Telegram connection...`);
    await client.connect();
    console.log(`✅ Persistent connection established – reused across all cycles.\n`);
  }

  let windowResult = null;
  let passExitCode = null;
  let fatal = null;
  try {
    if (RUN_DURATION_MINUTES <= 0) {
      console.log('🔄 Running one monitor pass.');
      // The one-shot pass has the SAME verdict as the window path (M-10): a
      // red pass is never a silent green. The exit code is decided here but
      // applied AFTER the teardown (below).
      await runSinglePass({
        check: async () => {
          return await checkNewReleases(client);
        },
        log: console.log,
        env: process.env,
        setExitCode: (code) => { passExitCode = code; },
      });
      console.log('🏁 Monitor pass finished.');
    } else {
      const CYCLE_TIMEOUT_MS = parseInt(process.env.CYCLE_TIMEOUT_MS || String(10 * 60 * 1000), 10);
      const TEARDOWN_TIMEOUT_MS = 30 * 1000;

      const timeoutGuard = (promise, ms, desc) => Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${desc} timed out after ${ms / 1000}s`)), ms))
      ]);

      windowResult = await runLoop({
        windowMs: RUN_DURATION_MINUTES * 60 * 1000,
        cycleBudgetMs: 6 * 60 * 1000,
        cycleTimeoutMs: CYCLE_TIMEOUT_MS,
        checkIntervalMs: CHECK_INTERVAL_SECONDS * 1000,
        check: async () => {
          return await checkNewReleases(client);
        },
        onCycleTimeout: async (cycle) => {
          console.warn(`⚠️ [Cycle #${cycle}] Performing bounded teardown of occupied resources...`);
          // 1. Disconnect Telegram client (bounded by 30s)
          if (client) {
            try {
              await timeoutGuard(client.disconnect(), TEARDOWN_TIMEOUT_MS, 'client.disconnect');
              console.log('📡 Persistent Telegram client disconnected.');
            } catch (e) {
              console.warn('⚠️ Client disconnect failed/timed out:', e.message);
            }
          }
          // 2. Close headless browser (bounded by 30s)
          try {
            await timeoutGuard(closeBrowser(), TEARDOWN_TIMEOUT_MS, 'closeBrowser');
            console.log('🌐 Headless browser closed.');
          } catch (e) {
            console.warn('⚠️ Browser close failed/timed out:', e.message);
          }
          // 3. Reconnect Telegram client before next cycle
          if (client) {
            try {
              console.log('🔄 Reconnecting Telegram client...');
              await timeoutGuard(client.connect(), TEARDOWN_TIMEOUT_MS, 'client.connect');
              console.log('✅ Reconnected successfully.');
            } catch (reconErr) {
              console.error('❌ Reconnection failed:', reconErr.message);
            }
          }
        },
        onCycleError: async (cycle, err) => {
          console.error(`Cycle #${cycle} error:`, err.message);
          // If client disconnected mid-cycle, try to reconnect for next cycle
          if (client && !client.connected) {
            try {
              console.log('🔄 Reconnecting Telegram client...');
              await client.connect();
              console.log('✅ Reconnected successfully.');
            } catch (reconErr) {
              console.error('❌ Reconnection failed:', reconErr.message);
            }
          }
        }
      });
    }
  } catch (e) {
    // F-07: a typed fatal must fail the run even when the caller is a
    // library user and not the entry point. The exit code is set AFTER the
    // teardown (below) and the fatal is rethrown to the caller.
    fatal = e;
  } finally {
    if (client) {
      try { await client.disconnect(); } catch { }
      console.log('📡 Persistent Telegram connection closed.');
    }
    // Always release the shared headless browser, on success and on failure.
    try {
      await closeBrowser();
    } catch (e) {
      console.warn('⚠️ Failed to close the headless browser:', e.message);
    }
  }

  // F-07: a fatal is rethrown AFTER the teardown; the exit code is set by
  // the wrapper (runContinuousMonitor) so it does not depend on the caller.
  if (fatal) {
    throw fatal;
  }

  // The verdict is applied AFTER the teardown. `process.exit` is never called
  // from here — the exit code is set instead, so the test suite can never be
  // killed by the runner.
  if (passExitCode) {
    console.error('🔴 pass red — the one-shot monitor pass ended in a failed state.');
    process.exitCode = passExitCode;
  }
  if (windowResult && windowResult.red) {
    console.error('🔴 window red — the monitor window ended in a failed state.');
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  runContinuousMonitor()
    .then(() => {
      // F-10: the process exits NATURALLY. `process.exit()` truncates the
      // pending stdout writes when stdout is a pipe (GitHub Actions) and the
      // final `🔴 window red:` line would be lost.
    })
    .catch(e => {
      // A typed fatal that never reached the loop (the pre-flight checks)
      // is logged here — ONCE, at the runner boundary (M-05).
      if (e && e.isFatal === true && e.fatalLogged !== true) {
        e.fatalLogged = true;
        console.error(`🔴 fatal: ${e.fatalCode || 'UNKNOWN'}`);
      }
      console.error('Fatal runner error:', e);
      process.exitCode = 1;
    });
}
