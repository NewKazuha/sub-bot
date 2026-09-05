import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import AdmZip from 'adm-zip';
import { CONFIG } from './config.mjs';
import { scrapePostPage } from './site-scrapers.mjs';
import { sendDocument } from './telegram.mjs';
import {
  findBestFileInMegaFolder,
  downloadMegaNode,
  findBestFileInMediafire,
  findBestFileInDrive,
  resolveMediafireDirectDownload
} from './cloud-folders.mjs';

const POSTED_FILE = path.resolve('data', 'posted.json');
const OUT_DIR = path.resolve('temp_extracted');
const HTTP_TIMEOUT_MS = 60_000;

function fetchWithTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  return fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(timeoutMs) });
}

export function safeMoveFile(src, dest) {
  if (!fs.existsSync(src)) return false;
  try {
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { force: true });
    }
    fs.renameSync(src, dest);
    return true;
  } catch {
    try {
      fs.copyFileSync(src, dest);
      fs.rmSync(src, { force: true });
      return true;
    } catch (e) {
      console.error(`Failed to move file ${src} -> ${dest}:`, e.message);
      return false;
    }
  }
}

// ====================================================================
// Source channel IDs
// ====================================================================
const CHANNEL_KOKOBOKO   = '1224725097';   // KokoBoko [Subdl] (Official)
const CHANNEL_RENGOKU    = '2217287273';   // Rengoku [Subdl] (Official)
const CHANNEL_ERAI       = '2084152036';   // Erai-Raws (Official)
const CHANNEL_LAZYSANO   = '1650610194';   // LazySano (Fansub)
const CHANNEL_FANSUB     = '1031770723';   // Arabic Anime Publisher (Fansub)

// ====================================================================
// Source abbreviation mapping to full official platform names
// ====================================================================
const SOURCE_FULL_NAME = {
  'cr':           'Crunchyroll',
  'crunchyroll':  'Crunchyroll',
  'hidive':       'HIDIVE',
  'nf':           'Netflix',
  'netflix':      'Netflix',
  'dsnp':         'Disney+',
  'disney+':      'Disney+',
  'disney':       'Disney+',
  'amzn':         'Amazon',
  'amazon':       'Amazon',
  'amazon prime': 'Amazon',
  'prime':        'Amazon',
  'shahid':       'Shahid',
  'funimation':   'Funimation',
  'funi':         'Funimation',
  'bilibili':     'Bilibili',
  'b-global':     'B-Global',
  'adn':          'ADN',
  'adi':          'ADN',
  'abema':        'ABEMA',
};

// ====================================================================
// ====================================================================
// Popular / Airing Anime Cross-Language Canonical Mapping
// ====================================================================
const ANIME_ALIASES = [
  { pattern: /bleach.*(?:sennen|thousand|tybw)/i, canon: 'bleach_tybw' },
  { pattern: /(?:dungeon.*deai|danmachi|is\s+it\s+wrong\s+to\s+try\s+to\s+pick)/i, canon: 'danmachi' },
  { pattern: /(?:kimetsu.*yaiba|demon\s*slayer)/i, canon: 'demon_slayer' },
  { pattern: /(?:boku\s*no\s*hero|my\s*hero\s*academia|mha)/i, canon: 'my_hero_academia' },
  { pattern: /(?:sousou\s*no\s*frieren|frieren)/i, canon: 'frieren' },
  { pattern: /(?:yomi\s*no\s*tsugai|daemons\s*of\s*the\s*shadow\s*realm)/i, canon: 'yomi_no_tsugai' },
  { pattern: /(?:jujutsu\s*kaisen|jjk)/i, canon: 'jujutsu_kaisen' },
  { pattern: /(?:chainsaw\s*man)/i, canon: 'chainsaw_man' },
  { pattern: /(?:one\s*piece)/i, canon: 'one_piece' },
  { pattern: /(?:shingeki.*kyojin|attack\s*on\s*titan)/i, canon: 'attack_on_titan' },
  { pattern: /(?:kage\s*no\s*jitsuryokusha|eminence\s*in\s*shadow)/i, canon: 'eminence_in_shadow' },
  { pattern: /(?:mushoku\s*tensei|jobless\s*reincarnation)/i, canon: 'mushoku_tensei' },
  { pattern: /(?:oshi\s*no\s*ko)/i, canon: 'oshi_no_ko' },
  { pattern: /(?:blue\s*lock)/i, canon: 'blue_lock' },
  { pattern: /(?:spy.*family)/i, canon: 'spy_family' },
  { pattern: /(?:solo\s*leveling)/i, canon: 'solo_leveling' },
  { pattern: /(?:kaiju.*(?:no.*)?8)/i, canon: 'kaiju_8' },
  { pattern: /(?:youjo\s*senki|youjo\s*shenki|saga\s*of\s*tanya)/i, canon: 'youjo_senki' },
  { pattern: /(?:re:\s*zero|rezero)/i, canon: 'rezero' },
  { pattern: /(?:shangri.*la\s*frontier)/i, canon: 'shangri_la_frontier' },
  { pattern: /(?:sakamoto\s*days)/i, canon: 'sakamoto_days' },
  { pattern: /(?:clevatess)/i, canon: 'clevatess' },
  { pattern: /(?:ranma\s*(?:1\/2|\xBD)?)/i, canon: 'ranma' },
  { pattern: /(?:dr\.\s*stone|doctor\s*stone)/i, canon: 'dr_stone' },
  { pattern: /(?:wind\s*breaker)/i, canon: 'wind_breaker' },
  { pattern: /(?:tower\s*of\s*god|kami\s*no\s*tou)/i, canon: 'tower_of_god' },
  { pattern: /(?:uzumaki)/i, canon: 'uzumaki' },
  { pattern: /(?:blue\s*exorcist|ao\s*no\s*exorcist)/i, canon: 'ao_no_exorcist' },
  { pattern: /(?:fairy\s*tail)/i, canon: 'fairy_tail' },
  { pattern: /(?:slimes?.*(?:tensei|reincarnated)|tensei.*shitara.*slime)/i, canon: 'tensei_slime' },
  { pattern: /(?:tsue\s*to\s*tsurugi|wistoria)/i, canon: 'wistoria' },
  { pattern: /(?:nige\s*jouzu|elusive\s*samurai)/i, canon: 'elusive_samurai' },
  { pattern: /(?:makeine|too\s*many\s*losing\s*heroines)/i, canon: 'makeine' },
  { pattern: /(?:gimai\s*seikatsu|days\s*with\s*my\s*stepsister)/i, canon: 'gimai_seikatsu' },
  { pattern: /(?:roshidere|alya\s*sometimes\s*hides)/i, canon: 'roshidere' },
  { pattern: /(?:dungeon\s*meshi|delicious\s*in\s*dungeon)/i, canon: 'dungeon_meshi' },
  { pattern: /(?:tsukimichi|moonlit\s*fantasy)/i, canon: 'tsukimichi' },
  { pattern: /(?:sekai\s*saikyou\s*no\s*kouei|strongest\s*rearguard)/i, canon: 'sekai_saikyou_kouei' },
  { pattern: /(?:seihantai\s*na\s*kimi|polar\s*opposites)/i, canon: 'seihantai_kimi' },
  { pattern: /(?:tetsunabe\s*no\s*jan|iron\s*wok\s*jan)/i, canon: 'tetsunabe_jan' },
  { pattern: /(?:kaiki[-_\s]*gumi)/i, canon: 'kaiki_gumi' },
  { pattern: /(?:digimon\s*beatbreak)/i, canon: 'digimon_beatbreak' },
  { pattern: /(?:kidou\s*senkan\s*nadesico|nadesico)/i, canon: 'nadesico' },
  { pattern: /(?:hell\s*mode)/i, canon: 'hell_mode' },
  { pattern: /(?:katainaka\s*no\s*ossan)/i, canon: 'katainaka_ossan' },
  { pattern: /(?:super\s*no\s*ura)/i, canon: 'super_no_ura' }
];

// ====================================================================
// Utility helpers (posted IDs, normalization, naming, deduplication)
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

export function extractEpisodeNumber(text) {
  if (!text) return '';
  const cleaned = text.replace(/\[\+fonts?\]|\.ass|\.srt|\.zip|\.rar|\.7z/gi, '');
  
  // Match patterns like: " - 46", " E46", " EP46", " Episode 46", " #46", " [46]", " 46"
  const m = cleaned.match(/(?:-\s*|ep(?:isode)?\s*|e\s*|#\s*|\s+)(\d{1,4})(?:\s*v\d+)?(?:\s*\[|\s*\(|\s*\.|\s*$)/i);
  if (m) return m[1].replace(/^0+/, '') || '0';
  return '';
}

export function getCoreAnimeEpisodeKey(title) {
  return title
    .toLowerCase()
    .replace(/\[\+fonts?\]|\.ass|\.srt|\.zip|\.rar|\.7z/gi, '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/Ⅱ/g, '2')
    .replace(/Ⅲ/g, '3')
    .replace(/Ⅳ/g, '4')
    .replace(/Ⅴ/g, '5')
    .replace(/Ⅵ/g, '6')
    .replace(/&amp;/g, '&')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
}

export function getCanonicalAnimeKey(title) {
  const norm = title
    .toLowerCase()
    .replace(/Ⅱ/g, '2')
    .replace(/Ⅲ/g, '3')
    .replace(/Ⅳ/g, '4')
    .replace(/Ⅴ/g, '5')
    .replace(/Ⅵ/g, '6');

  for (const alias of ANIME_ALIASES) {
    if (alias.pattern.test(norm)) {
      return alias.canon;
    }
  }
  return null;
}

export function getReleaseKeys(title, isOfficial = false) {
  const fullNorm = title
    .toLowerCase()
    .replace(/\[\+fonts?\]|\.ass|\.srt|\.zip|\.rar|\.7z/gi, '')
    .replace(/Ⅱ/g, '2')
    .replace(/Ⅲ/g, '3')
    .replace(/Ⅳ/g, '4')
    .replace(/Ⅴ/g, '5')
    .replace(/Ⅵ/g, '6')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');

  const coreKey = getCoreAnimeEpisodeKey(title);
  const canonName = getCanonicalAnimeKey(title);
  const epNum = extractEpisodeNumber(title);

  const keys = [fullNorm];
  if (coreKey) keys.push(coreKey);

  if (canonName && epNum) {
    keys.push(`canon_${canonName}_ep_${epNum}`);
  }

  // Generate prefix token keys from core anime words to bridge novel titles and short titles
  if (coreKey && epNum) {
    const words = coreKey.split('_').filter(w => w && w !== epNum && !/^(?:season|s\d+|2nd|3rd|4th|part|the|and|no|wa|ga|to|de|ni|mo|na|202\d)$/i.test(w));
    if (words.length >= 2) {
      const prefix2 = words.slice(0, 2).join('_');
      const prefix3 = words.slice(0, 3).join('_');
      const prefix4 = words.slice(0, 4).join('_');
      keys.push(`token_ep_${epNum}_${prefix2}`);
      keys.push(`token_ep_${epNum}_${prefix3}`);
      keys.push(`token_ep_${epNum}_${prefix4}`);
      if (isOfficial) {
        keys.push(`official_ep_${epNum}_${prefix2}`);
        keys.push(`official_ep_${epNum}_${prefix3}`);
        keys.push(`official_ep_${epNum}_${prefix4}`);
      }
    }
  }

  if (isOfficial) {
    if (canonName && epNum) {
      keys.push(`official_${canonName}_ep_${epNum}`);
    }
    if (coreKey) {
      keys.push(`official_${coreKey}`);
    }
    if (epNum && coreKey) {
      keys.push(`official_ep_${epNum}_${coreKey.slice(0, 20)}`);
    }
  }

  return Array.from(new Set(keys.filter(Boolean)));
}

// Fansub releases are deliberately deduplicated within the same team only.
// An official release (or another fansub team's release) must not suppress a
// team's own subtitle merely because the anime title and episode match.
export function getFansubReleaseKeys(title) {
  const fullNorm = title
    .toLowerCase()
    .replace(/\[\+fonts?\]|\.ass|\.srt|\.zip|\.rar|\.7z/gi, '')
    .replace(/Ⅱ/g, '2')
    .replace(/Ⅲ/g, '3')
    .replace(/Ⅳ/g, '4')
    .replace(/Ⅴ/g, '5')
    .replace(/Ⅵ/g, '6')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  const teamMatch = title.match(/^\[([^\]]+)\]/);
  const teamKey = (teamMatch?.[1] || 'unknown')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  const coreKey = getCoreAnimeEpisodeKey(title);
  const canonName = getCanonicalAnimeKey(title);
  const epNum = extractEpisodeNumber(title);
  const keys = [`fansub_${teamKey}_${fullNorm}`];

  if (epNum && (canonName || coreKey)) {
    keys.push(`fansub_${teamKey}_${canonName || coreKey}_ep_${epNum}`);
  }

  return Array.from(new Set(keys.filter(Boolean)));
}

export function isReleaseAlreadyPosted(posted, keys) {
  return keys.some(k => posted.has(k));
}

export function markReleaseAsPosted(posted, msgKey, keys = []) {
  if (msgKey) posted.add(msgKey);
  for (const k of keys) {
    if (k) posted.add(k);
  }
  savePostedIds(posted);
}

export function formatCleanTitle(raw) {
  return raw
    .replace(/^[📍📌🎬\s]+/, '')
    .replace(/\[\+fonts?\]/gi, '')
    .trim();
}

function isOfficialPlatformRelease(title) {
  return /^\[\s*(?:cr(?:unchyroll)?|nf|netflix|dsnp|disney\+?|amzn|amazon(?:\s+prime)?|prime|hidive|shahid|bilibili|b-global|adn|abema|erai[-_\s]*raws)\s*\]/i.test(title);
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

export function formatCleanCaption(title, isZip = false, isOfficial = false) {
  let clean = formatCleanTitle(title);
  const isOfficialPlatform = isOfficial || isOfficialPlatformRelease(clean);
  if (isZip && !isOfficialPlatform && !clean.toLowerCase().includes('[+fonts]')) {
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
  const signal = AbortSignal.timeout(10 * 60 * 1000);
  const requestOptions = {
    signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      ...headers
    }
  };
  let res = await fetch(url, requestOptions);

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  // Large public Google Drive files first return an HTML virus-scan warning.
  // Submit its public, one-time confirmation parameters before saving; without
  // this the extractor receives HTML instead of the MKV/subtitle file.
  const isGoogleDrive = /(?:drive\.google\.com|drive\.usercontent\.google\.com)/i.test(`${url} ${res.url}`);
  if (isGoogleDrive && /text\/html/i.test(res.headers.get('content-type') || '')) {
    const html = await res.text();
    const $ = cheerio.load(html);
    const form = $('form').first();
    const action = form.attr('action');
    const params = new URLSearchParams();
    form.find('input[name]').each((_, input) => {
      const name = $(input).attr('name');
      const value = $(input).attr('value') || '';
      if (name) params.set(name, value);
    });

    if (action && params.has('confirm')) {
      const confirmedUrl = new URL(action, res.url);
      confirmedUrl.search = params.toString();
      console.log('   ↪️ Confirming public Google Drive download.');
      res = await fetch(confirmedUrl, requestOptions);
      if (!res.ok) throw new Error(`Google Drive confirmation returned HTTP ${res.status}`);
    }
  }

  if (/text\/html/i.test(res.headers.get('content-type') || '')) {
    throw new Error('Download returned HTML instead of a file');
  }

  const fileStream = fs.createWriteStream(destPath, { flags: 'w' });
  await finished(Readable.fromWeb(res.body).pipe(fileStream));
  return destPath;
}

// ====================================================================
// SUBDL, Top4Top, and Mediafire resolvers
// ====================================================================
async function resolveSubdlDownloadUrl(infoUrl) {
  try {
    const res = await fetchWithTimeout(infoUrl, {
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
    const res = await fetchWithTimeout(top4topUrl, {
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

async function resolveMediafireDownloadUrl(mfUrl) {
  try {
    const res = await fetchWithTimeout(mfUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const doc = cheerio.load(html);
    const dlBtn = doc('#downloadButton').attr('href') || doc('a[aria-label="Download file"]').attr('href');
    if (dlBtn && dlBtn.startsWith('http')) return dlBtn;
    return null;
  } catch (e) {
    return null;
  }
}

function parseEraiMessage(msg) {
  const text = msg.message || '';

  const titleMatch = text.match(/Title:\s*(.+)/i);
  if (!titleMatch) return null;
  const title = titleMatch[1].trim();

  const sourceMatch = text.match(/Source:\s*(.+)/i);
  const source = sourceMatch ? sourceMatch[1].trim() : '';

  const hasArabic = text.includes('🇸🇦');

  const srcLower = source.toLowerCase().trim();
  const sourceName = SOURCE_FULL_NAME[srcLower] || source || 'Official';

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

  return { title, source, sourceName, hasArabic, torrentUrl, nyaaUrl };
}

function hasRequiredTools() {
  try {
    execSync('aria2c --version', { stdio: 'ignore' });
    execSync('mkvextract --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Extraction rule:
// If isOfficial = true (e.g. Erai-Raws), strictly extract .ass ONLY, NO fonts, NO zip.
// If isOfficial = false (e.g. Fansub), extract fonts and zip into [+Fonts].zip if fonts present.
function extractSubtitleAndFontsFromAnyFile(filePath, workDir, isOfficial = false, preferArabic = false) {
  if (!fs.existsSync(filePath)) return null;

  // 1. Direct valid archive or subtitle file
  const magic = validateFileMagic(filePath);
  if (magic) {
    return { filePath, isArchive: magic.isArchive, ext: magic.ext };
  }

  // 2. MKV / Video file with softsubs & fonts
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mkv' || ext === '.mp4' || ext === '.m4v') {
    try {
      const trackInfo = execSync(`mkvmerge --identify --identification-format json "${filePath}"`, {
        encoding: 'utf8',
        timeout: 30000
      });
      const info = JSON.parse(trackInfo);
      const subTracks = (info.tracks || []).filter(t => t.type === 'subtitles');
      if (subTracks.length === 0) return null;

      let selectedTrack = subTracks.find(t =>
        t.properties?.language === 'ara' ||
        t.properties?.language_ietf === 'ar' ||
        t.properties?.language_ietf === 'ar-SA' ||
        (t.properties?.track_name || '').toLowerCase().includes('arabic') ||
        (t.properties?.track_name || '').toLowerCase().includes('عربي')
      );

      if (!selectedTrack && !preferArabic) {
        selectedTrack = subTracks[0];
      }

      if (!selectedTrack) return null;

      const trackId = selectedTrack.id;
      const codec = (selectedTrack.codec || '').toLowerCase();
      const subExt = codec.includes('subrip') || codec.includes('srt') ? '.srt' : '.ass';
      const extractedSubPath = path.join(workDir, `extracted_sub${subExt}`);

      execSync(`mkvextract tracks "${filePath}" ${trackId}:"${extractedSubPath}"`, {
        stdio: 'pipe',
        timeout: 60000
      });

      if (!fs.existsSync(extractedSubPath) || fs.statSync(extractedSubPath).size < 50) return null;

      // Official releases (Erai-Raws) strictly receive .ass ONLY - no font extraction, no zip!
      if (isOfficial) {
        return { filePath: extractedSubPath, isArchive: false, ext: subExt };
      }

      // Fansub releases: extract fonts if present and package in .zip
      const attachments = (info.attachments || []).filter(a => {
        const fn = (a.file_name || '').toLowerCase();
        return fn.endsWith('.ttf') || fn.endsWith('.otf') || fn.endsWith('.ttc') || fn.endsWith('.woff') || fn.endsWith('.woff2');
      });

      if (attachments.length > 0) {
        console.log(`   📦 [Fansub] Found ${attachments.length} font attachment(s). Extracting and archiving with AdmZip...`);
        const fontsDir = path.join(workDir, 'fonts');
        fs.mkdirSync(fontsDir, { recursive: true });

        const extractArgs = attachments.map(a => `${a.id}:"${path.join(fontsDir, a.file_name)}"`).join(' ');
        try {
          execSync(`mkvextract attachments "${filePath}" ${extractArgs}`, { stdio: 'pipe', timeout: 60000 });
          const zipPath = path.join(workDir, 'release_fonts.zip');
          
          const zip = new AdmZip();
          zip.addLocalFile(extractedSubPath);
          for (const f of fs.readdirSync(fontsDir)) {
            const fontFile = path.join(fontsDir, f);
            if (fs.statSync(fontFile).isFile()) {
              zip.addLocalFile(fontFile);
            }
          }
          zip.writeZip(zipPath);

          if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 100) {
            return { filePath: zipPath, isArchive: true, ext: '.zip' };
          }
        } catch (e) {
          console.warn('   ⚠️ Font extraction/zipping error:', e.message);
        }
      }

      return { filePath: extractedSubPath, isArchive: false, ext: subExt };
    } catch (e) {
      console.warn('   ⚠️ MKV extraction error:', e.message);
      return null;
    }
  }

  return null;
}

async function downloadAndExtractSubtitleFromTorrent(torrentUrl, workDir, isOfficial = false, preferArabic = true) {
  const torrentPath = path.join(workDir, 'release.torrent');
  await downloadFileToDisk(torrentUrl, torrentPath);
  console.log(`   📥 Torrent file downloaded (${fs.statSync(torrentPath).size} bytes)`);

  const downloadDir = path.join(workDir, 'mkv_dl');
  fs.mkdirSync(downloadDir, { recursive: true });
  try {
    console.log(`   📥 Downloading MKV via aria2c...`);
    execSync(
      `aria2c --seed-time=0 --max-upload-limit=1K --file-allocation=none ` +
      `--max-concurrent-downloads=5 --split=5 --max-connection-per-server=5 ` +
      `--continue=true --dir="${downloadDir}" "${torrentPath}"`,
      { stdio: 'pipe', timeout: 10 * 60 * 1000 }
    );
  } catch (e) {
    console.error(`   ❌ aria2c download failed:`, e.message?.slice(0, 200));
    return null;
  }

  const mkvFiles = [];
  function findMkvs(dir) {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      if (fs.statSync(fp).isDirectory()) findMkvs(fp);
      else if (f.toLowerCase().endsWith('.mkv')) mkvFiles.push(fp);
    }
  }
  findMkvs(downloadDir);

  if (mkvFiles.length === 0) return null;

  const mkvPath = mkvFiles[0];
  console.log(`   🎬 MKV found: ${path.basename(mkvPath)} (${(fs.statSync(mkvPath).size / 1024 / 1024).toFixed(1)} MB)`);

  const result = extractSubtitleAndFontsFromAnyFile(mkvPath, workDir, isOfficial, preferArabic);

  try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(torrentPath, { force: true }); } catch {}

  return result;
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
  if (!toolsAvailable) console.log(`   ⚠️ aria2c/mkvextract not found in this environment – Torrent/Cloud extraction will run in GitHub Actions.`);

  const client = new TelegramClient(
    new StringSession(sessionStr),
    CONFIG.TELEGRAM.API_ID,
    CONFIG.TELEGRAM.API_HASH,
    { connectionRetries: 5 }
  );

  try {
    await client.connect();

    // Sync existing target channel history into posted set to eliminate any duplicates
    try {
      const targetChatId = CONFIG.TELEGRAM.TARGET_CHANNEL;
      const targetMsgs = await client.getMessages(targetChatId, { limit: 100 });
      for (const tm of targetMsgs) {
        const text = tm.message || '';
        const firstLine = text.split('\n')[0].trim();
        if (firstLine) {
          getReleaseKeys(firstLine, true).forEach(k => posted.add(k));
          getReleaseKeys(firstLine, false).forEach(k => posted.add(k));
          getFansubReleaseKeys(firstLine).forEach(k => posted.add(k));
        }
        if (tm.media?.document?.attributes) {
          const fn = tm.media.document.attributes.find(a => a.fileName)?.fileName;
          if (fn) {
            getReleaseKeys(fn, true).forEach(k => posted.add(k));
            getReleaseKeys(fn, false).forEach(k => posted.add(k));
          }
        }
      }
      console.log(`   📋 Synced ${targetMsgs.length} message(s) from target channel history to prevent duplicates.`);
    } catch (targetErr) {
      console.warn(`   ⚠️ Could not sync target channel history:`, targetErr.message);
    }

    const dialogs = await client.getDialogs({ limit: 150 });

    const targetSourceChats = dialogs.filter(d => {
      const idStr = String(d.id);
      const title = (d.title || '').toLowerCase();
      const isChatGroup = title.includes('chat') || title.includes('group') || title.includes('نقاشات') || title.includes('محادثة');
      if (isChatGroup) return false;

      const isFansubPublisher = idStr.includes(CHANNEL_FANSUB)   || title.includes('arabic anime publisher');
      const isOfficialKokoboko = idStr.includes(CHANNEL_KOKOBOKO) || title.includes('kokoboko [subdl]');
      const isOfficialRengoku  = idStr.includes(CHANNEL_RENGOKU)  || title.includes('rengoku [subdl]');
      const isEraiRaws         = idStr.includes(CHANNEL_ERAI)      || title.includes('erai-raws');
      const isLazySano         = idStr.includes(CHANNEL_LAZYSANO)  || title.includes('lazysano') || title.includes('レイジーさん');

      return isFansubPublisher || isOfficialKokoboko || isOfficialRengoku || isEraiRaws || isLazySano;
    });

    console.log(`   Found ${targetSourceChats.length} targeted source channel(s):`);
    targetSourceChats.forEach(c => console.log(`   - ${c.title} (ID: ${c.id})`));

    fs.mkdirSync(OUT_DIR, { recursive: true });

    for (const chat of targetSourceChats) {
      try {
        const idStr = String(chat.id);
        const titleLower = (chat.title || '').toLowerCase();
        const isKokoboko = idStr.includes(CHANNEL_KOKOBOKO) || titleLower.includes('kokoboko');
        const isRengoku  = idStr.includes(CHANNEL_RENGOKU)  || titleLower.includes('rengoku');
        const isErai     = idStr.includes(CHANNEL_ERAI)     || titleLower.includes('erai-raws');
        const isLazySano = idStr.includes(CHANNEL_LAZYSANO) || titleLower.includes('lazysano') || titleLower.includes('レイジーさん');
        const isFansubPublisher = idStr.includes(CHANNEL_FANSUB) || titleLower.includes('arabic anime publisher');

        console.log(`\n🔍 Checking: "${chat.title}" (ID: ${chat.id})`);
        // Sources can publish a batch far larger than one scheduled interval.
        // Keep enough history to retry a failed batch instead of losing it once
        // newer messages push it beyond the old 15-message window.
        const msgs = await client.getMessages(chat.id, { limit: 100 });

        for (const msg of msgs) {
          const msgKey = `tg_${chat.id}_${msg.id}`;
          const text = msg.message || '';
          const subdlTitle = (isKokoboko || isRengoku)
            ? formatCleanTitle(text.split('\n').map(l => l.trim()).find(Boolean) || '')
            : '';
          const isFansubSubdl = Boolean(subdlTitle) && /subdl\.com\/s\/info\//i.test(text) && !isOfficialPlatformRelease(subdlTitle);
          const retryFansubTitle = isFansubPublisher
            ? extractTeamAndFormatTitle(text)
            : subdlTitle;

          if (posted.has(msgKey)) {
            // Older releases were recorded with broad cross-source keys. A
            // source message marked by that old logic must be retried unless
            // its team-specific release key is present from the target channel.
            if (!(isFansubPublisher || isFansubSubdl) || isReleaseAlreadyPosted(posted, getFansubReleaseKeys(retryFansubTitle))) {
              continue;
            }
            console.log(`   🔁 Retrying previously skipped fansub message ${msg.id} with team-scoped deduplication.`);
          }

        // ==============================================================
        // SOURCE 1: Erai-Raws (Official Subtitles via Torrent - Strictly .ass)
        // ==============================================================
        if (isErai) {
          const eraiData = parseEraiMessage(msg);
          if (!eraiData) continue;

          if (!eraiData.hasArabic) {
            markReleaseAsPosted(posted, msgKey);
            continue;
          }

          const formattedTitle = `[${eraiData.sourceName}] ${eraiData.title}`;
          const releaseKeys = getReleaseKeys(formattedTitle, true);

          if (isReleaseAlreadyPosted(posted, releaseKeys)) {
            console.log(`   ⏭️ [Erai-Raws] "${formattedTitle}" already posted as official release. Skipping.`);
            markReleaseAsPosted(posted, msgKey, releaseKeys);
            continue;
          }

          if (!toolsAvailable) {
            console.log(`   ⏭️ [Erai-Raws] Skipping "${formattedTitle}" – aria2c/mkvextract not available locally.`);
            continue;
          }

          if (!eraiData.torrentUrl) {
            console.warn(`   ⚠️ [Erai-Raws] No torrent URL found for "${formattedTitle}". Skipping.`);
            continue;
          }

          console.log(`\n✨ [Erai-Raws Official] "${formattedTitle}"`);
          console.log(`   📦 Source: ${eraiData.source} → [${eraiData.sourceName}]`);
          console.log(`   🔗 Torrent: ${eraiData.torrentUrl}`);

          const eraiWorkDir = path.join(OUT_DIR, `erai_${msg.id}`);
          fs.mkdirSync(eraiWorkDir, { recursive: true });

          try {
            // isOfficial = true ensures strictly .ass extraction without fonts or zip
            const extracted = await downloadAndExtractSubtitleFromTorrent(eraiData.torrentUrl, eraiWorkDir, true, true);

            if (extracted && extracted.filePath) {
              const cleanFileName = getSafeTelegramFileName(formattedTitle, extracted.ext);
              const finalPath = path.join(OUT_DIR, cleanFileName);
              safeMoveFile(extracted.filePath, finalPath);

              const caption = formatCleanCaption(formattedTitle, false, true);
              console.log(`   📤 Publishing official sub: "${caption}" (filename: ${cleanFileName})`);
              const sendResult = await sendDocument(finalPath, caption);

              if (sendResult?.ok) {
                console.log(`   ✅ Successfully posted! (Message ID: ${sendResult.result?.message_id})`);
                newFound++;
                markReleaseAsPosted(posted, msgKey, releaseKeys);
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
        // SOURCE 2: Subdl Channels (KokoBoko & Rengoku - As-Is .ass or .zip)
        // ==============================================================
        if (isKokoboko || isRengoku) {
          const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
          const rawTitle = formatCleanTitle(lines[0] || 'Anime Release');
          // Rengoku also republishes Fansub releases.  Only a platform label
          // (e.g. Crunchyroll/Amazon) is an official release; team-labelled
          // messages must be deduplicated within that team, not globally.
          const isOfficialSubdl = isOfficialPlatformRelease(rawTitle);
          const releaseKeys = isOfficialSubdl
            ? getReleaseKeys(rawTitle, true)
            : getFansubReleaseKeys(rawTitle);

          if (isReleaseAlreadyPosted(posted, releaseKeys)) {
            markReleaseAsPosted(posted, msgKey, releaseKeys);
            continue;
          }

          const subdlMatch = text.match(/https?:\/\/(?:www\.)?subdl\.com\/s\/info\/[a-zA-Z0-9]+/i);
          if (subdlMatch) {
            const subdlInfoUrl = subdlMatch[0];
            console.log(`\n✨ [Subdl Official Release] "${rawTitle}"`);
            console.log(`   🌐 Resolving SUBDL link: ${subdlInfoUrl}`);
            const dlUrl = await resolveSubdlDownloadUrl(subdlInfoUrl);

            if (dlUrl) {
              try {
                console.log(`   📥 Downloading from SUBDL: ${dlUrl}`);
                const tempDownload = path.join(OUT_DIR, `temp_subdl_${msg.id}`);
                await downloadFileToDisk(dlUrl, tempDownload, { Referer: subdlInfoUrl });

                let validated = validateFileMagic(tempDownload);
                let effectiveDownloadPath = tempDownload;

                if (!validated) {
                  // Check if downloaded text file contains Top4Top / Mediafire / Mega link
                  try {
                    const textContent = fs.readFileSync(tempDownload, 'utf8');
                    const top4topMatch = textContent.match(/https?:\/\/[^\s"'<>]*top4top\.io\/[^\s"'<>]+/i);
                    const mfMatch = textContent.match(/https?:\/\/[^\s"'<>]*mediafire\.com\/[^\s"'<>]+/i);
                    const megaMatch = textContent.match(/https?:\/\/[^\s"'<>]*mega\.nz\/[^\s"'<>]+/i);

                    if (top4topMatch) {
                      console.log(`   🌐 Found Top4Top link in SUBDL text note: ${top4topMatch[0]}`);
                      const direct = await resolveTop4topDownloadUrl(top4topMatch[0]);
                      if (direct) {
                        const top4topDest = path.join(OUT_DIR, `top4top_${Date.now()}`);
                        await downloadFileToDisk(direct, top4topDest);
                        validated = validateFileMagic(top4topDest);
                        if (validated) effectiveDownloadPath = top4topDest;
                      }
                    } else if (mfMatch) {
                      console.log(`   🌐 Found Mediafire link in SUBDL text note: ${mfMatch[0]}`);
                      const mfBest = await findBestFileInMediafire(mfMatch[0]);
                      if (mfBest?.directUrl) {
                        const mfDest = path.join(OUT_DIR, `mf_${Date.now()}`);
                        await downloadFileToDisk(mfBest.directUrl, mfDest);
                        validated = validateFileMagic(mfDest);
                        if (validated) effectiveDownloadPath = mfDest;
                      }
                    }
                  } catch (e) {
                    console.warn(`   ⚠️ Fallback link parsing error:`, e.message);
                  }
                }

                if (!validated) {
                  console.warn(`   ⚠️ Downloaded SUBDL file was invalid or HTML. Skipping.`);
                  fs.rmSync(tempDownload, { force: true });
                  if (effectiveDownloadPath !== tempDownload) fs.rmSync(effectiveDownloadPath, { force: true });
                  continue;
                }

                // If Subdl downloaded a zip for an official single episode, unpack the .ass directly
                if (validated && validated.isArchive) {
                  try {
                    const zip = new AdmZip(effectiveDownloadPath);
                    const zipEntries = zip.getEntries();
                    const subEntries = zipEntries.filter(e => !e.isDirectory && /\.(ass|srt)$/i.test(e.entryName));
                    if (subEntries.length === 1) {
                      const subEntry = subEntries[0];
                      const singleExt = path.extname(subEntry.entryName).toLowerCase();
                      const unzippedSubPath = path.join(OUT_DIR, `subdl_${msg.id}${singleExt}`);
                      fs.writeFileSync(unzippedSubPath, subEntry.getData());
                      const unzippedVal = validateFileMagic(unzippedSubPath);
                      if (unzippedVal) {
                        if (effectiveDownloadPath !== tempDownload) {
                          try { fs.rmSync(effectiveDownloadPath, { force: true }); } catch {}
                        }
                        effectiveDownloadPath = unzippedSubPath;
                        validated = unzippedVal;
                      }
                    }
                  } catch (zipErr) {
                    console.warn('   ⚠️ Subdl single sub unpack warning:', zipErr.message);
                  }
                }

                const cleanFileName = getSafeTelegramFileName(rawTitle, validated.ext);
                const finalPath = path.join(OUT_DIR, cleanFileName);
                safeMoveFile(effectiveDownloadPath, finalPath);
                if (effectiveDownloadPath !== tempDownload) {
                  try { fs.rmSync(tempDownload, { force: true }); } catch {}
                }

                // Subdl files are taken as-is (.ass for single, .zip for batches)
                const caption = formatCleanCaption(rawTitle, validated.isArchive, isOfficialSubdl);
                console.log(`   📤 Publishing to channel: "${caption}" (filename: ${cleanFileName})`);
                const sendResult = await sendDocument(finalPath, caption);

                if (sendResult?.ok) {
                  console.log(`   ✅ Successfully posted! (Message ID: ${sendResult.result?.message_id})`);
                  newFound++;
                  markReleaseAsPosted(posted, msgKey, releaseKeys);
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

          continue;
        }

        // ==============================================================
        // SOURCE 3: LazySano Channel (Dedicated Fansub Channel)
        // ==============================================================
        if (isLazySano) {
          // Case A: File directly attached in LazySano message
          if (msg.media && msg.media.document) {
            const doc = msg.media.document;
            const originalName = doc.attributes?.find(a => a.fileName)?.fileName || '';
            const ext = path.extname(originalName).toLowerCase();

            if (['.ass', '.srt', '.zip', '.rar', '.7z'].includes(ext)) {
              let docBaseName = originalName
                .replace(/\.(ass|srt|zip|rar|7z)$/i, '')
                .replace(/\s*\((?:1080p|720p|480p)\)/gi, '')
                .trim();

              if (!docBaseName.toLowerCase().startsWith('[lazysano]')) {
                docBaseName = `[LazySano] ${docBaseName}`;
              }

              const titleLine = formatCleanTitle(docBaseName);
              const releaseKeys = getFansubReleaseKeys(titleLine);

              if (isReleaseAlreadyPosted(posted, releaseKeys)) {
                markReleaseAsPosted(posted, msgKey, releaseKeys);
                continue;
              }

              console.log(`\n✨ [LazySano Direct File] "${titleLine}" (${originalName})`);
              const localFilePath = path.join(OUT_DIR, originalName);

              try {
                const buffer = await client.downloadMedia(msg);
                if (buffer && Buffer.isBuffer(buffer)) {
                  fs.writeFileSync(localFilePath, buffer);

                  const validated = validateFileMagic(localFilePath);
                  if (validated) {
                    const cleanFileName = getSafeTelegramFileName(titleLine, validated.ext);
                    const finalPath = path.join(OUT_DIR, cleanFileName);
                    safeMoveFile(localFilePath, finalPath);

                    const caption = formatCleanCaption(titleLine, validated.isArchive, false);
                    console.log(`   📤 Publishing LazySano release: "${caption}"`);
                    const sendResult = await sendDocument(finalPath, caption);

                    if (sendResult?.ok) {
                      console.log(`   ✅ Successfully posted!`);
                      newFound++;
                      markReleaseAsPosted(posted, msgKey, releaseKeys);
                    }
                    fs.rmSync(finalPath, { force: true });
                    continue;
                  }
                  fs.rmSync(localFilePath, { force: true });
                }
              } catch (e) {
                console.warn(`   ⚠️ LazySano direct file download error:`, e.message);
              }
            }
          }

          // Case B: Post links in LazySano message
          const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
          let titleLine = formatCleanTitle(lines[0] || '');
          if (titleLine && !titleLine.startsWith('[LazySano]')) {
            titleLine = `[LazySano] ${titleLine}`;
          }

          if (titleLine) {
            const releaseKeys = getFansubReleaseKeys(titleLine);
            if (isReleaseAlreadyPosted(posted, releaseKeys)) {
              markReleaseAsPosted(posted, msgKey, releaseKeys);
              continue;
            }

            const urlMatches = text.match(/https?:\/\/[^\s"'<>]+/gi) || [];
            const postPageUrl = urlMatches.find(u => !u.includes('t.me') && !u.includes('twitter'));
            if (postPageUrl) {
              const pageData = await scrapePostPage(postPageUrl);
              if (pageData) {
                let directUrl = pageData.videoLinks?.directSub || (/\.(ass|srt|zip|rar|7z)$/i.test(pageData.bestDownloadUrl) ? pageData.bestDownloadUrl : null);
                if (pageData.videoLinks?.top4top) {
                  const resolved = await resolveTop4topDownloadUrl(pageData.videoLinks.top4top);
                  if (resolved) directUrl = resolved;
                }
                if (!directUrl && pageData.videoLinks?.mediafire) {
                  const mfBest = await findBestFileInMediafire(pageData.videoLinks.mediafire);
                  if (mfBest?.directUrl && mfBest.type === 'subtitle') directUrl = mfBest.directUrl;
                }
                if (!directUrl && pageData.videoLinks?.mega) {
                  const megaBest = await findBestFileInMegaFolder(pageData.videoLinks.mega);
                  if (megaBest?.node && megaBest.type === 'subtitle') {
                    try {
                      const tempDest = path.join(OUT_DIR, `lazy_${Date.now()}_${megaBest.name}`);
                      await downloadMegaNode(megaBest.node, tempDest);
                      const validated = validateFileMagic(tempDest);
                      if (validated) {
                        const cleanFileName = getSafeTelegramFileName(titleLine, validated.ext);
                        const finalPath = path.join(OUT_DIR, cleanFileName);
                        safeMoveFile(tempDest, finalPath);

                        const caption = formatCleanCaption(titleLine, validated.isArchive, false);
                        console.log(`   📤 Publishing LazySano post link: "${caption}"`);
                        const sendResult = await sendDocument(finalPath, caption);
                        if (sendResult?.ok) {
                          newFound++;
                          markReleaseAsPosted(posted, msgKey, releaseKeys);
                        }
                        fs.rmSync(finalPath, { force: true });
                        continue;
                      }
                      fs.rmSync(tempDest, { force: true });
                    } catch {}
                  }
                }
                if (directUrl) {
                  try {
                    const tempDest = path.join(OUT_DIR, `lazy_${Date.now()}`);
                    await downloadFileToDisk(directUrl, tempDest);
                    const validated = validateFileMagic(tempDest);
                    if (validated) {
                      const cleanFileName = getSafeTelegramFileName(titleLine, validated.ext);
                      const finalPath = path.join(OUT_DIR, cleanFileName);
                      safeMoveFile(tempDest, finalPath);

                      const caption = formatCleanCaption(titleLine, validated.isArchive, false);
                      console.log(`   📤 Publishing LazySano post link: "${caption}"`);
                      const sendResult = await sendDocument(finalPath, caption);
                      if (sendResult?.ok) {
                        newFound++;
                        markReleaseAsPosted(posted, msgKey, releaseKeys);
                      }
                      fs.rmSync(finalPath, { force: true });
                      continue;
                    }
                    fs.rmSync(tempDest, { force: true });
                  } catch {}
                }
              }
            }
          }

          continue;
        }

        // ==============================================================
        // SOURCE 4: Arabic Anime Publisher (Fansub Releases)
        // ==============================================================
        const titleLine = extractTeamAndFormatTitle(text);
        const releaseKeys = getFansubReleaseKeys(titleLine);

        if (isReleaseAlreadyPosted(posted, releaseKeys)) {
          markReleaseAsPosted(posted, msgKey, releaseKeys);
          continue;
        }

        // Case A: Direct file attached to the message
        if (msg.media && msg.media.document) {
          const doc = msg.media.document;
          const originalName = doc.attributes?.find(a => a.fileName)?.fileName || `sub_${msg.id}.ass`;
          const ext = path.extname(originalName).toLowerCase();

          if (['.ass', '.srt', '.zip', '.rar', '.7z'].includes(ext)) {
            console.log(`\n✨ [Fansub Attachment] "${titleLine}" (${originalName})`);
            const localFilePath = path.join(OUT_DIR, originalName);

            try {
              const buffer = await client.downloadMedia(msg);
              if (buffer && Buffer.isBuffer(buffer)) {
                fs.writeFileSync(localFilePath, buffer);

                const validated = validateFileMagic(localFilePath);
                if (validated) {
                  const cleanFileName = getSafeTelegramFileName(titleLine, validated.ext);
                  const finalPath = path.join(OUT_DIR, cleanFileName);
                  safeMoveFile(localFilePath, finalPath);

                  const caption = formatCleanCaption(titleLine, validated.isArchive, false);
                  console.log(`   📤 Publishing to channel: "${caption}"`);
                  const sendResult = await sendDocument(finalPath, caption);

                  if (sendResult?.ok) {
                    console.log(`   ✅ Successfully posted!`);
                    newFound++;
                    markReleaseAsPosted(posted, msgKey, releaseKeys);
                  }
                  fs.rmSync(finalPath, { force: true });
                  continue;
                }
                fs.rmSync(localFilePath, { force: true });
              }
            } catch (e) {
              console.warn(`   ⚠️ Fansub attachment download error:`, e.message);
            }
            continue;
          }
        }

        // Case B: Post links in Fansub Channel (Multi-cloud / Torrent / Direct)
        const urlMatches = text.match(/https?:\/\/[^\s"'<>]+/gi) || [];
        const postPageCandidates = [...new Set(urlMatches)]
          .filter(u => !u.includes('t.me') && !u.includes('twitter') && !u.includes('discord') && !u.includes('subdl.com'))
          .map(url => {
            const site = CONFIG.SITES.find(s => {
              try { return url.includes(new URL(s.base).hostname); } catch { return false; }
            });
            // Joint REVIVE/Rhythm releases must not stop at REVIVE's interactive
            // login wall when an accessible Rhythm mirror is also provided.
            const priority = site?.id === 'rhythm' ? 0 : site?.id === 'revive' ? 2 : 1;
            return { url, site, priority };
          })
          .sort((a, b) => a.priority - b.priority);

        for (const { url: postPageUrl, site: matchingSite } of postPageCandidates) {
          console.log(`\n✨ [Fansub Post] "${titleLine}"`);
          console.log(`   🌐 Scraping fansub post: ${postPageUrl}`);
          const pageData = await scrapePostPage(postPageUrl, matchingSite);

          if (pageData) {
            const fansubWorkDir = path.join(OUT_DIR, `fansub_${msg.id}`);
            fs.mkdirSync(fansubWorkDir, { recursive: true });

            try {
              let downloadedFilePath = null;
              const targetEp = extractEpisodeNumber(titleLine);

              // 1. Direct or Top4Top download
              let directUrl = pageData.videoLinks?.directSub || (/\.(ass|srt|zip|rar|7z)$/i.test(pageData.bestDownloadUrl) ? pageData.bestDownloadUrl : null);
              if (pageData.videoLinks?.top4top) {
                const resolved = await resolveTop4topDownloadUrl(pageData.videoLinks.top4top);
                if (resolved) directUrl = resolved;
              }

              if (directUrl) {
                try {
                  console.log(`   📥 Direct download: ${directUrl}`);
                  const tempDest = path.join(fansubWorkDir, `direct_${Date.now()}`);
                  await downloadFileToDisk(directUrl, tempDest, { Referer: postPageUrl });
                  if (fs.existsSync(tempDest)) downloadedFilePath = tempDest;
                } catch (e) {
                  console.warn(`   ⚠️ Direct download failed:`, e.message);
                }
              }

              // 2. Mediafire (Direct file or Folder)
              if (!downloadedFilePath && pageData.videoLinks?.mediafire) {
                console.log(`   📥 Resolving Mediafire: ${pageData.videoLinks.mediafire}`);
                try {
                  const mfBest = await findBestFileInMediafire(pageData.videoLinks.mediafire, targetEp);
                  if (mfBest && mfBest.directUrl) {
                    if (mfBest.type === 'subtitle' || toolsAvailable) {
                      console.log(`   📥 Downloading from Mediafire (${mfBest.type}): ${mfBest.name}`);
                      const tempDest = path.join(fansubWorkDir, `mf_${Date.now()}_${mfBest.name}`);
                      await downloadFileToDisk(mfBest.directUrl, tempDest, { Referer: postPageUrl });
                      if (fs.existsSync(tempDest)) downloadedFilePath = tempDest;
                    }
                  }
                } catch (e) {
                  console.warn(`   ⚠️ Mediafire download failed:`, e.message);
                }
              }

              // 3. Mega (Direct file or Folder via pure JS megajs)
              if (!downloadedFilePath && pageData.videoLinks?.mega) {
                console.log(`   📥 Resolving Mega: ${pageData.videoLinks.mega}`);
                try {
                  const megaBest = await findBestFileInMegaFolder(pageData.videoLinks.mega, targetEp);
                  if (megaBest && megaBest.node) {
                    if (megaBest.type === 'subtitle' || toolsAvailable) {
                      console.log(`   📥 Downloading from Mega (${megaBest.type}): ${megaBest.name}`);
                      const tempDest = path.join(fansubWorkDir, `mega_${Date.now()}_${megaBest.name}`);
                      await downloadMegaNode(megaBest.node, tempDest);
                      if (fs.existsSync(tempDest)) downloadedFilePath = tempDest;
                    }
                  }
                } catch (e) {
                  console.warn(`   ⚠️ Mega JS download failed:`, e.message);
                }
              }

              // 4. Google Drive (Direct file or Folder)
              if (!downloadedFilePath && pageData.videoLinks?.drive) {
                console.log(`   📥 Resolving Google Drive: ${pageData.videoLinks.drive}`);
                try {
                  const driveBest = await findBestFileInDrive(pageData.videoLinks.drive, targetEp);
                  if (driveBest && driveBest.directUrl) {
                    if (driveBest.type === 'subtitle' || toolsAvailable) {
                      console.log(`   📥 Downloading from Drive (${driveBest.type}): ${driveBest.name}`);
                      const tempDest = path.join(fansubWorkDir, `drive_${Date.now()}_${driveBest.name}`);
                      await downloadFileToDisk(driveBest.directUrl, tempDest, { Referer: postPageUrl });
                      if (fs.existsSync(tempDest)) downloadedFilePath = tempDest;
                    }
                  }
                } catch (e) {
                  console.warn(`   ⚠️ Google Drive download failed:`, e.message);
                }
              }

              // 5. Torrent (Prioritized for speed & reliability in GitHub Actions)
              if (!downloadedFilePath && pageData.videoLinks?.torrent && toolsAvailable) {
                console.log(`   📥 Fansub torrent found: ${pageData.videoLinks.torrent}`);
                const extractedTorrent = await downloadAndExtractSubtitleFromTorrent(pageData.videoLinks.torrent, fansubWorkDir, false, false);
                if (extractedTorrent && extractedTorrent.filePath) {
                  const cleanFileName = getSafeTelegramFileName(titleLine, extractedTorrent.ext);
                  const finalPath = path.join(OUT_DIR, cleanFileName);
                  safeMoveFile(extractedTorrent.filePath, finalPath);

                  const caption = formatCleanCaption(titleLine, extractedTorrent.isArchive, false);
                  console.log(`   📤 Publishing to channel: "${caption}"`);
                  const sendResult = await sendDocument(finalPath, caption);

                  if (sendResult?.ok) {
                    console.log(`   ✅ Successfully posted!`);
                    newFound++;
                    markReleaseAsPosted(posted, msgKey, releaseKeys);
                    fs.rmSync(finalPath, { force: true });
                    break;
                  }
                  fs.rmSync(finalPath, { force: true });
                }
              }

              // Process downloaded file (MKV extract or direct archive)
              if (downloadedFilePath) {
                const extracted = extractSubtitleAndFontsFromAnyFile(downloadedFilePath, fansubWorkDir, false, false);
                if (extracted && extracted.filePath) {
                  const cleanFileName = getSafeTelegramFileName(titleLine, extracted.ext);
                  const finalPath = path.join(OUT_DIR, cleanFileName);
                  safeMoveFile(extracted.filePath, finalPath);

                  const caption = formatCleanCaption(titleLine, extracted.isArchive, false);
                  console.log(`   📤 Publishing to channel: "${caption}"`);
                  const sendResult = await sendDocument(finalPath, caption);

                  if (sendResult?.ok) {
                    console.log(`   ✅ Successfully posted!`);
                    newFound++;
                    markReleaseAsPosted(posted, msgKey, releaseKeys);
                    fs.rmSync(finalPath, { force: true });
                    break;
                  }

                  fs.rmSync(finalPath, { force: true });
                }
              }
            } catch (e) {
              console.error(`   ❌ Fansub post processing error:`, e.message);
            } finally {
              try { fs.rmSync(fansubWorkDir, { recursive: true, force: true }); } catch {}
            }
          }
        }
        if (isReleaseAlreadyPosted(posted, releaseKeys)) continue;
      }
    } catch (chatErr) {
      console.warn(`   ⚠️ Error reading channel "${chat.title}":`, chatErr.message);
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
