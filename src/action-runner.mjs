import { checkNewReleases } from './feed-monitor.mjs';

// Duration to keep the action worker alive checking continuously
const RUN_DURATION_MINUTES = parseInt(process.env.RUN_DURATION_MINUTES || '15', 10);
const CHECK_INTERVAL_SECONDS = parseInt(process.env.CHECK_INTERVAL_SECONDS || '45', 10);

async function runContinuousMonitor() {
  console.log(`\n======================================================`);
  console.log(`🤖 Starting Anime Sub Auto-Poster (Continuous Loop)`);
  console.log(`⏱️ Window Duration: ${RUN_DURATION_MINUTES} minutes`);
  console.log(`⏰ Polling Interval: Every ${CHECK_INTERVAL_SECONDS} seconds`);
  console.log(`======================================================\n`);

  const startTime = Date.now();
  const endTime = startTime + RUN_DURATION_MINUTES * 60 * 1000;

  let cycle = 1;
  while (Date.now() < endTime) {
    console.log(`\n🔄 [Cycle #${cycle} - ${new Date().toISOString()}]`);
    try {
      await checkNewReleases();
    } catch (err) {
      console.error(`Cycle #${cycle} error:`, err.message);
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
}

runContinuousMonitor().catch(e => {
  console.error('Fatal runner error:', e);
  process.exit(1);
});
