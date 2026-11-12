import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.mjs';
import { checkNewReleases } from './feed-monitor.mjs';
import { classifyCycle } from './action-runner.mjs';

const app = express();

const ADMIN_KEY = process.env.ADMIN_KEY || '';

function timingSafeStringEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

app.get('/', (req, res) => {
  res.send('<h1>Anime Sub Telegram Bot is Running 24/7! 🚀</h1><p>Automated Subtitle Extractor & Channel Publisher</p>');
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

let isChecking = false;

/**
 * Classify a cycle summary exactly like the Actions path (F-03).
 *
 * The 24/7 deployment must apply the SAME verdict as the GitHub Actions
 * runner: the same counters, the same predicates, the same log lines. Before
 * this, the summary was ignored completely and every error was swallowed —
 * in this deployment NONE of the P0 contract existed.
 *
 * → the verdict (see classifyCycle)
 */
export function reportCycleVerdict(summary, { log = console.log } = {}) {
  const verdict = classifyCycle(summary, 0);
  const s = verdict.summary;
  log(`📊 cycle summary: attempted=${s.attempted} published=${s.published} failed=${s.failed} deferred=${s.deferred} skipped=${s.skipped} sourceErrors=${s.sourceErrors}`);
  if (verdict.red) {
    log(`🔴 cycle red: ${verdict.reasons.join(',')}`);
  } else if (verdict.stall) {
    log(`🔴 stall: ${s.attempted} candidates attempted, none published (skipped=${s.skipped} deferred=${s.deferred})`);
  } else {
    log(`🟢 cycle green`);
  }
  return verdict;
}

/**
 * One check cycle with the P0 verdict applied (F-03).
 *
 * A typed fatal is NOT swallowed here: it propagates to the caller, which
 * logs it distinctly and fails the process.
 *
 * → { summary, verdict }
 */
export async function runCheckCycle({
  check = checkNewReleases,
  log = console.log,
  setExitCode = (code) => { process.exitCode = code; },
} = {}) {
  const summary = await check();
  const verdict = reportCycleVerdict(summary, { log });
  // A red verdict (a failure OR a stall) fails the run — exactly like the
  // Actions path, which ends the window non-zero.
  if (verdict.red || verdict.stall) setExitCode(1);
  return { summary: verdict.summary, verdict };
}

async function safeCheckCycle(source = 'timer') {
  if (isChecking) {
    console.log(`⏳ [${source}] A check cycle is already in progress. Skipping overlapping run.`);
    return;
  }
  isChecking = true;
  try {
    await runCheckCycle({ check: () => checkNewReleases(), log: console.log });
  } catch (e) {
    if (e && e.isFatal === true) {
      // A typed fatal (CHANNELS_ZERO / STATE_LOAD_FAILED / AUTH_SESSION_CONFIG)
      // must NEVER be swallowed silently (F-03): it is logged distinctly, it
      // fails the process and it is not demoted to an ordinary check error.
      if (e.fatalLogged !== true) {
        e.fatalLogged = true;
        console.error(`🔴 fatal: ${e.fatalCode || 'UNKNOWN'}`);
      }
      process.exitCode = 1;
      return;
    }
    console.error(`[${source}] Check error:`, e);
    // An unexpected error is not a green cycle either.
    process.exitCode = 1;
  } finally {
    isChecking = false;
  }
}

app.get('/check-now', (req, res) => {
  if (!ADMIN_KEY) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  if (!timingSafeStringEqual(req.query.key, ADMIN_KEY)) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  if (isChecking) {
    return res.json({ message: 'A check cycle is already currently running.' });
  }
  res.json({ message: 'Triggered check cycle in background.' });
  safeCheckCycle('manual-api');
});

const PORT = CONFIG.PORT;

function startScheduler() {
  console.log(`\n======================================================`);
  console.log(`🤖 Anime Sub Telegram Bot loop initialized`);
  console.log(`⏰ Polling interval: Every ${CONFIG.POLL_INTERVAL_MINUTES} minutes`);
  console.log(`======================================================\n`);

  if (!CONFIG.TELEGRAM.SESSION) {
    console.warn('⚠️ TELEGRAM_SESSION is missing (checked env and SESSION_STRING.txt). Telegram publishing will fail until it is set.');
  } else if (!CONFIG.TELEGRAM.API_ID || !CONFIG.TELEGRAM.API_HASH) {
    console.warn('⚠️ TELEGRAM_API_ID / TELEGRAM_API_HASH are missing. Telegram publishing will fail until they are set.');
  } else if (!CONFIG.TELEGRAM.TARGET_CHANNEL) {
    console.warn('⚠️ TELEGRAM_TARGET_CHANNEL is missing. Telegram publishing will fail until it is set.');
  }
  if (!ADMIN_KEY) {
    console.log('ℹ️ ADMIN_KEY is not set – the /check-now endpoint is disabled.');
  }

  safeCheckCycle('initial');

  setInterval(() => {
    safeCheckCycle('interval');
  }, CONFIG.POLL_INTERVAL_MINUTES * 60 * 1000);
}

function startServer() {
  const server = app.listen(PORT, () => {
    console.log(`🌐 Health check server listening on port ${PORT}`);
    startScheduler();
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`⚠️ Port ${PORT} is in use. Web health check server disabled, but Telegram bot polling will continue running.`);
      startScheduler();
    } else {
      console.error('Web server error:', err);
      startScheduler();
    }
  });
}

// The server (and the 24/7 loop) only start on a DIRECT run — importing the
// module (e.g. from a test) must not open a socket or start the loop.
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  startServer();
}
