import { checkTelegramChannels } from './telegram-client.mjs';

export async function checkNewReleases(client = null) {
  console.log(`\n🔍 [${new Date().toISOString()}] Checking source channels (KokoBoko [Subdl], Rengoku [Subdl], Erai-Raws, LazySano & Arabic Anime Publisher)...`);
  try {
    await checkTelegramChannels(client);
  } catch (err) {
    console.error('Check error:', err.message);
  }
}
