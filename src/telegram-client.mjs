import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync, spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import AdmZip from 'adm-zip';
import SevenZip from '7zip-bin';
import { CONFIG } from './config.mjs';
import { scrapePostPage, resolveSubtitleFromDirectory, resolveBuzzheavierDownloadUrl } from './site-scrapers.mjs';
import { sendDocument } from './telegram.mjs';
import {
  findBestFileInMegaFolder,
  downloadMegaNode,
  downloadMegaFolderRelease,
  downloadDriveFolderRelease,
  isDriveFolderUrl,
  findBestFileInMediafire,
  findBestFileInDrive,
  resolveMediafireDirectDownload
} from './cloud-folders.mjs';
import { safeRemoteBaseName, isInsideDir } from './path-safety.mjs';
import { downloadViaBrowser, isRocksDdlHost } from './browser-fetch.mjs';
import {
  resolveCanonicalTitle,
  resolveCanonicalTitlesBatch,
  getCachedCanonical,
  resetCycleBudget,
  normalizeTeamName,
  buildSyntheticTitle
} from './title-identity.mjs';

const POSTED_FILE = path.resolve('data', 'posted.json');
const OUT_DIR = path.resolve('temp_extracted');
const HTTP_TIMEOUT_MS = 60_000;

function fetchWithTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  return fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(timeoutMs) });
}

export function safeMoveFile(src, dest) {
  if (!fs.existsSync(src)) return false;
  if (path.resolve(src) === path.resolve(dest)) return true;
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
const CHANNEL_KOKOBOKO = '1224725097';   // KokoBoko [Subdl] (Official)
const CHANNEL_RENGOKU = '2217287273';   // Rengoku [Subdl] (Official)
const CHANNEL_ERAI = '2084152036';   // Erai-Raws (Official)
const CHANNEL_LAZYSANO = '1650610194';   // LazySano (Fansub)
const CHANNEL_FANSUB = '1031770723';   // Arabic Anime Publisher (Fansub)

// ====================================================================
// Source abbreviation mapping to full official platform names
// ====================================================================
const SOURCE_FULL_NAME = {
  'cr': 'Crunchyroll',
  'crunchyroll': 'Crunchyroll',
  'hidive': 'HIDIVE',
  'nf': 'Netflix',
  'netflix': 'Netflix',
  'dsnp': 'Disney+',
  'disney+': 'Disney+',
  'disney': 'Disney+',
  'amzn': 'Amazon',
  'amazon': 'Amazon',
  'amazon prime': 'Amazon',
  'prime': 'Amazon',
  'shahid': 'Shahid',
  'funimation': 'Funimation',
  'funi': 'Funimation',
  'bilibili': 'Bilibili',
  'b-global': 'B-Global',
  'adn': 'ADN',
  'adi': 'ADN',
  'abema': 'ABEMA',
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
  { pattern: /(?:super\s*no\s*ura)/i, canon: 'super_no_ura' },
  { pattern: /(?:jojo.*steel\s*ball|steel\s*ball.*jojo|steel\s*ball\s*run)/i, canon: 'jojo_steel_ball_run' },
  { pattern: /(?:tougen\s*anki)/i, canon: 'tougen_anki' },
  { pattern: /(?:kusuriya\s*no\s*hitorigoto|apothecary\s*diaries|صيدلانية)/i, canon: 'kusuriya_no_hitorigoto' },
  { pattern: /(?:tokyo\s*revengers)/i, canon: 'tokyo_revengers' },
  { pattern: /(?:uchi\s*no\s*otouto|please\s*excuse\s*my\s*younger\s*brothers)/i, canon: 'uchi_no_otouto' },
  { pattern: /(?:yani\s*neko)/i, canon: 'yani_neko' },
  { pattern: /(?:thunder\s*3)/i, canon: 'thunder_3' },
  { pattern: /(?:quanzhi\s*fashi|versatile\s*mage)/i, canon: 'quanzhi_fashi' },
  { pattern: /(?:nijus?seiki\s*denki|eureka\s*evrika)/i, canon: 'denki_mokuroku' },
  { pattern: /(?:juuou\s*(?:bushin|mujin)\s*dandivine|beast\s*king.*dandivine|dandivine)/i, canon: 'juuou_dandivine' },
  { pattern: /(?:hyouken\s*no\s*majutsushi)/i, canon: 'hyouken_majutsushi' },
  { pattern: /(?:tsuihou.*(?:juukishi|juu\s*kishi))/i, canon: 'tsuihou_juukishi' },
  { pattern: /(?:kuro\s*neko\s*to\s*majo|kuroneko\s*to\s*majo)/i, canon: 'kuroneko_majo' },
  { pattern: /(?:shuiro\s*no\s*kamen|vermilion\s*mask)/i, canon: 'shuiro_no_kamen' }
];

// ====================================================================
// Utility helpers (posted IDs, normalization, naming, deduplication)
// ====================================================================
export function loadPostedIds() {
  const parsePosted = (raw) => {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('posted.json is not a JSON array');
    return new Set(parsed);
  };

  // A missing file is a legitimate first run — return an empty set (no throw).
  if (!fs.existsSync(POSTED_FILE)) {
    return new Set();
  }

  try {
    return parsePosted(fs.readFileSync(POSTED_FILE, 'utf8'));
  } catch (fileErr) {
    console.error(`⚠️ posted.json unreadable/corrupt (${fileErr.message}). Attempting git recovery...`);
    for (const ref of ['HEAD', 'HEAD~1']) {
      try {
        const raw = execSync(`git show ${ref}:data/posted.json`, {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024, // posted.json is already ~1 MB; the default 1 MB throws ENOBUFS
          stdio: ['ignore', 'pipe', 'pipe']
        });
        const recovered = parsePosted(raw);
        console.error(`⚠️ Recovered ${recovered.size} posted keys from git ${ref}.`);
        return recovered;
      } catch (gitErr) {
        const gitDetail = gitErr && gitErr.stderr
          ? String(gitErr.stderr).trim().split('\n')[0]
          : String(gitErr.message).split('\n')[0];
        console.error(`   ↳ recovery from git ${ref} failed: ${gitDetail}`);
      }
    }
    throw new Error('posted.json is corrupt and git recovery failed (HEAD, HEAD~1). Aborting this run to prevent mass re-posting.');
  }
}

export function savePostedIds(set) {
  try {
    fs.mkdirSync(path.dirname(POSTED_FILE), { recursive: true });
    const tmp = POSTED_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...set], null, 2));
    fs.renameSync(tmp, POSTED_FILE);
  } catch (e) {
    console.error('Failed to save posted IDs:', e.message);
  }
}

// Create a reusable Telegram client (caller is responsible for connect/disconnect)
export function createPersistentClient() {
  const sessionStr = CONFIG.TELEGRAM.SESSION;
  if (!sessionStr) {
    console.warn('No Telegram SESSION found in config.');
    return null;
  }
  return new TelegramClient(
    new StringSession(sessionStr),
    CONFIG.TELEGRAM.API_ID,
    CONFIG.TELEGRAM.API_HASH,
    { connectionRetries: 5 }
  );
}

const ARABIC_EPISODE_WORDS = [
  { p: /الحادية\s*عشر[ةه]?/i, ep: '11' },
  { p: /الثانية\s*عشر[ةه]?/i, ep: '12' },
  { p: /الثالثة\s*عشر[ةه]?/i, ep: '13' },
  { p: /الرابعة\s*عشر[ةه]?/i, ep: '14' },
  { p: /الخامسة\s*عشر[ةه]?/i, ep: '15' },
  { p: /السادسة\s*عشر[ةه]?/i, ep: '16' },
  { p: /السابعة\s*عشر[ةه]?/i, ep: '17' },
  { p: /الثامنة\s*عشر[ةه]?/i, ep: '18' },
  { p: /التاسعة\s*عشر[ةه]?/i, ep: '19' },
  { p: /العشر[ووي]ن/i, ep: '20' },
  { p: /الأول[ىي]/i, ep: '01' },
  { p: /الثانية/i, ep: '02' },
  { p: /الثالثة/i, ep: '03' },
  { p: /الرابعة/i, ep: '04' },
  { p: /الخامسة/i, ep: '05' },
  { p: /السادسة/i, ep: '06' },
  { p: /السابعة/i, ep: '07' },
  { p: /الثامنة/i, ep: '08' },
  { p: /التاسعة/i, ep: '09' },
  { p: /العاشرة/i, ep: '10' }
];

export function extractEpisodeNumber(text) {
  if (!text) return '';
  const cleaned = text.replace(/\[\+fonts?\]|\.ass|\.srt|\.zip|\.rar|\.7z/gi, '');

  // Range matching: "01-12", "01~03", "01 to 12" -> ranges are batches, not single episodes
  // But skip if preceded by S/Season (e.g. "S01 - 02" = Season 1 Episode 2, NOT a range)
  const rangeMatch = cleaned.match(/(S(?:eason)?\s*)?(\d{1,4})\s*(?:[-&~–]|to|and)\s*(\d{1,4})/i);
  if (rangeMatch && !rangeMatch[1]) {
    const start = parseInt(rangeMatch[2], 10);
    const end = parseInt(rangeMatch[3], 10);
    if (!isNaN(start) && !isNaN(end) && start < end && end - start <= 100) {
      return '';
    }
  }

  // Parse SxxEyy / Sxx EPyy / Sxx Episode yy (e.g. S01E15, S1 E07, S01EP15)
  const se = cleaned.match(/\bS(\d{1,2})\s*E(?:P|pisode)?\s*(\d{1,4})\b/i);
  if (se) {
    const n = parseInt(se[2], 10);
    if (!isNaN(n) && n > 0) return String(n);
  }

  for (const item of ARABIC_EPISODE_WORDS) {
    if (item.p.test(cleaned)) return item.ep;
  }

  // 1. Explicit dash or episode prefixes: " - 46", " - 02", " ep 04", " episode 12", " e04", " #46"
  const mExplicit = cleaned.match(/(?:\s+-\s*|\bep(?:isode)?\s*|\be\s*|#\s*)(\d{1,4})(?:\s*v\d+)?\b/i);
  if (mExplicit) return mExplicit[1].replace(/^0+/, '') || '0';

  // 2. Loose patterns like bare numbers: " 46", "~ 46" require a trailing bracket, paren, dot, or end-of-string
  const m = cleaned.match(/(?:\s+|~)(\d{1,4})(?:\s*v\d+)?(?:\s*\[|\s*\(|\s*\.|\s*$)/i);
  if (m) return m[1].replace(/^0+/, '') || '0';
  return '';
}

// Secondary/alternative episode marker inside brackets — the fast-path
// counterpart of extractEpisodeNumber: "[P2 - 01]", "[Part 2 - 01]",
// "[Cour 2 - 03]" -> the SECOND number (the per-part episode), unpadded.
// Standalone "[Part 2]" / "[Season 2]" / "[P2]" do NOT match (no dash+ep).
export function extractSecondaryEpisodeNumber(title) {
  if (!title) return '';
  const m = String(title).match(/\[\s*(?:part|cour|[ps])\s*(\d{1,2})\s*[-~]\s*(\d{1,4})\s*\]/i);
  if (!m) return '';
  return String(m[2]).replace(/^0+/, '') || '0';
}

// Replace the FIRST episode token with the pad2 dash form " - 01". Internal:
// used only by the fast-path / sequel synthesis below. Returns null when no
// episode token. Token locating mirrors buildSyntheticTitle exactly (F7):
//   - operate on the region AFTER the leading platform bracket (a number
//     inside the platform bracket is never an episode token),
//   - require idx > 0 (a real name region must exist),
//   - reject batch-shaped regions (\d{1,4}\s*[-~]\s*\d{1,4} after stripping
//     bracket contents) as ambiguous — EXCEPT period markers ("Part 2 - 13"),
//     which the same part/cour/season/[ps] prefix exclusion used by
//     extractBatchRange treats as period + episode, not a batch. (A literal
//     batch guard would reject the defect's own sequel title "...Part 2 - 13".)
// The EP_PATTERNS lookaheads keep numbers inside "[...]" (e.g. "[P2 - 01]")
// unmatchable, so bracket-internal numbers are never rewritten.
function replacePrimaryEpisode(title, ep) {
  try {
    const s = String(title ?? '');
    const noPad = String(ep ?? '').replace(/^0+/, '') || '0';
    const pad2 = noPad.padStart(2, '0');
    if (!s) return null;
    const platformMatch = s.match(/^\[[^\]]*\]\s*/);
    const platform = platformMatch ? platformMatch[0] : '';
    const rest = s.slice(platform.length);
    const batchProbe = rest.replace(/\[[^\]]*\]/g, ' ');
    for (const bm of batchProbe.matchAll(/\d{1,4}\s*[-~]\s*\d{1,4}/g)) {
      if (!/\b(?:part|cour|season|[ps])\s*$/i.test(batchProbe.slice(0, bm.index))) return null;
    }
    const EP_PATTERNS = [
      /\s+-\s*\d{1,4}(?:\s*v\d+)?(?=\s|$|\[|\()/,
      /\s+ep(?:isode)?\.?\s*\d{1,4}(?:\s*v\d+)?(?=\s|$|\[|\()/i,
      /\s+e\.?\s*\d{1,4}(?:\s*v\d+)?(?=\s|$|\[|\()/i,
      /#\s*\d{1,4}(?:\s*v\d+)?(?=\s|$|\[|\()/,
      /\s+S\d{1,2}E\d{1,3}(?:\s*v\d+)?(?=\s|$|\[|\()/i,
    ];
    let idx = -1;
    let hit = null;
    for (const re of EP_PATTERNS) {
      const m = rest.match(re);
      if (m && (idx === -1 || m.index < idx)) {
        idx = m.index;
        hit = m;
      }
    }
    if (idx <= 0 || !hit) return null;
    return platform + rest.slice(0, idx) + ` - ${pad2}` + rest.slice(idx + hit[0].length);
  } catch {
    return null;
  }
}

// Remove secondary bracket markers "[P2 - 01]" / "[Part 2 - 01]" /
// "[Cour 2 - 03]" (internal; sequel synthesis only).
function stripSecondaryBracket(title) {
  return String(title ?? '').replace(/\s*\[\s*(?:part|cour|[ps])\s*\d{1,2}\s*[-~]\s*\d{1,4}\s*\]/gi, '');
}

// ---- identity extra-title synthesis (SHARED by both key functions) --------
// Produces the extra titles whose OWN key families the resolved layer unions
// in, using ONE implementation (F2): (c) fast-path secondary episode and
// (d) sequel overflow. Each caller then re-runs ITS OWN recursive key function
// with resolved=null on each returned title (recursion guard unchanged).
// Only reachable with a non-null resolved object (callers guard), so the
// resolved=null path emits no fast-path/sequel keys.
function collectIdentityExtraTitles(title, epNum, resolved) {
  const out = [];
  try {
    // (c) FAST-PATH: a bracketed secondary episode ([P2 - 01], [Part 2 - 01],
    // [Cour 2 - 03]) also emits the full key set of the same title under the
    // per-part episode. The secondary bracket is stripped too (F1): keeping it
    // would leave a stale `_p2_01` suffix in the fast-path fullNorm/coreKey.
    const secondary = extractSecondaryEpisodeNumber(title);
    if (secondary && epNum && Number(secondary) !== Number(epNum)) {
      const altTitle = stripSecondaryBracket(replacePrimaryEpisode(title, secondary));
      if (altTitle && altTitle !== title) out.push(altTitle);
    }

    // (d) SEQUEL OVERFLOW: a cumulative episode count beyond the resolved
    // season's total means this is the sequel cour posted under the old
    // season name — emit the keys of the sequel title with the recomputed
    // 1-indexed difference (e.g. 13 - 12 = 1). Original keys stay (cumulative
    // posting). Fail-open: any error in here means no extra titles.
    if (
      Number.isInteger(resolved.episodes) && resolved.episodes > 0 &&
      Number(epNum) > resolved.episodes &&
      (Number(epNum) - resolved.episodes) <= 100 &&
      resolved.sequel && resolved.sequel.id != null
    ) {
      const diff = Number(epNum) - resolved.episodes;
      // F5 fail-CLOSED guard: when the sequel's own total is KNOWN and the
      // difference exceeds it, this release cannot be that sequel — skip.
      // (Wrong suppression is worse than a duplicate; unknown total -> allow.)
      const sequelTotal = resolved.sequel.episodes;
      const beyondKnownSequelTotal = Number.isInteger(sequelTotal) && sequelTotal > 0 && diff > sequelTotal;
      if (!beyondKnownSequelTotal) {
        const sequelName = resolved.sequel.romaji || resolved.sequel.english;
        let sequelTitle = sequelName ? buildSyntheticTitle(title, sequelName) : null;
        if (sequelTitle) {
          const replaced = replacePrimaryEpisode(sequelTitle, String(diff));
          if (replaced) {
            const finalSequelTitle = stripSecondaryBracket(replaced);
            if (finalSequelTitle && finalSequelTitle !== title) out.push(finalSequelTitle);
          }
        }
      }
    }
  } catch {
    // Fail-open: synthesis trouble must never shrink key generation —
    // base keys are emitted regardless of what happens here.
  }
  return out;
}

// NOTE: `_batch_` keys intentionally use a 2-variant scheme (raw + pad2) while
// `_ep_` keys use 3 variants (raw / noPad / pad2) — do not "fix" this asymmetry.
function getEpKeyVariants(ep) {
  if (!ep) return [];
  const raw = String(ep);
  const noPad = raw.replace(/^0+/, '') || '0';
  const pad2 = noPad.padStart(2, '0');
  return Array.from(new Set([raw, noPad, pad2]));
}

export function getCoreAnimeEpisodeKey(title) {
  return title
    .toLowerCase()
    .replace(/\[\+fonts?\]|\.ass|\.srt|\.zip|\.rar|\.7z/gi, '')
    .replace(/^\[[^\]]+\]\s*/, '')
    // bare season marker before the episode ("... s01 - 03") — mirrors
    // normalizeQuery rule 6b; without it the token lands inside the core key
    // and the same episode produces two different keys.
    .replace(/\bs\d{1,2}\b(?=\s*(?:[-~–]\s*\d|\s*$))/gi, ' ')
    .replace(/\b(?:1080p|720p|480p|2160p|4k|bd|web-?dl|bdrip|hevc|h264|x264|x265|aac)\b/gi, '')
    .replace(/\[\s*(?:1080p|720p|480p|2160p|4k|bd|web-?dl|bdrip|hevc|h264|x264|x265|aac)\s*\]/gi, '')
    .replace(/\b(?:end|ending|final|مكتمل)\b/gi, '')
    // Strip trailing scene tags ONLY after episode numbers at the tail
    .replace(/(\b(?:s\d{1,2}e\d{1,4}|\d{1,4})\b)(?:\s+[\(\[]?(?:cr|hidive|nf|netflix|dsnp|amzn|arabic|ara\s+ar|ar|web-?dl|web-?rip|multi-?subs?)[\)\]]?)+\s*$/i, '$1')
    .replace(/\bii\b/gi, '2')
    .replace(/\biii\b/gi, '3')
    .replace(/\biv\b/gi, '4')
    .replace(/\bv\b/gi, '5')
    .replace(/\bvi\b/gi, '6')
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

export function extractBatchRange(title) {
  if (!title) return null;
  const s = String(title);
  // A match right after "Part 2 -" / "Season 3 -" / "Cour 2 -" is a PERIOD
  // marker (part number + episode), NOT a batch range — never key on it.
  const isPeriodPrefix = (idx) => /\b(?:part|cour|season|[ps])\s*$/i.test(s.slice(0, idx));
  // start < end on ALL rules (descending "13-01" was previously ungated);
  // an invalid/excluded candidate CONTINUES the scan for a later range.
  const valid = (a, b, idx) => {
    const start = parseInt(a, 10);
    const end = parseInt(b, 10);
    if (isNaN(start) || isNaN(end)) return null;
    if (!(start < end)) return null;
    if (isPeriodPrefix(idx)) return null;
    return [start, end];
  };

  // 1. Tilde is unambiguous range (e.g. 001~005, 01~13, 01 ~ 13).
  // '&' is the same idea ("Specials 1&2"): two digits around it can only mean
  // a pair, and without this the release was treated as a single episode and
  // published as one .ass instead of being sent to the batch extractor.
  for (const m of s.matchAll(/(\d{1,4})\s*[~&]\s*(\d{1,4})/g)) {
    const r = valid(m[1], m[2], m.index);
    if (r) return r;
  }

  // 2. Bracketed range (e.g. [01 - 13], [01-13 END])
  for (const m of s.matchAll(/\[\s*(\d{1,4})\s*[-~]\s*(\d{1,4})\s*(?:END)?\s*\]/gi)) {
    const r = valid(m[1], m[2], m.index);
    if (r) return r;
  }

  // 3. Trailing range at end of string or before quality tags
  for (const m of s.matchAll(/(?:^|\s)\b(\d{1,4})\s*-\s*(\d{1,4})\b(?:\s*END)?(?:\s*\[|\s*$)/gi)) {
    const r = valid(m[1], m[2], m.index);
    if (r) return r;
  }

  return null;
}

// Shared title->key normalization chain used by BOTH the base `fullNorm`
// keys and the explicit canonical family's canonSlug (single implementation,
// no drift). Extracted verbatim from getReleaseKeys' original fullNorm block.
function fullNormalizeKey(title) {
  return title
    .toLowerCase()
    .replace(/\[\+fonts?\]|\.ass|\.srt|\.zip|\.rar|\.7z/gi, '')
    .replace(/Ⅱ/g, '2')
    .replace(/Ⅲ/g, '3')
    .replace(/Ⅳ/g, '4')
    .replace(/Ⅴ/g, '5')
    .replace(/Ⅵ/g, '6')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
}

// Source token for the explicit canonical family: normalize the leading
// platform bracket of the ORIGINAL title, mapping through SOURCE_FULL_NAME
// when a known abbreviation exists, else the lowercased raw token.
function resolveSourceToken(title) {
  const m = String(title).match(/^\[\s*([^\]]+)\]/);
  if (!m) return 'unknown';
  const token = m[1].trim();
  const mapped = SOURCE_FULL_NAME[token.toLowerCase()] || token;
  return mapped.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

export function getReleaseKeys(title, isOfficial = false, resolved = null) {
  const fullNorm = fullNormalizeKey(title);

  const coreKey = getCoreAnimeEpisodeKey(title);
  const canonName = getCanonicalAnimeKey(title);
  const epNum = extractEpisodeNumber(title);

  const keys = [fullNorm];
  if (coreKey) keys.push(coreKey);

  if (canonName && epNum) {
    for (const ev of getEpKeyVariants(epNum)) {
      keys.push(`canon_${canonName}_ep_${ev}`);
    }
  }

  // Batch episode normalization (e.g. 001~005, 01~05, 1~5, 01-13)
  const batchRange = extractBatchRange(title);
  if (batchRange) {
    const [s, e] = batchRange;
    const batchStripRegex = new RegExp(`(?:_0*${s})?_0*${e}(?:_end)?$`, 'i');
    const animeNameOnly = (coreKey || '').replace(batchStripRegex, '').replace(/^_+|_+$/g, '');
    if (animeNameOnly) {
      keys.push(`${animeNameOnly}_batch_${s}_${e}`);
      keys.push(`${animeNameOnly}_batch_${String(s).padStart(2, '0')}_${String(e).padStart(2, '0')}`);
      if (canonName) {
        keys.push(`canon_${canonName}_batch_${s}_${e}`);
        keys.push(`canon_${canonName}_batch_${String(s).padStart(2, '0')}_${String(e).padStart(2, '0')}`);
      }
    }
  }

  // Generate prefix token keys from core anime words to bridge novel titles and short titles
  if (coreKey && epNum) {
    const words = coreKey.split('_').filter(w => w && w !== epNum && !/^(?:season|s\d+|2nd|3rd|4th|part|the|and|no|wa|ga|to|de|ni|mo|na|202\d)$/i.test(w));
    if (words.length >= 2) {
      const prefix2 = words.slice(0, 2).join('_');
      const prefix3 = words.slice(0, 3).join('_');
      const prefix4 = words.slice(0, 4).join('_');
      for (const ev of getEpKeyVariants(epNum)) {
        keys.push(`token_ep_${ev}_${prefix2}`);
        keys.push(`token_ep_${ev}_${prefix3}`);
        keys.push(`token_ep_${ev}_${prefix4}`);
        if (isOfficial) {
          keys.push(`official_ep_${ev}_${prefix2}`);
          keys.push(`official_ep_${ev}_${prefix3}`);
          keys.push(`official_ep_${ev}_${prefix4}`);
        }
      }
    }
  }

  if (isOfficial) {
    if (canonName && epNum) {
      for (const ev of getEpKeyVariants(epNum)) {
        keys.push(`official_${canonName}_ep_${ev}`);
      }
    }
    if (coreKey) {
      keys.push(`official_${coreKey}`);
    }
    if (epNum && coreKey) {
      for (const ev of getEpKeyVariants(epNum)) {
        keys.push(`official_ep_${ev}_${coreKey.slice(0, 20)}`);
      }
    }

    // Sorted significant word signature to prevent duplicates when title words are flipped
    // e.g. "Steel Ball Run: JoJo" vs "JoJo: Steel Ball Run"
    if (coreKey && epNum) {
      const sortedWords = coreKey
        .split('_')
        .filter(w => w && w !== epNum && !/^(?:season|s\d+|2nd|3rd|4th|5th|6th|7th|\d+|part|the|and|no|wa|ga|to|de|ni|mo|na|202\d|end|hen)$/i.test(w));
      if (sortedWords.length >= 2) {
        const sortedSig = Array.from(new Set(sortedWords)).sort().join('_');
        for (const ev of getEpKeyVariants(epNum)) {
          keys.push(`official_sorted_ep_${ev}_${sortedSig}`);
        }
      }
    }

    // Condensed alphanumeric key (spaces and underscores removed) to catch spacing differences
    // e.g. "juu_kishi" vs "juukishi", "kuro_neko" vs "kuroneko"
    if (coreKey && epNum) {
      const condensed = coreKey.replace(/[^a-z0-9]/gi, '').replace(new RegExp(`${epNum}$`), '');
      if (condensed.length >= 6) {
        for (const ev of getEpKeyVariants(epNum)) {
          keys.push(`official_condensed_ep_${ev}_${condensed}`);
        }
      }
    }
  }

  const baseKeys = Array.from(new Set(keys.filter(Boolean)));

  // ---- ADDITIVE identity layer (resolved canonical titles) ----------------
  // Base key FAMILIES above are unchanged from the pre-layer behavior for the
  // same input when resolved == null (scope: families, not every key —
  // extractBatchRange's start<end / period-prefix gating intentionally applies
  // on ALL paths per acceptance ب, so bogus batch keys are absent everywhere).
  // AniList failure never reaches here with a broken object: callers pass null
  // on failure (fail-open). Any unexpected error inside this branch falls back
  // to base keys.
  if (!resolved || typeof resolved !== 'object') return baseKeys;
  try {
    const dictStrings = Array.from(new Set(
      [resolved.romaji, resolved.english].filter(s => typeof s === 'string' && s.trim())
    ));
    if (dictStrings.length === 0) return baseKeys;

    const additions = [];

    // (a) EXPLICIT canonical family: <canonSlug>_ep_<ev>_<source>
    const canonSlug = fullNormalizeKey(resolved.romaji || resolved.english);
    if (canonSlug && epNum) {
      const source = resolveSourceToken(title);
      for (const ev of getEpKeyVariants(epNum)) {
        additions.push(`${canonSlug}_ep_${ev}_${source}`);
      }
    }

    // (b) SYNTHETIC RE-RUNS: re-generate the full key set as if the release
    // had arrived under each dictionary title string (romaji/english),
    // preserving everything else in the original title verbatim.
    // Recursion guard: resolved=null prevents re-entering this branch.
    for (const dictName of dictStrings) {
      const syntheticTitle = buildSyntheticTitle(title, dictName);
      if (!syntheticTitle || syntheticTitle === title) continue;
      additions.push(...getReleaseKeys(syntheticTitle, isOfficial, null));
    }

    // (c)+(d) FAST-PATH + SEQUEL OVERFLOW: shared synthesis (single
    // implementation for both key functions); each extra title is re-run
    // through THIS function with resolved=null (recursion guard).
    for (const extraTitle of collectIdentityExtraTitles(title, epNum, resolved)) {
      additions.push(...getReleaseKeys(extraTitle, isOfficial, null));
    }

    return Array.from(new Set([...baseKeys, ...additions].filter(Boolean)));
  } catch (identityErr) {
    // Fail-open: identity layer trouble must never shrink or block key generation.
    return baseKeys;
  }
}

// Fansub releases are deliberately deduplicated within the same team only.
// An official release (or another fansub team's release) must not suppress a
// team's own subtitle merely because the anime title and episode match.
export function getFansubReleaseKeys(title, resolved = null) {
  const fullNorm = title
    .toLowerCase()
    .replace(/\[\+fonts?\]|\.ass|\.srt|\.zip|\.rar|\.7z/gi, '')
    .replace(/\b(?:1080p|720p|480p|2160p|4k|bd|web-?dl|bdrip|hevc|h264|x264|x265|aac)\b/gi, '')
    .replace(/\[\s*(?:1080p|720p|480p|2160p|4k|bd|web-?dl|bdrip|hevc|h264|x264|x265|aac)\s*\]/gi, '')
    .replace(/\b(?:end|ending|final|مكتمل)\b/gi, '')
    .replace(/\bii\b/gi, '2')
    .replace(/\biii\b/gi, '3')
    .replace(/\biv\b/gi, '4')
    .replace(/\bv\b/gi, '5')
    .replace(/\bvi\b/gi, '6')
    .replace(/Ⅱ/g, '2')
    .replace(/Ⅲ/g, '3')
    .replace(/Ⅳ/g, '4')
    .replace(/Ⅴ/g, '5')
    .replace(/Ⅵ/g, '6')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');

  const teamMatch = title.match(/^\[([^\]]+)\]/);
  const rawTeam = teamMatch?.[1] || 'unknown';
  const teamKey = rawTeam
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');

  // Support joint teams like "Revive & Rhythm", "A & B", "A x B", "A + B"
  const subTeams = rawTeam
    .split(/\s*(?:&|\+|x|\band\b|\bwith\b|\bو\b)\s*/i)
    .map(t => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, ''))
    .filter(Boolean);

  // ADDITIVE team-name normalization: emit BOTH raw AND normalized team key
  // families (aliases + year-suffix strip, e.g. "bam" -> "bam25",
  // "bam (2025)" -> "bam25"). Joint teams are already split above — the union
  // covers them, with each sub-team aliased individually.
  const rawTeamKeys = Array.from(new Set([teamKey, ...subTeams].filter(Boolean)));
  const normalizedTeamKeys = rawTeamKeys.map(t => normalizeTeamName(t)).filter(Boolean);
  const allTeamKeys = Array.from(new Set([...rawTeamKeys, ...normalizedTeamKeys]));
  const coreKey = getCoreAnimeEpisodeKey(title);
  const canonName = getCanonicalAnimeKey(title);
  const epNum = extractEpisodeNumber(title);

  // Batch episode normalization (e.g. 001~005, 01~05, 1~5, 01-13)
  const batchRange = extractBatchRange(title);
  let batchStart = null;
  let batchEnd = null;
  let animeNameOnly = coreKey || '';
  if (batchRange) {
    [batchStart, batchEnd] = batchRange;
    const batchStripRegex = new RegExp(`(?:_0*${batchStart})?_0*${batchEnd}(?:_end)?$`, 'i');
    animeNameOnly = animeNameOnly.replace(batchStripRegex, '').replace(/^_+|_+$/g, '');
  }

  const keys = [];
  for (const tKey of allTeamKeys) {
    keys.push(`fansub_${tKey}_${fullNorm}`);
    if (coreKey) {
      keys.push(`fansub_${tKey}_${coreKey}`);
    }
    if (epNum && (canonName || coreKey)) {
      for (const ev of getEpKeyVariants(epNum)) {
        keys.push(`fansub_${tKey}_${canonName || coreKey}_ep_${ev}`);
      }
    }
    if (batchStart !== null && batchEnd !== null && animeNameOnly) {
      keys.push(`fansub_${tKey}_${animeNameOnly}_batch_${batchStart}_${batchEnd}`);
      keys.push(`fansub_${tKey}_${animeNameOnly}_batch_${String(batchStart).padStart(2, '0')}_${String(batchEnd).padStart(2, '0')}`);
      if (canonName) {
        keys.push(`fansub_${tKey}_${canonName}_batch_${batchStart}_${batchEnd}`);
        keys.push(`fansub_${tKey}_${canonName}_batch_${String(batchStart).padStart(2, '0')}_${String(batchEnd).padStart(2, '0')}`);
      }
    }
  }

  const baseKeys = Array.from(new Set(keys.filter(Boolean)));

  // ---- ADDITIVE identity layer (resolved canonical titles) ----------------
  // Fansub dedup stays team-scoped: the explicit canonical family is emitted
  // PER team key currently in allTeamKeys (raw + normalized), preserving the
  // "same team only" semantics. Fail-open on any unexpected error.
  if (!resolved || typeof resolved !== 'object') return baseKeys;
  try {
    const dictStrings = Array.from(new Set(
      [resolved.romaji, resolved.english].filter(s => typeof s === 'string' && s.trim())
    ));
    if (dictStrings.length === 0) return baseKeys;

    const additions = [];

    // (a) EXPLICIT canonical family, scoped per team key.
    const canonSlug = fullNormalizeKey(resolved.romaji || resolved.english);
    if (canonSlug && epNum) {
      for (const tKey of allTeamKeys) {
        for (const ev of getEpKeyVariants(epNum)) {
          additions.push(`fansub_${tKey}_${canonSlug}_ep_${ev}`);
        }
      }
    }

    // (b) SYNTHETIC RE-RUNS: same dictionary-title substitution as the
    // official path (recursion guard: resolved=null).
    for (const dictName of dictStrings) {
      const syntheticTitle = buildSyntheticTitle(title, dictName);
      if (!syntheticTitle || syntheticTitle === title) continue;
      additions.push(...getFansubReleaseKeys(syntheticTitle, null));
    }

    // (c)+(d) FAST-PATH + SEQUEL OVERFLOW: shared synthesis (single
    // implementation for both key functions); each extra title is re-run
    // through THIS function with resolved=null (recursion guard; team-scoped
    // fansub keys preserved by the caller).
    for (const extraTitle of collectIdentityExtraTitles(title, epNum, resolved)) {
      additions.push(...getFansubReleaseKeys(extraTitle, null));
    }

    return Array.from(new Set([...baseKeys, ...additions].filter(Boolean)));
  } catch (identityErr) {
    return baseKeys;
  }
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
  let cleaned = raw
    .replace(/^[📍📌🎬\s]+/, '')
    .replace(/\[\+fonts?\]/gi, '')
    .trim();
  cleaned = cleaned.replace(/^\[\s*hoshizora(?:[-_\s]*subs?)?\s*\]/i, '[ReDEJA]');

  // Normalize romanization and spacing inconsistencies so official titles are always uniform
  cleaned = cleaned.replace(/\bjuuou\s+mujin\s+dandivine\b/gi, 'Juuou Bushin Dandivine');
  cleaned = cleaned.replace(/\bjuu\s+kishi\b/gi, 'Juukishi');
  cleaned = cleaned.replace(/\bkuro\s+neko\s+to\s+majo\b/gi, 'Kuroneko to Majo');
  cleaned = cleaned.replace(/\bkusuriya\s+no\s+hitorigoto\s*\((?:2025|2026)\)/gi, 'Kusuriya no Hitorigoto 3rd Season');
  cleaned = cleaned.replace(/\b(?:the\s+)?vermilion\s+mask\b/gi, 'Shuiro no Kamen');

  // Convert scene-release dot-separated names (e.g. "PSYREN.S01E01.CR.WEB-DL.Arabic.AR"
  // or "[CR] PSYREN.S01E01.WEB-DL.Arabic.AR") to space-separated, preventing Telegram
  // from treating them as clickable URLs (e.g. ".AR" = Argentina TLD).
  // A dot-chain is 3+ dot-separated tokens with no internal spaces (scene naming).
  const hasDotChain = /(?:^|\s)([^\s\[]+\.[^\s\[]+\.[^\s\[]+)/.test(cleaned);
  if (hasDotChain) {
    // Preserve text inside brackets, convert dots to spaces in dot-chains outside them
    cleaned = cleaned.replace(/(\[[^\]]*\])|(\S+)/g, (_, bracket, word) => {
      if (bracket) return bracket;
      // Only convert if the word itself has 3+ dot-separated parts (scene name pattern)
      if (word && word.split('.').length >= 3) {
        return word.replace(/\./g, ' ');
      }
      return word;
    }).replace(/\s+/g, ' ').trim();
  }

  return cleaned;
}

export function isOfficialPlatformRelease(title) {
  return /^\[\s*(?:cr(?:unchyroll)?|nf|netflix|dsnp|disney\+?|amzn|amazon(?:\s+prime)?|prime|hidive|shahid|bilibili|b-global|adn|abema|erai[-_\s]*raws)\s*\]/i.test(title)
    || /\b(?:CR|NF|Netflix|DSNP|Disney\+?|AMZN|Amazon|Prime|HIDIVE)\s*(?:\.|\s+)?(?:WEB-?DL|WEBRip)\b/i.test(title);
}

export function cleanEnglishTitleFromFilename(fileName, teamName = '') {
  // Reject font files, images, text/info files, or anything inside a fonts folder
  if (/\.(?:ttf|otf|woff2?|ttc|png|jpe?g|bmp|gif|txt|nfo|url|lnk)$/i.test(fileName)) {
    return null;
  }
  if (/(?:^|[\\/])fonts?[\\/]/i.test(fileName)) {
    return null;
  }

  let base = path.basename(fileName)
    .replace(/\.(mkv|mp4|ass|srt|zip|rar|7z)$/i, '')
    .trim();

  // Strip trailing language tags like .ARA, .Arabic, .AR
  base = base.replace(/\.(?:ara|arabic|ar)$/i, '').trim();

  // Strip temporary downloader prefixes like "mega_1791171461820_", "drive_12345_", "doc_12345_", "lazy_12345_"
  base = base.replace(/^(?:mega|drive|lazy|doc|work|temp|sub|down|download)[-_0-9]+[-_]/i, '').trim();

  // Strip team tag at the start if present
  let fileTeam = '';
  const teamMatch = base.match(/^\[([^\]]+)\]/);
  if (teamMatch) {
    fileTeam = teamMatch[1].trim();
    base = base.slice(teamMatch[0].length).trim();
  }

  // Strip quality tags, codecs, CRCs, resolutions
  base = base
    .replace(/\[[^\]]*(?:1080p|720p|480p|bd|bdrip|web(?:-dl)?|hevc|x26[45]|aac|flac|[0-9a-f]{8})[^\]]*\]/gi, '')
    .replace(/\([^\)]*(?:1080p|720p|480p|bd|bdrip|web(?:-dl)?|hevc|x26[45]|aac|flac|[0-9a-f]{8})[^\)]*\)/gi, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/[\(\)]+$/g, '')
    .trim();

  base = base.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  base = base.replace(/\s*(?:ep|e|#)\s*(\d{1,4})/gi, ' - $1');
  base = base.replace(/\s*-\s*(\d{1,4})/g, ' - $1');
  base = base.replace(/([a-zA-Z])\s+(\d{1,4})(?:\s*END)?$/i, '$1 - $2');
  base = base.replace(/\s+(?:ara|arabic|ar)\s*$/i, '').trim();
  base = base.replace(/\s+/g, ' ').trim();

  const hasEnglish = /[a-zA-Z]/.test(base);
  const hasArabic = /[\u0600-\u06FF\u0750-\u077F]/.test(base);

  // Ignore generic names like "extracted_sub", "subtitle", "track", "sub", "sub_1234", "untitled", "fonts", "release", "archive", "sample"
  if (/^(?:extracted(?:[-_\s]*(?:sub|subtitle))?|subtitle|sub(?:[-_\s]*\d+)?|track\d*|untitled|default|fonts?|releases?|sample(?:[-_\s]*release)?|archives?|packs?|batch(?:es)?|doc(?:[-_\s]*\d+)?|ep(?:[-_\s]*\d+)?)$/i.test(base)) {
    return null;
  }

  if (hasEnglish && !hasArabic && base.length >= 3) {
    let effectiveTeam = teamName || fileTeam;
    effectiveTeam = effectiveTeam.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (/^hoshizora(?:[-_\s]*subs?)?$/i.test(effectiveTeam)) effectiveTeam = 'ReDEJA';
    return effectiveTeam ? `[${effectiveTeam}] ${base}` : base;
  }
  return null;
}

export function resolveEnglishTitleIfArabic(rawTitle, fileNames = [], assContentPaths = []) {
  const teamMatch = rawTitle.match(/^\[([^\]]+)\]/);
  let team = teamMatch ? teamMatch[1] : '';
  if (/^hoshizora(?:[-_\s]*subs?)?$/i.test(team)) team = 'ReDEJA';

  const titleNoTeam = rawTitle.replace(/^\[[^\]]+\]\s*/, '').trim();
  const isArabic = /[\u0600-\u06FF\u0750-\u077F]/.test(titleNoTeam);

  const origEp = extractEpisodeNumber(rawTitle);

  // Expand candidate names (including files inside archives)
  const candidateNames = [];
  for (const fn of fileNames) {
    if (!fn) continue;
    let isArc = false;
    try {
      if (typeof fn === 'string' && fs.existsSync(fn) && validateFileMagic(fn)?.isArchive) {
        isArc = true;
        const innerFiles = listArchiveFiles(fn);
        // Prioritize .ass and .srt files inside archive, exclude font files
        const innerSubs = innerFiles.filter(f => /\.(ass|srt)$/i.test(f) && !/(?:^|[\\/])fonts?[\\/]/i.test(f));
        const otherInner = innerFiles.filter(f => !/\.(ass|srt)$/i.test(f) && !/\.(ttf|otf|woff2?|ttc|png|jpg|txt)$/i.test(f) && !/(?:^|[\\/])fonts?[\\/]/i.test(f));
        candidateNames.push(...innerSubs, ...otherInner);
      }
    } catch {}
    if (!isArc) {
      if (!/\.(ttf|otf|woff2?|ttc|png|jpg|txt)$/i.test(fn) && !/(?:^|[\\/])fonts?[\\/]/i.test(fn)) {
        candidateNames.push(fn);
      }
    }
  }

  // Detect batch episodes from candidate subtitle files
  const candidateSubs = candidateNames.filter(f => /\.(ass|srt)$/i.test(f));
  const epNumbers = new Set();
  for (const sub of candidateSubs) {
    const ep = extractEpisodeNumber(path.basename(sub));
    if (ep) epNumbers.add(parseInt(ep, 10));
  }
  const uniqueEps = Array.from(epNumbers).sort((a, b) => a - b);
  const isMultiEpBatch = uniqueEps.length > 1;
  const batchRangeStr = isMultiEpBatch ? `[${String(uniqueEps[0]).padStart(2, '0')}~${String(uniqueEps[uniqueEps.length - 1]).padStart(2, '0')}]` : '';
  // Detect joint teams from candidate file names (e.g. [Revive & Rhythm] inside archive or ASS)
  for (const fn of candidateNames) {
    const baseFn = path.basename(fn);
    const m = baseFn.match(/^\[([^\]]+)\]/);
    if (m) {
      const fnTeam = m[1].trim();
      if (/(?:&|\+|x|\band\b|\bwith\b|\bو\b)/i.test(fnTeam)) {
        console.log(`   🤝 Detected joint team from file: [${fnTeam}]`);
        team = fnTeam;
        break;
      }
    }
  }

  // Also inspect ASS headers for joint team attribution
  for (const p of assContentPaths) {
    if (!p || !fs.existsSync(p)) continue;
    try {
      const content = fs.readFileSync(p, 'utf8');
      const lines = content.slice(0, 3000).split('\n');
      for (const line of lines) {
        const m = line.match(/^Title:\s*(.+)/i);
        if (m) {
          const tMatch = m[1].match(/^\[([^\]]+)\]/);
          if (tMatch && /(?:&|\+|x|\band\b|\bwith\b|\bو\b)/i.test(tMatch[1])) {
            console.log(`   🤝 Detected joint team from ASS Title: [${tMatch[1]}]`);
            team = tMatch[1].trim();
            break;
          }
        }
      }
    } catch {}
  }

  if (!isArabic) {
    let baseEnglish = team ? `[${team}] ${titleNoTeam}` : rawTitle;
    if (isMultiEpBatch && !/(?:\[\s*\d+\s*[~-]\s*\d+\s*\]|\d+\s*[~-]\s*\d+)/.test(baseEnglish)) {
      baseEnglish = `${baseEnglish} ${batchRangeStr}`;
    }
    return baseEnglish;
  }

  // Check candidate file names
  for (const fn of candidateNames) {
    if (!fn) continue;
    let resolved = cleanEnglishTitleFromFilename(fn, team);
    if (resolved) {
      if (isMultiEpBatch) {
        resolved = resolved.replace(/\s*-\s*\d{1,4}$/, '').trim();
        resolved = `${resolved} ${batchRangeStr}`;
      } else if (origEp) {
        const resolvedEp = extractEpisodeNumber(resolved);
        if (!resolvedEp) {
          resolved = `${resolved} - ${origEp.padStart(2, '0')}`;
        }
      }
      console.log(`   🔤 Converted Arabic title "${rawTitle}" -> English "${resolved}" from file: ${path.basename(fn)}`);
      return resolved;
    }
  }

  // Check ASS file headers
  for (const p of assContentPaths) {
    if (!p || !fs.existsSync(p)) continue;
    try {
      const content = fs.readFileSync(p, 'utf8');
      const lines = content.slice(0, 3000).split('\n');
      for (const line of lines) {
        const m = line.match(/^Title:\s*(.+)/i);
        if (m) {
          let t = m[1].replace(/\s*-\s*(?:Arabic|العربية|عربي)\s*$/i, '').trim();
          if (!/^(?:untitled|default\s+aegisub|script|extracted)/i.test(t)) {
            let resolved = cleanEnglishTitleFromFilename(t, team);
            if (resolved) {
              if (isMultiEpBatch) {
                resolved = resolved.replace(/\s*-\s*\d{1,4}$/, '').trim();
                resolved = `${resolved} ${batchRangeStr}`;
              } else if (origEp) {
                const resolvedEp = extractEpisodeNumber(resolved);
                if (!resolvedEp) {
                  resolved = `${resolved} - ${origEp.padStart(2, '0')}`;
                }
              }
              console.log(`   🔤 Converted Arabic title "${rawTitle}" -> English "${resolved}" from ASS Title: ${t}`);
              return resolved;
            }
          }
        }
      }
    } catch {}
  }

  return team ? `[${team}] ${titleNoTeam}` : rawTitle;
}

export function extractTeamAndFormatTitle(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const line0 = (lines[0] || '').replace(/https?:\/\/[^\s"'<>]+/gi, '').trim();
  const rawTitle = formatCleanTitle(line0 || 'Anime Release');

  if (/^\[[^\]]+\]/.test(rawTitle)) {
    return rawTitle
      .replace(/^\[\s*hoshizora(?:[-_\s]*subs?)?\s*\]/i, '[ReDEJA]')
      // The same group posts under both "Bam" and "BAM25", and the source
      // sometimes puts the short form in the bracket — which published the
      // release under a team name that does not exist. Map it to the real one.
      .replace(/^\[\s*bam(?:[-_\s]*subs?)?\s*\]/i, '[BAM25]');
  }

  let team = '';
  for (const line of lines) {
    const match = line.match(/^(?:By|من قبل|ترجمة|بواسطة|فريق)\s+@?([a-zA-Z0-9_\- ]+)/i);
    if (match) {
      team = match[1].trim();
      break;
    }
  }

  if (team) {
    team = team
      .replace(/\b(?:fansubs?|subs?|subtitles?|team|فريق)\b/gi, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const tLower = team.toLowerCase();
    if (tLower === 'celestial dragons' || tLower === 'celestial') team = 'Celestial-Dragons';
    else if (tLower === 'lazysano' || tLower === 'lazysanosubs') team = 'LazySano';
    else if (tLower === 'asahi') team = 'Asahi';
    else if (tLower === 'rhythm') team = 'Rhythm';
    else if (tLower === 'kusanage') team = 'Kusanage';
    else if (tLower === 'a55bb') team = 'A55BB';
    else if (/^suzume(?:\s*soko)?$/i.test(team)) team = 'Suzume-Soko';
    else if (/^kiyoshi$/i.test(team)) team = 'Kiyoshi';
    else if (/^hoshizora(?:[-_\s]*subs?)?$/i.test(team) || tLower === 'redeja') team = 'ReDEJA';
    else if (tLower === 'zarax' || tLower === 'zaraxsub') team = 'ZaraXsub';
    else if (tLower === 'rocks' || tLower === 'rocks team') team = 'Rocks-Team';
    else if (tLower === 'mugi' || tLower === 'mugi subs') team = 'Mugi-Subs';
    else if (tLower === 'revive') team = 'REVIVE';
    else if (tLower === 'greyrats' || tLower === 'greyratssubs') team = 'Greyrats';
    else if (tLower === 'merasubs' || tLower === 'mera') team = 'Merasubs';
    else if (tLower === 'bruuhim' || tLower === 'bruuhimsubs') team = 'Bruuhim';
    else if (tLower === 'aurora' || tLower === 'aurorateam' || tLower === 'aurora team') team = 'Aurora-Team';
    else if (team) {
      team = team.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('-');
    }

    if (team) {
      return `[${team}] ${rawTitle}`;
    }
  }

  if (!team) {
    const urlMatch = text.match(/https?:\/\/(?:www\.)?([a-zA-Z0-9_\-]+)\.(?:blogspot\.com|com|net|org|pro|site|me|co|io|workers\.dev|pages\.dev)/i);
    if (urlMatch) {
      const host = urlMatch[1].toLowerCase();
      if (host.includes('mugi')) team = 'Mugi-Subs';
      else if (host.includes('kusanage')) team = 'Kusanage';
      else if (host.includes('zarax')) team = 'ZaraXsub';
      else if (host.includes('rocks')) team = 'Rocks-Team';
      else if (host.includes('rhythm')) team = 'Rhythm';
      else if (host.includes('revive')) team = 'REVIVE';
      else if (host.includes('mejaow')) team = 'Mejaow';
      else if (host.includes('suzume')) team = 'Suzume-Soko';
      else if (host.includes('kiyoshi')) team = 'Kiyoshi';
      else if (host.includes('hoshizora') || host.includes('redeja')) team = 'ReDEJA';
      else if (host.includes('a55bb')) team = 'A55BB';
      else if (host.includes('celestial')) team = 'Celestial-Dragons';
      else if (host.includes('lazysano')) team = 'LazySano';
      else if (host.includes('animesan')) team = 'Anime-San';
      else if (host.includes('stellarsaber')) team = 'Stellarsaber';
      else if (host.includes('bruuhim')) team = 'Bruuhim';
      else if (host.includes('aurora')) team = 'Aurora-Team';
    }
  }

  if (!team) {
    if (/suzume[-_\s]*soko|suzumesoko/i.test(text)) team = 'Suzume-Soko';
    else if (/kiyoshi/i.test(text)) team = 'Kiyoshi';
    else if (/hoshizora|redeja/i.test(text)) team = 'ReDEJA';
    else if (/a55bb/i.test(text)) team = 'A55BB';
    else if (/zaraxsub/i.test(text)) team = 'ZaraXsub';
    else if (/kusanage/i.test(text)) team = 'Kusanage';
    else if (/rocks[-_\s]*team/i.test(text)) team = 'Rocks-Team';
    else if (/mugi[-_\s]*subs/i.test(text)) team = 'Mugi-Subs';
    else if (/greyrats/i.test(text)) team = 'Greyrats';
    else if (/merasubs/i.test(text)) team = 'Merasubs';
  }

  return team ? `[${team}] ${rawTitle}` : rawTitle;
}

export function formatCleanCaption(title, isZip = false, isOfficial = false, hasFonts = null) {
  let clean = formatCleanTitle(title);
  clean = clean.replace(/^\[\s*hoshizora(?:[-_\s]*subs?)?\s*\]/i, '[ReDEJA]');
  const isOfficialPlatform = isOfficial || isOfficialPlatformRelease(clean);
  const fontsIncluded = hasFonts !== null ? hasFonts : (isZip && !isOfficialPlatform);
  if (fontsIncluded && !clean.toLowerCase().includes('[+fonts]')) {
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

    const suffixMatch = remainder.match(/(\s*(?:\[\s*\d+\s*(?:~|-)\s*\d+\s*\]|\(\s*\d+\s*(?:~|-)\s*\d+\s*\)|-\s*\d+.*))$/);
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

export function listArchiveFiles(archivePath) {
  const magic = validateFileMagic(archivePath);
  const ext = (magic?.ext || path.extname(archivePath)).toLowerCase();
  if (ext === '.zip') {
    try {
      const zip = new AdmZip(archivePath);
      return zip.getEntries().filter(e => !e.isDirectory).map(e => e.entryName);
    } catch { }
  }
  if (ext === '.7z' || ext === '.rar' || magic?.isArchive) {
    // 1. Try system full 7z (supports RAR when p7zip-full/p7zip-rar is installed)
    try {
      const stdout = execFileSync('7z', ['l', archivePath], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const lines = stdout.split(/\r?\n/);
      const files = [];
      let headerPassed = false;
      let parseFailed = false;
      for (const line of lines) {
        if (line.includes('-------------------')) {
          headerPassed = !headerPassed;
          continue;
        }
        if (headerPassed) {
          const match = line.match(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+([A-Za-z.]+)\s+\d+\s+(?:\d+)?\s+(.+)$/);
          if (match) {
            const attr = match[1];
            const name = match[2].trim();
            if (!attr.includes('D') && name) files.push(name);
          } else if (line.trim()) {
            parseFailed = true;
          }
        }
      }
      // Fail-closed: a row that cannot be parsed means this attempt's listing
      // is only partial – never trust it for the zip-slip guard. Drop it and
      // fall through to the next listing tool; if no tool yields a complete,
      // fully-parsed listing this function still returns [] overall.
      if (parseFailed) {
        console.warn('   ⚠️ 7z listing contained unparseable rows – refusing partial listing (fail-closed).');
      } else if (files.length > 0) return files;
    } catch { }

    // 2. Try unrar bare listing (unrar lb)
    try {
      const stdout = execFileSync('unrar', ['lb', archivePath], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const files = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (files.length > 0) return files;
    } catch { }

    // 3. Try bundled 7za
    try {
      const stdout = execFileSync(SevenZip.path7za, ['l', archivePath], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const lines = stdout.split(/\r?\n/);
      const files = [];
      let headerPassed = false;
      let parseFailed = false;
      for (const line of lines) {
        if (line.includes('-------------------')) {
          headerPassed = !headerPassed;
          continue;
        }
        if (headerPassed) {
          const match = line.match(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+([A-Za-z.]+)\s+\d+\s+(?:\d+)?\s+(.+)$/);
          if (match) {
            const attr = match[1];
            const name = match[2].trim();
            if (!attr.includes('D') && name) files.push(name);
          } else if (line.trim()) {
            parseFailed = true;
          }
        }
      }
      if (parseFailed) {
        console.warn('   ⚠️ 7za listing contained unparseable rows – refusing partial listing (fail-closed).');
      } else if (files.length > 0) return files;
    } catch { }
  }

  // 4. Try tar -tf (supports RAR on Windows bsdtar)
  try {
    const stdout = execFileSync('tar', ['-tf', archivePath], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return stdout
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => Boolean(l) && !l.endsWith('/'));
  } catch (e) {
    return [];
  }
}

// Post-extraction containment check (zip-slip catch-all): after a successful
// extraction, no entry may resolve outside the destination directory.
// On any escape, best-effort discard the whole extraction and report failure.
function verifyExtractedTree(destDir) {
  const discard = (why) => {
    console.warn(`   ⚠️ Discarding extraction in ${path.basename(destDir)}: ${why}`);
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { }
    return false;
  };
  let realRoot;
  try {
    realRoot = fs.realpathSync(destDir);
  } catch (e) {
    return discard(`verification error: ${e.message}`);
  }
  const stack = [realRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return discard(`verification error: ${e.message}`);
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      let real;
      try {
        real = fs.realpathSync(full);
      } catch (e) {
        return discard(`unresolvable entry ${full}: ${e.message}`);
      }
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        return discard(`entry escapes destination: ${full} -> ${real}`);
      }
      // Verify the link target above, but never descend through symlinks.
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) stack.push(full);
    }
  }
  return true;
}

export function extractArchive(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const magic = validateFileMagic(archivePath);
  const ext = (magic?.ext || path.extname(archivePath)).toLowerCase();
  // Fail-closed guard against path traversal (zip-slip) in untrusted archives – applies to ALL extraction paths.
  try {
    const entries = listArchiveFiles(archivePath);
    const isUnsafe = (e) => {
      const s = String(e);
      return s.split(/[\\/]/).some(c => /^\.\.[ .]*$/.test(c)) || s.startsWith('/') || s.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(s);
    };
    if (entries.length === 0) {
      console.warn(`   ⚠️ Refusing to extract ${path.basename(archivePath)}: empty/failed listing (fail-closed).`);
      return false;
    }
    if (entries.some(isUnsafe)) {
      console.warn(`   ⚠️ Refusing to extract ${path.basename(archivePath)}: unsafe path entries detected.`);
      return false;
    }
    // Refuse archives containing symbolic links (symlink-based zip-slip).
    // Tri-state probes: 'unsafe' (symlink found), 'checked' (probe ran and
    // could read the format, no symlinks), 'unavailable' (tool missing or
    // could not read the format). Refuse on 'unsafe', and also when every
    // probe is 'unavailable' – if nothing could verify symlink safety we must
    // not extract (fail-closed).
    const refuse = (why) => {
      console.warn(`   ⚠️ Refusing to extract ${path.basename(archivePath)}: ${why}`);
      return false;
    };
    const symlinkProbes = [];
    if (ext === '.zip') {
      // AdmZip reads exactly the archives the zip extraction branch below
      // will read, so a successful read counts as 'checked'.
      try {
        const zip = new AdmZip(archivePath);
        const unixMode = (e) => (Number(e.attr) >>> 16) & 0xF000; // S_IFLNK = 0xA000
        symlinkProbes.push(zip.getEntries().some(e => unixMode(e) === 0xA000) ? 'unsafe' : 'checked');
      } catch { symlinkProbes.push('unavailable'); }
    }
    try {
      const tv = execFileSync('tar', ['-tvf', archivePath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 });
      symlinkProbes.push(tv.split(/\r?\n/).some(l => l.startsWith('l')) ? 'unsafe' : 'checked');
    } catch { symlinkProbes.push('unavailable'); }
    for (const tool of ['7z', SevenZip.path7za]) {
      try {
        const slt = execFileSync(tool, ['l', '-slt', archivePath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 });
        symlinkProbes.push(/^Symbolic Link = /m.test(slt) ? 'unsafe' : 'checked');
      } catch { symlinkProbes.push('unavailable'); }
    }
    if (symlinkProbes.includes('unsafe')) return refuse('archive contains symbolic links.');
    if (!symlinkProbes.includes('checked')) return refuse('cannot verify symlink safety (fail-closed).');
  } catch (e) {
    console.warn(`   ⚠️ Refusing to extract ${path.basename(archivePath)}: listing error (fail-closed): ${e.message}`);
    return false;
  }
  if (ext === '.zip') {
    try {
      const zip = new AdmZip(archivePath);
      zip.extractAllTo(destDir, true);
      return verifyExtractedTree(destDir);
    } catch { }
  }
  if (ext === '.7z' || ext === '.rar' || magic?.isArchive) {
    // 1. Try system full 7z
    try {
      execFileSync('7z', ['x', archivePath, `-o${destDir}`, '-y'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return verifyExtractedTree(destDir);
    } catch { }

    // 2. Try unrar
    try {
      execFileSync('unrar', ['x', '-y', '-inul', archivePath, `${destDir}/`], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return verifyExtractedTree(destDir);
    } catch { }

    // 3. Try bundled 7za
    try {
      execFileSync(SevenZip.path7za, ['x', archivePath, `-o${destDir}`, '-y'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return verifyExtractedTree(destDir);
    } catch { }
  }

  // 4. Try tar -xf (supports RAR on Windows bsdtar)
  try {
    execFileSync('tar', ['-xf', archivePath, '-C', destDir], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return verifyExtractedTree(destDir);
  } catch (e) {
    return false;
  }
}

export function packFolderToZip(folderPath, destZipPath) {
  const zip = new AdmZip();
  function addRecursive(dir, zipSubDir = '') {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        addRecursive(fullPath, zipSubDir ? `${zipSubDir}/${item.name}` : item.name);
      } else if (/\.(ass|srt)$/i.test(item.name)) {
        zip.addLocalFile(fullPath, zipSubDir);
      } else if (/\.(ttf|otf|woff2?|ttc)$/i.test(item.name)) {
        const targetFontDir = zipSubDir || 'Fonts';
        zip.addLocalFile(fullPath, targetFontDir);
      }
    }
  }
  addRecursive(folderPath);
  zip.writeZip(destZipPath);
  return destZipPath;
}

export async function downloadFileToDisk(url, destPath, headers = {}, options = {}) {
  const signal = AbortSignal.timeout(10 * 60 * 1000);
  const requestOptions = {
    signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      ...headers
    }
  };
  const expectedHost = options.expectedHost ? String(options.expectedHost).toLowerCase() : null;
  const assertHost = res => {
    if (!expectedHost) return;
    const actualHost = new URL(res.url).hostname.toLowerCase();
    if (actualHost !== expectedHost) {
      throw new Error(`Download redirected to unexpected host "${actualHost}" (expected "${expectedHost}")`);
    }
  };

  let res = await fetch(url, requestOptions);
  assertHost(res);

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
      assertHost(res);
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
function fetchSubdlHtmlWithCurl(url) {
  try {
    const command = process.platform === 'win32' ? 'curl.exe' : 'curl';
    return execFileSync(command, [
      '-s', '-L', '--compressed',
      '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '-H', 'Accept-Language: en-US,en;q=0.9',
      url
    ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 30000 });
  } catch (e) {
    console.warn('SUBDL curl fallback error:', e.message);
    return null;
  }
}

export async function resolveSubdlDownloadData(infoUrl) {
  let html = '';
  try {
    const res = await fetchWithTimeout(infoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (res.ok) {
      const candidate = await res.text();
      if (!candidate.includes('Just a moment...') && !/<title>\s*Just a moment/i.test(candidate)) {
        html = candidate;
      }
    }
  } catch {}

  if (!html || !html.includes('dl.subdl.com')) {
    const curlHtml = fetchSubdlHtmlWithCurl(infoUrl);
    if (curlHtml && !curlHtml.includes('Just a moment...') && curlHtml.includes('dl.subdl.com')) {
      html = curlHtml;
    }
  }

  // Cloudflare bypass fallback via Jina reader (returns complete HTML without Cloudflare challenge)
  if (!html || !html.includes('dl.subdl.com') || html.includes('Just a moment...')) {
    try {
      const jinaRes = await fetchWithTimeout(`https://r.jina.ai/${infoUrl}`, {
        headers: {
          'X-Return-Format': 'html',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      if (jinaRes.ok) {
        const jinaHtml = await jinaRes.text();
        if (jinaHtml.includes('dl.subdl.com')) {
          html = jinaHtml;
        }
      }
    } catch (e) {
      console.warn('Subdl Jina fallback error:', e.message);
    }
  }

  if (!html) return null;

  const doc = cheerio.load(html);
  const allLinks = [];
  doc('a[href]').each((_, el) => {
    const href = doc(el).attr('href') || '';
    if (href.includes('dl.subdl.com/subtitle/')) {
      if (!allLinks.includes(href)) allLinks.push(href);
    }
  });

  if (allLinks.length === 0) {
    const rawMatches = [...html.matchAll(/href=["']([^"']*dl\.subdl\.com\/subtitle\/[^"']*)["']/gi)];
    for (const m of rawMatches) {
      if (!allLinks.includes(m[1])) allLinks.push(m[1]);
    }
  }

  if (allLinks.length === 0) return null;

  // The main complete batch zip archive on Subdl matches /subtitle/\d+-\d+
  const batchZipLink = allLinks.find(l => /dl\.subdl\.com\/subtitle\/\d+-\d+/i.test(l));
  const individualLinks = allLinks.filter(l => !/dl\.subdl\.com\/subtitle\/\d+-\d+/i.test(l));

  return {
    batchZipLink: batchZipLink || null,
    individualLinks,
    allLinks
  };
}

function extractKeywordsFromTitleOrFile(str) {
  const norm = (str || '')
    .toLowerCase()
    .replace(/[._\-+,]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ');
  return norm.split(/\s+/).filter(w =>
    w.length >= 3 &&
    !/^(?:zip|rar|7z|ass|srt|1080p|720p|480p|end|batch|pack|the|and|sub|subdl)$/i.test(w)
  );
}

export function findMatchingPosterMsgForDoc(docMsg, allMsgs) {
  const doc = docMsg.media?.document;
  const originalName = doc?.attributes?.find(a => a.fileName)?.fileName || '';
  const docKeywords = extractKeywordsFromTitleOrFile(originalName);

  let bestMsg = null;
  let bestScore = -1;

  for (let offset = 1; offset <= 3; offset++) {
    for (const sign of [-1, 1]) {
      const targetId = docMsg.id + (sign * offset);
      const cand = allMsgs.find(m => m && m.id === targetId);
      if (!cand || !cand.message) continue;

      const candText = cand.message;
      const candKeywords = extractKeywordsFromTitleOrFile(candText);

      let overlap = 0;
      for (const kw of docKeywords) {
        if (candKeywords.includes(kw)) overlap++;
      }

      let score = overlap * 10;
      if (sign === -1) score += (4 - offset); // Preceding message gets priority bonus

      if (candText.includes('📍') || /^\[[^\]]+\]/.test(candText.trim())) {
        score += 2;
      }

      if (overlap >= 1 && score > bestScore) {
        bestScore = score;
        bestMsg = cand;
      }
    }
  }

  // Fallback: if no keyword overlap found, check immediate predecessor
  if (!bestMsg) {
    const prev = allMsgs.find(m => m && m.id === docMsg.id - 1);
    if (prev && prev.message && (prev.message.includes('📍') || /^\[[^\]]+\]/.test(prev.message.trim()))) {
      bestMsg = prev;
    }
  }

  return bestMsg;
}

export function hasCoveringDocumentMsg(textMsg, allMsgs) {
  for (let offset = 1; offset <= 3; offset++) {
    for (const sign of [1, -1]) {
      const targetId = textMsg.id + (sign * offset);
      const candDoc = allMsgs.find(m => m && m.id === targetId && m.media?.document);
      if (candDoc) {
        const matchedPoster = findMatchingPosterMsgForDoc(candDoc, allMsgs);
        if (matchedPoster && matchedPoster.id === textMsg.id) {
          return candDoc;
        }
      }
    }
  }
  return null;
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

  // Erai lists the subtitle languages, sometimes as flags and sometimes as
  // plain text. Requiring the 🇸🇦 emoji alone silently dropped every release
  // that spelled it out — JoJo SBR 06 was marked as posted and never published.
  const hasArabic = text.includes('🇸🇦') || /\barabic\b|العربية|عربي|عربى/i.test(text);

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
export function extractSubtitleAndFontsFromAnyFile(filePath, workDir, isOfficial = false, preferArabic = false, customSubName = '') {
  if (!fs.existsSync(filePath)) return null;

  // 1. Direct valid archive or subtitle file
  const magic = validateFileMagic(filePath);
  if (magic) {
    if (magic.isArchive && customSubName) {
      const arcUnpackDir = path.join(workDir, 'arc_unpack');
      if (extractArchive(filePath, arcUnpackDir)) {
        const allFiles = [];
        function scanA(dir) {
          for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, f.name);
            if (f.isDirectory()) scanA(full);
            else allFiles.push(full);
          }
        }
        scanA(arcUnpackDir);
        const subFiles = allFiles.filter(f => /\.(ass|srt)$/i.test(f));
        if (subFiles.length === 1) {
          const subExt = path.extname(subFiles[0]).toLowerCase();
          const properSubName = getSafeTelegramFileName(customSubName, subExt);
          const renamedPath = path.join(path.dirname(subFiles[0]), properSubName);
          if (subFiles[0] !== renamedPath) {
            safeMoveFile(subFiles[0], renamedPath);
          }
          const repackedZip = path.join(workDir, 'repacked_release.zip');
          packFolderToZip(arcUnpackDir, repackedZip);
          if (fs.existsSync(repackedZip) && fs.statSync(repackedZip).size > 100) {
            return { filePath: repackedZip, isArchive: true, ext: '.zip', resolvedTitle: customSubName };
          }
        } else if (subFiles.length > 1) {
          // Multi-episode batch archive: repack with packFolderToZip to ensure fonts are in Fonts/
          const repackedZip = path.join(workDir, 'repacked_release.zip');
          packFolderToZip(arcUnpackDir, repackedZip);
          if (fs.existsSync(repackedZip) && fs.statSync(repackedZip).size > 100) {
            return { filePath: repackedZip, isArchive: true, ext: '.zip', resolvedTitle: customSubName };
          }
        }
      }
    }
    return { filePath, isArchive: magic.isArchive, ext: magic.ext, resolvedTitle: customSubName };
  }

  // 2. MKV / Video file with softsubs & fonts
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mkv' || ext === '.mp4' || ext === '.m4v') {
    try {
      const trackInfo = execFileSync('mkvmerge', ['--identify', '--identification-format', 'json', filePath], {
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

      const videoBase = path.basename(filePath, path.extname(filePath));
      const cleanedVideoBase = cleanEnglishTitleFromFilename(videoBase) || videoBase;

      let subBaseName = '';
      if (customSubName) {
        subBaseName = getSafeTelegramFileName(customSubName, '');
      } else {
        subBaseName = getSafeTelegramFileName(cleanedVideoBase, '');
      }
      if (!subBaseName || subBaseName === 'extracted_sub') subBaseName = 'subtitle';
      const extractedSubPath = path.join(workDir, `${subBaseName}${subExt}`);

      execFileSync('mkvextract', ['tracks', filePath, `${trackId}:${extractedSubPath}`], {
        stdio: 'pipe',
        timeout: 60000
      });

      if (!fs.existsSync(extractedSubPath) || fs.statSync(extractedSubPath).size < 50) return null;

      // Official releases (Erai-Raws) strictly receive .ass ONLY - no font extraction, no zip!
      if (isOfficial) {
        return { filePath: extractedSubPath, isArchive: false, ext: subExt, resolvedTitle: customSubName || cleanedVideoBase };
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

        const extractArgs = attachments.map(a => `${a.id}:${path.join(fontsDir, safeRemoteBaseName(a.file_name, `font_${a.id}`))}`);
        try {
          execFileSync('mkvextract', ['attachments', filePath, ...extractArgs], { stdio: 'pipe', timeout: 60000 });
          const zipPath = path.join(workDir, 'release_fonts.zip');

          const zip = new AdmZip();
          zip.addLocalFile(extractedSubPath);
          for (const f of fs.readdirSync(fontsDir)) {
            const fontFile = path.join(fontsDir, f);
            if (fs.statSync(fontFile).isFile()) {
              zip.addLocalFile(fontFile, 'Fonts');
            }
          }
          zip.writeZip(zipPath);

          if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 100) {
            return { filePath: zipPath, isArchive: true, ext: '.zip', resolvedTitle: customSubName || cleanedVideoBase };
          }
        } catch (e) {
          console.warn('   ⚠️ Font extraction/zipping error:', e.message);
        }
      }

      return { filePath: extractedSubPath, isArchive: false, ext: subExt, resolvedTitle: customSubName || cleanedVideoBase };
    } catch (e) {
      console.warn('   ⚠️ MKV extraction error:', e.message);
      return null;
    }
  }

  return null;
}

function downloadTorrentWithAria2c(args, timeoutMs = 8 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('aria2c', args, { stdio: 'pipe' });
    let timer = null;
    let killed = false;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { }
        }, 5000).unref?.();
        reject(new Error(`aria2c timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    }

    proc.on('error', err => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    proc.on('close', code => {
      if (timer) clearTimeout(timer);
      if (killed) return;
      if (code === 0) resolve();
      else reject(new Error(`aria2c exited with code ${code}`));
    });
  });
}

async function downloadAndExtractSubtitleFromTorrent(torrentUrl, workDir, isOfficial = false, preferArabic = true, customSubName = '') {
  const torrentPath = path.join(workDir, 'release.torrent');
  await downloadFileToDisk(torrentUrl, torrentPath);
  console.log(`   📥 Torrent file downloaded (${fs.statSync(torrentPath).size} bytes)`);

  const downloadDir = path.join(workDir, 'mkv_dl');
  fs.mkdirSync(downloadDir, { recursive: true });
  try {
    console.log(`   📥 Downloading MKV via aria2c...`);
    await downloadTorrentWithAria2c(
      [
        '--seed-time=0', '--max-upload-limit=1K', '--file-allocation=none',
        '--max-concurrent-downloads=5', '--split=5', '--max-connection-per-server=5',
        '--continue=true', `--dir=${downloadDir}`, torrentPath
      ],
      8 * 60 * 1000
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

  let resolvedTitle = customSubName;
  if (mkvPath) {
    resolvedTitle = resolveEnglishTitleIfArabic(customSubName, [mkvPath]);
  }

  const result = extractSubtitleAndFontsFromAnyFile(mkvPath, workDir, isOfficial, preferArabic, resolvedTitle);

  try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch { }
  try { fs.rmSync(torrentPath, { force: true }); } catch { }

  return result ? { ...result, resolvedTitle } : null;
}

// ====================================================================
// Document publisher (Bot API with automatic MTProto Fallback)
// ====================================================================
export async function publishDocument(client, filePath, caption, options = {}) {
  const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  const FILE_SIZE_BOT_API_LIMIT = 50 * 1024 * 1024; // 50 MB (official Bot API document limit)

  // 1. Try standard Telegram Bot API for small files
  if (CONFIG.TELEGRAM.BOT_TOKEN && fileSize <= FILE_SIZE_BOT_API_LIMIT) {
    try {
      const sendResult = await sendDocument(filePath, caption, options);
      if (sendResult?.ok) {
        return sendResult;
      }
      console.warn(`   ⚠️ Telegram Bot API failed:`, sendResult?.description || sendResult);
    } catch (botErr) {
      console.warn(`   ⚠️ Telegram Bot API error:`, botErr.message);
    }
  } else if (fileSize > FILE_SIZE_BOT_API_LIMIT) {
    console.log(`   📦 File is ${(fileSize / 1024 / 1024).toFixed(1)} MB – skipping Bot API, using MTProto directly.`);
  }

  // 2. Post directly via MTProto client session (primary for large files, fallback for small)
  if (client && client.connected) {
    console.log(`   🔄 Publishing via MTProto client session...`);
    try {
      const channel = await client.getEntity(CONFIG.TELEGRAM.TARGET_CHANNEL);
      const uploadTimeoutMs = Math.max(180_000, Math.ceil(fileSize / (40 * 1024)) * 1000); // at least 3m, or calculated from size
      const uploadPromise = client.sendFile(channel, {
        file: filePath,
        caption: caption,
        parseMode: 'html',
        forceDocument: true,
        workers: 4
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`MTProto upload timed out after ${Math.round(uploadTimeoutMs / 1000)}s`)), uploadTimeoutMs)
      );
      const sent = await Promise.race([uploadPromise, timeoutPromise]);
      if (sent) {
        console.log(`   ✅ Successfully posted via MTProto! (Message ID: ${sent.id})`);
        return { ok: true, result: { message_id: sent.id } };
      }
    } catch (mtErr) {
      console.error(`   ❌ MTProto upload failed:`, mtErr.message);
    }
  }

  return { ok: false, description: 'All publication methods failed' };
}

export async function dispatchBatchExtractor(torrentUrl, releaseTitle, chatId, langs = 'ara') {
  const ghPat = process.env.GH_PAT;
  if (!ghPat) {
    console.warn('   ⚠️ GH_PAT not configured; cannot dispatch to sub-extractor.');
    return false;
  }
  try {
    const res = await fetch('https://api.github.com/repos/NewKazuha/sub-extractor/actions/workflows/extract.yml/dispatches', {
      method: 'POST',
      headers: {
        'Authorization': `token ${ghPat}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'sub-bot'
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          url: torrentUrl,
          name: releaseTitle,
          chat_id: String(chatId),
          langs: String(langs || 'ara')
        }
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (res.status === 204) {
      console.log(`   ✅ Successfully triggered sub-extractor for "${releaseTitle}"!`);
      return true;
    } else {
      const errText = await res.text();
      console.warn(`   ⚠️ sub-extractor dispatch failed (HTTP ${res.status}): ${errText}`);
      return false;
    }
  } catch (e) {
    console.warn(`   ⚠️ sub-extractor dispatch network error:`, e.message);
    return false;
  }
}

// ====================================================================
// Main check function
// ====================================================================
export async function checkTelegramChannels(existingClient = null) {
  const sessionStr = CONFIG.TELEGRAM.SESSION;
  if (!sessionStr) {
    console.warn('No Telegram SESSION found in config.');
    return;
  }

  const posted = loadPostedIds();
  resetCycleBudget(); // fresh AniList query budget for this check cycle
  let newFound = 0;
  const toolsAvailable = hasRequiredTools();

  if (!toolsAvailable) console.log(`   ⚠️ aria2c/mkvextract not found in this environment – Torrent/Cloud extraction will run in GitHub Actions.`);

  // Reuse caller-provided client or create a local one (auto-cleaned in finally)
  const ownClient = !existingClient;
  const client = existingClient || new TelegramClient(
    new StringSession(sessionStr),
    CONFIG.TELEGRAM.API_ID,
    CONFIG.TELEGRAM.API_HASH,
    { connectionRetries: 5 }
  );

  try {
    if (!client.connected) {
      console.log(`\n📡 [Telegram MTProto Client] Connecting to Telegram...`);
      await client.connect();
    } else {
      console.log(`\n📡 [Telegram MTProto Client] Reusing persistent connection...`);
    }

    // Sync existing target channel history into posted set to eliminate any duplicates
    try {
      const targetChatId = CONFIG.TELEGRAM.TARGET_CHANNEL;
      const targetMsgs = await client.getMessages(targetChatId, { limit: 300 });
      // Identity layer: prefetch canonical titles for all unique strings in the
      // sync window (deduped, budget-capped, fail-open). Cold-cache note: this
      // pre-pass may consume the whole per-cycle AniList budget; the candidate
      // sites below then fail open to text keys for this cycle (safe).
      const syncTitles = [];
      for (const tm of targetMsgs) {
        const text = tm.message || '';
        const firstLine = text.split('\n')[0].trim();
        if (firstLine) syncTitles.push(firstLine);
        if (tm.media?.document?.attributes) {
          const fn = tm.media.document.attributes.find(a => a.fileName)?.fileName;
          if (fn) syncTitles.push(fn);
        }
      }
      await resolveCanonicalTitlesBatch(syncTitles);
      for (const tm of targetMsgs) {
        const text = tm.message || '';
        const firstLine = text.split('\n')[0].trim();
        if (firstLine) {
          const rc = getCachedCanonical(firstLine);
          getReleaseKeys(firstLine, true, rc).forEach(k => posted.add(k));
          getReleaseKeys(firstLine, false, rc).forEach(k => posted.add(k));
          getFansubReleaseKeys(firstLine, rc).forEach(k => posted.add(k));
        }
        if (tm.media?.document?.attributes) {
          const fn = tm.media.document.attributes.find(a => a.fileName)?.fileName;
          if (fn) {
            const rc = getCachedCanonical(fn);
            getReleaseKeys(fn, true, rc).forEach(k => posted.add(k));
            getReleaseKeys(fn, false, rc).forEach(k => posted.add(k));
            getFansubReleaseKeys(fn, rc).forEach(k => posted.add(k));
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

      const isFansubPublisher = idStr.includes(CHANNEL_FANSUB) || title.includes('arabic anime publisher');
      const isOfficialKokoboko = idStr.includes(CHANNEL_KOKOBOKO) || title.includes('kokoboko [subdl]');
      const isOfficialRengoku = idStr.includes(CHANNEL_RENGOKU) || title.includes('rengoku [subdl]');
      const isEraiRaws = idStr.includes(CHANNEL_ERAI) || title.includes('erai-raws');
      const isLazySano = idStr.includes(CHANNEL_LAZYSANO) || title.includes('lazysano') || title.includes('レイジーさん');

      return isFansubPublisher || isOfficialKokoboko || isOfficialRengoku || isEraiRaws || isLazySano;
    });

    function getChannelPriority(chat) {
      const idStr = String(chat.id);
      const titleLower = (chat.title || '').toLowerCase();
      if (idStr.includes(CHANNEL_RENGOKU) || titleLower.includes('rengoku')) return 1;
      if (idStr.includes(CHANNEL_KOKOBOKO) || titleLower.includes('kokoboko')) return 2;
      if (idStr.includes(CHANNEL_LAZYSANO) || titleLower.includes('lazysano') || titleLower.includes('レイジーさん')) return 3;
      if (idStr.includes(CHANNEL_ERAI) || titleLower.includes('erai-raws')) return 4;
      if (idStr.includes(CHANNEL_FANSUB) || titleLower.includes('arabic anime publisher')) return 5;
      return 10;
    }

    targetSourceChats.sort((a, b) => getChannelPriority(a) - getChannelPriority(b));

    console.log(`   Found ${targetSourceChats.length} targeted source channel(s) (ordered by priority):`);
    targetSourceChats.forEach(c => console.log(`   - ${c.title} (ID: ${c.id})`));

    fs.mkdirSync(OUT_DIR, { recursive: true });

    for (const chat of targetSourceChats) {
      try {
        const idStr = String(chat.id);
        const titleLower = (chat.title || '').toLowerCase();
        const isKokoboko = idStr.includes(CHANNEL_KOKOBOKO) || titleLower.includes('kokoboko');
        const isRengoku = idStr.includes(CHANNEL_RENGOKU) || titleLower.includes('rengoku');
        const isErai = idStr.includes(CHANNEL_ERAI) || titleLower.includes('erai-raws');
        const isLazySano = idStr.includes(CHANNEL_LAZYSANO) || titleLower.includes('lazysano') || titleLower.includes('レイジーさん');
        const isFansubPublisher = idStr.includes(CHANNEL_FANSUB) || titleLower.includes('arabic anime publisher');

        console.log(`\n🔍 Checking: "${chat.title}" (ID: ${chat.id})`);
        // Sources can publish a batch far larger than one scheduled interval.
        // Keep enough history to retry a failed batch instead of losing it once
        // newer messages push it beyond the old 15-message window.
        const msgs = await client.getMessages(chat.id, { limit: 15 });

        for (const msg of msgs) {
          const msgKey = `tg_${chat.id}_${msg.id}`;
          const text = msg.message || '';
          if (posted.has(msgKey)) {
            continue;
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
            const eraiResolved = await resolveCanonicalTitle(formattedTitle);
            const releaseKeys = getReleaseKeys(formattedTitle, true, eraiResolved);

            if (isReleaseAlreadyPosted(posted, releaseKeys)) {
              console.log(`   ⏭️ [Erai-Raws] "${formattedTitle}" already posted as official release. Skipping.`);
              markReleaseAsPosted(posted, msgKey, releaseKeys);
              continue;
            }

            // Batch Guard: detect multi-episode packages (e.g. 01 ~ 10, 01-12)
            // Instead of local download which freezes runner, dispatch to sub-extractor workflow
            const batchRange = extractBatchRange(eraiData.title);
            if (batchRange && batchRange[1] > batchRange[0]) {
              console.log(`   📦 [Erai-Raws] Detected multi-episode batch "${formattedTitle}" (episodes ${batchRange[0]}~${batchRange[1]}).`);
              if (process.env.GH_PAT && eraiData.torrentUrl) {
                console.log(`   🚀 Dispatching batch extraction to sub-extractor workflow...`);
                const dispatched = await dispatchBatchExtractor(eraiData.torrentUrl, formattedTitle, CONFIG.TELEGRAM.TARGET_CHANNEL);
                if (dispatched) {
                  markReleaseAsPosted(posted, msgKey, releaseKeys);
                } else {
                  console.warn(`   ⚠️ Dispatch failed — will retry next cycle.`);
                }
              } else {
                console.log(`   ⏭️ Skipping batch extraction (GH_PAT not set or no torrent URL).`);
              }
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
              const extracted = await downloadAndExtractSubtitleFromTorrent(eraiData.torrentUrl, eraiWorkDir, true, true, formattedTitle);

              if (extracted && extracted.filePath) {
                const effectiveTitle = extracted.resolvedTitle || formattedTitle;
                const cleanFileName = getSafeTelegramFileName(effectiveTitle, extracted.ext);
                const finalPath = path.join(OUT_DIR, cleanFileName);
                safeMoveFile(extracted.filePath, finalPath);

                const caption = formatCleanCaption(effectiveTitle, false, true);
                console.log(`   📤 Publishing official sub: "${caption}" (filename: ${cleanFileName})`);
                const sendResult = await publishDocument(client, finalPath, caption);

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
              try { fs.rmSync(eraiWorkDir, { recursive: true, force: true }); } catch { }
            }

            continue;
          }

          // ==============================================================
          // SOURCE 2: Subdl Channels (KokoBoko & Rengoku - As-Is .ass or .zip)
          // ==============================================================
          if (isKokoboko || isRengoku) {
            // --- CASE A: File directly attached in KokoBoko/Rengoku message ---
            if (msg.media && msg.media.document) {
              const doc = msg.media.document;
              const originalName = doc.attributes?.find(a => a.fileName)?.fileName || '';
              const docExt = path.extname(originalName).toLowerCase();

              if (['.ass', '.srt', '.zip', '.rar', '.7z'].includes(docExt)) {
                let cleanTitle = '';
                let linkedMsgId = null;

                const lines = (msg.message || '').split('\n').map(l => l.trim()).filter(Boolean);
                if (lines.length > 0 && lines[0].length > 3) {
                  cleanTitle = formatCleanTitle(lines[0]);
                }

                // Look for matching poster message using keyword matching and chronology
                if (!cleanTitle || !/^\[[^\]]+\]/.test(cleanTitle)) {
                  const matchedPoster = findMatchingPosterMsgForDoc(msg, msgs);
                  if (matchedPoster) {
                    const posterLines = (matchedPoster.message || '').split('\n').map(l => l.trim()).filter(Boolean);
                    if (posterLines[0]) {
                      cleanTitle = formatCleanTitle(posterLines[0]);
                      linkedMsgId = matchedPoster.id;
                    }
                  }
                }

                if (!cleanTitle) {
                  const baseName = originalName
                    .replace(/\.(ass|srt|zip|rar|7z)$/i, '')
                    .replace(/_/g, ' ')
                    .trim();
                  cleanTitle = formatCleanTitle(baseName);
                  if (!/^\[[^\]]+\]/.test(cleanTitle)) {
                    const teamMatch = baseName.match(/^([a-zA-Z0-9_\-]+)\s+/);
                    if (teamMatch && /^(revive|rhythm|celestial|lazysano|suzume|kiyoshi|redeja|asahi|zarax|rocks|3yar|bruuhim|aurora)/i.test(teamMatch[1])) {
                      cleanTitle = `[${teamMatch[1]}] ${baseName.slice(teamMatch[0].length).trim()}`;
                    } else {
                      cleanTitle = `[Subdl] ${cleanTitle}`;
                    }
                  }
                }

                const isOfficialSubdl = isOfficialPlatformRelease(cleanTitle);
                const cleanTitleResolved = await resolveCanonicalTitle(cleanTitle);
                const releaseKeys = isOfficialSubdl
                  ? getReleaseKeys(cleanTitle, true, cleanTitleResolved)
                  : getFansubReleaseKeys(cleanTitle, cleanTitleResolved);

                if (isReleaseAlreadyPosted(posted, releaseKeys)) {
                  markReleaseAsPosted(posted, msgKey, releaseKeys);
                  if (linkedMsgId) markReleaseAsPosted(posted, `tg_${chat.id}_${linkedMsgId}`, releaseKeys);
                  continue;
                }

                console.log(`\n✨ [Subdl Direct File] "${cleanTitle}" (${originalName})`);
                const localFilePath = path.join(OUT_DIR, `doc_${msg.id}_${safeRemoteBaseName(originalName)}`);
                if (!isInsideDir(localFilePath, OUT_DIR)) {
                  console.warn(`   ⚠️ Skipping "${cleanTitle}": unsafe document file name "${originalName}".`);
                  continue;
                }

                try {
                  await client.downloadMedia(msg, { outputFile: localFilePath, workers: 4 });
                  if (fs.existsSync(localFilePath) && fs.statSync(localFilePath).size > 0) {
                    let validated = validateFileMagic(localFilePath);

                    if (validated) {
                      let effectiveDownloadPath = localFilePath;

                      let hasArchiveFonts = false;
                      if (validated.isArchive) {
                        const archiveFiles = listArchiveFiles(localFilePath);
                        cleanTitle = resolveEnglishTitleIfArabic(cleanTitle, [originalName, ...archiveFiles]);
                        const subFiles = archiveFiles.filter(f => /\.(ass|srt)$/i.test(f));
                        const fontFiles = archiveFiles.filter(f => /\.(ttf|otf|woff2?)$/i.test(f));
                        hasArchiveFonts = fontFiles.length > 0;

                        if (subFiles.length === 0) {
                          console.warn(`   ⚠️ Archive contains NO subtitles (.ass/.srt), only fonts/assets. Skipping.`);
                          fs.rmSync(localFilePath, { force: true });
                          continue;
                        }

                        const isBatch = subFiles.length > 1 || /(?:\[\s*\d{1,4}|\b\d{1,4})\s*(?:~|-|–|to)\s*\d{1,4}(?:\s*END)?(?:\s*\]|\b)/i.test(cleanTitle) || /كامل|batch|pack/i.test(cleanTitle);

                        if (!isBatch && subFiles.length === 1 && !hasArchiveFonts) {
                          const extractDir = path.join(OUT_DIR, `unpack_single_${msg.id}`);
                          if (extractArchive(localFilePath, extractDir)) {
                            const singleFileName = path.basename(subFiles[0]);
                            const foundFile = path.join(extractDir, subFiles[0]);
                            const singleExt = path.extname(singleFileName).toLowerCase();
                            cleanTitle = resolveEnglishTitleIfArabic(cleanTitle, [singleFileName, originalName], [foundFile]);
                            const unzippedSubPath = path.join(OUT_DIR, getSafeTelegramFileName(cleanTitle, singleExt));
                            if (fs.existsSync(foundFile)) {
                              safeMoveFile(foundFile, unzippedSubPath);
                              const unzippedVal = validateFileMagic(unzippedSubPath);
                              if (unzippedVal) {
                                effectiveDownloadPath = unzippedSubPath;
                                validated = unzippedVal;
                              }
                            }
                            try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { }
                          }
                        } else {
                          // For batch releases or releases with fonts, repack as clean universal .zip
                          const extractDir = path.join(OUT_DIR, `unpack_batch_${msg.id}`);
                          if (extractArchive(localFilePath, extractDir)) {
                            const allExt = [];
                            function scanSubdlA(dir) {
                              for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                                const full = path.join(dir, f.name);
                                if (f.isDirectory()) scanSubdlA(full);
                                else if (/\.(ass|srt)$/i.test(f.name)) allExt.push(full);
                              }
                            }
                            scanSubdlA(extractDir);
                            if (allExt.length === 1) {
                              cleanTitle = resolveEnglishTitleIfArabic(cleanTitle, [path.basename(allExt[0]), originalName], [allExt[0]]);
                              const sExt = path.extname(allExt[0]).toLowerCase();
                              const properSubName = getSafeTelegramFileName(cleanTitle, sExt);
                              const renamedSub = path.join(path.dirname(allExt[0]), properSubName);
                              if (allExt[0] !== renamedSub) {
                                safeMoveFile(allExt[0], renamedSub);
                              }
                            }
                            const repackedZip = path.join(OUT_DIR, `batch_${msg.id}.zip`);
                            packFolderToZip(extractDir, repackedZip);
                            const zipVal = validateFileMagic(repackedZip);
                            const originalSize = fs.statSync(localFilePath).size;
                            const repackedSize = zipVal ? fs.statSync(repackedZip).size : Infinity;
                            // If repacked zip is significantly larger than original, keep original archive
                            if (zipVal && repackedSize <= originalSize * 1.5) {
                              effectiveDownloadPath = repackedZip;
                              validated = zipVal;
                            } else if (zipVal) {
                              console.log(`   📦 Repacked zip (${(repackedSize / 1024 / 1024).toFixed(1)} MB) is much larger than original (${(originalSize / 1024 / 1024).toFixed(1)} MB) – keeping original archive.`);
                              try { fs.rmSync(repackedZip, { force: true }); } catch { }
                              // Keep original archive as effectiveDownloadPath (already set to localFilePath)
                            }
                            try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { }
                          }
                        }
                      } else {
                        cleanTitle = resolveEnglishTitleIfArabic(cleanTitle, [originalName, localFilePath], [localFilePath]);
                      }

                      const cleanFileName = getSafeTelegramFileName(cleanTitle, validated.ext);
                      const finalPath = path.join(OUT_DIR, cleanFileName);
                      safeMoveFile(effectiveDownloadPath, finalPath);
                      if (effectiveDownloadPath !== localFilePath) {
                        try { fs.rmSync(localFilePath, { force: true }); } catch { }
                      }

                      const caption = formatCleanCaption(cleanTitle, validated.isArchive, isOfficialPlatformRelease(cleanTitle), hasArchiveFonts);
                      console.log(`   📤 Publishing Subdl direct file: "${caption}" (filename: ${cleanFileName})`);
                      const sendResult = await publishDocument(client, finalPath, caption);

                      if (sendResult?.ok) {
                        console.log(`   ✅ Successfully posted! (Message ID: ${sendResult.result?.message_id})`);
                        newFound++;
                        markReleaseAsPosted(posted, msgKey, releaseKeys);
                        if (linkedMsgId) markReleaseAsPosted(posted, `tg_${chat.id}_${linkedMsgId}`, releaseKeys);
                      } else {
                        console.error(`   ❌ Failed to send document:`, sendResult);
                      }

                      fs.rmSync(finalPath, { force: true });
                      continue;
                    }
                    fs.rmSync(localFilePath, { force: true });
                  }
                } catch (e) {
                  console.warn(`   ⚠️ Subdl direct file error:`, e.message);
                }
              }
            }

            // --- CASE B: Text / Link release in KokoBoko/Rengoku ---
            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
            let rawTitle = formatCleanTitle(lines[0] || 'Anime Release');
            // Rengoku also republishes Fansub releases.  Only a platform label
            // (e.g. Crunchyroll/Amazon) is an official release; team-labelled
            // messages must be deduplicated within that team, not globally.
            const isOfficialSubdl = isOfficialPlatformRelease(rawTitle);
            const rawTitleResolved = await resolveCanonicalTitle(rawTitle);
            const releaseKeys = isOfficialSubdl
              ? getReleaseKeys(rawTitle, true, rawTitleResolved)
              : getFansubReleaseKeys(rawTitle, rawTitleResolved);

            if (isReleaseAlreadyPosted(posted, releaseKeys)) {
              markReleaseAsPosted(posted, msgKey, releaseKeys);
              continue;
            }

            // Check if there is an attached document message specifically covering this release
            const coveringDoc = hasCoveringDocumentMsg(msg, msgs);
            if (coveringDoc) {
              // The attached document covers this release and will be handled directly
              continue;
            }

            const subdlMatch = text.match(/https?:\/\/(?:www\.)?subdl\.com\/s\/info\/[a-zA-Z0-9]+/i);
            if (subdlMatch) {
              const subdlInfoUrl = subdlMatch[0];
              console.log(`\n✨ [Subdl Release via Link] "${rawTitle}"`);
              console.log(`   🌐 Resolving SUBDL link: ${subdlInfoUrl}`);
              const subdlData = await resolveSubdlDownloadData(subdlInfoUrl);

              if (subdlData) {
                const workDir = path.join(OUT_DIR, `work_subdl_${msg.id}`);
                const unpackDir = path.join(workDir, 'unpacked');
                fs.mkdirSync(unpackDir, { recursive: true });

                try {
                  const primaryDlUrl = subdlData.batchZipLink || subdlData.individualLinks[0] || subdlData.allLinks[0];
                  if (!primaryDlUrl) {
                    console.warn(`   ⚠️ No download link found on SUBDL page: ${subdlInfoUrl}`);
                    continue;
                  }

                  console.log(`   📥 Downloading subtitle(s) from SUBDL: ${primaryDlUrl}`);
                  const tempSubdl = path.join(workDir, `primary_subdl`);
                  await downloadFileToDisk(primaryDlUrl, tempSubdl, { Referer: subdlInfoUrl });

                  let subdlMagic = validateFileMagic(tempSubdl);

                  // If Subdl download was text note, check for fallback links inside
                  if (!subdlMagic) {
                    try {
                      const textContent = fs.readFileSync(tempSubdl, 'utf8');
                      const top4topMatch = textContent.match(/https?:\/\/[^\s"'<>]*top4top\.io\/[^\s"'<>]+/i);
                      const mfMatch = textContent.match(/https?:\/\/[^\s"'<>]*mediafire\.com\/[^\s"'<>]+/i);
                      if (top4topMatch) {
                        const direct = await resolveTop4topDownloadUrl(top4topMatch[0]);
                        if (direct) {
                          const fbDest = path.join(workDir, `fallback_top4top`);
                          await downloadFileToDisk(direct, fbDest);
                          subdlMagic = validateFileMagic(fbDest);
                          if (subdlMagic) safeMoveFile(fbDest, tempSubdl);
                        }
                      } else if (mfMatch) {
                        const mfBest = await findBestFileInMediafire(mfMatch[0]);
                        if (mfBest?.directUrl) {
                          const fbDest = path.join(workDir, `fallback_mf`);
                          await downloadFileToDisk(mfBest.directUrl, fbDest);
                          subdlMagic = validateFileMagic(fbDest);
                          if (subdlMagic) safeMoveFile(fbDest, tempSubdl);
                        }
                      }
                    } catch (e) {
                      console.warn(`   ⚠️ Fallback link parsing error:`, e.message);
                    }
                  }

                  if (subdlMagic?.isArchive) {
                    extractArchive(tempSubdl, unpackDir);
                  } else if (subdlMagic) {
                    const properName = getSafeTelegramFileName(rawTitle, subdlMagic.ext);
                    safeMoveFile(tempSubdl, path.join(unpackDir, properName));
                  }

                  // If multi-episode batch and no batch zip link existed, download remaining individual links if any
                  const isMultiEpTitle = /(?:\[\s*\d{1,4}|\b\d{1,4})\s*(?:~|-|–|to)\s*\d{1,4}(?:\s*END)?(?:\s*\]|\b)/i.test(rawTitle) || /كامل|batch|pack/i.test(rawTitle);
                  if (isMultiEpTitle && !subdlData.batchZipLink && subdlData.individualLinks.length > 1) {
                    for (let i = 1; i < subdlData.individualLinks.length; i++) {
                      const epUrl = subdlData.individualLinks[i];
                      const epPath = path.join(workDir, `ep_${i}`);
                      try {
                        await downloadFileToDisk(epUrl, epPath, { Referer: subdlInfoUrl });
                        const epMagic = validateFileMagic(epPath);
                        if (epMagic?.isArchive) extractArchive(epPath, unpackDir);
                        else if (epMagic) safeMoveFile(epPath, path.join(unpackDir, `sub_${msg.id}_${i}${epMagic.ext}`));
                      } catch {}
                    }
                  }

                  // Check if message text specifies external fonts (Top4Top, Mediafire, Mega)
                  const fontMatch = text.match(/(?:fonts|subs\s*&\s*fonts)[^:]*:\s*(https?:\/\/[^\s"'<>]+)/i) ||
                                    text.match(/https?:\/\/(?:www\.)?(?:top4top\.io|mediafire\.com|mega\.nz)\/[^\s"'<>]+/i);
                  if (fontMatch) {
                    const fontUrl = fontMatch[1] || fontMatch[0];
                    console.log(`   🌐 Found fonts link in message: ${fontUrl}`);
                    let directFontUrl = null;
                    if (/top4top\.io/i.test(fontUrl)) {
                      directFontUrl = await resolveTop4topDownloadUrl(fontUrl);
                    } else if (/mediafire\.com/i.test(fontUrl)) {
                      const mfBest = await findBestFileInMediafire(fontUrl);
                      directFontUrl = mfBest?.directUrl;
                    }
                    if (directFontUrl) {
                      const fontTempPath = path.join(workDir, `fonts_temp`);
                      try {
                        await downloadFileToDisk(directFontUrl, fontTempPath);
                        const fontMagic = validateFileMagic(fontTempPath);
                        if (fontMagic?.isArchive) {
                          extractArchive(fontTempPath, unpackDir);
                        } else if (fontMagic) {
                          safeMoveFile(fontTempPath, path.join(unpackDir, `font_${Date.now()}${fontMagic.ext}`));
                        }
                      } catch (fontErr) {
                        console.warn(`   ⚠️ Could not download external fonts:`, fontErr.message);
                      }
                    }
                  }

                  // Scan all extracted files in unpackDir
                  const allExtractedFiles = [];
                  function scanDir(dir) {
                    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                      const full = path.join(dir, f.name);
                      if (f.isDirectory()) scanDir(full);
                      else allExtractedFiles.push(full);
                    }
                  }
                  scanDir(unpackDir);

                  const subFiles = allExtractedFiles.filter(f => /\.(ass|srt)$/i.test(f));
                  const fontFiles = allExtractedFiles.filter(f => /\.(ttf|otf|woff2?)$/i.test(f));
                  const hasFonts = fontFiles.length > 0;

                  // MANDATORY CHECK: Drop if 0 subtitles found (never publish font-only releases)
                  if (subFiles.length === 0) {
                    console.warn(`   ⚠️ Release "${rawTitle}" contains NO subtitles (.ass/.srt), only fonts/assets. Dropping.`);
                    continue;
                  }

                  // Resolve English title from extracted subtitle filenames and ASS headers if rawTitle is Arabic
                  rawTitle = resolveEnglishTitleIfArabic(rawTitle, subFiles, subFiles);

                  // If single subtitle file in unpackDir, rename it to rawTitle if it has a generic or arabic name
                  if (subFiles.length === 1) {
                    const curBase = path.basename(subFiles[0], path.extname(subFiles[0])).toLowerCase();
                    const isGenericOrArabic = /^(?:extracted(?:_sub|\s+subtitle)?|sub(?:_\d+)?|untitled|default)$/i.test(curBase) || /[\u0600-\u06FF]/.test(curBase);
                    if (isGenericOrArabic) {
                      const sExt = path.extname(subFiles[0]).toLowerCase();
                      const properSubName = getSafeTelegramFileName(rawTitle, sExt);
                      const renamedPath = path.join(path.dirname(subFiles[0]), properSubName);
                      if (subFiles[0] !== renamedPath) {
                        safeMoveFile(subFiles[0], renamedPath);
                        subFiles[0] = renamedPath;
                      }
                    }
                  }

                  const isBatch = subFiles.length > 1 || isMultiEpTitle;

                  let finalFilePath = '';
                  let isArchiveRelease = false;

                  if (!isBatch && subFiles.length === 1 && !hasFonts) {
                    // Single subtitle without fonts: publish as naked .ass
                    const ext = path.extname(subFiles[0]).toLowerCase();
                    const cleanFileName = getSafeTelegramFileName(rawTitle, ext);
                    finalFilePath = path.join(OUT_DIR, cleanFileName);
                    safeMoveFile(subFiles[0], finalFilePath);
                    isArchiveRelease = false;
                  } else {
                    // Multi-episode batch or subtitle with fonts: pack everything to universal .zip
                    const repackedZip = path.join(OUT_DIR, `batch_${msg.id}.zip`);
                    packFolderToZip(unpackDir, repackedZip);
                    const cleanFileName = getSafeTelegramFileName(rawTitle, '.zip');
                    finalFilePath = path.join(OUT_DIR, cleanFileName);
                    safeMoveFile(repackedZip, finalFilePath);
                    isArchiveRelease = true;
                  }

                  const caption = formatCleanCaption(rawTitle, isArchiveRelease, isOfficialSubdl, hasFonts);
                  console.log(`   📤 Publishing to channel: "${caption}" (filename: ${path.basename(finalFilePath)})`);
                  const sendResult = await publishDocument(client, finalFilePath, caption);

                  if (sendResult?.ok) {
                    console.log(`   ✅ Successfully posted! (Message ID: ${sendResult.result?.message_id})`);
                    newFound++;
                    markReleaseAsPosted(posted, msgKey, releaseKeys);
                  } else {
                    console.error(`   ❌ Failed to send document:`, sendResult);
                  }

                  try { fs.rmSync(finalFilePath, { force: true }); } catch {}
                  continue;
                } catch (e) {
                  console.error(`   ❌ Error downloading/posting SUBDL release:`, e.message);
                } finally {
                  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
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
                const titleLineResolved = await resolveCanonicalTitle(titleLine);
                const releaseKeys = getFansubReleaseKeys(titleLine, titleLineResolved);

                if (isReleaseAlreadyPosted(posted, releaseKeys)) {
                  markReleaseAsPosted(posted, msgKey, releaseKeys);
                  continue;
                }

                console.log(`\n✨ [LazySano Direct File] "${titleLine}" (${originalName})`);
                const localFilePath = path.join(OUT_DIR, safeRemoteBaseName(originalName, `sub_${msg.id}`));
                if (!isInsideDir(localFilePath, OUT_DIR)) {
                  console.warn(`   ⚠️ Skipping LazySano direct file: unsafe document file name "${originalName}".`);
                  continue;
                }

                try {
                  await client.downloadMedia(msg, { outputFile: localFilePath, workers: 4 });
                  if (fs.existsSync(localFilePath) && fs.statSync(localFilePath).size > 0) {
                    const validated = validateFileMagic(localFilePath);
                    if (validated) {
                      const cleanFileName = getSafeTelegramFileName(titleLine, validated.ext);
                      const finalPath = path.join(OUT_DIR, cleanFileName);
                      safeMoveFile(localFilePath, finalPath);

                      const caption = formatCleanCaption(titleLine, validated.isArchive, false);
                      console.log(`   📤 Publishing LazySano release: "${caption}"`);
                      const sendResult = await publishDocument(client, finalPath, caption);

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
              const titleLineResolved = await resolveCanonicalTitle(titleLine);
              const releaseKeys = getFansubReleaseKeys(titleLine, titleLineResolved);
              if (isReleaseAlreadyPosted(posted, releaseKeys)) {
                markReleaseAsPosted(posted, msgKey, releaseKeys);
                continue;
              }

              const urlMatches = text.match(/https?:\/\/[^\s"'<>]+/gi) || [];
              const postPageUrl = urlMatches.find(u => !u.includes('t.me') && !u.includes('twitter'));
              if (postPageUrl) {
                const pageData = await scrapePostPage(postPageUrl, null, extractEpisodeNumber(titleLine) || null, titleLine);
                if (!pageData) console.warn(`   ⚠️ No page data extracted from ${postPageUrl}`);
                else if (!pageData.bestDownloadUrl && !pageData.videoLinks?.directSub) console.warn(`   ⚠️ No download links found in ${postPageUrl}`);
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
                        const tempDest = path.join(OUT_DIR, `lazy_${Date.now()}_${safeRemoteBaseName(megaBest.name)}`);
                        if (!isInsideDir(tempDest, OUT_DIR)) throw new Error(`unsafe mega file name: ${megaBest.name}`);
                        await downloadMegaNode(megaBest.node, tempDest, OUT_DIR);
                        const validated = validateFileMagic(tempDest);
                        if (validated) {
                          const cleanFileName = getSafeTelegramFileName(titleLine, validated.ext);
                          const finalPath = path.join(OUT_DIR, cleanFileName);
                          safeMoveFile(tempDest, finalPath);

                          const caption = formatCleanCaption(titleLine, validated.isArchive, false);
                          console.log(`   📤 Publishing LazySano post link: "${caption}"`);
                          const sendResult = await publishDocument(client, finalPath, caption);
                          if (sendResult?.ok) {
                            newFound++;
                            markReleaseAsPosted(posted, msgKey, releaseKeys);
                          }
                          fs.rmSync(finalPath, { force: true });
                          continue;
                        }
                        fs.rmSync(tempDest, { force: true });
                      } catch { }
                    }
                  }
                  if (directUrl) {
                    try {
                      const tempDest = path.join(OUT_DIR, `lazy_${Date.now()}`);
                      const dlOptions = pageData?.source === 'mugi-worker' ? { expectedHost: new URL(directUrl).hostname } : {};
                      await downloadFileToDisk(directUrl, tempDest, {}, dlOptions);
                      const validated = validateFileMagic(tempDest);
                      if (validated) {
                        const cleanFileName = getSafeTelegramFileName(titleLine, validated.ext);
                        const finalPath = path.join(OUT_DIR, cleanFileName);
                        safeMoveFile(tempDest, finalPath);

                        const caption = formatCleanCaption(titleLine, validated.isArchive, false);
                        console.log(`   📤 Publishing LazySano post link: "${caption}"`);
                        const sendResult = await publishDocument(client, finalPath, caption);
                        if (sendResult?.ok) {
                          newFound++;
                          markReleaseAsPosted(posted, msgKey, releaseKeys);
                        }
                        fs.rmSync(finalPath, { force: true });
                        continue;
                      }
                      fs.rmSync(tempDest, { force: true });
                    } catch { }
                  }
                }
              }
            }

            continue;
          }

          // ==============================================================
          // SOURCE 4: Arabic Anime Publisher (Fansub Releases)
          // ==============================================================
          const hasAttachment = Boolean(msg.media && msg.media.document);
          const hasLinks = /https?:\/\/[^\s"'<>]+/i.test(text);
          if (!hasAttachment && !hasLinks) {
            markReleaseAsPosted(posted, msgKey);
            continue;
          }

          let titleLine = extractTeamAndFormatTitle(text);
          const titleLineResolved = await resolveCanonicalTitle(titleLine);
          let releaseKeys = getFansubReleaseKeys(titleLine, titleLineResolved);

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
              const localFilePath = path.join(OUT_DIR, safeRemoteBaseName(originalName, `sub_${msg.id}.ass`));
              if (!isInsideDir(localFilePath, OUT_DIR)) {
                console.warn(`   ⚠️ Skipping fansub attachment: unsafe document file name "${originalName}".`);
                continue;
              }

              try {
                await client.downloadMedia(msg, { outputFile: localFilePath, workers: 4 });
                if (fs.existsSync(localFilePath) && fs.statSync(localFilePath).size > 0) {
                  const validated = validateFileMagic(localFilePath);
                  if (validated) {
                    titleLine = resolveEnglishTitleIfArabic(titleLine, [originalName, localFilePath], [localFilePath]);
                    if (validated.isArchive) {
                      const archiveFiles = listArchiveFiles(localFilePath);
                      titleLine = resolveEnglishTitleIfArabic(titleLine, [originalName, ...archiveFiles]);
                    }
                    const cleanFileName = getSafeTelegramFileName(titleLine, validated.ext);
                    const finalPath = path.join(OUT_DIR, cleanFileName);
                    safeMoveFile(localFilePath, finalPath);

                    const caption = formatCleanCaption(titleLine, validated.isArchive, false);
                    console.log(`   📤 Publishing to channel: "${caption}"`);
                    const sendResult = await publishDocument(client, finalPath, caption);

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
            const targetEp = extractEpisodeNumber(titleLine);
            const pageData = await scrapePostPage(postPageUrl, matchingSite, targetEp, titleLine);

            if (!pageData) console.warn(`   ⚠️ No page data extracted from ${postPageUrl}`);
            else if (!pageData.bestDownloadUrl && !pageData.videoLinks?.directSub) console.warn(`   ⚠️ No download links found in ${postPageUrl}`);

            if (pageData) {
              const fansubWorkDir = path.join(OUT_DIR, `fansub_${msg.id}`);
              fs.mkdirSync(fansubWorkDir, { recursive: true });

              try {
                let downloadedFilePath = null;

                // 1. Direct or Top4Top download
                let directUrl = pageData.videoLinks?.directSub || (/\.(ass|srt|zip|rar|7z)$/i.test(pageData.bestDownloadUrl) ? pageData.bestDownloadUrl : null);
                if (pageData.videoLinks?.top4top) {
                  const resolved = await resolveTop4topDownloadUrl(pageData.videoLinks.top4top);
                  if (resolved) directUrl = resolved;
                }
                if (directUrl && /(?:workers\.dev|ddl\.[^/]+|\/0:)/i.test(directUrl) && !/\.(ass|srt|zip|rar|7z)$/i.test(directUrl)) {
                  const resolved = await resolveSubtitleFromDirectory(directUrl, targetEp);
                  if (resolved) directUrl = resolved;
                }

                // Skip folder URLs from direct single-file HTTP download
                if (directUrl && !isDriveFolderUrl(directUrl) && !directUrl.includes('mega.nz')) {
                  try {
                    console.log(`   📥 Direct download: ${directUrl}`);
                    const tempDest = path.join(fansubWorkDir, `direct_${Date.now()}`);
                    const dlOptions = pageData?.source === 'mugi-worker' ? { expectedHost: new URL(directUrl).hostname } : {};
                    if (isRocksDdlHost(directUrl)) {
                      // Rocks-Team DDL needs the browser's Cloudflare cookie.
                      const ok = await downloadViaBrowser(directUrl, tempDest);
                      if (!ok) throw new Error('Browser download failed');
                    } else {
                      await downloadFileToDisk(directUrl, tempDest, { Referer: postPageUrl }, dlOptions);
                    }
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
                        const tempDest = path.join(fansubWorkDir, `mf_${Date.now()}_${safeRemoteBaseName(mfBest.name)}`);
                        if (!isInsideDir(tempDest, fansubWorkDir)) throw new Error(`unsafe mediafire file name: ${mfBest.name}`);
                        await downloadFileToDisk(mfBest.directUrl, tempDest, { Referer: postPageUrl });
                        if (fs.existsSync(tempDest)) downloadedFilePath = tempDest;
                      }
                    }
                  } catch (e) {
                    console.warn(`   ⚠️ Mediafire download failed:`, e.message);
                  }
                }

                // 3. Mega (Direct file or Folder via pure JS megajs)
                const megaCandidate = (pageData.videoLinks?.directSub && pageData.videoLinks.directSub.includes('mega.nz'))
                  ? pageData.videoLinks.directSub
                  : pageData.videoLinks?.mega;

                if (!downloadedFilePath && megaCandidate) {
                  console.log(`   📥 Resolving Mega: ${megaCandidate}`);
                  try {
                    const megaRelease = await downloadMegaFolderRelease(megaCandidate, fansubWorkDir, targetEp);
                    if (megaRelease && megaRelease.filePath && fs.existsSync(megaRelease.filePath)) {
                      downloadedFilePath = megaRelease.filePath;
                    }
                  } catch (e) {
                    console.warn(`   ⚠️ Mega JS download failed:`, e.message);
                  }
                }

                // 4. Google Drive (Direct file or Folder release with fonts)
                const driveCandidate = (pageData.videoLinks?.directSub && isDriveFolderUrl(pageData.videoLinks.directSub))
                  ? pageData.videoLinks.directSub
                  : pageData.videoLinks?.drive;

                if (!downloadedFilePath && driveCandidate) {
                  console.log(`   📥 Resolving Google Drive: ${driveCandidate}`);
                  try {
                    if (isDriveFolderUrl(driveCandidate)) {
                      const driveRelease = await downloadDriveFolderRelease(
                        driveCandidate,
                        fansubWorkDir,
                        targetEp,
                        pageData.videoLinks?.fonts,
                        titleLine
                      );
                      if (driveRelease && driveRelease.filePath && fs.existsSync(driveRelease.filePath)) {
                        downloadedFilePath = driveRelease.filePath;
                      }
                    }

                    if (!downloadedFilePath) {
                      const driveBest = await findBestFileInDrive(driveCandidate, targetEp);
                      if (driveBest && driveBest.directUrl) {
                        if (driveBest.type === 'subtitle' || toolsAvailable) {
                          console.log(`   📥 Downloading from Drive (${driveBest.type}): ${driveBest.name}`);
                          const tempDest = path.join(fansubWorkDir, safeRemoteBaseName(driveBest.name, `drive_${Date.now()}`));
                          if (!isInsideDir(tempDest, fansubWorkDir)) throw new Error(`unsafe drive file name: ${driveBest.name}`);
                          await downloadFileToDisk(driveBest.directUrl, tempDest, { Referer: postPageUrl });
                          if (fs.existsSync(tempDest)) downloadedFilePath = tempDest;
                        }
                      }
                    }
                  } catch (e) {
                    console.warn(`   ⚠️ Google Drive download failed:`, e.message);
                  }
                }

                // 5. Buzzheavier (Direct video file via HX-Redirect or token on GitHub Actions)
                if (!downloadedFilePath && pageData.videoLinks?.buzzheavier && toolsAvailable) {
                  console.log(`   📥 Resolving Buzzheavier: ${pageData.videoLinks.buzzheavier}`);
                  try {
                    const directBuzz = await resolveBuzzheavierDownloadUrl(pageData.videoLinks.buzzheavier);
                    if (directBuzz) {
                      console.log(`   📥 Downloading from Buzzheavier: ${directBuzz}`);
                      const tempDest = path.join(fansubWorkDir, `buzz_${Date.now()}.mkv`);
                      const cmd = process.platform === 'win32' ? 'curl.exe' : 'curl';
                      try {
                        execFileSync(cmd, [
                          '-s', '-L',
                          '--max-time', '600',
                          '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
                          '-H', `Referer: ${pageData.videoLinks.buzzheavier}`,
                          '-o', tempDest,
                          directBuzz
                        ], { timeout: 650_000 });
                        if (fs.existsSync(tempDest) && fs.statSync(tempDest).size > 1024) {
                          downloadedFilePath = tempDest;
                        }
                      } catch (cErr) {
                        await downloadFileToDisk(directBuzz, tempDest, { Referer: pageData.videoLinks.buzzheavier });
                        if (fs.existsSync(tempDest) && fs.statSync(tempDest).size > 1024) {
                          downloadedFilePath = tempDest;
                        }
                      }
                    }
                  } catch (e) {
                    console.warn(`   ⚠️ Buzzheavier download failed:`, e.message);
                  }
                }

                // 6. Torrent (Prioritized for speed & reliability in GitHub Actions)
                if (!downloadedFilePath && pageData.videoLinks?.torrent && toolsAvailable) {
                  console.log(`   📥 Fansub torrent found: ${pageData.videoLinks.torrent}`);
                  const extractedTorrent = await downloadAndExtractSubtitleFromTorrent(pageData.videoLinks.torrent, fansubWorkDir, false, false, titleLine);
                  if (extractedTorrent && extractedTorrent.filePath) {
                    if (extractedTorrent.resolvedTitle) {
                      titleLine = extractedTorrent.resolvedTitle;
                    }
                    const cleanFileName = getSafeTelegramFileName(titleLine, extractedTorrent.ext);
                    const finalPath = path.join(OUT_DIR, cleanFileName);
                    safeMoveFile(extractedTorrent.filePath, finalPath);

                    const caption = formatCleanCaption(titleLine, extractedTorrent.isArchive, false);
                    console.log(`   📤 Publishing to channel: "${caption}"`);
                    const sendResult = await publishDocument(client, finalPath, caption);

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
                  if (validateFileMagic(downloadedFilePath)?.isArchive) {
                    const innerFiles = listArchiveFiles(downloadedFilePath);
                    titleLine = resolveEnglishTitleIfArabic(titleLine, [...innerFiles, downloadedFilePath]);
                  } else {
                    titleLine = resolveEnglishTitleIfArabic(titleLine, [downloadedFilePath], [downloadedFilePath]);
                  }

                  const extracted = extractSubtitleAndFontsFromAnyFile(downloadedFilePath, fansubWorkDir, false, false, titleLine);
                  if (extracted && extracted.filePath) {
                    if (extracted.resolvedTitle) {
                      titleLine = extracted.resolvedTitle;
                    }
                    const cleanFileName = getSafeTelegramFileName(titleLine, extracted.ext);
                    const finalPath = path.join(OUT_DIR, cleanFileName);
                    safeMoveFile(extracted.filePath, finalPath);

                    const caption = formatCleanCaption(titleLine, extracted.isArchive, false);
                    console.log(`   📤 Publishing to channel: "${caption}"`);
                    const sendResult = await publishDocument(client, finalPath, caption);

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
                try { fs.rmSync(fansubWorkDir, { recursive: true, force: true }); } catch { }
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
    if (ownClient) {
      try { await client.disconnect(); } catch { }
    }
  }

  savePostedIds(posted);
  console.log(`\n🏁 Telegram check finished. Processed ${newFound} new release(s).\n`);
}
