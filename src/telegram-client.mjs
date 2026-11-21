import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execSync, execFileSync, spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';
import SevenZip from '7zip-bin';
import { CONFIG } from './config.mjs';
import { scrapePostPage as baseScrapePostPage, resolveSubtitleFromDirectory as baseResolveSubtitleFromDirectory, resolveBuzzheavierDownloadUrl } from './site-scrapers.mjs';
import { sendDocument, escapeHtml } from './telegram.mjs';
import {
  findBestFileInMegaFolder,
  downloadMegaNode,
  downloadMegaFolderRelease,
  downloadDriveFolderRelease,
  isDriveFolderUrl,
  findBestFileInMediafire,
  findBestFileInDrive,
  resolveMediafireDirectDownload,
  extractExplicitEpisodeRange,
  orderCloudSources,
  listingOffersSubtitles,
  listCloudFolderFiles,
  cloudKindOfUrl,
  isProviderHostUrl,
  SUBTITLE_FILE_RE,
  logSafe,
  redactUrl,
  uniqueFileName,
  nextTempTag,
  unpackDirBytes,
  mapWithConcurrency,
  assertCloudBatchCaps,
  cloudCapError,
  isCloudCapError,
  isCloudCapCooldownActive,
  markCloudCapCooldown,
  CLOUD_CAP_LIMITS
} from './cloud-folders.mjs';
import { safeRemoteBaseName, isInsideDir } from './path-safety.mjs';
import { downloadViaBrowser, isRocksDdlHost } from './browser-fetch.mjs';
import {
  parseRecoverySpec, withRecoveryMessages, recordPendingAttempt, unknownRecoveryChatIds,
  isRecoveryMessage, recoveryFatalCodeFor, recoveryScrapeOptions, withRecoveryMode,
  scrapeOptionsForState, RECOVERY_CODES, RECOVERY_REDIRECT_MODE, siteHosts
} from './recovery.mjs';
import {
  resolveCanonicalTitle,
  resolveCanonicalTitlesBatch,
  getCachedCanonical,
  resetCycleBudget,
  normalizeTeamName,
  buildSyntheticTitle
} from './title-identity.mjs';

// F1/F4: the recovery path must forbid redirects. The call sites stay exactly
// as they were (audited by T38); a thin wrapper injects the single no-redirect
// mode constant only while a MARKED recovery message is being scraped (id and
// pending retries included). The main loop is sequential, so no leak.
// G4: the toggle and the option injection are the pure helpers in recovery.mjs
// (withRecoveryMode / scrapeOptionsForState) so they are directly unit-testable.
const recoveryState = { active: false, msg: null };
function scrapePostPage(pageUrl, siteConfig, targetEp, releaseTitle, options = {}) {
  const effective = scrapeOptionsForState(options, recoveryState);
  return baseScrapePostPage(pageUrl, siteConfig, targetEp, releaseTitle, effective);
}
// G2: the second directory call site keeps its exact batch-options shape (the
// T38 source contract). The no-redirect mode is injected here from the same
// guard state as the page scrape, via recoveryScrapeOptions — so a marked
// recovery message never renders a Rocks DDL directory in Chromium nor lets a
// GoIndex POST follow a redirect. Normal callers get no extra options.
function resolveSubtitleFromDirectory(directoryUrl, targetEp, options = {}) {
  const effective = { ...options, ...recoveryScrapeOptions(recoveryState.msg) };
  return baseResolveSubtitleFromDirectory(directoryUrl, targetEp, effective);
}

const POSTED_FILE = path.resolve('data', 'posted.json');
const OUT_DIR = path.resolve('temp_extracted');
const HTTP_TIMEOUT_MS = 60_000;

// ====================================================================
// P0-3 typed fatal errors (F-03)
// A fatal aborts the monitoring window. It must survive the runner's own
// catch (runLoop demotes everything else to a cycle error) and turn into a
// non-zero exit AFTER the teardown. `process.exit` is never called from
// library code — the test suite must not kill the runner process.
// The codes are fixed: no interpolated remote data ever reaches the log.
// ====================================================================
export const FATAL_CODES = {
  CHANNELS_ZERO: 'CHANNELS_ZERO',
  STATE_LOAD_FAILED: 'STATE_LOAD_FAILED',
  AUTH_SESSION_CONFIG: 'AUTH_SESSION_CONFIG',
  LISTENER_ERROR: 'LISTENER_ERROR',
  RECOVERY_SPEC_INVALID: RECOVERY_CODES.SPEC_INVALID,
  RECOVERY_CHAT_UNKNOWN: RECOVERY_CODES.CHAT_UNKNOWN,
  RECOVERY_MSG_MISSING: RECOVERY_CODES.MSG_MISSING,
  RECOVERY_REDIRECT: RECOVERY_CODES.REDIRECT,
  RECOVERY_FETCH_UNSAFE: RECOVERY_CODES.FETCH_UNSAFE,
};

export function createFatalError(code, message, summary = null) {
  const err = new Error(message);
  err.isFatal = true;
  err.fatalCode = FATAL_CODES[code] || code;
  if (summary) {
    summary.immediateFatal = { code: err.fatalCode, message };
    err.summary = summary;
  }
  // The fatal code is logged ONCE, at the runner boundary (M-05): the
  // creator must not print it.
  return err;
}

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

// Size guard (P0-4a): `posted` is only ever ADDED to, never removed from —
// the ADD-ONLY INVARIANT (P-9): the posted set may only ever grow, because a
// release that is on the list is by definition already published. An unchanged
// size therefore implies unchanged content — the ~2 MB file does not have to be
// rewritten on every markReleaseAsPosted() call.
// P-1 trade-off (durability over write amplification): every mark that adds ≥1
// key still rewrites the whole ~2 MB file; coalescing to the end of the cycle
// would break the on-disk durability contract. Pruning + minification is the
// P2 mitigation.
let lastSavedPostedSize = -1;

/**
 * The size guard's counter (M-04). Exposed so a test can observe it.
 * (-1 = nothing was written yet.)
 */
export function getPostedSizeGuard() {
  return lastSavedPostedSize;
}

/**
 * Reset the size guard (M-04): the next mark writes again, even when the
 * set did not change.
 */
export function resetPostedSizeGuard() {
  lastSavedPostedSize = -1;
}

/**
 * Persist the posted set.
 * → true when the state is on disk (or was already there and unchanged),
 *   false when the write FAILED (M-03: the caller has to see it).
 */
export function savePostedIds(set) {
  try {
    const size = set instanceof Set ? set.size : (Array.isArray(set) ? set.length : -1);
    if (size >= 0 && size === lastSavedPostedSize && fs.existsSync(POSTED_FILE)) {
      return true; // unchanged since the last successful write
    }
    fs.mkdirSync(path.dirname(POSTED_FILE), { recursive: true });
    const tmp = POSTED_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...set], null, 2));
    fs.renameSync(tmp, POSTED_FILE);
    lastSavedPostedSize = size;
    return true;
  } catch (e) {
    console.error('Failed to save posted IDs:', e.message);
    return false; // the state was NOT persisted
  }
}

/**
 * The end-of-cycle state write (M-03).
 *
 * A failed write is a REAL failure — not a deferral: the published keys are
 * not on disk and the next cycle would publish them again. It is counted as
 * a failure (so the owner's policy classifies it: red when nothing was
 * published, warning when there were successes) and it gets its own log
 * line.
 *
 * → true when the state was persisted.
 */
export function finalizePostedState(posted, summary) {
  const saved = savePostedIds(posted);
  if (!saved) {
    if (summary && typeof summary === 'object') {
      summary.failed = (Number(summary.failed) || 0) + 1;
    }
    console.error(`🔴 state write failed — this cycle's published keys may be re-published`);
  }
  return saved;
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

// F2b — the Arabic ordinal word is an episode ONLY when the title is about an
// episode. "الدفعة الأولى من ..." means "the first BATCH of ...", not "episode
// 1": the collection word cancels the ordinal. "الحلقة الأولى ..." ("the first
// EPISODE") is not a collection and keeps working. The numeric forms ("- 04",
// "[04]", "S01E04") are never affected by this guard.
const ARABIC_COLLECTION_WORDS = /(?:الدفعة|الدفعات|الجزء|الأجزاء|المجموعة|المجموعات|الباقة|الباقات|الحزمة|الرزمة)/;

// M5 — the collection word and its ordinal are ADJACENT only when nothing
// separates them: the ordinal is blanked ONLY when the collection word ends
// at most 25 characters earlier AND the gap holds no separator
// (":", "،", ",", ".", ";", "؛", "!", "?", a newline).
//
//   "الدفعة الأولى: الحلقة الأولى"  -> the first ordinal is blanked, the
//                                      SECOND one ("الحلقة الأولى") survives
//   "الجزء الثاني: الحلقة الثالثة"  -> the second ordinal survives
//   "الدفعة الأولى - 004"            -> the ordinal is blanked, the number
//                                      "004" stays the episode
//   "الدفعة الأولى من سلسلة ..."     -> the ordinal is blanked
//
// The blanket suppression (ANY collection word kills EVERY ordinal) was
// wrong: it dropped the episode of "الدفعة الأولى: الحلقة الأولى".
const COLLECTION_GAP_MAX_CHARS = 25;
const COLLECTION_ORDINAL_SEPARATOR = /[:،,.;؛!?\n]/;
// X10: a genuine episode word between the collection word and the ordinal
// breaks the adjacency too ("الجزء الثاني الحلقة الثالثة" — the second
// ordinal belongs to the episode, not to the collection).
const EPISODE_WORD_BREAK = /الحلق(?:ة|ات)/;

export function stripCollectionAdjacentOrdinals(text) {
  const raw = String(text ?? '');
  if (!raw) return '';

  let out = raw;
  for (const item of ARABIC_EPISODE_WORDS) {
    const re = new RegExp(item.p.source, 'gi');
    let m;
    while ((m = re.exec(out)) !== null) {
      const ordinalStart = m.index;
      const before = out.slice(0, ordinalStart);

      // The nearest collection word that ENDS before the ordinal.
      const cre = new RegExp(ARABIC_COLLECTION_WORDS.source, 'gi');
      let cm;
      let collectionEnd = -1;
      while ((cm = cre.exec(before)) !== null) {
        collectionEnd = cm.index + cm[0].length;
      }
      if (collectionEnd < 0) continue;

      const gap = before.slice(collectionEnd);
      if (gap.length > COLLECTION_GAP_MAX_CHARS) continue;   // too far away
      if (COLLECTION_ORDINAL_SEPARATOR.test(gap)) continue;  // a separator breaks the adjacency
      if (EPISODE_WORD_BREAK.test(gap)) continue;            // X10: an episode word breaks it too

      // Blank the ordinal (the length is kept, so the other offsets stay valid).
      out = out.slice(0, ordinalStart) + ' '.repeat(m[0].length) + out.slice(ordinalStart + m[0].length);
      re.lastIndex = ordinalStart + m[0].length;
    }
  }
  return out;
}

// m7 — is this title a COLLECTION (a batch) instead of a single episode?
// An Arabic collection word ("الدفعة الأولى") or an explicit episode range
// ("[01~05]") means the post asks for a BATCH: the DDL directory then holds
// one archive per episode and the whole-batch archive must be preferred.
export function isCollectionTitle(title) {
  const text = String(title || '');
  if (ARABIC_COLLECTION_WORDS.test(text)) return true;
  return extractExplicitEpisodeRange(text).length > 1;
}

// A cap refusal is a per-SOURCE event: the message keeps looping over the
// remaining cloud sources. SERIES_FOLDER_BATCH is the one refusal that does
// NOT get a 6 h cooldown — a single-episode title was narrowed out of a
// series-wide folder, so a different source may still carry that episode.
// The log carries only the cap counts (via logSafe): never source.url, never
// a Mega fragment/key or a raw title.
export function handleCloudCapRefusal(e, { kind, url, label }) {
  if (!isCloudCapError(e)) {
    console.warn(`   ⚠️ ${label} download failed:`, logSafe(e && e.message));
    return;
  }
  if (e.code === 'SERIES_FOLDER_BATCH') {
    console.warn(`   ⚠️ ${label} single-episode refused (SERIES_FOLDER_BATCH): ${logSafe(e.message)} — not a batch title`);
    return;
  }
  markCloudCapCooldown(kind, url);
  console.warn(`   ⚠️ ${label} REFUSED (${e.code}): ${logSafe(e.message)} — cooldown ${Math.round(CLOUD_CAP_LIMITS.CAP_COOLDOWN_MS / 60000)} min`);
}

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

  // F2b/M5: an Arabic ordinal is an episode only when it is NOT glued to a
  // collection word — "الدفعة الأولى من ..." ("the first BATCH of ...") is a
  // collection, so its ordinal must not become an episode number, while
  // "الدفعة الأولى: الحلقة الأولى" keeps the episode of the SECOND ordinal.
  const ordinalText = stripCollectionAdjacentOrdinals(cleaned);
  for (const item of ARABIC_EPISODE_WORDS) {
    if (item.p.test(ordinalText)) return item.ep;
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
// episode token. Token locating mirrors buildSyntheticTitle's EXPLICIT token
// rules (F7):
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
// P1-2: buildSyntheticTitle additionally splits off a BARE episode token
// (" 04"). That fallback is deliberately NOT mirrored here: this function
// REWRITES the token into the pad2 dash form, so locating a bare token would
// rewrite the announcement's shape (the bare form is kept as-is by the
// synthetic title).
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
    // "Show S01E03" and "Show - 03" are the same episode, and sources use both
    // spellings freely (a KokoBoko mirror of a Crunchyroll post is exactly this
    // case). Collapse only SEASON ONE, so S02E03 never collides with episode 3.
    .replace(/\bs01e(\d{1,4})\b/gi, '$1')
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

// ---------------------------------------------------------------------------
// P1-2 (Layer 2 — the GUARD): a series-level key must not suppress an
// episode-scoped candidate.
//
// A release key is either scoped to ONE EPISODE (it carries an episode
// marker) or it is SERIES-LEVEL (the anime name only). The stored state
// contains BOTH kinds, because the synthetic (canonical re-run) family used
// to emit a series-level key for every release: the name-matching consumed
// the bare episode token ("<anime> 04" -> "<anime>"), so the synthetic key
// family lost the episode. P1-2 Layer 1 fixed that root cause, but the
// keys that are ALREADY in the state stay there (no state migration), and
// any other path that emits a series-level key for an episode-scoped
// candidate would reopen the hole. So the dedup DECISION itself is guarded:
// for an episode-scoped candidate a series-level match is NOT decisive —
// the episode-scoped keys decide. A candidate with no episode at all keeps
// the previous behaviour ("any key matches").
// ---------------------------------------------------------------------------

/**
 * Does this release key carry an EPISODE marker (is it scoped to a single
 * episode)? The families are explicit:
 *   - `_ep_<n>`        — the episode-key family: `…_ep_4`,
 *                        `official_ep_4_<core>`, `token_ep_4_<prefix>`,
 *                        `official_sorted_ep_4_<sig>`,
 *                        `official_condensed_ep_4_<condensed>`,
 *                        `<slug>_ep_4_<source>`
 *   - `_batch_<a>_<b>` — the batch (episode RANGE) family
 *   - `_s<d>e<d>`      — the `S01E10` marker
 *   - a numeric token  — the episode number of the NORMALIZED title
 *                        (`kanojo_no_tomodachi_04`). The token is accepted in
 *                        ANY position, not only trailing: the official
 *                        fullNorm keeps the trailing tags after the number
 *                        (`…_04__end`) and a batch fullNorm keeps the range
 *                        inline (`…_01_13_end`).
 * Everything else (the anime name only, e.g. `fansub_bam25_kanojo_no_tomodachi`)
 * is SERIES-LEVEL.
 */
export function isEpisodeScopedKey(key) {
  const k = String(key ?? '');
  if (!k) return false;
  if (/(?:^|_)ep_\d{1,4}(?:_|$)/.test(k)) return true;
  if (/(?:^|_)batch_\d{1,4}_\d{1,4}(?:_|$)/.test(k)) return true;
  if (/(?:^|_)s\d{1,2}e\d{1,4}(?:_|$)/i.test(k)) return true;
  if (/(?:^|_)(\d{1,4})(?=_|$)/.test(k)) return true;
  return false;
}

/**
 * The release-level dedup decision.
 *
 * P1-2 (Layer 2): when the candidate is scoped to an episode, a match on a
 * SERIES-LEVEL key is not decisive — the episode-scoped keys decide (a
 * series-level key stored for episode 01 must not swallow episode 04).
 * A candidate with no episode at all keeps the previous behaviour ("any key
 * matches"), so an episode-less release is still suppressed by a series-level
 * key.
 *
 * `isReleasePostedByAnyKey` keeps the pre-P1-2 semantics ("any key matches")
 * available for callers that rely on them.
 */
export function isReleaseAlreadyPosted(posted, keys) {
  const list = Array.isArray(keys) ? keys : [];
  const episodeScoped = list.filter(k => isEpisodeScopedKey(k));
  // An episode-LESS candidate: unchanged behaviour ("any key matches").
  if (episodeScoped.length === 0) return list.some(k => posted.has(k));
  // An episode-scoped candidate: only the episode-scoped keys decide.
  return episodeScoped.some(k => posted.has(k));
}

/**
 * The pre-P1-2 dedup decision ("any key matches") — kept available for
 * callers that rely on the unguarded semantics.
 */
export function isReleasePostedByAnyKey(posted, keys) {
  return (Array.isArray(keys) ? keys : []).some(k => posted.has(k));
}

export function markReleaseAsPosted(posted, msgKey, keys = []) {
  if (msgKey) posted.add(msgKey);
  for (const k of keys) {
    if (k) posted.add(k);
  }
  savePostedIds(posted);
}

// ---------------------------------------------------------------------------
// P1-5 (H10): the dispatch ledger — "dispatched" is NOT "published".
//
// A multi-episode batch that is handed to the sub-extractor repository is
// only ACCEPTED there (HTTP 204); this bot never sees the published file.
// Recording it as a plain posted key made the state claim a publication that
// never happened here — and a lost dispatch was never retried.
//
// The ledger lives INSIDE the existing posted.json (no new state file): a
// dispatched batch is recorded as `dispatched:<msgKey>` and
// `dispatched:<releaseKey>`, and the dedup gates consult it, so the batch is
// still not dispatched twice.
// ---------------------------------------------------------------------------

/** The prefix of every dispatch-ledger key inside posted.json. */
export const DISPATCH_LEDGER_PREFIX = 'dispatched:';

/** The state file's key-length cap (scripts/merge-posted-state.mjs). */
const MAX_POSTED_KEY_LENGTH = 512;

/** The ledger key of a message key or a release key. */
export function dispatchLedgerKey(key) {
  return key ? `${DISPATCH_LEDGER_PREFIX}${key}` : null;
}

/**
 * The message-level gate: the message was already handled — published OR
 * dispatched — in an earlier cycle. Legacy plain `tg_<chat>_<id>` keys keep
 * working exactly as before.
 */
export function isMessageAlreadyHandled(posted, msgKey) {
  if (!msgKey) return false;
  return posted.has(msgKey) || posted.has(dispatchLedgerKey(msgKey));
}

/** Was this release handed to the sub-extractor instead of published here? */
export function isReleaseDispatched(posted, keys) {
  return keys.some(k => k && posted.has(dispatchLedgerKey(k)));
}

/**
 * The release-level gate: a release that was published OR dispatched must
 * not be processed again. This is the gate that also consults the dispatch
 * ledger; the dedup half is `isReleaseAlreadyPosted`, which carries the
 * P1-2 (Layer 2) guard — a series-level key never decides an episode-scoped
 * candidate. The dispatch-ledger half is UNCHANGED by P1-2.
 */
export function isReleaseAlreadyPostedOrDispatched(posted, keys, { season = null } = {}) {
  // BUG A: apply the additive season qualification ONCE, before BOTH halves
  // (the posted set and the `dispatched:` ledger). A season-2 candidate must
  // not be suppressed by a season-1 key sitting in either half.
  const decisionKeys = qualifyKeysBySeason(keys, season);
  return isReleaseAlreadyPosted(posted, decisionKeys) || isReleaseDispatched(posted, decisionKeys);
}

/**
 * Record a DISPATCHED batch in the ledger — NEVER as a plain posted key, so
 * the state stays honest about what actually happened.
 */
export function markReleaseAsDispatched(posted, msgKey, keys = []) {
  const added = [];
  const addLedgerKey = (key) => {
    const ledgerKey = dispatchLedgerKey(key);
    if (!ledgerKey) return;
    if (ledgerKey.length > MAX_POSTED_KEY_LENGTH) {
      // A key the merge script would reject would make the WHOLE state file
      // invalid (a red push) — the ledger entry is dropped instead.
      console.warn(`   ⚠️ Dispatch ledger key too long (${ledgerKey.length} > ${MAX_POSTED_KEY_LENGTH}) — not recorded.`);
      return;
    }
    posted.add(ledgerKey);
    added.push(ledgerKey);
  };
  addLedgerKey(msgKey);
  for (const k of keys) addLedgerKey(k);
  savePostedIds(posted);
  return added;
}

/**
 * A release-level dedup hit: the release is already known, so the message is
 * skipped. A release that was only DISPATCHED is recorded in the dispatch
 * ledger — never as a plain posted key (the state must not claim a
 * publication that this bot did not make).
 */
export function markReleaseAsKnown(posted, msgKey, keys = [], { season = null } = {}) {
  // BUG A: the CHECK is season-qualified, but the STORED keys are the full
  // list — that is how the season-qualified key is persisted so a re-arrival
  // is suppressed on the next cycle.
  const decisionKeys = qualifyKeysBySeason(keys, season);
  if (isReleaseAlreadyPosted(posted, decisionKeys)) {
    markReleaseAsPosted(posted, msgKey, keys);
  } else {
    markReleaseAsDispatched(posted, msgKey, keys);
  }
}

// ---------------------------------------------------------------------------
// BUG A (season isolation) + BUG B (two-phase dedup) — shared helpers.
//
// seasonOfReleaseTitle derives ONE root season from a title (null for S1 /
// unmarked). qualifyKeysBySeason is ADDITIVE: it narrows a candidate's keys to
// the season-qualified ones ONLY when season>=2 AND at least one such key
// exists; otherwise it returns the list unchanged (today's guard). No key
// generator takes a season argument — the guard is purely string based.
// ---------------------------------------------------------------------------

const ROMAN_SEASON = Object.freeze({ ii: 2, iii: 3, iv: 4, v: 5, vi: 6 });
const ORDINAL_SUFFIX = Object.freeze({ 1: 'st', 2: 'nd', 3: 'rd' });

export function seasonOfReleaseTitle(title) {
  const s = String(title ?? '');
  if (!s) return null;
  const patterns = [
    /\b(?:season|سيزون)\s*(\d{1,2})\b/i,
    /\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i,
    /\bs(\d{1,2})e\d{1,3}\b/i,
    /\bs(\d{1,2})\b/i,
    /\bseason\s+(ii|iii|iv|v|vi)\b/i,
    /\b(ii|iii|iv|v|vi)\s+season\b/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (!m) continue;
    const raw = m[1];
    const n = /^\d+$/.test(raw) ? Number(raw) : ROMAN_SEASON[String(raw).toLowerCase()];
    if (!Number.isFinite(n)) continue;
    // Season 1 / unmarked keeps today's behaviour (no qualification).
    return n >= 2 ? n : null;
  }
  return null;
}

// Is a stored/candidate key explicitly tied to `season` (>=2)? Accepts the
// spellings the key generators actually emit: "2nd_season", "season_2",
// "s02e03"/"s2e03", "s2", ASCII roman numerals, and the condensed no-separator
// form ("2ndseason"). Kept local — the key generators stay untouched.
function isSeasonQualifiedKey(key, season) {
  const k = String(key ?? '').toLowerCase();
  if (!k) return false;
  const n = Number(season);
  if (!Number.isFinite(n) || n < 2) return false;
  const d = String(n);
  const pad = String(n).padStart(2, '0');
  const roman = ROMAN_SEASON[d] || '';
  const reSeasonThenN = new RegExp(`season[_\\s-]*(?:0*${d}${roman ? `|${roman}` : ''})(?:[_\\s-]|\\d|$)`);
  const reNThenSeason = new RegExp(`0*${d}(?:st|nd|rd|th)?[_\\s-]*season`);
  const reSxE = new RegExp(`(?:^|[_\\s-])s(?:${d}|${pad})e\\d`);
  const reS = new RegExp(`(?:^|[_\\s-])s(?:0*${d}|${pad})(?:[_\\s-]|$)`);
  return reSeasonThenN.test(k) || reNThenSeason.test(k) || reSxE.test(k) || reS.test(k);
}

export function qualifyKeysBySeason(keys, season) {
  const list = Array.isArray(keys) ? keys : [];
  const n = Number(season);
  if (!Number.isFinite(n) || n < 2) return list;
  const qualified = list.filter(k => isSeasonQualifiedKey(k, n));
  return qualified.length ? qualified : list;
}

// Build the pre-download key union ONCE per gate: the raw title plus each
// resolved dictionary title. Fansub resolved names carry the raw title's
// leading [team] (never pass a bare dictionary name — that would emit
// `fansub_unknown_*`). No AniList query here: the caller passes `resolved`.
export function computeReleaseKeySet(title, { isOfficial = false, resolved = null } = {}) {
  const raw = String(title ?? '').trim();
  const r = (resolved && typeof resolved === 'object') ? resolved : null;

  let season = seasonOfReleaseTitle(raw);
  if (season == null && r) {
    season = seasonOfReleaseTitle(r.romaji) ?? seasonOfReleaseTitle(r.english);
  }

  const teamMatch = raw.match(/^\[\s*([^\]]+)\]\s*/);
  const teamPrefix = teamMatch ? `[${teamMatch[1]}] ` : '';
  const withTeam = (name) => teamPrefix ? `${teamPrefix}${name}` : String(name);

  const keys = [];
  const addFor = (candidate) => {
    if (!candidate) return;
    if (isOfficial) keys.push(...getReleaseKeys(candidate, true, r));
    else keys.push(...getFansubReleaseKeys(candidate, r));
  };
  addFor(raw);
  if (r?.romaji) addFor(withTeam(r.romaji));
  if (r?.english) addFor(withTeam(r.english));

  return { keys: Array.from(new Set(keys.filter(Boolean))), season: season ?? null };
}

// Shared phase-2 gate used immediately before every publish. It merges the
// phase-1 keys with a fresh union on the post-resolver effective title, keeps
// the phase-1 season, re-gates, and (on a hit) records the release as known —
// including the linked poster message — before returning proceed:false.
export function gateReleaseBeforePublish(posted, msgKey, phase1, {
  effectiveTitle = null, resolved = null, isOfficial = false, extraTitles = [], linkedMsgKey = null,
} = {}) {
  const p1 = (phase1 && Array.isArray(phase1.keys))
    ? phase1
    : { keys: Array.isArray(phase1) ? phase1 : [], season: null };
  const season = p1.season;

  const phase2 = computeReleaseKeySet(effectiveTitle || '', { isOfficial, resolved });
  const extraKeys = [];
  for (const t of (Array.isArray(extraTitles) ? extraTitles : [])) {
    extraKeys.push(...computeReleaseKeySet(t, { isOfficial, resolved }).keys);
  }
  const mergedKeys = Array.from(new Set([...p1.keys, ...phase2.keys, ...extraKeys]));

  if (isReleaseAlreadyPostedOrDispatched(posted, mergedKeys, { season })) {
    markReleaseAsKnown(posted, msgKey, mergedKeys, { season });
    if (linkedMsgKey) markReleaseAsKnown(posted, linkedMsgKey, mergedKeys, { season });
    return { proceed: false, mergedKeys, season };
  }
  return { proceed: true, mergedKeys, season };
}

/**
 * The Erai batch dispatch outcome (P1-5).
 *
 * A dispatched batch is DEFERRED: the publication happens in the
 * sub-extractor repository and is NOT confirmed here, so it is never counted
 * as published (and never as skipped either — it was handed over). It is
 * recorded in the dispatch ledger, not as a published release.
 */
export function recordDispatchedBatch(posted, msgKey, releaseKeys = [], { title = '', counters = null } = {}) {
  if (counters && typeof counters.countDeferred === 'function') counters.countDeferred(msgKey);
  markReleaseAsDispatched(posted, msgKey, releaseKeys);
  console.warn(`   ⏸️ DEFERRED (dispatched to sub-extractor, publication NOT confirmed): "${title}"`);
}

// ---------------------------------------------------------------------------
// P1-1c: the per-source "no links" counter (observability ONLY — it never
// changes the red/green policy; the owner has not approved that).
// ---------------------------------------------------------------------------

/** The host of a URL ('unknown' when it cannot be parsed). */
export function sourceHostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * S1b — the ONE validator for a `.torrent` URL before it reaches the download
 * sink. Returns the normalised hostname (use it as `expectedHost`) or throws.
 * No raw URL is ever echoed in a thrown message.
 *
 *   * https only; no userinfo; no trailing dot; no `xn--` (punycode) labels;
 *   * NO IP literals at all (bracketed IPv6, dotted IPv4 and Node-normalised
 *     decimal/octal/hex forms such as `https://2130706433/` → `127.0.0.1`);
 *   * loopback / private / link-local ranges are rejected explicitly;
 *   * recovery messages additionally require a dot-anchored `siteHosts()` match.
 */
export function validateTorrentUrl(raw, { recovery = false } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error('Torrent URL rejected: invalid URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('Torrent URL rejected: https required');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('Torrent URL rejected: userinfo not allowed');
  }
  const host = url.hostname.toLowerCase();
  if (!host || host.endsWith('.') || host.includes('..')) {
    throw new Error('Torrent URL rejected: host rejected');
  }
  if (host.split('.').some(label => label.startsWith('xn--'))) {
    throw new Error('Torrent URL rejected: host rejected');
  }
  // Deny by default: ONLY a plausible DNS name is a torrent host. Node already
  // normalises decimal/octal/hex IP forms to a dotted quad (or bracketed IPv6)
  // at URL-parse time, so net.isIP + the DNS grammar below reject them all —
  // including `0x7f000001`, `2130706433`, `0177.0.0.1` and `[::1]`.
  // NOTE: DNS resolution is NOT pinned to the validated name — a DNS rebound
  // after this check is a documented limitation (out of scope here).
  const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  const dnsNameRe = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})*$`);
  const tld = host.split('.').pop() || '';
  if (host.includes('0x') || net.isIP(host) !== 0 || host.length > 253 ||
      !dnsNameRe.test(host) || /(?:^|\.)0\d/.test(host) ||
      !/^[a-z][a-z0-9-]*$/.test(tld)) {
    throw new Error('Torrent URL rejected: host rejected');
  }
  // Bracketed IPv6 and any residual IP forms are refused as defence-in-depth.
  if (host.startsWith('[') || /^\d+$/.test(host) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
      host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('Torrent URL rejected: host rejected');
  }
  // Folded private/special IPv4 ranges (unreachable after net.isIP above, kept
  // explicit for intent): loopback, private, link-local, 0/8, multicast,
  // CGNAT 100.64/10 and benchmarking 198.18/15.
  const ranges = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ranges) {
    const a = Number(ranges[1]);
    const b = Number(ranges[2]);
    if (a === 0 || a >= 224 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 169 && b === 254) ||
        (a === 100 && b >= 64 && b <= 127) || (a === 198 && b >= 18 && b <= 19)) {
      throw new Error('Torrent URL rejected: host rejected');
    }
  }
  if (recovery) {
    const ok = [...siteHosts()].some(d => host === d || host.endsWith(`.${d}`));
    if (!ok) throw new Error('Torrent URL rejected: recovery host not allowlisted');
  }
  return host;
}

/**
 * The per-source no-links counter as ONE operator-facing line.
 * Returns null when nothing was counted (an empty line is noise).
 */
export function formatNoLinksBySource(counts) {
  const map = counts instanceof Map ? counts : new Map(Object.entries(counts || {}));
  const entries = [...map.entries()]
    .filter(([, n]) => Number(n) > 0)
    .sort((a, b) => (Number(b[1]) - Number(a[1])) || String(a[0]).localeCompare(String(b[0])));
  if (!entries.length) return null;
  return `ℹ️ sources with no links this cycle: ${entries.map(([host, n]) => `${host}=${n}`).join(', ')}`;
}

/**
 * Classify a scraped post page for the two CONFIRMED "no links" outcomes:
 * a negative-cached candidate and a FRESH scrape that yielded no usable link.
 * BOTH are recorded in the pending ledger with the SAME bounds:
 * max 3 attempts/msg, 200 pending keys (oldest pruned), 7d TTL skips on read
 * only. A scrape failure (!pageData) is NOT a confirmed no-links page and is
 * deliberately left to the caller's unchanged warning branch.
 *
 * `countNoLinks` is the caller's per-source observability counter and `log`
 * emits the branch's exact warning line (level + text), so the two call sites
 * keep their original wording and behaviour. Returns true when an attempt was
 * recorded here (used only by tests/observability, not by the publish policy).
 */
export function noteNoLinksOutcome(pageData, posted, msgKey, postPageUrl, countNoLinks, log) {
  // S4: make a refused write visible. The message carries NO url/query/token —
  // only the reason code. This is observability; the publish policy is unchanged.
  const notePendingRefusal = () => {
    if (typeof log === 'function') {
      log('warn', '   ⚠️ pending-ledger: attempt not recorded (invalid msg key or 3-attempt cap reached)');
    }
  };
  if (pageData?.negativeCached) {
    countNoLinks(postPageUrl);
    if (!recordPendingAttempt(posted, msgKey)) notePendingRefusal();
    log('log', `   ⏭️ Negative cache: no links for ${sourceHostOf(postPageUrl)} — skipped this cycle (no fetch).`);
    return true;
  }
  if (pageData && !pageData.bestDownloadUrl && !pageData.videoLinks?.directSub) {
    countNoLinks(postPageUrl);
    if (!recordPendingAttempt(posted, msgKey)) notePendingRefusal();
    log('warn', `   ⚠️ No download links found in ${sourceHostOf(postPageUrl)}`);
    return true;
  }
  return false;
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

// BUG C — temporary downloader artefacts are never a release title.
// Two ANCHORED forms (no loose "contains a number" matching, so a legitimate
// "Direct 10" / "Ep 12" is not refused):
//   * file form:   <prefix>_<digits>[_<digits>]…   (prefix needs a separator)
//   * caption form: <direct|buzz|font> <10+-digit-ms>[ - <seq>]…
export function isTempDownloadName(base) {
  // S3: NFKC + zero-width stripping + trim. The separator collapse is a CHECK
  // normaliser ONLY (never used for display), and is applied to the file form
  // only so a spaced "Ep 12" can never be rewritten into "ep_12".
  let s = String(base ?? '').normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '').trim();
  if (!s) return false;
  // Strip only KNOWN archive suffixes (.tar.gz, .tgz, .zip, .rar, .7z, .gz),
  // including repeats — never an arbitrary `\.[a-z0-9]{1,5}` (F10).
  const bare = s.replace(/(?:\.tar\.gz|\.tgz|\.zip|\.rar|\.7z|\.gz)+$/i, '');

  // Caption form: <direct|buzz|font><sep><10+-digit-ms>[<sep><seq>]…
  if (/^(?:direct|buzz|font)[ _-]\d{10,}(?:[ _-]+\d+)*$/i.test(bare)) return true;
  // Episode-temp form (kept deliberately short; matched WITHOUT space collapse
  // so "Ep 12" is a legitimate title and is not refused).
  if (/^ep_\d+$/i.test(bare)) return true;

  const collapsed = bare.replace(/[\s_-]+/g, '_');
  // File form: timestamped tokens require 10+ digits. Compound extensions were
  // removed above, so `direct_1795059597549.tar.gz` is caught.
  if (/^(?:direct|buzz|font|cloud_file)_\d{10,}(?:_\d+)*$/i.test(collapsed)) return true;
  // Legacy short downloader prefixes (no `direct`/`buzz`/`font` here — those
  // now require 10+ digits, which kills `direct-12345` / `Direct 10`). Kept for
  // backward compatibility with the existing regression fixtures.
  if (/^(?:lazy|mega|drive|doc|work|temp|sub|down|download|cloud_file)_\d+(?:_\d+)*$/i.test(collapsed)) return true;
  return false;
}

// The ONE helper used by publishDocument to reduce a caption / file name to the
// bare candidate token before the temp-name test. It strips a leading [team]
// block, a trailing file extension and trailing [tags]/(tags). It is a CHECK
// normalizer only — it never derives a release title.
function stripTeamAndTrailingTags(name) {
  let s = String(name ?? '').trim();
  s = s.replace(/^[📍📌🎬\s]*\[[^\]]+\]\s*/, '');
  s = s.replace(/\.(?:mkv|mp4|m4v|ass|srt|zip|rar|7z)\s*$/i, '');
  s = s.replace(/\s*\[[^\]]*\]\s*$/g, '').trim();
  s = s.replace(/\s*\([^\)]*\)\s*$/g, '').trim();
  return s.trim();
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

  // BUG C: a temporary downloader name (`direct_1795059597549`,
  // `direct 1795059597549 - 10`, `ep_12`, `cloud_file_123`, …) must never
  // become an English release title. Check BEFORE the `[._] -> space`
  // normalization so both the file form and the caption form are matched.
  if (isTempDownloadName(base)) return null;

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
  // BUG C (cont.): the temp token can also sit behind a [team] bracket (ASS
  // Title headers carry one). Check the team-stripped base too.
  if (isTempDownloadName(base)) return null;

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

// F1.2 — the positions in a release file name where a number IS an episode
// token: " - 001", "_001", " E01", " EP01", "#01". A number anywhere else
// ("5 Cent-per-Second", "S2") belongs to the title and must survive.
const EPISODE_TOKEN_PATTERNS = [
  /(\s+-\s*)(\d{1,4})(?=\s|$|[\[\]().])/g,                       // " - 001"
  /(_)(\d{1,4})(?=\s|$|[\[\]().])/g,                             // "_001"
  /(\s+[eE][pP]?(?:isode)?\.?\s*)(\d{1,4})(?=\s|$|[\[\]().])/g,  // " E01" / " EP01"
  /(\s*#\s*)(\d{1,4})(?=\s|$|[\[\]().])/g,                       // "#01"
];

// F1.2 — remove ONE episode token (the source file's OWN episode number)
// from a resolved name, wherever it appears, so that a multi-episode package
// does not promise a single episode:
//   "Aikatsu! - 001 [1080p]" -> "Aikatsu! [1080p]"
// Only a number in an episode-token position is touched — a number that is
// not the file's own episode token ("5 Cent-per-Second", "S2") survives.
function stripEpisodeTokenFromName(name, episodeNumber) {
  if (!name || !episodeNumber) return name;
  const target = parseInt(String(episodeNumber).replace(/^0+/, ''), 10);
  if (!Number.isFinite(target) || target <= 0) return name;
  let out = String(name);
  for (const re of EPISODE_TOKEN_PATTERNS) {
    out = out.replace(re, (match, prefix, digits) => (
      parseInt(digits, 10) === target ? '' : match
    ));
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

// m10 — the numbers that are a RESOLUTION, not an episode number. A number of
// this list is skipped ONLY when it is not in an explicit episode-token
// position (" - 1080" IS an episode, "Show 1080.mkv" is a resolution).
const RESOLUTION_NUMBERS = [480, 540, 576, 720, 1080, 1440, 2160, 4320];

// Is this number in an episode-token position (" - 001", "_001", " E01", "#01")?
function isEpisodeTokenNumber(name, epNum) {
  const target = Number(epNum);
  if (!Number.isFinite(target)) return false;
  for (const re of EPISODE_TOKEN_PATTERNS) {
    const rx = new RegExp(re.source, 'gi');
    let m;
    while ((m = rx.exec(name)) !== null) {
      if (m[2] !== undefined && parseInt(m[2], 10) === target) return true;
      if (rx.lastIndex === m.index) rx.lastIndex += 1;
    }
  }
  return false;
}

export function resolveEnglishTitleIfArabic(rawTitle, fileNames = [], assContentPaths = [], { episodeNames = fileNames } = {}) {
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

  // Detect the batch episodes from EVERY media file of the package (F1.1).
  // A Blu-ray batch holds one .mkv per episode (Arabic track embedded) plus
  // usually only ONE loose .ass — the subtitle files alone would describe a
  // single episode, and the caption would promise "001" for a 001-004 set.
  // m6: the episode numbers come from `episodeNames` (the caller decides
  // WHICH files carry them) while the NAME candidates stay the caller's
  // choice — the official/Subdl title derivation is restored.
  const epNumbers = new Set();
  for (const media of (Array.isArray(episodeNames) ? episodeNames : [])) {
    if (!media || typeof media !== 'string') continue;
    if (!/\.(?:ass|srt|mkv|mp4|m4v)$/i.test(media)) continue;
    const mediaBase = path.basename(media);
    const ep = extractEpisodeNumber(mediaBase);
    if (!ep) continue;
    const epNum = parseInt(ep, 10);
    if (!(epNum > 0)) continue;
    // m10: a number of four digits is not an episode ("1080.mkv"), but a
    // KNOWN resolution is skipped only when it is not in an episode-token
    // position (" - 1080" IS an episode).
    if (epNum > 9999) continue;
    if (RESOLUTION_NUMBERS.includes(epNum) && !isEpisodeTokenNumber(mediaBase, epNum)) continue;
    epNumbers.add(epNum);
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
    if (isMultiEpBatch) {
      // F1.2: the name comes from the post, so its OWN episode token is the
      // one that must not survive in the title of a multi-episode package.
      baseEnglish = stripEpisodeTokenFromName(baseEnglish, origEp);
      if (!/(?:\[\s*\d+\s*[~-]\s*\d+\s*\]|\d+\s*[~-]\s*\d+)/.test(baseEnglish)) {
        baseEnglish = `${baseEnglish} ${batchRangeStr}`;
      }
    }
    return baseEnglish;
  }

  // Check candidate file names
  for (const fn of candidateNames) {
    if (!fn) continue;
    let resolved = cleanEnglishTitleFromFilename(fn, team);
    if (resolved) {
      if (isMultiEpBatch) {
        // F1.2: remove the episode token of the file the name came from
        // (wherever it appears), then the range describes the whole set.
        resolved = stripEpisodeTokenFromName(resolved, extractEpisodeNumber(path.basename(fn)));
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
                // F1.2: same rule as the file-name branch — the episode token
                // of the ASS file the name came from is removed.
                resolved = stripEpisodeTokenFromName(resolved, extractEpisodeNumber(path.basename(p)));
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
  let clean = String(name ?? '')
    // M2: the C0 control characters (NUL, ESC, …) can never reach a
    // published document name.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

// S2 — the UNCOMPRESSED size of an archive, checked BEFORE the extraction.
//
// A zip bomb (a tiny archive that expands to gigabytes) must never be
// extracted: the entry sizes are summed first and the archive is refused
// when the total is over the cap. A listing that cannot be read is refused
// as well (fail-closed).
export function assertArchiveUncompressedCapped(archivePath, maxBytes = CLOUD_CAP_LIMITS.CLOUD_EXTRACT_MAX_BYTES) {
  const ext = path.extname(archivePath).toLowerCase();
  let total = 0;

  if (ext === '.zip') {
    const zip = new AdmZip(archivePath);
    for (const entry of zip.getEntries()) {
      const size = Number(entry.header && entry.header.size);
      if (!Number.isFinite(size) || size < 0) {
        throw cloudCapError('ARCHIVE_TOO_LARGE', 'archive listing is unreadable (fail-closed)');
      }
      total += size;
      if (total > maxBytes) {
        throw cloudCapError('ARCHIVE_TOO_LARGE', `archive refused: more than ${maxBytes} bytes uncompressed`);
      }
    }
    return total;
  }

  // 7z / rar: the technical listing carries the uncompressed "Size =" of
  // every entry.
  let listing = null;
  for (const tool of ['7z', SevenZip.path7za]) {
    try {
      listing = execFileSync(tool, ['l', '-slt', archivePath], {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024
      });
      break;
    } catch { /* try the next tool */ }
  }
  if (listing == null) {
    throw cloudCapError('ARCHIVE_TOO_LARGE', 'archive listing failed (fail-closed)');
  }
  // The archive properties come first; the entries follow the separator.
  const separator = listing.indexOf('----------');
  const entriesText = separator >= 0 ? listing.slice(separator) : listing;
  const sizes = [...entriesText.matchAll(/^Size = (\d+)\s*$/gm)].map(m => Number(m[1]));
  if (sizes.length === 0) {
    throw cloudCapError('ARCHIVE_TOO_LARGE', 'archive listing is unreadable (fail-closed)');
  }
  total = sizes.reduce((a, b) => a + b, 0);
  if (total > maxBytes) {
    throw cloudCapError('ARCHIVE_TOO_LARGE', `archive refused: ${total} bytes uncompressed > ${maxBytes} bytes`);
  }
  return total;
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
  // S2: the UNCOMPRESSED size of the archive is checked BEFORE anything is
  // extracted (a zip bomb is refused here). The temp extraction dir is
  // removed on the refusal.
  try {
    assertArchiveUncompressedCapped(archivePath);
  } catch (e) {
    console.warn(`   ⚠️ Refusing to extract ${logSafe(path.basename(archivePath))}: ${logSafe(e && e.message)}`);
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { }
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
      // m3: the ENTRY name is sanitized again (defense-in-depth, like
      // packToZip): the file itself is still read under its REAL name.
      const safeName = safeRemoteBaseName(item.name, 'entry');
      const fullPath = path.join(dir, item.name);
      if (!isInsideDir(fullPath, folderPath)) throw new Error('unsafe cloud file name: ' + item.name);
      if (item.isDirectory()) {
        addRecursive(fullPath, zipSubDir ? `${zipSubDir}/${safeName}` : safeName);
      } else if (/\.(ass|srt)$/i.test(item.name)) {
        zip.addLocalFile(fullPath, zipSubDir, safeName);
      } else if (/\.(ttf|otf|woff2?|ttc)$/i.test(item.name)) {
        const targetFontDir = zipSubDir || 'Fonts';
        zip.addLocalFile(fullPath, targetFontDir, safeName);
      }
    }
  }
  addRecursive(folderPath);
  zip.writeZip(destZipPath);
  return destZipPath;
}

export async function downloadFileToDisk(url, destPath, headers = {}, options = {}) {
  const signal = AbortSignal.timeout(10 * 60 * 1000);
  // S1c/F4: only an explicitly requested manual mode changes fetch behaviour;
  // every existing caller (no `redirect` option) keeps the default 'follow'.
  // F4: recovery messages still treat ANY 3xx as a typed fatal; non-recovery
  // manual mode follows a BOUNDED, re-validated redirect chain instead.
  const manualRedirect = options.redirect === RECOVERY_REDIRECT_MODE;
  const isRecovery = options.recovery === true;
  const requestOptions = {
    signal,
    ...(manualRedirect ? { redirect: RECOVERY_REDIRECT_MODE } : {}),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      ...headers
    }
  };
  const expectedHost = options.expectedHost ? String(options.expectedHost).toLowerCase() : null;
  // The per-file cap (M6/C7b/C10): a hostile server must not be able to fill
  // the disk with ONE file.
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : null;
  const assertHost = res => {
    if (!expectedHost) return;
    const actualHost = new URL(res.url).hostname.toLowerCase();
    if (actualHost !== expectedHost) {
      throw new Error(`Download redirected to unexpected host "${actualHost}" (expected "${expectedHost}")`);
    }
  };
  const throwTypedRedirect = () => {
    const err = new Error(RECOVERY_CODES.REDIRECT);
    err.code = RECOVERY_CODES.REDIRECT;
    throw err;
  };

  let currentUrl = url;
  let res = await fetch(currentUrl, requestOptions);
  let hopsLeft = manualRedirect && !isRecovery ? 3 : 0;
  while (manualRedirect && res.status >= 300 && res.status < 400) {
    // Recovery: a 3xx is fatal BEFORE any body is read (typed RECOVERY_REDIRECT).
    if (isRecovery) throwTypedRedirect();
    if (hopsLeft-- <= 0) throw new Error('Too many redirects');
    const location = res.headers.get('location');
    if (!location) throw new Error('Redirect without Location');
    let nextUrl;
    try { nextUrl = new URL(location, currentUrl); } catch { throw new Error('Invalid redirect'); }
    // Re-validate with the SAME validator and require the same host BEFORE the
    // next request — an SSRF redirect can never smuggle a private host through.
    const nextHost = validateTorrentUrl(nextUrl.toString(), { recovery: false });
    if (expectedHost && nextHost !== expectedHost) throw new Error('Redirect host rejected');
    currentUrl = nextUrl.toString();
    res = await fetch(currentUrl, requestOptions);
  }
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
      // F12: no drive.google.com torrent URL ever reaches this sink — torrent
      // URLs come from the site allowlist via validateTorrentUrl — so strict
      // expectedHost equality here (no driveusercontent exception) is intentional.
      const confirmedUrl = new URL(action, res.url);
      confirmedUrl.search = params.toString();
      console.log('   ↪️ Confirming public Google Drive download.');
      res = await fetch(confirmedUrl.toString(), requestOptions);
      if (manualRedirect && res.status >= 300 && res.status < 400) throwTypedRedirect();
      assertHost(res);
      if (!res.ok) throw new Error(`Google Drive confirmation returned HTTP ${res.status}`);
    }
  }

  if (/text\/html/i.test(res.headers.get('content-type') || '')) {
    throw new Error('Download returned HTML instead of a file');
  }

  // The declared size is checked BEFORE the first byte is written.
  if (maxBytes) {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw cloudCapError('FILE_TOO_LARGE', `download refused: ${declared} bytes > ${maxBytes} bytes`);
    }
  }

  const fileStream = fs.createWriteStream(destPath, { flags: 'w' });
  try {
    // The bytes are counted WHILE they arrive (a lying Content-Length does
    // not help: the counter aborts the download and the partial file is
    // removed).
    const source = Readable.fromWeb(res.body);
    await (maxBytes
      ? pipeline(source, byteCounter(maxBytes), fileStream)
      : pipeline(source, fileStream));
  } catch (e) {
    // The partial file NEVER survives a refused/failed download (M7).
    try {
      if (!fileStream.closed) {
        fileStream.destroy();
        await new Promise(resolve => fileStream.once('close', resolve));
      }
    } catch { }
    try { fs.rmSync(destPath, { force: true }); } catch { }
    throw e;
  }
  return destPath;
}

// A stream transform that refuses a body larger than `maxBytes` (M6).
function byteCounter(maxBytes) {
  let received = 0;
  return new Transform({
    transform(chunk, _enc, callback) {
      received += chunk.length;
      if (received > maxBytes) {
        callback(cloudCapError('FILE_TOO_LARGE', `download refused: more than ${maxBytes} bytes`));
        return;
      }
      callback(null, chunk);
    }
  });
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

export function parseEraiMessage(msg) {
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
  // C4: a synthetic recovery message has NO Telegram entities — its torrent
  // URL is plain text. Without this fallback parseEraiMessage returns no URL
  // and the release is silently skipped (never published).
  // S1a/S1b: https ONLY, and validate before it can reach the download sink.
  // An unsafe URL is dropped (torrentUrl stays empty → the release is skipped
  // and never downloaded). The entity-based path above is unchanged.
  if (!torrentUrl) {
    const plain = text.match(/https:\/\/[^\s"'<>]+\.torrent[^\s"'<>]*/i);
    if (plain) {
      try {
        validateTorrentUrl(plain[0], { recovery: isRecoveryMessage(msg) });
        torrentUrl = plain[0];
      } catch { /* unsafe URL: leave empty, never reaches the sink */ }
    }
  }

  return { title, source, sourceName, hasArabic, torrentUrl, nyaaUrl };
}

// The two binaries the extractor needs. Fixed labels only — never any
// interpolated remote data.
const REQUIRED_MEDIA_TOOLS = ['aria2c', 'mkvextract'];

function missingMediaTools() {
  const missing = [];
  for (const tool of REQUIRED_MEDIA_TOOLS) {
    try {
      execSync(`${tool} --version`, { stdio: 'ignore' });
    } catch {
      missing.push(tool);
    }
  }
  return missing;
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
      } else {
        // A refused extraction must never publish the raw archive.
        return null;
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

export async function downloadAndExtractSubtitleFromTorrent(torrentUrl, workDir, isOfficial = false, preferArabic = true, customSubName = '', options = {}) {
  // S1b/S1c: validate FIRST (no raw URL in any thrown message), pin the host and
  // cap the bytes. The text/html rejection already lives in downloadFileToDisk.
  const { recovery = false } = options;
  const expectedHost = validateTorrentUrl(torrentUrl, { recovery });
  const torrentPath = path.join(workDir, 'release.torrent');
  await downloadFileToDisk(torrentUrl, torrentPath, {}, {
    expectedHost,
    maxBytes: 20 * 1024 * 1024,
    // F4: manual redirect for ALL messages (recovery still aborts on any 3xx,
    // non-recovery follows a bounded re-validated chain in downloadFileToDisk).
    redirect: RECOVERY_REDIRECT_MODE,
    recovery,
  });
  // S1d: only accept a file that actually downloaded with a non-zero size.
  const torrentSize = fs.statSync(torrentPath).size;
  if (!(torrentSize > 0)) {
    // F11: never leak an empty file behind a failed size check.
    try { fs.rmSync(torrentPath, { force: true }); } catch { }
    throw new Error('Torrent download produced an empty file');
  }
  console.log(`   📥 Torrent file downloaded (${torrentSize} bytes)`);

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
  // BUG C — last-line defence for all 9 publish sites: a caption or file name
  // that is still a temporary downloader artefact is refused (counts as failed
  // at the caller). Never transform it into a title — that is the root cause.
  const captionBase = stripTeamAndTrailingTags(caption);
  const fileBase = stripTeamAndTrailingTags(path.basename(filePath));
  if (isTempDownloadName(captionBase) || isTempDownloadName(fileBase)) {
    const refused = logSafe(captionBase || fileBase);
    console.warn(`   ⚠️ Refusing to publish temporary download name: "${refused}"`);
    return { ok: false, description: `Temporary download name refused: ${refused}` };
  }

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
        // M8: the MTProto transport sends with parseMode 'html', so the
        // caption MUST be escaped here. The Bot API transport escapes its
        // own copy inside sendDocument (telegram.mjs) — each transport
        // escapes EXACTLY ONCE, the caption that reaches publishDocument is
        // always the raw one (the Bot API failure falls through to this
        // path with the same raw caption).
        caption: escapeHtml(caption),
        parseMode: 'html',
        forceDocument: true,
        workers: 4
      });
      // The upload timeout timer must be RELEASED when the race is over:
      // an uncleared timer keeps the process alive for minutes after the
      // document was published (it also blocks the test runner from exiting).
      let uploadTimer = null;
      const timeoutPromise = new Promise((_, reject) => {
        uploadTimer = setTimeout(() => reject(new Error(`MTProto upload timed out after ${Math.round(uploadTimeoutMs / 1000)}s`)), uploadTimeoutMs);
      });
      let sent;
      try {
        sent = await Promise.race([uploadPromise, timeoutPromise]);
      } finally {
        if (uploadTimer) clearTimeout(uploadTimer);
      }
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
// Cloud source selection (F2c) and cloud subtitle packages (F2d)
// ====================================================================

/**
 * F2c — the cloud sources of a post page, ordered so that a SUBTITLE-bearing
 * source is tried BEFORE a video source.
 *
 * A post can offer the same batch twice: as a folder of .ass subtitles (light,
 * publishable whole as ONE package) and as a folder of .mkv videos (heavy,
 * publishable one episode at a time). The production log showed the video
 * folder winning, and only episode 001 being published.
 *
 * The post's SUBTITLE button (`videoLinks.directSub`) is the subtitle source
 * BY CONSTRUCTION — the scraper only puts a link there when the post presents
 * it as the subtitle/archive link — and it may be a cloud FOLDER, which the
 * plain direct download skips. The other cloud links are inspected with a
 * folder LISTING (no file is downloaded for that).
 *
 * M1 — the listing of every candidate is CARRIED by the candidate
 * (`source.listing`), so the download path does NOT list the folder a second
 * time. The lister is injectable (`options.listFolder`) for the tests; it is
 * called AT MOST ONCE per candidate and NEVER for a `directSub` candidate
 * (that one is a subtitle source by construction).
 */
export async function buildPostCloudSources(videoLinks = {}, options = {}) {
  const { listFolder = listCloudFolderFiles } = options || {};
  const vl = videoLinks || {};

  // m12: a post without any cloud link is not inspected at all.
  if (!vl.mediafire && !vl.mega && !vl.drive && !vl.directSub) return [];

  const candidates = [];
  const add = (kind, url, offersSubtitles = false) => {
    if (!url) return;
    const existing = candidates.find(c => c.kind === kind && c.url === url);
    if (existing) {
      if (offersSubtitles) existing.offersSubtitles = true;
      return;
    }
    candidates.push({ kind, url, offersSubtitles });
  };

  // The subtitle button of the post (may be a cloud FOLDER of .ass files).
  // m5: the provider is decided by the HOSTNAME, never by a substring of the
  // whole url (a hostile link can carry "mega.nz" anywhere).
  const directSub = vl.directSub;
  if (directSub) {
    const directKind = cloudKindOfUrl(directSub);
    if (directKind) add(directKind, directSub, true);
  }

  // The softsub providers (usually the videos).
  // X3: the provider of a field is decided by its HOSTNAME — a field that
  // points somewhere else (a hostile link that merely mentions
  // "mediafire.com") is DROPPED instead of being fetched server-side.
  for (const [kind, value] of [['mediafire', vl.mediafire], ['mega', vl.mega], ['drive', vl.drive]]) {
    if (!value) continue;
    if (!isProviderHostUrl(value, kind)) {
      console.warn(`   ⚠️ ${kind} link ignored: it is not hosted by ${kind} (${redactUrl(value)})`);
      continue;
    }
    add(kind, value);
  }

  // A source that holds subtitle files is detected from its folder LISTING.
  let listedSources = 0;
  let listedFiles = 0;
  let listingErrors = 0;
  for (const c of candidates) {
    if (c.offersSubtitles) continue;
    const listing = await listFolder(c.kind, c.url);
    listedSources += 1;
    if (listing == null) {
      // m11: a FAILED listing is not an empty folder — it is remembered so
      // the caller can tell them apart.
      c.listingError = true;
      c.listing = [];
      listingErrors += 1;
      continue;
    }
    c.listing = Array.isArray(listing) ? listing : [];
    listedFiles += c.listing.length;
    if (listingOffersSubtitles(c.listing)) c.offersSubtitles = true;
  }
  console.log(`   ℹ️ Cloud listings: ${listedSources} source(s), ${listedFiles} file(s), ${listingErrors} failure(s).`);

  return orderCloudSources(candidates);
}

/**
 * F2d — download a cloud SUBTITLE selection. One file is downloaded as it is;
 * several files are downloaded and packed into ONE package (the file names are
 * kept, the fonts are not touched here — that is the release path's job).
 *
 * M6 — the batch is refused BEFORE the first download when it holds too many
 * files or too many bytes; M7 — the unpack directory never survives the call
 * (not on success and not on a failure) and a failed single download leaves
 * no partial file behind.
 */
export async function downloadCloudSubtitleSelection(selection, destDir, referer, options = {}) {
  const {
    downloadNode = downloadMegaNode,
    downloadFile = downloadFileToDisk,
    packFolder = packFolderToZip,
  } = options || {};

  if (!selection) return null;

  const files = selection.type === 'subtitles' && Array.isArray(selection.files) ? selection.files : [];
  const single = files.length === 1 ? files[0] : (files.length === 0 ? selection : null);

  if (single) {
    // X5: the cap depends on the TYPE of the selection — a subtitle file is
    // bounded by SUB_MAX_FILE_BYTES (64 MiB), a video/archive by
    // CLOUD_FILE_MAX_BYTES (4 GiB, the Telegram ceiling). A real MKV must
    // NOT be aborted by the subtitle cap.
    const isSubtitle = single.type !== 'mkv' && SUBTITLE_FILE_RE.test(String(single.name || ''));
    const maxBytes = isSubtitle
      ? CLOUD_CAP_LIMITS.SUB_MAX_FILE_BYTES
      : CLOUD_CAP_LIMITS.CLOUD_FILE_MAX_BYTES;
    if (isSubtitle) {
      // The per-file cap of a single subtitle (C7b/C10).
      assertCloudBatchCaps([single]);
    } else {
      // The listed size of a video/archive is checked against the video cap.
      const listedSize = Number(single.size);
      if (Number.isFinite(listedSize) && listedSize > maxBytes) {
        throw cloudCapError('FILE_TOO_LARGE', `cloud file refused: ${listedSize} bytes > ${maxBytes} bytes`);
      }
    }
    const dest = path.join(destDir, uniqueFileName(safeRemoteBaseName(single.name, nextTempTag('cloud_file'))));
    if (!isInsideDir(dest, destDir)) throw new Error('unsafe cloud file name: ' + single.name);
    try {
      if (single.node) await downloadNode(single.node, dest, destDir, { maxBytes });
      else if (single.directUrl) await downloadFile(single.directUrl, dest, { Referer: referer }, { maxBytes });
      else return null;
    } catch (e) {
      // The partial file NEVER survives a failed download (M7).
      try { fs.rmSync(dest, { force: true }); } catch { }
      throw e;
    }
    return fs.existsSync(dest) ? dest : null;
  }

  // Several subtitles: ONE package (the same pattern as the Drive release).
  // The cap is checked BEFORE the first download and BEFORE the unpack
  // directory exists (M6).
  assertCloudBatchCaps(files);

  const unpackDir = path.join(destDir, nextTempTag('cloud_unpack'));
  fs.mkdirSync(unpackDir, { recursive: true });
  const usedNames = new Set();
  try {
    // P2: the destination names are computed FIRST (sequentially, so the
    // unique names can never race), then the downloads run with a BOUNDED
    // parallelism.
    const targets = files.map(f => ({
      file: f,
      dest: path.join(unpackDir, uniqueFileName(safeRemoteBaseName(f.name, nextTempTag('cloud_file')), usedNames)),
    }));
    for (const t of targets) {
      if (!isInsideDir(t.dest, unpackDir)) throw new Error('unsafe cloud file name: ' + t.file.name);
    }
    await mapWithConcurrency(targets, CLOUD_CAP_LIMITS.CONCURRENCY, async (t) => {
      const f = t.file;
      if (f.node) await downloadNode(f.node, t.dest, unpackDir, { maxBytes: CLOUD_CAP_LIMITS.SUB_MAX_FILE_BYTES });
      else await downloadFile(f.directUrl, t.dest, { Referer: referer }, { maxBytes: CLOUD_CAP_LIMITS.SUB_MAX_FILE_BYTES });
    });
    // C7c: the listing of a direct-URL source carries no reliable size, so
    // the batch total is checked AFTER the download (a stat of the files).
    const totalBytes = unpackDirBytes(unpackDir);
    if (totalBytes > CLOUD_CAP_LIMITS.BATCH_MAX_TOTAL_BYTES) {
      throw cloudCapError(
        'BATCH_TOO_LARGE',
        `cloud batch refused: ${Math.round(totalBytes / 1024 / 1024)} MiB > ${Math.round(CLOUD_CAP_LIMITS.BATCH_MAX_TOTAL_BYTES / 1024 / 1024)} MiB`
      );
    }
    const zipPath = path.join(destDir, `${nextTempTag('cloud_bundle')}.zip`);
    // X11: a failed pack leaves no partial zip behind.
    try {
      packFolder(unpackDir, zipPath);
    } catch (e) {
      try { fs.rmSync(zipPath, { force: true }); } catch { }
      throw e;
    }
    return fs.existsSync(zipPath) ? zipPath : null;
  } finally {
    // The unpack directory NEVER survives the call (M7) — not on success and
    // not on a failure in the middle of the loop.
    try { fs.rmSync(unpackDir, { recursive: true, force: true }); } catch { }
  }
}

// ====================================================================
// Main check function
// ====================================================================

/**
 * The per-cycle counters (F-01).
 *
 * The four TERMINAL counters (published / failed / deferred / skipped) are
 * EXCLUSIVE per message: the FIRST classification of a msgKey wins and every
 * later classification of the same key is ignored (and is not counted again).
 * The per-counter sets alone could not guarantee that: a CASE A failure fell
 * through into CASE B and the same message was counted as failed AND
 * published, and a deferred release could later be counted as a failure.
 *
 * The invariant: for each msgKey at most ONE of published/failed/deferred/
 * skipped is incremented, and `attempted` counts it exactly once.
 */
export function createCycleCounters(summary) {
  const attemptedKeys = new Set();
  const publishedKeys = new Set();
  const failedKeys = new Set();
  const deferredKeys = new Set();
  const skippedKeys = new Set();
  // The shared, exclusive classification set (F-01).
  const classifiedKeys = new Set();

  const countAttempted = (key) => { if (!attemptedKeys.has(key)) { attemptedKeys.add(key); summary.attempted++; } };
  // Claim the terminal classification of a message: the FIRST claim wins.
  const claimClassification = (key) => {
    if (classifiedKeys.has(key)) return false;
    classifiedKeys.add(key);
    return true;
  };
  const countPublished = (key) => { if (claimClassification(key)) { publishedKeys.add(key); summary.published++; } };
  const countFailed = (key) => { if (claimClassification(key)) { failedKeys.add(key); summary.failed++; } };
  const countDeferred = (key) => { if (claimClassification(key)) { deferredKeys.add(key); summary.deferred++; } };
  const countSkipped = (key) => { if (claimClassification(key)) { skippedKeys.add(key); summary.skipped++; } };
  // Has this message already been classified into a terminal counter?
  const classified = (key) => classifiedKeys.has(key)
    || publishedKeys.has(key) || failedKeys.has(key)
    || deferredKeys.has(key) || skippedKeys.has(key);

  return { countAttempted, countPublished, countFailed, countDeferred, countSkipped, classified };
}

export async function checkTelegramChannels(existingClient = null) {
  // ------------------------------------------------------------------
  // P0-3 success contract (F-03 / F-08 / F-10 / F-12).
  // The summary is returned on the non-fatal path. A fatal condition
  // throws a typed error (err.isFatal === true) that the runner rethrows,
  // so the window aborts with a non-zero exit after the teardown.
  // F-11: `immediateFatal` is ALWAYS null on the RETURNED path — a fatal is
  // thrown, never returned. Its counters travel with the error (err.summary)
  // and the runner logs them from there.
  // ------------------------------------------------------------------
  const summary = {
    attempted: 0,
    published: 0,
    failed: 0,
    deferred: 0,
    skipped: 0,
    sourceErrors: 0,
    syncFailed: false,
    immediateFatal: null,
  };

  // The counters are EXCLUSIVE per message (F-01): the first terminal
  // classification of a msgKey wins and every later classification of the
  // same key is ignored. See createCycleCounters().
  const {
    countAttempted, countPublished, countFailed, countDeferred, countSkipped, classified,
  } = createCycleCounters(summary);

  // P1-1c: the per-source "no links" counter. OBSERVABILITY ONLY — it never
  // changes the red/green policy (the owner has not approved that); it is
  // printed once per cycle so the broken sources are visible.
  const noLinksBySource = new Map();
  const countNoLinks = (url) => {
    const host = sourceHostOf(url);
    noLinksBySource.set(host, (noLinksBySource.get(host) || 0) + 1);
  };

  const sessionStr = CONFIG.TELEGRAM.SESSION;
  if (!sessionStr) {
    throw createFatalError('AUTH_SESSION_CONFIG', 'No Telegram SESSION found in config.', summary);
  }

  let posted;
  try {
    posted = loadPostedIds();
  } catch (stateErr) {
    throw createFatalError('STATE_LOAD_FAILED', `posted.json could not be loaded: ${stateErr.message}`, summary);
  }

  resetCycleBudget(); // fresh AniList query budget for this check cycle
  const missingTools = missingMediaTools();
  const toolsAvailable = missingTools.length === 0;

  if (!toolsAvailable) {
    for (const tool of missingTools) {
      console.warn(`⚠️ required media tool missing: ${tool}`);
    }
  }

  // Reuse caller-provided client or create a local one (auto-cleaned in finally)
  const ownClient = !existingClient;
  const client = existingClient || new TelegramClient(
    new StringSession(sessionStr),
    CONFIG.TELEGRAM.API_ID,
    CONFIG.TELEGRAM.API_HASH,
    { connectionRetries: 5 }
  );

  // Recovery / backfill spec (RECOVERY_SPEC). Parsed once per run; a blank or
  // absent value is completely inert. A parse error is fatal and logged by
  // code only — the raw spec is never echoed.
  let recoveryTasks = [];
  try {
    recoveryTasks = parseRecoverySpec(process.env.RECOVERY_SPEC || '').tasks;
  } catch (specErr) {
    throw createFatalError(RECOVERY_CODES.SPEC_INVALID, RECOVERY_CODES.SPEC_INVALID, summary);
  }
  const fetchByIds = (chatId, ids) => client.getMessages(chatId, { ids });
  const recoveryLog = (...args) => console.log(...args);
  // F1/F4: EVERY recovery message (synthetic / id / pending retry) carries a
  // marker. Its postUrl scrape forbids redirects (SSRF second hop); ONLY the
  // typed recovery refusals are fatal — every other error propagates unchanged.
  const scrapeWithRecoveryGuard = (msg, scrape) => withRecoveryMode(msg, async () => {
    try {
      return await scrape();
    } catch (e) {
      const fatalCode = recoveryFatalCodeFor(e);
      if (fatalCode) throw createFatalError(fatalCode, fatalCode, summary);
      throw e;
    }
  }, recoveryState);

  try {
    if (!client.connected) {
      console.log(`\n📡 [Telegram MTProto Client] Connecting to Telegram...`);
      try {
        await client.connect();
      } catch (connectErr) {
        throw createFatalError('AUTH_SESSION_CONFIG', `Telegram connect failed: ${connectErr.message}`, summary);
      }
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
      // The duplicate-safety net is OFF for this cycle — it must be visible.
      // IMPLEMENTED POLICY (F-05): `syncFailed` is REPORTED (it is part of
      // the cycle summary and it is printed by the runner) and it appears in
      // the window red REASON when the window is red for another reason — it
      // does NOT by itself make a cycle red.
      summary.syncFailed = true;
      console.warn(`   ⚠️ Could not sync target channel history:`, targetErr.message);
    }

    let dialogs;
    try {
      dialogs = await client.getDialogs({ limit: 150 });
    } catch (dialogErr) {
      throw createFatalError('LISTENER_ERROR', `getDialogs failed: ${dialogErr.message}`, summary);
    }

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

    // Zero source channels means the bot would silently do nothing for the
    // whole window while the run stays green — an immediate fatal (F-03).
    if (targetSourceChats.length === 0) {
      throw createFatalError('CHANNELS_ZERO', 'No target source channel found — refusing to run a silent window.', summary);
    }

    // C4/F5: EVERY task must reference a FULL dialog id of a target source chat
    // (strict String equality). One bogus chatId beside a valid one is fatal —
    // never silently ignored. The withRecoveryMessages check stays as depth.
    if (recoveryTasks.length) {
      const unknown = unknownRecoveryChatIds(recoveryTasks, targetSourceChats.map(c => c.id));
      if (unknown.length) {
        // Fatal diagnostic is code-only: no raw spec and no chat id is echoed.
        throw createFatalError(RECOVERY_CODES.CHAT_UNKNOWN, RECOVERY_CODES.CHAT_UNKNOWN, summary);
      }
    }

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
        const windowMsgs = await client.getMessages(chat.id, { limit: 15 });
        const chatRecoveryTasks = recoveryTasks.filter(t => String(t.chatId) === idStr);
        const { msgs, fatal: recoveryFatal } = await withRecoveryMessages({
          chat, windowMsgs, posted, tasks: chatRecoveryTasks, fetchByIds, log: recoveryLog,
        });
        if (recoveryFatal) {
          throw createFatalError(recoveryFatal.code, recoveryFatal.message, summary);
        }

        for (const msg of msgs) {
          // G2: expose the message being processed for the WHOLE iteration. The
          // page-scrape guard restores its own flag when the scrape returns, but
          // the fansub directory call happens later in this same iteration and
          // must still see the recovery marker.
          recoveryState.msg = isRecoveryMessage(msg) ? msg : null;
          const msgKey = `tg_${chat.id}_${msg.id}`;
          const text = msg.message || '';
          if (isMessageAlreadyHandled(posted, msgKey)) {
            // Already published OR already dispatched in an earlier cycle — a
            // non-fatal skip (the dispatch ledger is consulted as well).
            countSkipped(msgKey);
            continue;
          }
          // The message passed the posted-gate and is taken for processing.
          countAttempted(msgKey);

          // ==============================================================
          // SOURCE 1: Erai-Raws (Official Subtitles via Torrent - Strictly .ass)
          // ==============================================================
          if (isErai) {
            const eraiData = parseEraiMessage(msg);
            if (!eraiData) {
              countSkipped(msgKey); // unparsable message
              continue;
            }

            if (!eraiData.hasArabic) {
              countSkipped(msgKey); // non-Arabic release
              markReleaseAsPosted(posted, msgKey);
              continue;
            }

            const formattedTitle = `[${eraiData.sourceName}] ${eraiData.title}`;
            const eraiResolved = await resolveCanonicalTitle(formattedTitle);
            const phase1 = computeReleaseKeySet(formattedTitle, { isOfficial: true, resolved: eraiResolved });

            if (isReleaseAlreadyPostedOrDispatched(posted, phase1.keys, { season: phase1.season })) {
              // P1-5: the log must not claim a publication that never
              // happened here — a dispatched release is named as such.
              const wasDispatched = isReleaseDispatched(posted, phase1.keys);
              console.log(`   ⏭️ [Erai-Raws] "${formattedTitle}" already ${wasDispatched ? 'dispatched to the sub-extractor' : 'posted as official release'}. Skipping.`);
              countSkipped(msgKey); // dedup hit
              markReleaseAsKnown(posted, msgKey, phase1.keys, { season: phase1.season });
              continue;
            }

            // Batch Guard: detect multi-episode packages (e.g. 01 ~ 10, 01-12)
            // Instead of local download which freezes runner, dispatch to sub-extractor workflow
            const batchRange = extractBatchRange(eraiData.title);
            if (batchRange && batchRange[1] > batchRange[0]) {
              console.log(`   📦 [Erai-Raws] Detected multi-episode batch "${formattedTitle}" (episodes ${batchRange[0]}~${batchRange[1]}).`);
              if (process.env.GH_PAT && eraiData.torrentUrl) {
                // F7: validate BEFORE handing the URL to Actions — an unsafe
                // URL is never sent to the sub-extractor workflow. No raw URL
                // in the log (a stable code is emitted instead).
                let batchTorrentUrl = null;
                try {
                  validateTorrentUrl(eraiData.torrentUrl);
                  batchTorrentUrl = eraiData.torrentUrl;
                } catch {
                  console.warn('   ⛔ [Erai-Raws] batch torrent URL rejected (TORRENT_URL_UNSAFE); skipping dispatch.');
                }
                if (batchTorrentUrl) {
                console.log(`   🚀 Dispatching batch extraction to sub-extractor workflow...`);
                const dispatched = await dispatchBatchExtractor(batchTorrentUrl, formattedTitle, CONFIG.TELEGRAM.TARGET_CHANNEL);
                if (dispatched) {
                  // DEFERRED — the batch was handed to the sub-extractor
                  // repository, but the publication there is NOT confirmed
                  // here. It is recorded in the DISPATCH LEDGER (never as a
                  // published release) so the state does not claim a
                  // publication this bot never made — and it is not
                  // dispatched a second time.
                  recordDispatchedBatch(posted, msgKey, phase1.keys, { title: formattedTitle, counters: { countDeferred } });
                } else {
                  // DEFERRED — never counted as failed, and deliberately NOT
                  // marked as posted so the release is retried next cycle.
                  countDeferred(msgKey);
                  console.warn(`   ⏸️ DEFERRED (batch dispatch failed): "${formattedTitle}" – NOT marked as posted`);
                }
                } else {
                  countSkipped(msgKey); // unsafe batch torrent URL — never dispatched
                  console.log(`   ⏭️ Skipping batch extraction (unsafe torrent URL).`);
                }
              } else {
                countSkipped(msgKey); // batch extraction skipped
                console.log(`   ⏭️ Skipping batch extraction (GH_PAT not set or no torrent URL).`);
              }
              continue;
            }

            if (!toolsAvailable) {
              // DEFERRED — the work is postponed, not failed, and the release
              // is NOT marked as posted so it is retried once the tools exist.
              countDeferred(msgKey);
              console.log(`   ⏸️ DEFERRED (tools missing): "${formattedTitle}" – NOT marked as posted`);
              continue;
            }

            if (!eraiData.torrentUrl) {
              countSkipped(msgKey); // no torrent URL
              console.warn(`   ⚠️ [Erai-Raws] No torrent URL found for "${formattedTitle}". Skipping.`);
              continue;
            }

            console.log(`\n✨ [Erai-Raws Official] "${formattedTitle}"`);
            console.log(`   📦 Source: ${eraiData.source} → [${eraiData.sourceName}]`);
            // S2: log the host only — never the full URL / query / credentials.
            console.log(`   🔗 Torrent host: ${sourceHostOf(eraiData.torrentUrl)}`);

            const eraiWorkDir = path.join(OUT_DIR, `erai_${msg.id}`);
            fs.mkdirSync(eraiWorkDir, { recursive: true });

            try {
              // isOfficial = true ensures strictly .ass extraction without fonts or zip
              const extracted = await downloadAndExtractSubtitleFromTorrent(
                eraiData.torrentUrl, eraiWorkDir, true, true, formattedTitle,
                { recovery: isRecoveryMessage(msg) },
              );

              if (extracted && extracted.filePath) {
                const effectiveTitle = extracted.resolvedTitle || formattedTitle;
                const cleanFileName = getSafeTelegramFileName(effectiveTitle, extracted.ext);
                const finalPath = path.join(OUT_DIR, cleanFileName);
                safeMoveFile(extracted.filePath, finalPath);

                const caption = formatCleanCaption(effectiveTitle, false, true);
                // BUG B — phase-2 gate: re-check on the post-resolver title.
                const gate = gateReleaseBeforePublish(posted, msgKey, phase1, {
                  effectiveTitle, resolved: eraiResolved, isOfficial: true,
                });
                if (!gate.proceed) {
                  countSkipped(msgKey);
                  try { fs.rmSync(finalPath, { force: true }); } catch { }
                  continue;
                }
                console.log(`   📤 Publishing official sub: "${logSafe(caption)}" (filename: ${logSafe(cleanFileName)})`);
                const sendResult = await publishDocument(client, finalPath, caption);

                if (sendResult?.ok) {
                  console.log(`   ✅ Successfully posted! (Message ID: ${sendResult.result?.message_id})`);
                  countPublished(msgKey);
                  markReleaseAsPosted(posted, msgKey, gate.mergedKeys);
                } else {
                  countFailed(msgKey);
                  console.error(`   ❌ Failed to send document:`, sendResult);
                }

                fs.rmSync(finalPath, { force: true });
              }
            } catch (e) {
              countFailed(msgKey);
              console.error(`   ❌ Erai-Raws processing error:`, e.message);
            } finally {
              try { fs.rmSync(eraiWorkDir, { recursive: true, force: true }); } catch { }
            }

            // Safety net: every message must end up in exactly one terminal
            // counter, otherwise the stall rule could not see it.
            if (!classified(msgKey)) countSkipped(msgKey);
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
                const phase1 = computeReleaseKeySet(cleanTitle, { isOfficial: isOfficialSubdl, resolved: cleanTitleResolved });
                const linkedMsgKey = linkedMsgId ? `tg_${chat.id}_${linkedMsgId}` : null;

                if (isReleaseAlreadyPostedOrDispatched(posted, phase1.keys, { season: phase1.season })) {
                  countSkipped(msgKey); // dedup hit
                  markReleaseAsKnown(posted, msgKey, phase1.keys, { season: phase1.season });
                  if (linkedMsgKey) markReleaseAsKnown(posted, linkedMsgKey, phase1.keys, { season: phase1.season });
                  continue;
                }

                console.log(`\n✨ [Subdl Direct File] "${logSafe(cleanTitle)}" (${logSafe(originalName)})`);
                const localFilePath = path.join(OUT_DIR, `doc_${msg.id}_${safeRemoteBaseName(originalName)}`);
                if (!isInsideDir(localFilePath, OUT_DIR)) {
                  countSkipped(msgKey); // unsafe path
                  console.warn(`   ⚠️ Skipping "${logSafe(cleanTitle)}": unsafe document file name "${logSafe(originalName)}".`);
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
                          countSkipped(msgKey); // no subtitle in the archive
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
                          } else {
                            // A refused extraction must NEVER publish the raw archive.
                            console.warn(`   ⚠️ Extraction refused — not publishing the raw archive.`);
                            countFailed(msgKey);
                            try { fs.rmSync(localFilePath, { force: true }); } catch { }
                            continue;
                          }
                        } else {
                          // For batch releases or releases with fonts, repack as clean universal .zip
                          const extractDir = path.join(OUT_DIR, `unpack_batch_${msg.id}`);
                          if (extractArchive(localFilePath, extractDir)) {
                            const allExt = [];
                            const allExtracted = [];
                            function scanSubdlA(dir) {
                              for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                                const full = path.join(dir, f.name);
                                if (f.isDirectory()) scanSubdlA(full);
                                else {
                                  // F1.3: EVERY extracted file is kept — the video names
                                  // carry the episode numbers of the package.
                                  allExtracted.push(full);
                                  if (/\.(ass|srt)$/i.test(f.name)) allExt.push(full);
                                }
                              }
                            }
                            scanSubdlA(extractDir);
                            if (allExt.length === 1) {
                              // F1.3: the whole package contributes its episode
                              // numbers (the videos) — but the NAME still comes
                              // from the .ass chain (m6): the pre-patch name
                              // candidates are kept, the episode detection runs
                              // over `allExtracted`.
                              cleanTitle = resolveEnglishTitleIfArabic(
                                cleanTitle,
                                [path.basename(allExt[0]), originalName],
                                [allExt[0]],
                                { episodeNames: allExtracted }
                              );
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
                          } else {
                            // A refused extraction must NEVER publish the raw archive.
                            console.warn(`   ⚠️ Extraction refused — not publishing the raw archive.`);
                            countFailed(msgKey);
                            try { fs.rmSync(localFilePath, { force: true }); } catch { }
                            continue;
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
                      const gate = gateReleaseBeforePublish(posted, msgKey, phase1, {
                        effectiveTitle: cleanTitle, resolved: cleanTitleResolved,
                        isOfficial: isOfficialSubdl, linkedMsgKey,
                      });
                      if (!gate.proceed) {
                        countSkipped(msgKey);
                        try { fs.rmSync(finalPath, { force: true }); } catch { }
                        continue;
                      }
                      console.log(`   📤 Publishing Subdl direct file: "${logSafe(caption)}" (filename: ${logSafe(cleanFileName)})`);
                      const sendResult = await publishDocument(client, finalPath, caption);

                      if (sendResult?.ok) {
                        console.log(`   ✅ Successfully posted! (Message ID: ${sendResult.result?.message_id})`);
                        countPublished(msgKey);
                        markReleaseAsPosted(posted, msgKey, gate.mergedKeys);
                        if (linkedMsgKey) markReleaseAsPosted(posted, linkedMsgKey, gate.mergedKeys);
                      } else {
                        countFailed(msgKey);
                        console.error(`   ❌ Failed to send document:`, sendResult);
                      }

                      fs.rmSync(finalPath, { force: true });
                      continue;
                    }
                    fs.rmSync(localFilePath, { force: true });
                  }
                } catch (e) {
                  countFailed(msgKey);
                  console.warn(`   ⚠️ Subdl direct file error:`, e.message);
                  // F-01: a CASE A failure must NOT fall through into CASE B
                  // for the same message — the release is not re-attempted as
                  // a link release in the same cycle (the message is already
                  // classified as failed).
                  continue;
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
            const phase1 = computeReleaseKeySet(rawTitle, { isOfficial: isOfficialSubdl, resolved: rawTitleResolved });

            if (isReleaseAlreadyPostedOrDispatched(posted, phase1.keys, { season: phase1.season })) {
              countSkipped(msgKey); // dedup hit
              markReleaseAsKnown(posted, msgKey, phase1.keys, { season: phase1.season });
              continue;
            }

            // Check if there is an attached document message specifically covering this release
            const coveringDoc = hasCoveringDocumentMsg(msg, msgs);
            if (coveringDoc) {
              // The attached document covers this release and will be handled directly
              countSkipped(msgKey);
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
                    countSkipped(msgKey); // no download link
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
                    countSkipped(msgKey); // no subtitle in the release
                    continue;
                  }

                  // Resolve English title from the extracted files and the ASS headers if rawTitle is Arabic.
                  // F1.1: the WHOLE package takes part in the episode detection — a Blu-ray
                  // batch holds one .mkv per episode and usually only ONE loose .ass, so
                  // the subtitle files alone would describe a single episode ("001") for a
                  // 001-004 set.
                  // m6: the NAME candidates are the pre-patch ones (the subtitle files
                  // only — a stray video must never hijack the release name), the
                  // episode detection runs over `allExtractedFiles`.
                  rawTitle = resolveEnglishTitleIfArabic(rawTitle, subFiles, subFiles, { episodeNames: allExtractedFiles });

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
                  const gate = gateReleaseBeforePublish(posted, msgKey, phase1, {
                    effectiveTitle: rawTitle, resolved: rawTitleResolved, isOfficial: isOfficialSubdl,
                  });
                  if (!gate.proceed) {
                    countSkipped(msgKey);
                    try { fs.rmSync(finalFilePath, { force: true }); } catch { }
                    continue;
                  }
                  console.log(`   📤 Publishing to channel: "${logSafe(caption)}" (filename: ${logSafe(path.basename(finalFilePath))})`);
                  const sendResult = await publishDocument(client, finalFilePath, caption);

                  if (sendResult?.ok) {
                    console.log(`   ✅ Successfully posted! (Message ID: ${sendResult.result?.message_id})`);
                    countPublished(msgKey);
                    markReleaseAsPosted(posted, msgKey, gate.mergedKeys);
                  } else {
                    countFailed(msgKey);
                    console.error(`   ❌ Failed to send document:`, sendResult);
                  }

                  try { fs.rmSync(finalFilePath, { force: true }); } catch {}
                  continue;
                } catch (e) {
                  countFailed(msgKey);
                  console.error(`   ❌ Error downloading/posting SUBDL release:`, e.message);
                } finally {
                  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
                }
              }
            }

            // Safety net: a CASE A -> CASE B fall-through must still leave the
            // message in exactly one terminal counter.
            if (!classified(msgKey)) countSkipped(msgKey);
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
                const phase1 = computeReleaseKeySet(titleLine, { isOfficial: false, resolved: titleLineResolved });

                if (isReleaseAlreadyPostedOrDispatched(posted, phase1.keys, { season: phase1.season })) {
                  countSkipped(msgKey); // dedup hit
                  markReleaseAsKnown(posted, msgKey, phase1.keys, { season: phase1.season });
                  continue;
                }

                console.log(`\n✨ [LazySano Direct File] "${logSafe(titleLine)}" (${logSafe(originalName)})`);
                const localFilePath = path.join(OUT_DIR, safeRemoteBaseName(originalName, `sub_${msg.id}`));
                if (!isInsideDir(localFilePath, OUT_DIR)) {
                  countSkipped(msgKey); // unsafe path
                  console.warn(`   ⚠️ Skipping LazySano direct file: unsafe document file name "${logSafe(originalName)}".`);
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
                      const gate = gateReleaseBeforePublish(posted, msgKey, phase1, {
                        effectiveTitle: titleLine, resolved: titleLineResolved, isOfficial: false,
                      });
                      if (!gate.proceed) {
                        countSkipped(msgKey);
                        try { fs.rmSync(finalPath, { force: true }); } catch { }
                        continue;
                      }
                      console.log(`   📤 Publishing LazySano release: "${logSafe(caption)}"`);
                      const sendResult = await publishDocument(client, finalPath, caption);

                      if (sendResult?.ok) {
                        console.log(`   ✅ Successfully posted!`);
                        countPublished(msgKey);
                        markReleaseAsPosted(posted, msgKey, gate.mergedKeys);
                      } else {
                        // No failure branch existed here: the release was
                        // silently lost. It is NOT marked as posted, so it is
                        // retried on the next cycle.
                        countFailed(msgKey);
                        console.error(`   ❌ Failed to send document:`, sendResult);
                      }
                      fs.rmSync(finalPath, { force: true });
                      continue;
                    }
                    fs.rmSync(localFilePath, { force: true });
                  }
                } catch (e) {
                  countFailed(msgKey);
                  console.warn(`   ⚠️ LazySano direct file download error:`, e.message);
                  // F-01: the same rule as the Subdl CASE A — a failed direct
                  // file is NOT re-attempted as a post link in the same cycle.
                  continue;
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
              const phase1 = computeReleaseKeySet(titleLine, { isOfficial: false, resolved: titleLineResolved });
              if (isReleaseAlreadyPostedOrDispatched(posted, phase1.keys, { season: phase1.season })) {
                countSkipped(msgKey); // dedup hit
                markReleaseAsKnown(posted, msgKey, phase1.keys, { season: phase1.season });
                continue;
              }

              const urlMatches = text.match(/https?:\/\/[^\s"'<>]+/gi) || [];
              const postPageUrl = urlMatches.find(u => !u.includes('t.me') && !u.includes('twitter'));
              if (postPageUrl) {
                // m7: a collection title ("الدفعة الأولى", "[01~05]") asks for
                // the WHOLE batch — the DDL directory then holds one archive
                // per episode and the whole-batch archive must be preferred.
                const pageData = await scrapeWithRecoveryGuard(msg, () => scrapePostPage(postPageUrl, null, extractEpisodeNumber(titleLine) || null, titleLine, { batch: isCollectionTitle(titleLine) }));
                // P1-1b: a negative-cached candidate was already fetched and
                // found to have NO link — the request was not made again. It
                // is logged distinctly and left unclassified by the cycle
                // counters on purpose: the message can still be published from
                // another candidate, and the per-message safety net counts it
                // as skipped. (The pending ledger still records it — see below.)
                const negativeCached = Boolean(pageData?.negativeCached);
                // C8/F7: EVERY confirmed no-links outcome is recorded in the
                // ledger — negative-cached OR freshly scraped — with the same
                // bounds: max 3 attempts/msg, 200 pending keys (oldest pruned),
                // 7d TTL skips on read only.
                noteNoLinksOutcome(pageData, posted, msgKey, postPageUrl, countNoLinks,
                  (level, text) => console[level](text));
                if (!pageData) console.warn(`   ⚠️ No page data extracted from ${postPageUrl}`);
                if (pageData && !negativeCached) {
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
                    // M6/C11: a Mega source that already refused a cap is in
                    // cooldown (6 h) — it is not retried on every cycle.
                    if (isCloudCapCooldownActive('mega', pageData.videoLinks.mega)) {
                      console.warn(`   ⏳ Mega skipped: a cap refusal is in cooldown for ${redactUrl(pageData.videoLinks.mega)}`);
                    } else {
                      const megaBest = await findBestFileInMegaFolder(pageData.videoLinks.mega);
                      // F2d: a multi-episode Mega folder of subtitles is ONE
                      // package (the selection is packed by the shared helper).
                      if (megaBest && (megaBest.node || megaBest.type === 'subtitles') && megaBest.type !== 'mkv') {
                        let tempDest = null;
                        try {
                          tempDest = await downloadCloudSubtitleSelection(megaBest, OUT_DIR, postPageUrl);
                          if (tempDest) {
                            const validated = validateFileMagic(tempDest);
                            if (validated) {
                              const cleanFileName = getSafeTelegramFileName(titleLine, validated.ext);
                              const finalPath = path.join(OUT_DIR, cleanFileName);
                              safeMoveFile(tempDest, finalPath);

                              const caption = formatCleanCaption(titleLine, validated.isArchive, false);
                              const gate = gateReleaseBeforePublish(posted, msgKey, phase1, {
                                effectiveTitle: titleLine, resolved: titleLineResolved, isOfficial: false,
                              });
                              if (!gate.proceed) {
                                countSkipped(msgKey);
                                try { fs.rmSync(finalPath, { force: true }); } catch { }
                                continue;
                              }
                              console.log(`   📤 Publishing LazySano post link: "${logSafe(caption)}"`);
                              const sendResult = await publishDocument(client, finalPath, caption);
                              if (sendResult?.ok) {
                                countPublished(msgKey);
                                markReleaseAsPosted(posted, msgKey, gate.mergedKeys);
                              } else {
                                // No failure branch existed here (F-10).
                                countFailed(msgKey);
                                console.error(`   ❌ Failed to send document:`, sendResult);
                              }
                              fs.rmSync(finalPath, { force: true });
                              continue;
                            }
                            fs.rmSync(tempDest, { force: true });
                          }
                        } catch (e) {
                          // M7/C13: the failure is NOT swallowed silently any
                          // more and the partial file is removed.
                          console.warn('   ⚠️ LazySano cloud download failed: ' + logSafe(e && e.message));
                          if (tempDest) { try { fs.rmSync(tempDest, { force: true }); } catch { } }
                        }
                      }
                    }
                  }
                  if (directUrl) {
                    let tempDest = null;
                    try {
                      tempDest = path.join(OUT_DIR, nextTempTag('lazy'));
                      const dlOptions = pageData?.source === 'mugi-worker' ? { expectedHost: new URL(directUrl).hostname } : {};
                      // X4: a direct (non-subtitle) payload is bounded by the
                      // 4 GiB ceiling.
                      dlOptions.maxBytes = CLOUD_CAP_LIMITS.CLOUD_FILE_MAX_BYTES;
                      await downloadFileToDisk(directUrl, tempDest, {}, dlOptions);
                      const validated = validateFileMagic(tempDest);
                      if (validated) {
                        const cleanFileName = getSafeTelegramFileName(titleLine, validated.ext);
                        const finalPath = path.join(OUT_DIR, cleanFileName);
                        safeMoveFile(tempDest, finalPath);

                        const caption = formatCleanCaption(titleLine, validated.isArchive, false);
                        const gate = gateReleaseBeforePublish(posted, msgKey, phase1, {
                          effectiveTitle: titleLine, resolved: titleLineResolved, isOfficial: false,
                        });
                        if (!gate.proceed) {
                          countSkipped(msgKey);
                          try { fs.rmSync(finalPath, { force: true }); } catch { }
                          continue;
                        }
                        console.log(`   📤 Publishing LazySano post link: "${logSafe(caption)}"`);
                        const sendResult = await publishDocument(client, finalPath, caption);
                        if (sendResult?.ok) {
                          countPublished(msgKey);
                          markReleaseAsPosted(posted, msgKey, gate.mergedKeys);
                        } else {
                          // No failure branch existed here (F-10).
                          countFailed(msgKey);
                          console.error(`   ❌ Failed to send document:`, sendResult);
                        }
                        fs.rmSync(finalPath, { force: true });
                        continue;
                      }
                      fs.rmSync(tempDest, { force: true });
                    } catch (e) {
                      // M7/C13: the failure is NOT swallowed silently any more
                      // and the partial file is removed.
                      console.warn('   ⚠️ LazySano cloud download failed: ' + logSafe(e && e.message));
                      if (tempDest) { try { fs.rmSync(tempDest, { force: true }); } catch { } }
                    }
                  }
                }
              }
            }

            // Safety net: every message must end up in exactly one terminal counter.
            if (!classified(msgKey)) countSkipped(msgKey);
            continue;
          }

          // ==============================================================
          // SOURCE 4: Arabic Anime Publisher (Fansub Releases)
          // ==============================================================
          const hasAttachment = Boolean(msg.media && msg.media.document);
          const hasLinks = /https?:\/\/[^\s"'<>]+/i.test(text);
          if (!hasAttachment && !hasLinks) {
            countSkipped(msgKey); // no attachment and no link
            markReleaseAsPosted(posted, msgKey);
            continue;
          }

          let titleLine = extractTeamAndFormatTitle(text);
          const titleLineResolved = await resolveCanonicalTitle(titleLine);
          const phase1 = computeReleaseKeySet(titleLine, { isOfficial: false, resolved: titleLineResolved });

          if (isReleaseAlreadyPostedOrDispatched(posted, phase1.keys, { season: phase1.season })) {
            countSkipped(msgKey); // dedup hit
            markReleaseAsKnown(posted, msgKey, phase1.keys, { season: phase1.season });
            continue;
          }

          // Case A: Direct file attached to the message
          if (msg.media && msg.media.document) {
            const doc = msg.media.document;
            const originalName = doc.attributes?.find(a => a.fileName)?.fileName || `sub_${msg.id}.ass`;
            const ext = path.extname(originalName).toLowerCase();

            if (['.ass', '.srt', '.zip', '.rar', '.7z'].includes(ext)) {
              console.log(`\n✨ [Fansub Attachment] "${logSafe(titleLine)}" (${logSafe(originalName)})`);
              const localFilePath = path.join(OUT_DIR, safeRemoteBaseName(originalName, `sub_${msg.id}.ass`));
              if (!isInsideDir(localFilePath, OUT_DIR)) {
                countSkipped(msgKey); // unsafe path
                console.warn(`   ⚠️ Skipping fansub attachment: unsafe document file name "${logSafe(originalName)}".`);
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
                    const gate = gateReleaseBeforePublish(posted, msgKey, phase1, {
                      effectiveTitle: titleLine, resolved: titleLineResolved, isOfficial: false,
                    });
                    if (!gate.proceed) {
                      countSkipped(msgKey);
                      try { fs.rmSync(finalPath, { force: true }); } catch { }
                      continue;
                    }
                    console.log(`   📤 Publishing to channel: "${logSafe(caption)}"`);
                    const sendResult = await publishDocument(client, finalPath, caption);

                    if (sendResult?.ok) {
                      console.log(`   ✅ Successfully posted!`);
                      countPublished(msgKey);
                      markReleaseAsPosted(posted, msgKey, gate.mergedKeys);
                    } else {
                      // No failure branch existed here (F-10).
                      countFailed(msgKey);
                      console.error(`   ❌ Failed to send document:`, sendResult);
                    }
                    fs.rmSync(finalPath, { force: true });
                    continue;
                  }
                  // F-02: the download produced something that is not a usable
                  // subtitle file. Without this the message was attempted but
                  // NEVER classified — the cycle could stay green with zero
                  // publications. It is a failure: nothing publishable came
                  // out of the download.
                  countFailed(msgKey);
                  console.error(`   ❌ Fansub attachment is not a usable subtitle file: "${logSafe(originalName)}"`);
                  fs.rmSync(localFilePath, { force: true });
                  continue;
                }
                // F-02: the download produced NO file at all (missing or
                // empty) — the message must still end in exactly one
                // terminal classification.
                countFailed(msgKey);
                console.error(`   ❌ Fansub attachment download produced no usable file: "${logSafe(originalName)}"`);
              } catch (e) {
                countFailed(msgKey);
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
            console.log(`\n✨ [Fansub Post] "${logSafe(titleLine)}"`);
            console.log(`   🌐 Scraping fansub post: ${postPageUrl}`);
            const targetEp = extractEpisodeNumber(titleLine);
            const pageData = await scrapeWithRecoveryGuard(msg, () => scrapePostPage(postPageUrl, matchingSite, targetEp, titleLine));

            // P1-1b: a negative-cached candidate was already fetched and found
            // to have NO link — the request was not made again. It is logged
            // distinctly and left unclassified by the cycle counters on
            // purpose: this message can still be published from another
            // candidate URL, and the per-message safety net counts it as
            // skipped. (The pending ledger still records it — see below.)
            const negativeCached = Boolean(pageData?.negativeCached);
            // C8/F7: EVERY confirmed no-links outcome is recorded in the
            // ledger — negative-cached OR freshly scraped — with the same
            // bounds: max 3 attempts/msg, 200 pending keys (oldest pruned),
            // 7d TTL skips on read only.
            noteNoLinksOutcome(pageData, posted, msgKey, postPageUrl, countNoLinks,
              (level, text) => console[level](text));
            if (!pageData) console.warn(`   ⚠️ No page data extracted from ${postPageUrl}`);

            if (pageData && !negativeCached) {
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
                  // X7: the same batch option as the LazySano caller — a
                  // collection title asks for the whole batch. (The no-redirect
                  // mode for recovery messages is injected by the local wrapper.)
                  const resolved = await resolveSubtitleFromDirectory(directUrl, targetEp, { batch: isCollectionTitle(titleLine) });
                  if (resolved) directUrl = resolved;
                }

                // Skip folder URLs from direct single-file HTTP download
                if (directUrl && !isDriveFolderUrl(directUrl) && !directUrl.includes('mega.nz')) {
                  try {
                    console.log(`   📥 Direct download: ${redactUrl(directUrl)}`);
                    const tempDest = path.join(fansubWorkDir, `direct_${Date.now()}`);
                    const dlOptions = pageData?.source === 'mugi-worker' ? { expectedHost: new URL(directUrl).hostname } : {};
                    // X4: a direct (non-subtitle) payload is bounded by the
                    // 4 GiB ceiling.
                    dlOptions.maxBytes = CLOUD_CAP_LIMITS.CLOUD_FILE_MAX_BYTES;
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

                // 2-4. Cloud sources (Mediafire / Mega / Google Drive).
                //      F2c: a SUBTITLE-bearing source is tried BEFORE a video
                //      source — the subtitles are ~100x lighter and a folder of
                //      them can be published whole as ONE package, while a
                //      folder of videos can only be published one episode at a
                //      time (the production log picked the Mega MKV folder and
                //      published episode 001 only).
                //      F2d: a multi-subtitle selection is packed into ONE release.
                //      M1: the listing of every source is carried by the source
                //      (the folder is NOT listed a second time) — and the cloud
                //      resolution is skipped entirely when the file is already
                //      downloaded.
                const cloudSources = downloadedFilePath ? [] : await buildPostCloudSources(pageData.videoLinks);
                // M4: only an EXPLICIT episode range narrows a cloud folder — a
                // title with a single episode number never narrows a
                // multi-episode folder (m9).
                const titleEps = extractExplicitEpisodeRange(titleLine || '');
                const CLOUD_LABEL = { mediafire: 'Mediafire', mega: 'Mega', drive: 'Google Drive' };
                for (const source of cloudSources) {
                  if (downloadedFilePath) break;
                  const sourceLabel = CLOUD_LABEL[source.kind] || source.kind;
                  // M6: a source that already refused a cap is in cooldown
                  // (6 h) — it is not retried on every cycle.
                  if (isCloudCapCooldownActive(source.kind, source.url)) {
                    console.warn(`   ⏳ ${sourceLabel} skipped: a cap refusal is in cooldown for ${redactUrl(source.url)}`);
                    continue;
                  }
                  // The listing of the source (M1) — it is passed to the
                  // downloader so the folder is listed ONCE per post.
                  const listing = (Array.isArray(source.listing) && source.listing.length > 0) ? source.listing : null;
                  console.log(`   📥 Resolving ${sourceLabel}: ${redactUrl(source.url)}`);
                  try {
                    if (source.kind === 'mediafire') {
                      const mfBest = await findBestFileInMediafire(source.url, targetEp, titleEps, listing, isCollectionTitle(titleLine));
                      if (mfBest && (mfBest.directUrl || mfBest.type === 'subtitles')) {
                        if (mfBest.type === 'subtitle' || mfBest.type === 'subtitles' || toolsAvailable) {
                          const mfLabel = mfBest.name || `${mfBest.files.length} subtitle(s)`;
                          console.log(`   📥 Downloading from Mediafire (${mfBest.type}): ${logSafe(mfLabel)}`);
                          downloadedFilePath = await downloadCloudSubtitleSelection(mfBest, fansubWorkDir, postPageUrl);
                        } else {
                          // DEFERRED — the media tools are missing, so the release
                          // is postponed (never a failure) and is NOT marked as
                          // posted, so it is retried once the tools exist.
                          countDeferred(msgKey);
                          console.warn(`   ⏸️ DEFERRED (tools missing): "${logSafe(titleLine)}" – NOT marked as posted`);
                        }
                      }
                    } else if (source.kind === 'mega') {
                      const megaRelease = await downloadMegaFolderRelease(source.url, fansubWorkDir, targetEp, { rawTitle: titleLine, listedFiles: listing, batch: isCollectionTitle(titleLine) });
                      if (megaRelease && megaRelease.filePath && fs.existsSync(megaRelease.filePath)) {
                        downloadedFilePath = megaRelease.filePath;
                      }
                    } else if (source.kind === 'drive') {
                      if (isDriveFolderUrl(source.url)) {
                        const driveRelease = await downloadDriveFolderRelease(
                          source.url,
                          fansubWorkDir,
                          targetEp,
                          pageData.videoLinks?.fonts,
                          titleLine,
                          { listedFiles: listing, batch: isCollectionTitle(titleLine) }
                        );
                        if (driveRelease && driveRelease.filePath && fs.existsSync(driveRelease.filePath)) {
                          downloadedFilePath = driveRelease.filePath;
                        }
                      }

                      if (!downloadedFilePath) {
                        const driveBest = await findBestFileInDrive(source.url, targetEp, titleEps, listing, isCollectionTitle(titleLine));
                        if (driveBest && (driveBest.directUrl || driveBest.type === 'subtitles')) {
                          if (driveBest.type === 'subtitle' || driveBest.type === 'subtitles' || toolsAvailable) {
                            const driveLabel = driveBest.name || `${driveBest.files.length} subtitle(s)`;
                            console.log(`   📥 Downloading from Drive (${driveBest.type}): ${logSafe(driveLabel)}`);
                            downloadedFilePath = await downloadCloudSubtitleSelection(driveBest, fansubWorkDir, postPageUrl);
                          } else {
                            // DEFERRED — tools missing; NOT marked as posted.
                            countDeferred(msgKey);
                            console.warn(`   ⏸️ DEFERRED (tools missing): "${logSafe(titleLine)}" – NOT marked as posted`);
                          }
                        }
                      }
                    }
                  } catch (e) {
                    // M6: a cap refusal is a REFUSAL, not a soft failure: the
                    // source goes into a 6 h cooldown (the key carries the
                    // REDACTED url — a Mega key never ends up in a log), EXCEPT
                    // for a SERIES_FOLDER_BATCH refusal — there the loop simply
                    // continues to the next source. No state key is written,
                    // so the message ends `skipped` via the safety net below.
                    handleCloudCapRefusal(e, { kind: source.kind, url: source.url, label: sourceLabel });
                  }
                }

                // 3. Mega (Direct file or Folder via pure JS megajs) and
                // 4. Google Drive (Direct file or Folder release with fonts)
                //    are part of the cloud loop above (F2c): the SUBTITLE
                //    bearing source is always tried before a video source.

                // 5. Buzzheavier (Direct video file via HX-Redirect or token on GitHub Actions)
                if (!downloadedFilePath && pageData.videoLinks?.buzzheavier) {
                  if (!toolsAvailable) {
                    // DEFERRED — tools missing; NOT marked as posted.
                    countDeferred(msgKey);
                    console.warn(`   ⏸️ DEFERRED (tools missing): "${logSafe(titleLine)}" – NOT marked as posted`);
                  } else {
                    console.log(`   📥 Resolving Buzzheavier: ${redactUrl(pageData.videoLinks.buzzheavier)}`);
                    try {
                      const directBuzz = await resolveBuzzheavierDownloadUrl(pageData.videoLinks.buzzheavier);
                      if (directBuzz) {
                        console.log(`   📥 Downloading from Buzzheavier: ${redactUrl(directBuzz)}`);
                        const tempDest = path.join(fansubWorkDir, `buzz_${Date.now()}.mkv`);
                        const cmd = process.platform === 'win32' ? 'curl.exe' : 'curl';
                        try {
                          execFileSync(cmd, [
                            '-s', '-L',
                            '--max-time', '600',
                            // S1: the download is bounded (4 GiB) and a
                            // redirect may not downgrade to http.
                            '--max-filesize', String(CLOUD_CAP_LIMITS.CLOUD_FILE_MAX_BYTES),
                            '--proto-redir', '=https',
                            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
                            '-H', `Referer: ${pageData.videoLinks.buzzheavier}`,
                            '-o', tempDest,
                            directBuzz
                          ], { timeout: 650_000 });
                        } catch (cErr) {
                          // S1: the fallback download is bounded too (and it
                          // may not end up on another host).
                          await downloadFileToDisk(directBuzz, tempDest, { Referer: pageData.videoLinks.buzzheavier }, {
                            maxBytes: CLOUD_CAP_LIMITS.CLOUD_FILE_MAX_BYTES,
                            expectedHost: new URL(directBuzz).hostname,
                          });
                        }
                        // S1: the size is verified AFTER the download (curl
                        // only refuses a KNOWN content-length): an oversize
                        // file is removed and refused.
                        const size = fs.existsSync(tempDest) ? fs.statSync(tempDest).size : 0;
                        if (size > CLOUD_CAP_LIMITS.CLOUD_FILE_MAX_BYTES) {
                          try { fs.rmSync(tempDest, { force: true }); } catch { }
                          throw cloudCapError('FILE_TOO_LARGE', `Buzzheavier download refused: ${size} bytes > ${CLOUD_CAP_LIMITS.CLOUD_FILE_MAX_BYTES} bytes`);
                        }
                        if (size > 1024) {
                          downloadedFilePath = tempDest;
                        }
                      }
                    } catch (e) {
                      console.warn(`   ⚠️ Buzzheavier download failed:`, logSafe(e && e.message));
                    }
                  }
                }

                // 6. Torrent (Prioritized for speed & reliability in GitHub Actions)
                if (!downloadedFilePath && pageData.videoLinks?.torrent) {
                  if (!toolsAvailable) {
                    // DEFERRED — tools missing; NOT marked as posted.
                    countDeferred(msgKey);
                    console.warn(`   ⏸️ DEFERRED (tools missing): "${logSafe(titleLine)}" – NOT marked as posted`);
                  } else {
                    console.log(`   📥 Fansub torrent found: ${redactUrl(pageData.videoLinks.torrent)}`);
                    const extractedTorrent = await downloadAndExtractSubtitleFromTorrent(
                      pageData.videoLinks.torrent, fansubWorkDir, false, false, titleLine,
                      // F9: use the in-scope loop `msg`, not recoveryState.msg —
                      // nested scrape guards can restore/clear the shared state
                      // during this iteration, so the two can diverge.
                      { recovery: isRecoveryMessage(msg) },
                    );
                    if (extractedTorrent && extractedTorrent.filePath) {
                      if (extractedTorrent.resolvedTitle) {
                        titleLine = extractedTorrent.resolvedTitle;
                      }
                      const cleanFileName = getSafeTelegramFileName(titleLine, extractedTorrent.ext);
                      const finalPath = path.join(OUT_DIR, cleanFileName);
                      safeMoveFile(extractedTorrent.filePath, finalPath);

                      const caption = formatCleanCaption(titleLine, extractedTorrent.isArchive, false);
                      const gate = gateReleaseBeforePublish(posted, msgKey, phase1, {
                        effectiveTitle: titleLine, resolved: titleLineResolved, isOfficial: false,
                      });
                      if (!gate.proceed) {
                        countSkipped(msgKey);
                        try { fs.rmSync(finalPath, { force: true }); } catch { }
                        continue;
                      }
                      console.log(`   📤 Publishing to channel: "${logSafe(caption)}"`);
                      const sendResult = await publishDocument(client, finalPath, caption);

                      if (sendResult?.ok) {
                        console.log(`   ✅ Successfully posted!`);
                        countPublished(msgKey);
                        markReleaseAsPosted(posted, msgKey, gate.mergedKeys);
                        fs.rmSync(finalPath, { force: true });
                        break;
                      } else {
                        // No failure branch existed here (F-10): the release
                        // is NOT marked as posted, so it is retried.
                        countFailed(msgKey);
                        console.error(`   ❌ Failed to send document:`, sendResult);
                      }
                      fs.rmSync(finalPath, { force: true });
                    }
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
                    const gate = gateReleaseBeforePublish(posted, msgKey, phase1, {
                      effectiveTitle: titleLine, resolved: titleLineResolved, isOfficial: false,
                    });
                    if (!gate.proceed) {
                      countSkipped(msgKey);
                      try { fs.rmSync(finalPath, { force: true }); } catch { }
                      continue;
                    }
                    console.log(`   📤 Publishing to channel: "${logSafe(caption)}"`);
                    const sendResult = await publishDocument(client, finalPath, caption);

                    if (sendResult?.ok) {
                      console.log(`   ✅ Successfully posted!`);
                      countPublished(msgKey);
                      markReleaseAsPosted(posted, msgKey, gate.mergedKeys);
                      fs.rmSync(finalPath, { force: true });
                      break;
                    } else {
                      // No failure branch existed here (F-10): the release is
                      // NOT marked as posted, so it is retried.
                      countFailed(msgKey);
                      console.error(`   ❌ Failed to send document:`, sendResult);
                    }

                    fs.rmSync(finalPath, { force: true });
                  }
                }
              } catch (e) {
                countFailed(msgKey);
                console.error(`   ❌ Fansub post processing error:`, e.message);
              } finally {
                try { fs.rmSync(fansubWorkDir, { recursive: true, force: true }); } catch { }
              }
            }
          }
          // Safety net (F-02): every attempted message must end up in exactly
          // one terminal counter, otherwise the stall rule could not see it.
          if (!classified(msgKey)) countSkipped(msgKey);
        }
      } catch (chatErr) {
        // The source could not be read — counted separately from candidate
        // failures; it must never be able to render the cycle green (F-08).
        summary.sourceErrors++;
        console.warn(`   ⚠️ Error reading channel "${chat.title}":`, chatErr.message);
      }
    }
  } catch (err) {
    // A listener-level error is an immediate fatal: the window is aborted.
    if (err && err.isFatal === true) throw err;
    throw createFatalError('LISTENER_ERROR', `Telegram channel listener error: ${err.message}`, summary);
  } finally {
    if (ownClient) {
      try { await client.disconnect(); } catch { }
    }
  }

  finalizePostedState(posted, summary);
  // P1-1c: one line per cycle with the sources that had no links.
  const noLinksLine = formatNoLinksBySource(noLinksBySource);
  if (noLinksLine) console.log(noLinksLine);
  console.log(`\n🏁 Telegram check finished. Processed ${summary.published} new release(s).\n`);
  return summary;
}
