import { checkTelegramChannels } from './telegram-client.mjs';

export async function checkNewReleases() {
  console.log(`\n🔍 [${new Date().toISOString()}] Checking source channels (KokoBoko [Subdl] & Arabic Anime Publisher)...`);
  try {
    await checkTelegramChannels();
  } catch (err) {
    console.error('Check error:', err.message);
  }
}
