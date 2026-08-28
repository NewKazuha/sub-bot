import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { CONFIG } from './config.mjs';
import { scrapePostPage } from './site-scrapers.mjs';
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
    .replace(/\[\+fonts?\]|\.ass|\.srt|\.zip|\.rar|\.7z/gi, '')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
}

export function formatCleanTitle(raw) {
  return raw
    .replace(/^[📍📌🎬\s]+/, '')
    .replace(/\[\+fonts?\]/gi, '')
    .trim();
}

export function extractTeamAndFormatTitle(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const rawTitle = formatCleanTitle(lines[0] || 'Anime Release');

  // If title already has [Team] at start
  if (/^\[[^\]]+\]/.test(rawTitle)) {
    return rawTitle;
  }

  // Look for "By ..." or "بواسطة ..." line in message text
  let team = '';
  for (const line of lines) {
    const match = line.match(/^(?:By|من قبل|ترجمة|بواسطة)\s+@?([a-zA-Z0-9_\- ]+)/i);
    if (match) {
      team = match[1].trim();
      break;
    }
  }

  if (team) {
    team = team
      .replace(/fansubs?|subs?|subtitles?|team|فريق/gi, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (team.toLowerCase() === 'celestial dragons') team = 'Celestial-Dragons';
    if (team.toLowerCase() === 'lazysano' || team.toLowerCase() === 'lazysanosubs') team = 'LazySano';
    if (team.toLowerCase() === 'asahi') team = 'Asahi';
    if (team.toLowerCase() === 'rhythm') team = 'Rhythm';
    if (team.toLowerCase() === 'kusanage') team = 'Kusanage';
    if (team.toLowerCase() === 'a55bb') team = 'A55BB';

    if (team) {
      return `[${team}] ${rawTitle}`;
    }
  }

  return rawTitle;
}

export function formatCleanCaption(title, isZip = false) {
  let clean = formatCleanTitle(title);
  if (isZip && !clean.toLowerCase().includes('[+fonts]')) {
    return `${clean} [+Fonts]`;
  }
  return clean;
}

export function getSafeTelegramFileName(name, ext = '.ass') {
  let clean = name.replace(/[\\/:*?"<>|,]+/g, ' ').replace(/\s+/g, ' ').trim();
  const maxBaseLen = 55 - ext.length;
  
  if (clean.length > maxBaseLen) {
    const prefixMatch = clean.match(/^(\[[^\]]+\]\s*)/);
    const prefix = prefixMatch ? prefixMatch[1] : '';
    const remainder = clean.slice(prefix.length);

    const suffixMatch = remainder.match(/(\s*-\s*\d+.*)$/);
    const suffix = suffixMatch ? suffixMatch[1] : '';
    const middle = remainder.slice(0, remainder.length - suffix.length);

    const targetMiddleLen = maxBaseLen - prefix.length - suffix.length;
    if (targetMiddleLen > 5) {
      clean = `${prefix}${middle.slice(0, targetMiddleLen).trim()}${suffix}`;
    } else {
      clean = clean.slice(0, maxBaseLen).trim();
    }
  }

  return `${clean}${ext}`;
}

export async function downloadFileToDisk(url, destPath, headers = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      ...headers
    }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  const fileStream = fs.createWriteStream(destPath, { flags: 'w' });
  await finished(Readable.fromWeb(res.body).pipe(fileStream));
  return destPath;
}

async function resolveSubdlDownloadUrl(infoUrl) {
  try {
    const res = await fetch(infoUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
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
  if (!sessionStr) {
    console.warn('No Telegram SESSION found in config.');
    return;
  }

  const posted = loadPostedIds();
  let newFound = 0;

  console.log(`\n📡 [Telegram MTProto Client] Connecting to Telegram...`);
  const client = new TelegramClient(
    new StringSession(sessionStr),
    CONFIG.TELEGRAM.API_ID,
    CONFIG.TELEGRAM.API_HASH,
    { connectionRetries: 5 }
  );

  try {
    await client.connect();
    const dialogs = await client.getDialogs({ limit: 100 });

    const targetSourceChats = dialogs.filter(d => {
      const idStr = String(d.id);
      const title = (d.title || '').toLowerCase();
      const isChatGroup = title.includes('chat') || title.includes('group');
      if (isChatGroup) return false;

      const isFansubPublisher = idStr.includes('1031770723') || title.includes('arabic anime publisher');
      const isOfficialKokoboko = idStr.includes('1224725097') || title.includes('kokoboko [subdl]');

      return isFansubPublisher || isOfficialKokoboko;
    });

    console.log(`   Found ${targetSourceChats.length} targeted source channel(s):`);
    targetSourceChats.forEach(c => console.log(`   - ${c.title} (ID: ${c.id})`));

    fs.mkdirSync(OUT_DIR, { recursive: true });

    for (const chat of targetSourceChats) {
      const isKokoboko = String(chat.id).includes('1224725097') || (chat.title || '').toLowerCase().includes('kokoboko');
      console.log(`\n🔍 Checking: "${chat.title}" (ID: ${chat.id})`);
      const msgs = await client.getMessages(chat.id, { limit: 10 });

      for (const msg of msgs) {
        const msgKey = `tg_${chat.id}_${msg.id}`;
        if (posted.has(msgKey)) continue;

        const text = msg.message || '';
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const titleLine = isKokoboko ? formatCleanTitle(lines[0] || 'Anime Release') : extractTeamAndFormatTitle(text);
        const normKey = normalizeReleaseKey(titleLine);

        if (posted.has(normKey)) {
          posted.add(msgKey);
          savePostedIds(posted);
          continue;
        }

        // ==============================================================
        // 1. CHANNEL 1: KokoBoko [Subdl] (Official Subtitles)
        // ==============================================================
        if (isKokoboko) {
          const subdlMatch = text.match(/https?:\/\/(?:www\.)?subdl\.com\/s\/info\/[a-zA-Z0-9]+/i);
          if (subdlMatch) {
            const subdlInfoUrl = subdlMatch[0];
            console.log(`\n✨ [Official Release] "${titleLine}"`);
            console.log(`   🌐 Resolving SUBDL link: ${subdlInfoUrl}`);
            const dlUrl = await resolveSubdlDownloadUrl(subdlInfoUrl);

            if (dlUrl) {
              try {
                console.log(`   📥 Downloading from SUBDL: ${dlUrl}`);
                const tempDownload = path.join(OUT_DIR, `temp_subdl_${msg.id}`);
                await downloadFileToDisk(dlUrl, tempDownload, { Referer: subdlInfoUrl });

                const headerBuffer = Buffer.alloc(100);
                const fd = fs.openSync(tempDownload, 'r');
                fs.readSync(fd, headerBuffer, 0, 100, 0);
                fs.closeSync(fd);

                const headerStr = headerBuffer.toString('utf8');
                const isZip = headerBuffer.subarray(0, 4).toString('hex') === '504b0304';
                const isAss = headerStr.includes('[Script Info]') || headerStr.includes('Dialogue:');
                const isSrt = /^\s*1\s*\r?\n\d\d:\d\d:\d\d/m.test(headerStr);

                const ext = isZip ? '.zip' : (isSrt ? '.srt' : '.ass');
                const cleanFileName = getSafeTelegramFileName(titleLine, ext);
                const finalPath = path.join(OUT_DIR, cleanFileName);

                fs.renameSync(tempDownload, finalPath);

                const caption = formatCleanCaption(titleLine, isZip);
                console.log(`   📤 Publishing to channel: "${caption}" (filename: ${cleanFileName})`);
                const sendResult = await sendDocument(finalPath, caption);

                if (sendResult?.ok) {
                  console.log(`   ✅ Successfully posted! (Message ID: ${sendResult.result?.message_id})`);
                  newFound++;
                  posted.add(msgKey);
                  posted.add(normKey);
                  savePostedIds(posted);
                } else {
                  console.error(`   ❌ Failed to send document:`, sendResult);
                }

                fs.rmSync(finalPath, { force: true });
                continue;
              } catch (e) {
                console.error(`   ❌ Error downloading/posting SUBDL release:`, e.message);
              }
            }
          }
        }

        // ==============================================================
        // 2. CHANNEL 2: Arabic Anime Publisher (Fansub Releases)
        // ==============================================================
        // Case A: Direct file attached to the message
        if (msg.media && msg.media.document) {
          const doc = msg.media.document;
          const originalName = doc.attributes?.find(a => a.fileName)?.fileName || `sub_${msg.id}.ass`;
          const ext = path.extname(originalName).toLowerCase();

          if (['.ass', '.srt', '.zip', '.rar', '.7z'].includes(ext)) {
            const isZip = ['.zip', '.rar', '.7z'].includes(ext);
            console.log(`\n✨ [Fansub Attachment] "${titleLine}" (${originalName})`);
            const localFilePath = path.join(OUT_DIR, originalName);

            const buffer = await client.downloadMedia(msg);
            fs.writeFileSync(localFilePath, buffer);

            const caption = formatCleanCaption(titleLine, isZip);
            console.log(`   📤 Publishing to channel: "${caption}"`);
            const sendResult = await sendDocument(localFilePath, caption);

            if (sendResult?.ok) {
              console.log(`   ✅ Successfully posted!`);
              newFound++;
              posted.add(msgKey);
              posted.add(normKey);
              savePostedIds(posted);
            }

            fs.rmSync(localFilePath, { force: true });
            continue;
          }
        }

        // Case B: Post links in Fansub Channel
        const urlMatches = text.match(/https?:\/\/[^\s"'<>]+/gi) || [];
        const postPageUrl = urlMatches.find(u =>
          !u.includes('t.me') && !u.includes('twitter') && !u.includes('discord') && !u.includes('subdl.com')
        );

        if (postPageUrl) {
          console.log(`\n✨ [Fansub Post] "${titleLine}"`);
          console.log(`   🌐 Scraping fansub post: ${postPageUrl}`);
          const matchingSite = CONFIG.SITES.find(s => {
            try { return postPageUrl.includes(new URL(s.base).hostname); } catch { return false; }
          });
          const pageData = await scrapePostPage(postPageUrl, matchingSite);

          if (pageData && pageData.bestDownloadUrl) {
            const dlUrl = pageData.bestDownloadUrl;
            console.log(`   🎯 Download link found: ${dlUrl}`);

            if (/\.(ass|srt|zip|rar|7z)$/i.test(dlUrl) || dlUrl.includes('top4top.io') || dlUrl.includes('mediafire.com')) {
              try {
                const tempFile = path.join(OUT_DIR, `fansub_dl_${msg.id}`);
                await downloadFileToDisk(dlUrl, tempFile, { Referer: postPageUrl });

                const headerBuffer = Buffer.alloc(100);
                const fd = fs.openSync(tempFile, 'r');
                fs.readSync(fd, headerBuffer, 0, 100, 0);
                fs.closeSync(fd);

                const isZip = headerBuffer.subarray(0, 4).toString('hex') === '504b0304';
                const ext = isZip ? '.zip' : (/\.ass/i.test(dlUrl) ? '.ass' : '.zip');
                const cleanFileName = getSafeTelegramFileName(titleLine, ext);
                const finalPath = path.join(OUT_DIR, cleanFileName);

                fs.renameSync(tempFile, finalPath);

                const caption = formatCleanCaption(titleLine, isZip);
                console.log(`   📤 Publishing to channel: "${caption}"`);
                const sendResult = await sendDocument(finalPath, caption);

                if (sendResult?.ok) {
                  console.log(`   ✅ Successfully posted!`);
                  newFound++;
                  posted.add(msgKey);
                  posted.add(normKey);
                  savePostedIds(posted);
                }

                fs.rmSync(finalPath, { force: true });
                continue;
              } catch (e) {
                console.warn(`   ⚠️ Direct download failed for ${dlUrl}:`, e.message);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('Telegram channel listener error:', err.message);
  } finally {
    try { await client.disconnect(); } catch {}
  }

  savePostedIds(posted);
  console.log(`\n🏁 Telegram check finished. Processed ${newFound} new release(s).\n`);
}
