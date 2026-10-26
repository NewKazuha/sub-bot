import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNewReleases } from './feed-monitor.mjs';
import { createPersistentClient } from './telegram-client.mjs';
import { CONFIG } from './config.mjs';
import { closeBrowser } from './browser-fetch.mjs';

// Duration to keep the action worker alive checking continuously
const RUN_DURATION_MINUTES = parseInt(process.env.RUN_DURATION_MINUTES || '25', 10);
const CHECK_INTERVAL_SECONDS = parseInt(process.env.CHECK_INTERVAL_SECONDS || '60', 10);

/**
 * Core monitoring loop engine with injectable clock and sleep for deterministic testing.
 */
export async function runLoop({
  windowMs,
  cycleBudgetMs = 0,
  checkIntervalMs = 60 * 1000,
  check,
  now = () => Date.now(),
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
  onCycleError = null,
  log = console.log,
} = {}) {
  const startTime = now();
  const endTime = startTime + windowMs;

  let cycle = 1;
  while (now() + cycleBudgetMs <= endTime) {
    log(`\n🔄 [Cycle #${cycle} - ${new Date(now()).toISOString()}]`);
    try {
      await check();
    } catch (err) {
      if (onCycleError) await onCycleError(cycle, err);
      else console.error(`Cycle #${cycle} error:`, err.message);
    }

    const timeLeft = endTime - now();
    if (timeLeft < cycleBudgetMs) {
      break;
    }

    log(`⏳ Sleeping ${Math.round(checkIntervalMs / 1000)}s until next check... (Remaining window: ${Math.round(timeLeft / 60000)}m)`);
    await sleep(checkIntervalMs);
    cycle++;
  }

  log(`\n🏁 Continuous monitor window finished successfully after ${cycle} cycles.\n`);
  return { cycles: cycle, elapsed: now() - startTime };
}

async function runContinuousMonitor() {
  console.log(`\n======================================================`);
  console.log(`🤖 Starting Anime Sub Auto-Poster (Continuous Loop)`);
  console.log(`⏱️ Window Duration: ${RUN_DURATION_MINUTES} minutes`);
  console.log(`⏰ Polling Interval: Every ${CHECK_INTERVAL_SECONDS} seconds`);
  console.log(`======================================================\n`);

  // Pre-flight: verify credentials (read from CONFIG after env/.env/session-file fallback).
  const session = CONFIG.TELEGRAM.SESSION;
  if (!session) {
    console.error('❌ TELEGRAM_SESSION is missing (checked env and SESSION_STRING.txt). Aborting.');
    process.exit(1);
  }
  if (!CONFIG.TELEGRAM.API_ID || !CONFIG.TELEGRAM.API_HASH) {
    console.error('❌ TELEGRAM_API_ID and TELEGRAM_API_HASH are required together with TELEGRAM_SESSION. Aborting.');
    process.exit(1);
  }
  if (!CONFIG.TELEGRAM.TARGET_CHANNEL) {
    console.error('❌ TELEGRAM_TARGET_CHANNEL is missing. Aborting.');
    process.exit(1);
  }

  // Create a single persistent Telegram client for the entire monitoring window.
  // This avoids the expensive connect/disconnect overhead on every cycle.
  const client = createPersistentClient();
  if (client) {
    console.log(`📡 Establishing persistent Telegram connection...`);
    await client.connect();
    console.log(`✅ Persistent connection established – reused across all cycles.\n`);
  }

  try {
    if (RUN_DURATION_MINUTES <= 0) {
      console.log('🔄 Running one monitor pass.');
      await checkNewReleases(client);
      console.log('🏁 Monitor pass finished.');
      return;
    }

    await runLoop({
      windowMs: RUN_DURATION_MINUTES * 60 * 1000,
      cycleBudgetMs: 6 * 60 * 1000,
      checkIntervalMs: CHECK_INTERVAL_SECONDS * 1000,
      check: async () => {
        await checkNewReleases(client);
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
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  runContinuousMonitor().catch(e => {
    console.error('Fatal runner error:', e);
    process.exit(1);
  });
}
