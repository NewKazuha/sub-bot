import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { CONFIG } from './config.mjs';
import { scrapePostPage } from './site-scrapers.mjs';
import { sendDocument } from './telegram.mjs';

const POSTED_FILE = path.resolve('data', 'posted.json');
const OUT_DIR = path.resolve('temp_extracted');

// ====================================================================
// Source channel IDs
// ====================================================================
const CHANNEL_KOKOBOKO   = '1224725097';   // KokoBoko [Subdl]
const CHANNEL_FANSUB     = '1031770723';   // Arabic Anime Publisher
const CHANNEL_ERAI       = '2084152036';   // Erai-Raws

// ====================================================================
// Source abbreviation mapping for Erai-Raws
// ====================================================================
const SOURCE_ABBREV = {
  'crunchyroll': 'CR',
  'hidive':      'HIDIVE',
  'netflix':     'NF',
  'disney+':     'DSNP',
  'amazon':      'AMZN',
  'amazon prime': 'AMZN',
  'shahid':      'Shahid',
  'funimation':  'Funi',
  'bilibili':    'B-Global',
  'adi':         'ADI',
  'abema':       'ABEMA',
};

// ====================================================================
// Utility helpers (posted IDs, normalization, naming)
// ====================================================================
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

  if (/^\[[^\]]+\]/.test(rawTitle)) {
    return rawTitle;
  }

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

export function validateFileMagic(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 50) return null;

    const buf = Buffer.alloc(100);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, 100, 0);
    fs.closeSync(fd);

    const headerStr = buf.toString('utf8');

    if (/^\s*<!DOCTYPE\s+html/i.test(headerStr) || /^\s*<html/i.test(headerStr)) {
      return null;
    }

    const hex4 = buf.subarray(0, 4).toString('hex');
    const hex6 = buf.subarray(0, 6).toString('hex');

    if (hex4 === '504b0304' || hex4 === '504b0506') return { ext: '.zip', isArchive: true };
    if (hex6 === '377abcaf271c') return { ext: '.7z', isArchive: true };
    if (hex4 === '52617221') return { ext: '.rar', isArchive: true };
    if (headerStr.includes('[Script Info]') || headerStr.includes('Dialogue:') || headerStr.includes('Format:')) return { ext: '.ass', isArchive: false };
    if (/^\s*1\s*\r?\n\d\d:\d\d:\d\d/m.test(headerStr)) return { ext: '.srt', isArchive: false };

    return null;
  } catch (e) {
    return null;
  }
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

// ====================================================================
// SUBDL & Top4Top URL resolvers
// ====================================================================
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

async function resolveTop4topDownloadUrl(top4topUrl) {
  try {
    const res = await fetch(top4topUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const doc = cheerio.load(html);
    let directUrl = null;
    doc('input[value*="top4top.io/"]').each((_, el) => {
      const val = doc(el).attr('value') || '';
      if (val.startsWith('http')) {
        directUrl = val;
        return false;
      }
    });
    if (!directUrl) {
      doc('a[href*="top4top.io/f_"]').each((_, el) => {
        directUrl = doc(el).attr('href');
        return false;
      });
    }
    return directUrl;
  } catch (e) {
    return null;
  }
}

// ====================================================================
// Erai-Raws helpers
// ====================================================================

/**
 * Parse an Erai-Raws Telegram message.
 * Returns { title, source, sourceAbbrev, hasArabic, torrentUrl, nyaaUrl } or null.
 */
function parseEraiMessage(msg) {
  const text = msg.message || '';

  // Extract "Title:" line
  const titleMatch = text.match(/Title:\s*(.+)/i);
  if (!titleMatch) return null;
  const title = titleMatch[1].trim();

  // Extract "Source:" line
  const sourceMatch = text.match(/Source:\s*(.+)/i);
  const source = sourceMatch ? sourceMatch[1].trim() : '';

  // Check for Arabic flag 🇸🇦
  const hasArabic = text.includes('🇸🇦');

  // Get source abbreviation
  const srcLower = source.toLowerCase();
  const sourceAbbrev = SOURCE_ABBREV[srcLower] || source;

  // Extract URLs from entities (hyperlinks in "View Link" and "Torrent Link")
  let nyaaUrl = '';
  let torrentUrl = '';
  if (msg.entities) {
    for (const ent of msg.entities) {
      if (ent.className === 'MessageEntityTextUrl' && ent.url) {
        if (ent.url.includes('.torrent')) {
          torrentUrl = ent.url;
        } else if (ent.url.includes('nyaa.si/view/')) {
          nyaaUrl = ent.url;
        }
      }
    }
  }

  return { title, source, sourceAbbrev, hasArabic, torrentUrl, nyaaUrl };
}

/**
 * Check if aria2c and mkvextract are available (GitHub Actions environment).
 */
function hasRequiredTools() {
  try {
    execSync('aria2c --version', { stdio: 'ignore' });
    execSync('mkvextract --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Download torrent via aria2c → extract Arabic subtitle track via mkvextract.
 * Returns the path to the extracted .ass file, or null on failure.
 */
async function downloadAndExtractArabicSub(torrentUrl, workDir) {
  // 1. Download the .torrent file
  const torrentPath = path.join(workDir, 'erai.torrent');
  await downloadFileToDisk(torrentUrl, torrentPath);
  console.log(`   📥 Torrent file downloaded (${fs.statSync(torrentPath).size} bytes)`);

  // 2. Download the MKV via aria2c
  const downloadDir = path.join(workDir, 'mkv_dl');
  fs.mkdirSync(downloadDir, { recursive: true });
  try {
    console.log(`   📥 Downloading MKV via aria2c...`);
    execSync(
      `aria2c --seed-time=0 --max-upload-limit=1K --file-allocation=none ` +
      `--max-concurrent-downloads=5 --split=5 --max-connection-per-server=5 ` +
      `--continue=true --dir="${downloadDir}" "${torrentPath}"`,
      { stdio: 'pipe', timeout: 10 * 60 * 1000 } // 10 min timeout
    );
  } catch (e) {
    console.error(`   ❌ aria2c download failed:`, e.message?.slice(0, 200));
    return null;
  }

  // 3. Find the MKV file
  const mkvFiles = [];
  function findMkvs(dir) {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      if (fs.statSync(fp).isDirectory()) findMkvs(fp);
      else if (f.toLowerCase().endsWith('.mkv')) mkvFiles.push(fp);
    }
  }
  findMkvs(downloadDir);

  if (mkvFiles.length === 0) {
    console.warn(`   ⚠️ No .mkv files found after aria2c download.`);
    return null;
  }

  const mkvPath = mkvFiles[0];
  console.log(`   🎬 MKV found: ${path.basename(mkvPath)} (${(fs.statSync(mkvPath).size / 1024 / 1024).toFixed(1)} MB)`);

  // 4. Identify Arabic subtitle track with mkvmerge --identify
  let trackInfo;
  try {
    trackInfo = execSync(`mkvmerge --identify --identification-format json "${mkvPath}"`, {
      encoding: 'utf8',
      timeout: 30000
    });
  } catch (e) {
    console.error(`   ❌ mkvmerge identify failed:`, e.message?.slice(0, 200));
    return null;
  }

  const info = JSON.parse(trackInfo);
  const arabicTrack = info.tracks?.find(t =>
    t.type === 'subtitles' &&
    (t.properties?.language === 'ara' ||
     t.properties?.language_ietf === 'ar' ||
     t.properties?.language_ietf === 'ar-SA' ||
     (t.properties?.track_name || '').toLowerCase().includes('arabic') ||
     (t.properties?.track_name || '').toLowerCase().includes('عربي'))
  );

  if (!arabicTrack) {
    console.warn(`   ⚠️ No Arabic subtitle track found in MKV.`);
    // List available tracks for debugging
    const subTracks = (info.tracks || []).filter(t => t.type === 'subtitles');
    subTracks.forEach(t => {
      console.log(`      Track ${t.id}: lang=${t.properties?.language} ietf=${t.properties?.language_ietf} name="${t.properties?.track_name || ''}"`);
    });
    return null;
  }

  const trackId = arabicTrack.id;
  const codec = (arabicTrack.codec || '').toLowerCase();
  const subExt = codec.includes('subrip') || codec.includes('srt') ? '.srt' : '.ass';
  const extractedPath = path.join(workDir, `arabic_sub${subExt}`);

  console.log(`   🔍 Found Arabic track #${trackId} (${arabicTrack.properties?.track_name || arabicTrack.properties?.language}) codec=${arabicTrack.codec}`);

  // 5. Extract the Arabic subtitle track
  try {
    execSync(`mkvextract tracks "${mkvPath}" ${trackId}:"${extractedPath}"`, {
      stdio: 'pipe',
      timeout: 60000
    });
  } catch (e) {
    console.error(`   ❌ mkvextract failed:`, e.message?.slice(0, 200));
    return null;
  }

  if (!fs.existsSync(extractedPath) || fs.statSync(extractedPath).size < 50) {
    console.warn(`   ⚠️ Extracted subtitle is empty or missing.`);
    return null;
  }

  console.log(`   ✅ Arabic subtitle extracted: ${(fs.statSync(extractedPath).size / 1024).toFixed(1)} KB`);

  // 6. Delete the large MKV to free space
  try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(torrentPath, { force: true }); } catch {}

  return extractedPath;
}

// ====================================================================
// Main check function
// ====================================================================
export async function checkTelegramChannels() {
  const sessionStr = CONFIG.TELEGRAM.SESSION;
  if (!sessionStr) {
    console.warn('No Telegram SESSION found in config.');
    return;
  }

  const posted = loadPostedIds();
  let newFound = 0;
  const toolsAvailable = hasRequiredTools();

  console.log(`\n📡 [Telegram MTProto Client] Connecting to Telegram...`);
  if (!toolsAvailable) console.log(`   ⚠️ aria2c/mkvextract not found – Erai-Raws processing will be skipped.`);

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

      const isFansubPublisher = idStr.includes(CHANNEL_FANSUB)  || title.includes('arabic anime publisher');
      const isOfficialKokoboko = idStr.includes(CHANNEL_KOKOBOKO) || title.includes('kokoboko [subdl]');
      const isEraiRaws = idStr.includes(CHANNEL_ERAI) || title.includes('erai-raws');

      return isFansubPublisher || isOfficialKokoboko || isEraiRaws;
    });

    console.log(`   Found ${targetSourceChats.length} targeted source channel(s):`);
    targetSourceChats.forEach(c => console.log(`   - ${c.title} (ID: ${c.id})`));

    fs.mkdirSync(OUT_DIR, { recursive: true });

    for (const chat of targetSourceChats) {
      const idStr = String(chat.id);
      const titleLower = (chat.title || '').toLowerCase();
      const isKokoboko = idStr.includes(CHANNEL_KOKOBOKO) || titleLower.includes('kokoboko');
      const isErai     = idStr.includes(CHANNEL_ERAI)     || titleLower.includes('erai-raws');

      console.log(`\n🔍 Checking: "${chat.title}" (ID: ${chat.id})`);
      const msgs = await client.getMessages(chat.id, { limit: 10 });

      for (const msg of msgs) {
        const msgKey = `tg_${chat.id}_${msg.id}`;
        if (posted.has(msgKey)) continue;

        const text = msg.message || '';

        // ==============================================================
        // CHANNEL 3: Erai-Raws (Official Subtitles via Torrent)
        // ==============================================================
        if (isErai) {
          const eraiData = parseEraiMessage(msg);
          if (!eraiData) continue;

          // Only process releases with Arabic subtitles
          if (!eraiData.hasArabic) {
            posted.add(msgKey);
            savePostedIds(posted);
            continue;
          }

          const formattedTitle = `[${eraiData.sourceAbbrev}] ${eraiData.title}`;
          const normKey = normalizeReleaseKey(formattedTitle);

          if (posted.has(normKey)) {
            posted.add(msgKey);
            savePostedIds(posted);
            continue;
          }

          if (!toolsAvailable) {
            console.log(`   ⏭️ [Erai-Raws] Skipping "${formattedTitle}" – aria2c/mkvextract not available.`);
            continue;
          }

          if (!eraiData.torrentUrl) {
            console.warn(`   ⚠️ [Erai-Raws] No torrent URL found for "${formattedTitle}". Skipping.`);
            continue;
          }

          console.log(`\n✨ [Erai-Raws] "${formattedTitle}"`);
          console.log(`   📦 Source: ${eraiData.source} → [${eraiData.sourceAbbrev}]`);
          console.log(`   🔗 Torrent: ${eraiData.torrentUrl}`);

          const eraiWorkDir = path.join(OUT_DIR, `erai_${msg.id}`);
          fs.mkdirSync(eraiWorkDir, { recursive: true });

          try {
            const extractedSubPath = await downloadAndExtractArabicSub(eraiData.torrentUrl, eraiWorkDir);

            if (extractedSubPath) {
              const subExt = path.extname(extractedSubPath);
              const cleanFileName = getSafeTelegramFileName(formattedTitle, subExt);
              const finalPath = path.join(OUT_DIR, cleanFileName);
              fs.renameSync(extractedSubPath, finalPath);

              const caption = formattedTitle;
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
            }
          } catch (e) {
            console.error(`   ❌ Erai-Raws processing error:`, e.message);
          } finally {
            try { fs.rmSync(eraiWorkDir, { recursive: true, force: true }); } catch {}
          }

          continue;
        }

        // ==============================================================
        // Build title for KokoBoko / Fansub channels
        // ==============================================================
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const titleLine = isKokoboko ? formatCleanTitle(lines[0] || 'Anime Release') : extractTeamAndFormatTitle(text);
        const normKey = normalizeReleaseKey(titleLine);

        if (posted.has(normKey)) {
          posted.add(msgKey);
          savePostedIds(posted);
          continue;
        }

        // ==============================================================
        // CHANNEL 1: KokoBoko [Subdl] (Official Subtitles)
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

                const validated = validateFileMagic(tempDownload);
                if (!validated) {
                  console.warn(`   ⚠️ Downloaded SUBDL file was invalid or HTML. Skipping.`);
                  fs.rmSync(tempDownload, { force: true });
                  continue;
                }

                const cleanFileName = getSafeTelegramFileName(titleLine, validated.ext);
                const finalPath = path.join(OUT_DIR, cleanFileName);
                fs.renameSync(tempDownload, finalPath);

                const caption = formatCleanCaption(titleLine, validated.isArchive);
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
        // CHANNEL 2: Arabic Anime Publisher (Fansub Releases)
        // ==============================================================
        // Case A: Direct file attached to the message
        if (msg.media && msg.media.document) {
          const doc = msg.media.document;
          const originalName = doc.attributes?.find(a => a.fileName)?.fileName || `sub_${msg.id}.ass`;
          const ext = path.extname(originalName).toLowerCase();

          if (['.ass', '.srt', '.zip', '.rar', '.7z'].includes(ext)) {
            console.log(`\n✨ [Fansub Attachment] "${titleLine}" (${originalName})`);
            const localFilePath = path.join(OUT_DIR, originalName);

            const buffer = await client.downloadMedia(msg);
            fs.writeFileSync(localFilePath, buffer);

            const validated = validateFileMagic(localFilePath);
            if (validated) {
              const caption = formatCleanCaption(titleLine, validated.isArchive);
              console.log(`   📤 Publishing to channel: "${caption}"`);
              const sendResult = await sendDocument(localFilePath, caption);

              if (sendResult?.ok) {
                console.log(`   ✅ Successfully posted!`);
                newFound++;
                posted.add(msgKey);
                posted.add(normKey);
                savePostedIds(posted);
              }
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
            let dlUrl = pageData.bestDownloadUrl;
            console.log(`   🎯 Download link found: ${dlUrl}`);

            if (dlUrl.includes('top4top.io') && !dlUrl.includes('/f_')) {
              const resolvedTop4top = await resolveTop4topDownloadUrl(dlUrl);
              if (resolvedTop4top) dlUrl = resolvedTop4top;
            }

            if (/\.(ass|srt|zip|rar|7z)$/i.test(dlUrl) || dlUrl.includes('top4top.io')) {
              try {
                const tempFile = path.join(OUT_DIR, `fansub_dl_${msg.id}`);
                await downloadFileToDisk(dlUrl, tempFile, { Referer: postPageUrl });

                const validated = validateFileMagic(tempFile);
                if (!validated) {
                  console.warn(`   ⚠️ Downloaded fansub file was invalid/HTML (not a valid subtitle/archive). Skipping.`);
                  fs.rmSync(tempFile, { force: true });
                  continue;
                }

                const cleanFileName = getSafeTelegramFileName(titleLine, validated.ext);
                const finalPath = path.join(OUT_DIR, cleanFileName);
                fs.renameSync(tempFile, finalPath);

                const caption = formatCleanCaption(titleLine, validated.isArchive);
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
