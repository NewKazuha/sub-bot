import * as cheerio from 'cheerio';
import path from 'node:path';
import { CONFIG } from './config.mjs';
import { scrapePostPage } from './site-scrapers.mjs';
import { processAndExtract } from './extractor.mjs';
import { sendDocument } from './telegram.mjs';
import { checkTelegramChannels, loadPostedIds, savePostedIds, normalizeReleaseKey, formatCleanCaption } from './telegram-client.mjs';

export async function checkNewReleases() {
  console.log(`\n🔍 [${new Date().toISOString()}] Checking all sources for new anime releases...`);
  const posted = loadPostedIds();

  // 1. Check Source Telegram Channels (Arabic Anime Publisher & SUBDL)
  try {
    await checkTelegramChannels();
  } catch (err) {
    console.error('Channel monitor error:', err.message);
  }

  // 2. Check Fansub Team Websites (RSS Feeds)
  for (const site of CONFIG.SITES) {
    try {
      console.log(`📡 Checking feed for: ${site.name} (${site.feed})`);
      const res = await fetch(site.feed, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const $ = cheerio.load(xml, { xmlMode: true });

      const items = [];
      $('item').each((_, el) => {
        const title = $(el).find('title').text().trim();
        const link = $(el).find('link').text().trim() || $(el).find('guid').text().trim();
        if (title && link) items.push({ title, link });
      });

      for (const item of items.slice(0, 3)) {
        if (posted.has(item.link)) continue;

        const rawTitle = item.title;
        const normKey = normalizeReleaseKey(rawTitle);

        if (posted.has(normKey)) {
          console.log(`   ⏭️ Already posted previously: ${rawTitle}`);
          posted.add(item.link);
          savePostedIds(posted);
          continue;
        }

        console.log(`\n✨ NEW RSS RELEASE: "${item.title}"`);
        const pageData = await scrapePostPage(item.link, site);
        if (!pageData || !pageData.bestDownloadUrl) {
          posted.add(item.link);
          continue;
        }

        const extracted = await processAndExtract(pageData.bestDownloadUrl, pageData.title || item.title);

        // 1. Send all extracted subtitle files (.ass)
        for (const subFile of extracted.subFiles) {
          const cleanCaption = formatCleanCaption(path.basename(subFile), false);
          console.log(`   📄 Sending: ${cleanCaption}`);
          await sendDocument(subFile, cleanCaption);
        }

        // 2. Send font zip if present
        if (extracted.fontZip) {
          const cleanCaption = formatCleanCaption(path.basename(extracted.fontZip), true);
          console.log(`   🔤 Sending fonts: ${cleanCaption}`);
          await sendDocument(extracted.fontZip, cleanCaption);
        }

        if (extracted.subFiles.length > 0 || extracted.fontZip) {
          posted.add(normKey);
        }

        posted.add(item.link);
        savePostedIds(posted);
      }
    } catch (err) {
      console.warn(`Feed check warning for ${site.name}:`, err.message);
    }
  }

  savePostedIds(posted);
}
