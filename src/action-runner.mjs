import { checkNewReleases } from './feed-monitor.mjs';
import { createPersistentClient } from './telegram-client.mjs';

// Duration to keep the action worker alive checking continuously
const RUN_DURATION_MINUTES = parseInt(process.env.RUN_DURATION_MINUTES || '25', 10);
const CHECK_INTERVAL_SECONDS = parseInt(process.env.CHECK_INTERVAL_SECONDS || '60', 10);

async function runContinuousMonitor() {
  console.log(`\n======================================================`);
  console.log(`🤖 Starting Anime Sub Auto-Poster (Continuous Loop)`);
  console.log(`⏱️ Window Duration: ${RUN_DURATION_MINUTES} minutes`);
  console.log(`⏰ Polling Interval: Every ${CHECK_INTERVAL_SECONDS} seconds`);
  console.log(`======================================================\n`);

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

    const startTime = Date.now();
    const endTime = startTime + RUN_DURATION_MINUTES * 60 * 1000;

    let cycle = 1;
    while (Date.now() < endTime) {
      console.log(`\n🔄 [Cycle #${cycle} - ${new Date().toISOString()}]`);
      try {
        await checkNewReleases(client);
      } catch (err) {
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

      const timeLeft = endTime - Date.now();
      if (timeLeft <= CHECK_INTERVAL_SECONDS * 1000) {
        break;
      }

      console.log(`⏳ Sleeping ${CHECK_INTERVAL_SECONDS}s until next check... (Remaining window: ${Math.round(timeLeft / 60000)}m)`);
      await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL_SECONDS * 1000));
      cycle++;
    }

    console.log(`\n🏁 Continuous monitor window finished successfully after ${cycle} cycles.\n`);
  } finally {
    if (client) {
      try { await client.disconnect(); } catch { }
      console.log('📡 Persistent Telegram connection closed.');
    }
  }
}

runContinuousMonitor().catch(e => {
  console.error('Fatal runner error:', e);
  process.exit(1);
});
