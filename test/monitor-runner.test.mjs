import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLoop } from '../src/action-runner.mjs';

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

