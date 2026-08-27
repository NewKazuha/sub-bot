import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.mjs';
import { scrapePostPage } from './site-scrapers.mjs';
import { processAndExtract } from './extractor.mjs';
import { sendDocument } from './telegram.mjs';

const POSTED_FILE = path.resolve('data', 'posted.json');
const OUT_DIR = path.resolve('temp_extracted');

export function loadPostedIds() {
  try {
    if (fs.existsSync(POSTED_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(POSTED_FILE, 'utf8')));
    }
  } catch {}
  return new Set();
}

export function savePostedIds(set) {
  try {
    fs.mkdirSync(path.dirname(POSTED_FILE), { recursive: true });
    fs.writeFileSync(POSTED_FILE, JSON.stringify([...set], null, 2));
  } catch (e) {
    console.error('Failed to save posted IDs:', e.message);
  }
}

// Generate normalized key to prevent duplicate posts across multiple sources
export function normalizeReleaseKey(rawTitle) {
  return rawTitle
    .toLowerCase()
    .replace(/\[\+fonts?\]|\.ass|\.srt|\.zip|\.rar/gi, '')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
}

// Clean caption matching the old channel format exactly:
// e.g. "[Crunchyroll] Maou 2099 - 06" or "[ESPADAS-3ASQ] Bleach Sennen Kessen-hen - 33 [+Fonts]"
export function formatCleanCaption(fileName, isZip = false) {
  let base = path.basename(fileName, path.extname(fileName));
  if (isZip && !base.includes('[+Fonts]') && !base.includes('[+fonts]')) {
    return `${base} [+Fonts]`;
  }
  return base;
}

export async function checkTelegramChannels() {
  const sessionStr = CONFIG.TELEGRAM.SESSION;
  if (!sessionStr) return;

  const posted = loadPostedIds();
  let newFound = 0;

  console.log(`\n📡 [Telegram MTProto Client] Connecting to Telegram...`);
  const client = new TelegramClient(new StringSession(sessionStr), CONFIG.TELEGRAM.API_ID, CONFIG.TELEGRAM.API_HASH, {
    connectionRetries: 5
  });

  try {
    await client.start({ botAuthToken: '' });
    const dialogs = await client.getDialogs({ limit: 100 });

    // Target source channels:
    // 1. Fansub publisher (instant fansub releases)
    // 2. SUBDL channels (for official subs: Crunchyroll, Netflix, Shahid, etc.)
    const targetSourceChats = dialogs.filter(d => {
      const idStr = String(d.id);
      const title = (d.title || '').toLowerCase();
      return (
        idStr.includes('1031770723') ||
        idStr.includes('1224725097') ||
        idStr.includes('2166566367') ||
        idStr.includes('2217287273') ||
        title.includes('arabic anime publisher') ||
        title.includes('kokoboko') ||
        title.includes('rengoku')
      );
    });

    for (const chat of targetSourceChats) {
      const isSubdlSource = (chat.title || '').toLowerCase().includes('subdl') || (chat.title || '').toLowerCase().includes('rengoku');
      console.log(`\n🔍 Checking: "${chat.title}" (ID: ${chat.id})`);
      const msgs = await client.getMessages(chat.id, { limit: 10 });

      for (const msg of msgs) {
        const msgKey = `tg_${chat.id}_${msg.id}`;
        if (posted.has(msgKey)) continue;

        const text = msg.message || '';
        
        // Case A: Direct file attached (.ass, .srt, .zip, .rar, .7z)
        if (msg.media && msg.media.document) {
          const doc = msg.media.document;
          const originalName = doc.attributes?.find(a => a.fileName)?.fileName || `sub_${msg.id}.ass`;
          const ext = path.extname(originalName).toLowerCase();

          if (['.ass', '.srt', '.zip', '.rar', '.7z'].includes(ext)) {
            const isZip = ['.zip', '.rar', '.7z'].includes(ext);
            const normKey = normalizeReleaseKey(originalName);

            // Deduplication check
            if (posted.has(normKey)) {
              console.log(`   ⏭️ Already posted previously: ${originalName}`);
              posted.add(msgKey);
              savePostedIds(posted);
              continue;
            }

            console.log(`   ⚡ Downloading subtitle file: "${originalName}"`);
            fs.mkdirSync(OUT_DIR, { recursive: true });
            const localFilePath = path.join(OUT_DIR, originalName);

            const buffer = await client.downloadMedia(msg);
            fs.writeFileSync(localFilePath, buffer);

            const cleanCaption = formatCleanCaption(originalName, isZip);
            console.log(`   📤 Publishing to channel with caption: "${cleanCaption}"`);
            
            await sendDocument(localFilePath, cleanCaption);
            console.log(`   ✅ Successfully posted!`);
            
            newFound++;
            posted.add(msgKey);
            posted.add(normKey);
            savePostedIds(posted);
            continue;
          }
        }

        // Case B: Post links in Fansub Channel (e.g. Arabic Anime Publisher)
        const urlMatches = text.match(/https?:\/\/[^\s"'<>]+/gi) || [];
        if (urlMatches.length === 0) {
          posted.add(msgKey);
          savePostedIds(posted);
          continue;
        }

        const postPageUrl = urlMatches.find(u => 
          !u.includes('t.me') && !u.includes('twitter') && !u.includes('discord') && !u.includes('subdl.com')
        );

        let bestUrl = null;
        let pageData = null;

        if (postPageUrl) {
          console.log(`   🌐 Scraping fansub post: ${postPageUrl}`);
          pageData = await scrapePostPage(postPageUrl);
          bestUrl = pageData?.bestDownloadUrl;
        }

        if (!bestUrl) {
          bestUrl = urlMatches.find(u => 
            u.includes('mega.nz') || u.includes('drive.google.com') || u.includes('mediafire.com') || u.includes('nyaa.si') || /\.(ass|srt|zip)$/i.test(u)
          );
        }

        if (bestUrl) {
          const rawTitle = pageData?.title || text.split('\n')[0].trim();
          const normKey = normalizeReleaseKey(rawTitle);

          if (posted.has(normKey)) {
            console.log(`   ⏭️ Already posted previously: ${rawTitle}`);
            posted.add(msgKey);
            savePostedIds(posted);
            continue;
          }

          console.log(`   🎯 Extracting: ${bestUrl}`);
          const extracted = await processAndExtract(bestUrl, rawTitle);

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
            console.log(`   ✅ Successfully posted!`);
            newFound++;
            posted.add(normKey);
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
