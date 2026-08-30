import express from 'express';
import { CONFIG } from './config.mjs';
import { checkNewReleases } from './feed-monitor.mjs';

const app = express();

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

app.get('/check-now', async (req, res) => {
  if (isChecking) {
    return res.json({ message: 'A check cycle is already currently running.' });
  }
  res.json({ message: 'Triggered check cycle in background.' });
  safeCheckCycle('manual-api');
});

const PORT = CONFIG.PORT;
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🤖 Anime Sub Telegram Bot started on port ${PORT}`);
  console.log(`⏰ Polling interval: Every ${CONFIG.POLL_INTERVAL_MINUTES} minutes`);
  console.log(`======================================================\n`);

  safeCheckCycle('initial');

  setInterval(() => {
    safeCheckCycle('interval');
  }, CONFIG.POLL_INTERVAL_MINUTES * 60 * 1000);
});
