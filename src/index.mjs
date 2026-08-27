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

app.get('/check-now', async (req, res) => {
  res.json({ message: 'Triggered check cycle in background.' });
  checkNewReleases().catch(e => console.error('Check error:', e));
});

const PORT = CONFIG.PORT;
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🤖 Anime Sub Telegram Bot started on port ${PORT}`);
  console.log(`⏰ Polling interval: Every ${CONFIG.POLL_INTERVAL_MINUTES} minutes`);
  console.log(`======================================================\n`);

  checkNewReleases().catch(e => console.error('Initial check error:', e));

  setInterval(() => {
    checkNewReleases().catch(e => console.error('Loop check error:', e));
  }, CONFIG.POLL_INTERVAL_MINUTES * 60 * 1000);
});
