import express from 'express';
import crypto from 'node:crypto';
import { CONFIG } from './config.mjs';
import { checkNewReleases } from './feed-monitor.mjs';

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

async function safeCheckCycle(source = 'timer') {
  if (isChecking) {
    console.log(`⏳ [${source}] A check cycle is already in progress. Skipping overlapping run.`);
    return;
  }
  isChecking = true;
  try {
    await checkNewReleases();
  } catch (e) {
    console.error(`[${source}] Check error:`, e);
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
    console.warn('⚠️ TELEGRAM_API_ID / TELEGRAM_API_HASH are missing. Telegram publishing will fail until both are set.');
  }
  if (!ADMIN_KEY) {
    console.log('ℹ️ ADMIN_KEY is not set – the /check-now endpoint is disabled.');
  }

  safeCheckCycle('initial');

  setInterval(() => {
    safeCheckCycle('interval');
  }, CONFIG.POLL_INTERVAL_MINUTES * 60 * 1000);
}

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
