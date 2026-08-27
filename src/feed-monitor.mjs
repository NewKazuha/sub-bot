import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.mjs';
import { scrapePostPage } from './site-scrapers.mjs';
import { processAndExtract } from './extractor.mjs';
import { sendDocument, sendPhoto, sendMessage } from './telegram.mjs';
import { checkTelegramChannels } from './telegram-client.mjs';

const POSTED_FILE = path.resolve('data', 'posted.json');

function loadPostedIds() {
  try {
    if (fs.existsSync(POSTED_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(POSTED_FILE, 'utf8')));
    }
  } catch {}
  return new Set();
}

function savePostedIds(set) {
  try {
    fs.mkdirSync(path.dirname(POSTED_FILE), { recursive: true });
    fs.writeFileSync(POSTED_FILE, JSON.stringify([...set], null, 2));
  } catch (e) {
    console.error('Failed to save posted IDs:', e.message);
  }
}

export async function checkNewReleases() {
  console.log(`\n🔍 [${new Date().toISOString()}] Checking all sources for new anime releases...`);
  const posted = loadPostedIds();

  // 1. Check Source Telegram Channels (Arabic Anime Publisher & SUBDL / Rengoku)
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

        console.log(`\n✨ NEW RSS RELEASE: "${item.title}"`);
        const pageData = await scrapePostPage(item.link, site);
        if (!pageData || !pageData.bestDownloadUrl) {
          posted.add(item.link);
          continue;
        }

        const extracted = await processAndExtract(pageData.bestDownloadUrl, pageData.title || item.title);

        if (extracted.subFiles.length > 0) {
          console.log(`   📤 Publishing to Telegram Channel...`);
          
          const caption = [
            `🎬 <b>${pageData.title || item.title}</b>`,
            `👥 <b>فريق الترجمة:</b> ${site.name}`,
            `🔗 <a href="${item.link}">رابط تدوينة العمل الأصلية</a>`,
            `\n💎 <i>تم استخراج الترجمة تلقائياً عبر @ArAnimeSubBot</i>`
          ].join('\n');

          if (pageData.posterUrl) {
            await sendPhoto(pageData.posterUrl, caption).catch(() => {});
          } else {
            await sendMessage(caption).catch(() => {});
          }

          for (const subFile of extracted.subFiles) {
            const subName = path.basename(subFile);
            await sendDocument(subFile, `📎 <b>ملف الترجمة:</b> <code>${subName}</code>`);
          }

          if (extracted.fontZip) {
            const zipName = path.basename(extracted.fontZip);
            await sendDocument(extracted.fontZip, `🔤 <b>حزمة الخطوط المرفقة بالعمل:</b> <code>${zipName}</code>`);
          }
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
