import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
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

export function normalizeReleaseKey(rawTitle) {
  return rawTitle
    .toLowerCase()
    .replace(/\[\+fonts?\]|\.ass|\.srt|\.zip|\.rar/gi, '')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
}

export function formatCleanCaption(fileName, isZip = false) {
  let base = path.basename(fileName, path.extname(fileName));
  if (isZip && !base.includes('[+Fonts]') && !base.includes('[+fonts]')) {
    return `${base} [+Fonts]`;
  }
  return base;
}

async function resolveSubdlDownloadUrl(infoUrl) {
  try {
    const res = await fetch(infoUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const html = await res.text();
    const doc = cheerio.load(html);
    let dlUrl = null;
    doc('a[href]').each((_, el) => {
      const href = doc(el).attr('href') || '';
      if (href.includes('dl.subdl.com/subtitle/')) {
        dlUrl = href;
        return false;
      }
    });
    return dlUrl;
  } catch (e) {
    console.warn('SUBDL resolve error:', e.message);
    return null;
  }
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

    const targetSourceChats = dialogs.filter(d => {
      const idStr = String(d.id);
      const title = (d.title || '').toLowerCase();
      const isChatGroup = title.includes('chat') || title.includes('group');
      if (isChatGroup) return false;

      const isFansubPublisher = idStr.includes('1031770723') || title === 'arabic anime publisher';
      const isOfficialKokoboko = idStr.includes('1224725097') || title === 'kokoboko [subdl]';

      return isFansubPublisher || isOfficialKokoboko;
    });

    console.log(`   Found ${targetSourceChats.length} targeted source channel(s):`);
    targetSourceChats.forEach(c => console.log(`   - ${c.title} (ID: ${c.id})`));

    for (const chat of targetSourceChats) {
      console.log(`\n🔍 Checking: "${chat.title}" (ID: ${chat.id})`);
      const msgs = await client.getMessages(chat.id, { limit: 10 });

      for (const msg of msgs) {
        const msgKey = `tg_${chat.id}_${msg.id}`;
        if (posted.has(msgKey)) continue;

        const text = msg.message || '';
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const titleLine = lines[0]?.replace(/^[📍📌🎬\s]+/, '') || 'Anime Release';
        const normKey = normalizeReleaseKey(titleLine);

        // Deduplication
        if (posted.has(normKey)) {
          console.log(`   ⏭️ Already posted previously: ${titleLine}`);
          posted.add(msgKey);
          savePostedIds(posted);
          continue;
        }

        // Case A: Direct file attached
        if (msg.media && msg.media.document) {
          const doc = msg.media.document;
          const originalName = doc.attributes?.find(a => a.fileName)?.fileName || `sub_${msg.id}.ass`;
          const ext = path.extname(originalName).toLowerCase();

          if (['.ass', '.srt', '.zip', '.rar', '.7z'].includes(ext)) {
            const isZip = ['.zip', '.rar', '.7z'].includes(ext);
            console.log(`   ⚡ Downloading attached file: "${originalName}"`);
            fs.mkdirSync(OUT_DIR, { recursive: true });
            const localFilePath = path.join(OUT_DIR, originalName);

            const buffer = await client.downloadMedia(msg);
            fs.writeFileSync(localFilePath, buffer);

            const cleanCaption = formatCleanCaption(originalName, isZip);
            console.log(`   📤 Publishing to channel: "${cleanCaption}"`);
            await sendDocument(localFilePath, cleanCaption);
            console.log(`   ✅ Successfully posted!`);

            newFound++;
            posted.add(msgKey);
            posted.add(normKey);
            savePostedIds(posted);
            continue;
          }
        }

        // Case B: SUBDL Info Link in KokoBoko [Subdl]
        const subdlMatch = text.match(/https?:\/\/(?:www\.)?subdl\.com\/s\/info\/[a-zA-Z0-9]+/i);
        if (subdlMatch) {
          const subdlInfoUrl = subdlMatch[0];
          console.log(`   🌐 Resolving official SUBDL download link: ${subdlInfoUrl}`);
          const dlUrl = await resolveSubdlDownloadUrl(subdlInfoUrl);

          if (dlUrl) {
            console.log(`   📥 Downloading official subtitle from SUBDL: ${dlUrl}`);
            fs.mkdirSync(OUT_DIR, { recursive: true });
            const tempZip = path.join(OUT_DIR, `subdl_${msg.id}.zip`);
            const subdlRes = await fetch(dlUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const zipBuffer = await subdlRes.arrayBuffer();
            fs.writeFileSync(tempZip, Buffer.from(zipBuffer));

            const extractTemp = path.join(OUT_DIR, `subdl_extracted_${msg.id}`);
            fs.mkdirSync(extractTemp, { recursive: true });
            try {
              execSync(`unzip -o "${tempZip}" -d "${extractTemp}"`);
            } catch {
              try {
                execSync(`tar -xf "${tempZip}" -C "${extractTemp}"`);
              } catch {}
            }

            const subFiles = fs.readdirSync(extractTemp).filter(f => /\.(ass|srt)$/i.test(f));
            if (subFiles.length > 0) {
              for (const sFile of subFiles) {
                const ext = path.extname(sFile);
                const safeName = `${titleLine.replace(/[\\/:*?"<>|]+/g, '_')}${ext}`;
                const finalSubPath = path.join(OUT_DIR, safeName);
                fs.copyFileSync(path.join(extractTemp, sFile), finalSubPath);

                const cleanCaption = titleLine;
                console.log(`   📤 Publishing official subtitle: "${cleanCaption}"`);
                await sendDocument(finalSubPath, cleanCaption);
                console.log(`   ✅ Successfully posted!`);
                newFound++;
              }
              posted.add(msgKey);
              posted.add(normKey);
              savePostedIds(posted);
              fs.rmSync(extractTemp, { recursive: true, force: true });
              fs.rmSync(tempZip, { force: true });
              continue;
            }
          }
        }

        // Case C: Post links in Fansub Channel (Arabic Anime Publisher)
        const urlMatches = text.match(/https?:\/\/[^\s"'<>]+/gi) || [];
        const postPageUrl = urlMatches.find(u => 
          !u.includes('t.me') && !u.includes('twitter') && !u.includes('discord') && !u.includes('subdl.com')
        );

        let bestUrl = null;
        let pageData = null;

        if (postPageUrl) {
          console.log(`   🌐 Scraping fansub post: ${postPageUrl}`);
          const matchingSite = CONFIG.SITES.find(s => postPageUrl.includes(new URL(s.base).hostname));
          pageData = await scrapePostPage(postPageUrl, matchingSite);
          bestUrl = pageData?.bestDownloadUrl;
        }

        if (!bestUrl) {
          bestUrl = urlMatches.find(u => 
            u.includes('mega.nz') || u.includes('drive.google.com') || u.includes('mediafire.com') || u.includes('nyaa.si') || /\.(ass|srt|zip)$/i.test(u)
          );
        }

        if (bestUrl) {
          const rawTitle = pageData?.title || titleLine;
          console.log(`   🎯 Extracting: ${bestUrl}`);
          try {
            const extracted = await processAndExtract(bestUrl, rawTitle);

            for (const subFile of extracted.subFiles) {
              const cleanCaption = formatCleanCaption(path.basename(subFile), false);
              console.log(`   📄 Sending: ${cleanCaption}`);
              await sendDocument(subFile, cleanCaption);
            }

            if (extracted.fontZip) {
              const cleanCaption = formatCleanCaption(path.basename(extracted.fontZip), true);
              console.log(`   🔤 Sending fonts: ${cleanCaption}`);
              await sendDocument(extracted.fontZip, cleanCaption);
            }

            if (extracted.subFiles.length > 0 || extracted.fontZip) {
              console.log(`   ✅ Successfully posted!`);
              newFound++;
              posted.add(msgKey);
              posted.add(normKey);
              savePostedIds(posted);
            }
          } catch (e) {
            console.error(`   ❌ Extraction failed for ${bestUrl}:`, e.message);
          }
        } else {
          console.warn(`   ⚠️ No valid download link could be extracted from: ${postPageUrl || text}`);
        }
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
