import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.mjs';
import { scrapePostPage } from './site-scrapers.mjs';
import { processAndExtract } from './extractor.mjs';
import { sendDocument, sendPhoto, sendMessage } from './telegram.mjs';

const POSTED_FILE = path.resolve('data', 'posted.json');
const OUT_DIR = path.resolve('temp_extracted');

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

export async function checkTelegramChannels() {
  const sessionStr = CONFIG.TELEGRAM.SESSION;
  if (!sessionStr) {
    console.warn('⚠️ No TELEGRAM_SESSION found in configuration. Skipping channel polling.');
    return;
  }

  const posted = loadPostedIds();
  let newFound = 0;

  console.log(`\n📡 [Telegram MTProto Client] Connecting to Telegram to check source channels...`);
  const client = new TelegramClient(new StringSession(sessionStr), CONFIG.TELEGRAM.API_ID, CONFIG.TELEGRAM.API_HASH, {
    connectionRetries: 5
  });

  try {
    await client.start({ botAuthToken: '' });
    console.log('   ✅ Connected successfully as user!');

    const dialogs = await client.getDialogs({ limit: 100 });
    
    // Find target source channels
    const targetSourceChats = dialogs.filter(d => {
      const idStr = String(d.id);
      const title = (d.title || '').toLowerCase();
      return (
        idStr.includes('1031770723') ||
        idStr.includes('1224725097') ||
        idStr.includes('2217287273') ||
        idStr.includes('2166566367') ||
        title.includes('arabic anime publisher') ||
        title.includes('kokoboko') ||
        title.includes('rengoku')
      );
    });

    console.log(`   Found ${targetSourceChats.length} source channel(s) in dialogs.`);

    for (const chat of targetSourceChats) {
      console.log(`\n🔍 Checking recent messages from: "${chat.title}" (ID: ${chat.id})`);
      const msgs = await client.getMessages(chat.id, { limit: 5 });

      for (const msg of msgs) {
        const msgKey = `tg_${chat.id}_${msg.id}`;
        if (posted.has(msgKey)) continue;

        const text = msg.message || '';
        console.log(`\n✨ NEW MESSAGE DETECTED from [${chat.title}]:`);
        console.log(`   Message snippet: ${text.slice(0, 150).replace(/\n/g, ' ')}`);

        // 1. Check if the message has an attached subtitle / archive file directly (.ass, .srt, .zip, .rar)
        if (msg.media && msg.media.document) {
          const doc = msg.media.document;
          const fileName = doc.attributes?.find(a => a.fileName)?.fileName || `sub_${msg.id}.ass`;
          const ext = path.extname(fileName).toLowerCase();

          if (['.ass', '.srt', '.zip', '.rar', '.7z'].includes(ext)) {
            console.log(`   ⚡ Direct subtitle/font document attached in message: "${fileName}"`);
            fs.mkdirSync(OUT_DIR, { recursive: true });
            const localFilePath = path.join(OUT_DIR, fileName);

            console.log(`   📥 Downloading attachment from Telegram...`);
            const buffer = await client.downloadMedia(msg);
            fs.writeFileSync(localFilePath, buffer);

            const titleMatch = text.split('\n')[0] || fileName;
            const caption = [
              `🎬 <b>${titleMatch}</b>`,
              `👥 <b>المصدر:</b> ${chat.title}`,
              `\n💎 <i>تم النشر تلقائياً عبر @ArAnimeSubBot</i>`
            ].join('\n');

            console.log(`   📤 Publishing directly to Telegram Channel...`);
            await sendDocument(localFilePath, caption);
            console.log(`   ✅ Successfully posted!`);
            newFound++;
            posted.add(msgKey);
            savePostedIds(posted);
            continue;
          }
        }

        // 2. Extract URLs from message text
        const urlMatches = text.match(/https?:\/\/[^\s"'<>]+/gi) || [];
        if (urlMatches.length === 0) {
          posted.add(msgKey);
          savePostedIds(posted);
          continue;
        }

        console.log(`   Discovered ${urlMatches.length} link(s) in message.`);
        const titleLine = text.split('\n')[0].trim() || 'Anime Release';

        // Check if there is a blog / post page URL (e.g. Celestial, Asahi, Blogspot, Rhythm, Revive, etc.)
        const postPageUrl = urlMatches.find(u => 
          !u.includes('t.me') && !u.includes('twitter') && !u.includes('discord') && !u.includes('subdl.com')
        );

        let bestUrl = null;
        let pageData = null;

        if (postPageUrl) {
          console.log(`   🌐 Scraping post page: ${postPageUrl}`);
          pageData = await scrapePostPage(postPageUrl);
          bestUrl = pageData?.bestDownloadUrl;
        }

        // If not found from scraping, check if there's a direct Mega/Drive/Mediafire link in the message text itself
        if (!bestUrl) {
          bestUrl = urlMatches.find(u => 
            u.includes('mega.nz') || u.includes('drive.google.com') || u.includes('mediafire.com') || u.includes('nyaa.si') || /\.(ass|srt|zip)$/i.test(u)
          );
        }

        if (bestUrl) {
          console.log(`   🎯 Selected Best Download Link: ${bestUrl}`);
          const extracted = await processAndExtract(bestUrl, pageData?.title || titleLine);

          if (extracted.subFiles.length > 0) {
            console.log(`   📤 Publishing to Telegram Channel...`);
            
            const caption = [
              `🎬 <b>${pageData?.title || titleLine}</b>`,
              `👥 <b>المصدر:</b> ${chat.title}`,
              postPageUrl ? `🔗 <a href="${postPageUrl}">رابط التدوينة الأصلية</a>` : '',
              `\n💎 <i>تم استخراج الترجمة تلقائياً عبر @ArAnimeSubBot</i>`
            ].filter(Boolean).join('\n');

            if (pageData?.posterUrl) {
              await sendPhoto(pageData.posterUrl, caption).catch(() => {});
            } else {
              await sendMessage(caption).catch(() => {});
            }

            for (const subFile of extracted.subFiles) {
              const subName = path.basename(subFile);
              console.log(`   📄 Sending subtitle file: ${subName}`);
              await sendDocument(subFile, `📎 <b>ملف الترجمة:</b> <code>${subName}</code>`);
            }

            if (extracted.fontZip) {
              const zipName = path.basename(extracted.fontZip);
              console.log(`   🔤 Sending fonts package: ${zipName}`);
              await sendDocument(extracted.fontZip, `🔤 <b>حزمة الخطوط المرفقة بالعمل:</b> <code>${zipName}</code>`);
            }

            console.log(`   ✅ Successfully posted to Telegram!`);
            newFound++;
          }
        }

        posted.add(msgKey);
        savePostedIds(posted);
      }
    }
  } catch (err) {
    console.error('Telegram channel listener error:', err.message);
  } finally {
    await client.disconnect();
  }

  savePostedIds(posted);
  console.log(`🏁 Telegram Channel check complete. Processed ${newFound} new release(s).\n`);
}
