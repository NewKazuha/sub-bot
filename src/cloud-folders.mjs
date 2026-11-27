import { File } from 'megajs';
import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import AdmZip from 'adm-zip';
import { safeRemoteBaseName, isInsideDir } from './path-safety.mjs';
import { fetchSafe, isStaticSafeUrl } from './url-safety.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const HTTP_TIMEOUT_MS = 60_000;
const DRIVE_DOWNLOAD_TIMEOUT_MS = 180_000;
const MEGA_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

// ====================================================================
// Cloud resource caps (M6)
// --------------------------------------------------------------------
// A remote folder is attacker-controlled input: without a cap a single
// hostile folder can exhaust the disk, the RAM or the cycle time on EVERY
// cycle. The caps below are the refusal point — they throw a CloudCapError
// BEFORE anything is downloaded, and the refusal is counted (the counters
// are NOT part of the P0 per-message cycle summary: a refusal is a
// per-source event, the message itself is classified later as `skipped`).
// ====================================================================

export const CLOUD_CAP_LIMITS = {
  MAX_FILES: 20,                            // files per cloud batch
  SUB_MAX_FILE_BYTES: 64 * 1024 * 1024,      // 64 MiB per subtitle file
  // X4: the ceiling of a NON-subtitle payload (a video, an archive): the
  // Telegram MTProto limit. A subtitle keeps the 64 MiB cap above.
  CLOUD_FILE_MAX_BYTES: 4 * 1024 * 1024 * 1024, // 4 GiB
  BATCH_MAX_TOTAL_BYTES: 512 * 1024 * 1024,  // 512 MiB per batch
  LISTING_MAX_ENTRIES: 2000,                 // entries per remote listing
  CONCURRENCY: 3,                            // parallel downloads per batch
  CAP_COOLDOWN_MS: 6 * 60 * 60 * 1000,       // 6 h refusal cooldown
  MAX_COOLDOWN_ENTRIES: 500,                   // M1: the cooldown map is bounded
  MAX_NAME_DEDUP: 100,                       // " (n)" suffix attempts
  RANGE_MAX_SPAN: 100,                       // episode range span
  // S2: the ceiling of the UNCOMPRESSED size of an archive that may be
  // extracted (a zip bomb is refused before anything is written).
  CLOUD_EXTRACT_MAX_BYTES: 4 * 1024 * 1024 * 1024, // 4 GiB
};

// The listing caps (C12): how many entries a remote listing may hold and how
// large the listing RESPONSE may be before it is refused (Drive / Mediafire
// return HTML / JSON that is read into the RAM).
export const CLOUD_LISTING_MAX_ENTRIES = CLOUD_CAP_LIMITS.LISTING_MAX_ENTRIES;
export const CLOUD_LISTING_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB

export class CloudCapError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'CloudCapError';
    this.code = code;
  }
}

export function isCloudCapError(err) {
  return Boolean(err) && (err instanceof CloudCapError || err.name === 'CloudCapError');
}

// The refusal counters — one increment per refusal (never per attempt).
const cloudCapStats = { refusals: 0, byCode: Object.create(null) };

export function __getCloudCapStats() {
  return { refusals: cloudCapStats.refusals, byCode: { ...cloudCapStats.byCode } };
}

export function __resetCloudCapStats() {
  cloudCapStats.refusals = 0;
  cloudCapStats.byCode = Object.create(null);
}

// Every cap refusal goes through here: it counts ONCE and returns the error.
export function cloudCapError(code, message) {
  cloudCapStats.refusals += 1;
  cloudCapStats.byCode[code] = (cloudCapStats.byCode[code] || 0) + 1;
  return new CloudCapError(code, message);
}

// The 6 h cooldown: a source that already refused a cap is not retried on
// every cycle (the key carries the kind and the REDACTED url — a Mega key
// must never end up in a map key that could be logged).
const cloudCapCooldowns = new Map();

export function cloudCapCooldownKey(kind, url) {
  return `${kind}|${redactUrl(url)}`;
}

// M1: the expired entries are pruned — the map never holds a dead entry.
function pruneCloudCapCooldowns(now) {
  for (const [key, until] of cloudCapCooldowns) {
    if (now >= until) cloudCapCooldowns.delete(key);
  }
}

export function isCloudCapCooldownActive(kind, url, now = Date.now()) {
  const key = cloudCapCooldownKey(kind, url);
  const until = cloudCapCooldowns.get(key);
  if (!until) return false;
  if (now >= until) {
    cloudCapCooldowns.delete(key);
    return false;
  }
  return true;
}

export function markCloudCapCooldown(kind, url, now = Date.now()) {
  // M1: the map is BOUNDED — the expired entries are pruned on every insert
  // and the oldest entry is dropped when the cap is reached (a hostile feed
  // with thousands of distinct urls must not grow the map forever).
  pruneCloudCapCooldowns(now);
  const key = cloudCapCooldownKey(kind, url);
  cloudCapCooldowns.delete(key);
  cloudCapCooldowns.set(key, now + CLOUD_CAP_LIMITS.CAP_COOLDOWN_MS);
  while (cloudCapCooldowns.size > CLOUD_CAP_LIMITS.MAX_COOLDOWN_ENTRIES) {
    const oldest = cloudCapCooldowns.keys().next().value;
    if (oldest === undefined) break;
    cloudCapCooldowns.delete(oldest);
  }
}

export function __getCloudCapCooldowns() {
  return [...cloudCapCooldowns.entries()];
}

export function __resetCloudCapCooldowns() {
  cloudCapCooldowns.clear();
}

/**
 * The batch cap: how many files, how large per file and how large in total.
 * Throws CloudCapError BEFORE the first byte is downloaded.
 */
export function assertCloudBatchCaps(files, extraFiles = []) {
  const mainFiles = Array.isArray(files) ? files : [];
  const auxFiles = Array.isArray(extraFiles) ? extraFiles : [];
  const all = [...mainFiles, ...auxFiles];

  if (all.length > CLOUD_CAP_LIMITS.MAX_FILES) {
    const err = cloudCapError(
      'TOO_MANY_FILES',
      `cloud batch refused: ${all.length} files > ${CLOUD_CAP_LIMITS.MAX_FILES}`
    );
    if (mainFiles.length <= CLOUD_CAP_LIMITS.MAX_FILES && auxFiles.length > 0) {
      err.fontOverflow = true;
    }
    throw err;
  }

  let total = 0;
  for (const f of all) {
    const size = Number(f && f.size);
    if (!Number.isFinite(size) || size <= 0) continue;
    // The per-file cap applies to the SUBTITLE files of the batch (an
    // archive that travels with them is bounded by the total cap below).
    const isSubtitle = /\.(ass|srt)$/i.test(String((f && f.name) || ''));
    if (isSubtitle && size > CLOUD_CAP_LIMITS.SUB_MAX_FILE_BYTES) {
      throw cloudCapError(
        'FILE_TOO_LARGE',
        `cloud file refused: ${Math.round(size / 1024 / 1024)} MiB > ${Math.round(CLOUD_CAP_LIMITS.SUB_MAX_FILE_BYTES / 1024 / 1024)} MiB`
      );
    }
    total += size;
  }

  if (total > CLOUD_CAP_LIMITS.BATCH_MAX_TOTAL_BYTES) {
    throw cloudCapError(
      'BATCH_TOO_LARGE',
      `cloud batch refused: ${Math.round(total / 1024 / 1024)} MiB > ${Math.round(CLOUD_CAP_LIMITS.BATCH_MAX_TOTAL_BYTES / 1024 / 1024)} MiB`
    );
  }

  return true;
}

// A unique local name for a remote file: on a collision " (n)" is inserted
// BEFORE the extension (a.ass -> a (2).ass) so two remote files never
// overwrite each other in the unpack directory. The counter starts at 2 (the
// first duplicate becomes " (2)"), like the usual file managers.
export function uniqueFileName(name, usedSet) {
  const base = safeRemoteBaseName(name, 'file');
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  const used = usedSet instanceof Set ? usedSet : null;
  const key = c => String(c).toLowerCase();

  let candidate = base;
  let n = 2;
  while (used && used.has(key(candidate)) && n <= CLOUD_CAP_LIMITS.MAX_NAME_DEDUP) {
    candidate = `${stem} (${n})${ext}`;
    n += 1;
  }
  if (used) used.add(key(candidate));
  return candidate;
}

// The temp-name generator (m2): `Date.now()` alone collides when two
// temporary names are created inside the same millisecond.
let tmpSeq = 0;
export function nextTempTag(prefix) {
  tmpSeq += 1;
  return `${prefix}_${Date.now()}_${tmpSeq}`;
}

// Log safety (m4): a scraped name/URL must never forge a log line.
export function logSafe(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// URL redaction (m4/C8): a Mega url carries its decryption key in the
// FRAGMENT and other providers carry a token in the query string.
export function redactUrl(url) {
  const raw = String(url ?? '');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return logSafe(raw.split('#')[0]);
  }
  parsed.hash = '';
  parsed.username = '';
  parsed.password = '';
  const signedDownload = /\/download\.aspx$/i.test(parsed.pathname);
  for (const key of [...parsed.searchParams.keys()]) {
    if (/key|token|sig|auth|password|expiry|expires|mac/i.test(key) || (signedDownload && /^file$/i.test(key))) {
      parsed.searchParams.delete(key);
    }
  }
  return parsed.toString();
}

// Extract a pCloud publink code ONLY when the hostname is a genuine pCloud domain.
export function extractPcloudPublinkCode(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase();
  const isPcloudDomain = host === 'pcloud.link' || host.endsWith('.pcloud.link')
    || host === 'pcloud.com' || host.endsWith('.pcloud.com');
  if (!isPcloudDomain) return null;
  const code = parsed.searchParams.get('code') || '';
  return /^[a-zA-Z0-9]+$/.test(code) ? code : null;
}

export function isPcloudPublinkUrl(url) {
  return Boolean(extractPcloudPublinkCode(url));
}

// The provider of a url, decided by its HOSTNAME (m5) — never by a
// substring of the whole url (a hostile link can carry "mega.nz" anywhere).
export function cloudKindOfUrl(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const isHost = (domain) => host === domain || host.endsWith(`.${domain}`);
  if (isHost('mega.nz') || isHost('mega.co.nz')) return 'mega';
  if (isHost('mediafire.com')) return 'mediafire';
  if (isHost('drive.google.com')) return isDriveFolderUrl(url) ? 'drive' : null;
  if (isPcloudPublinkUrl(url)) return 'pcloud';
  return null;
}

// X3 — the hostname of a url (null when it is malformed).
export function cloudHostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// X3 — is this url hosted by the given provider? The HOSTNAME decides: a
// url that merely mentions "mediafire.com" in its query is NOT a mediafire
// url (it would be fetched server-side otherwise).
export function isProviderHostUrl(url, kind) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  const domains = {
    mediafire: ['mediafire.com'],
    mega: ['mega.nz', 'mega.co.nz'],
    drive: ['drive.google.com', 'docs.google.com'],
    pcloud: ['pcloud.link', 'pcloud.com'],
  }[kind] || [];
  return domains.some(d => host === d || host.endsWith(`.${d}`));
}

// A bounded parallel map (M6): at most `limit` workers run at the same time.
export async function mapWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const max = Math.max(1, Number(limit) || 1);
  let cursor = 0;
  const runner = async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      await worker(list[index], index);
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(max, list.length); i++) workers.push(runner());
  await Promise.all(workers);
  return list.length;
}

// Close a write stream and remove the (partial) file it wrote — the close
// is awaited so the handle is released before the removal (Windows).
async function destroyStreamAndRemove(stream, filePath) {
  try {
    if (stream && !stream.closed) {
      await new Promise(resolve => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        stream.once('close', finish);
        stream.destroy();
        const guard = setTimeout(finish, 2000);
        if (typeof guard.unref === 'function') guard.unref();
      });
    }
  } catch { }
  try { if (filePath) fs.rmSync(filePath, { force: true }); } catch { }
}

// X1 — a stream failure must REJECT the download.
//
// A write stream that is full suspends the loop at the 'drain' wait; an
// 'error' (or the timeout) that arrives there would otherwise never settle
// the promise (a hang) and, with no 'error' listener, would crash the
// process with an unhandled 'error' event.
//
// `failure` is a promise that rejects on the first stream error; it is
// RACE against the drain wait, and its own rejection is marked as handled
// (a late error must never become an unhandled rejection).
function streamFailureGuard(stream) {
  let rejectFailure = null;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  failure.catch(() => { });
  const onError = (err) => {
    try { rejectFailure(err && err.message ? err : new Error(String(err))); } catch { }
  };
  // A stream without an event emitter (a test double) simply never fails.
  if (stream && typeof stream.on === 'function') {
    stream.on('error', onError);
  }
  return { failure, onError };
}

// Write a web/Node stream to a file with a byte cap: the cap is checked
// WHILE the bytes arrive and the partial file is removed on a breach.
async function writeStreamToFileWithCap(source, destPath, maxBytes) {
  const fileStream = fs.createWriteStream(destPath, { flags: 'w' });
  let received = 0;
  // X1: a write error rejects the download instead of hanging the drain wait.
  const { failure } = streamFailureGuard(fileStream);
  try {
    for await (const chunk of source) {
      received += chunk.length;
      if (maxBytes && received > maxBytes) {
        throw cloudCapError(
          'FILE_TOO_LARGE',
          `download refused: more than ${maxBytes} bytes`
        );
      }
      if (!fileStream.write(chunk)) {
        // The drain wait is RACED with the failure: an error that arrives
        // while the stream is full must not leave the download hanging.
        await Promise.race([
          new Promise(resolve => fileStream.once('drain', resolve)),
          failure
        ]);
      }
    }
    await new Promise((resolve, reject) => fileStream.end(err => (err ? reject(err) : resolve())));
    return received;
  } catch (e) {
    await destroyStreamAndRemove(fileStream, destPath);
    throw e;
  }
}

// A listing response is read into the RAM: its size is capped (C12).
// X8: the body is read THROUGH the cap (a chunked or lying Content-Length
// is refused while the body arrives, not after it was fully buffered).
export async function readResponseTextCapped(res, maxBytes = CLOUD_LISTING_MAX_BYTES) {
  const declared = Number(res && res.headers && typeof res.headers.get === 'function'
    ? res.headers.get('content-length')
    : NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw cloudCapError('LISTING_TOO_LARGE', `listing refused: ${declared} bytes > ${maxBytes} bytes`);
  }

  const body = res && res.body;
  if (!body || typeof body.getReader !== 'function') {
    // No readable body (a stubbed response): the text is read and checked.
    const text = await res.text();
    const size = Buffer.byteLength(String(text || ''), 'utf8');
    if (size > maxBytes) {
      throw cloudCapError('LISTING_TOO_LARGE', `listing refused: ${size} bytes > ${maxBytes} bytes`);
    }
    return text;
  }

  const reader = body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    received += chunk.length;
    if (received > maxBytes) {
      try { await reader.cancel(); } catch { }
      throw cloudCapError('LISTING_TOO_LARGE', `listing refused: more than ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function fetchWithTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  return fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(timeoutMs) });
}

// ====================================================================
// Episode matching utilities
// ====================================================================

export function extractEpisodesFromText(text) {
  if (!text) return [];
  const cleaned = text.replace(/\[\+fonts?\]|\.ass|\.srt|\.zip|\.rar|\.7z|\.mkv|\.mp4/gi, '');
  const eps = new Set();

  // Range matching: "07 & 08", "07-08", "07_08", "07 to 08"
  const rangeMatch = cleaned.match(/(\d{1,4})\s*(?:[-&~–]|to|and)\s*(\d{1,4})/i);
  if (rangeMatch) {
    // "S01 - 02" / "Season 1 - 02" / "Season2 - 05" is a season + an
    // episode, NOT a range — the "2 - 05" inside these names must not
    // expand to episodes 2..5. The single-number pass below still extracts
    // the episode ("05" → 5). Mirrors extractExplicitEpisodeRange.
    const head = cleaned.slice(0, rangeMatch.index) + rangeMatch[1];
    if (!/(?:S\d{1,2}|Season\s*\d{1,2}|Season)\s*$/i.test(head)) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (!isNaN(start) && !isNaN(end) && Math.abs(end - start) <= 50) {
        const min = Math.min(start, end);
        const max = Math.max(start, end);
        for (let i = min; i <= max; i++) eps.add(String(i));
      }
    }
  }

  // Single numbers: " - 08", "E08", "EP08", "Episode 8", " #8", " [08]"
  const singleMatches = cleaned.matchAll(/(?:-\s*|ep(?:isode)?\s*|e\s*|#\s*|\[|\s+)(\d{1,4})(?:\s*v\d+)?(?:\s*\]|\s*\[|\s*\(|\s*\.|\s*$|\s+)/gi);
  for (const m of singleMatches) {
    // A spelled-out season number ("Season 2 - 05") is a season, not an
    // episode: skip the "2" that the whitespace prefix would otherwise add.
    const head = cleaned.slice(0, m.index) + m[1];
    if (/(?:S\d{1,2}|Season\s*\d{1,2}|Season)\s*$/i.test(head)) continue;
    const num = m[1].replace(/^0+/, '') || '0';
    eps.add(num);
  }

  return Array.from(eps);
}

export function matchesEpisode(filename, targetEp) {
  if (!targetEp) return true;
  const targetNorm = targetEp.replace(/^0+/, '') || '0';
  const foundEps = extractEpisodesFromText(filename);
  return foundEps.includes(targetNorm);
}

// EPISODE_ABSENT — the requested episode is not in the folder yet (the
// source uploads it later). A typed, NON-cap error: the caller logs it and
// moves on without publishing, so the message is retried on a later cycle.
// Never substitute a DIFFERENT episode for the requested one.
export function episodeAbsentError() {
  const e = new Error('requested episode not present in folder (EPISODE_ABSENT)');
  e.code = 'EPISODE_ABSENT';
  return e;
}

// Archive choice for a single-episode request. A matching archive wins; if
// none matches but the names ARE episode-parsable, the episode is absent →
// EPISODE_ABSENT (defer). Non-parsable names keep the legacy last-archive
// fallback (a folder we cannot read episode numbers from is taken as-is).
export function chooseArchiveForEpisode(arcFiles, targetEpisode) {
  let chosen = arcFiles[arcFiles.length - 1];
  if (targetEpisode) {
    const match = arcFiles.find(f => matchesEpisode(f.name, targetEpisode));
    if (match) return match;
    if (arcFiles.some(f => extractEpisodesFromText(f.name).length > 0)) {
      throw episodeAbsentError();
    }
  }
  return chosen;
}

// Prefer softsub .mkv over .mp4/.m4v (which are frequently hardsubbed in fansub folders).
export function chooseVideoCandidate(videoFiles, targetEpisode) {
  const all = Array.isArray(videoFiles) ? videoFiles : [];
  if (all.length === 0) return null;
  const pureMkv = all.filter(f => /\.mkv$/i.test(f.name || ''));
  const preferredPool = pureMkv.length > 0 ? pureMkv : all;

  if (targetEpisode) {
    const mkvMatch = pureMkv.find(f => matchesEpisode(f.name, targetEpisode));
    if (mkvMatch) return mkvMatch;
    const anyMatch = all.find(f => matchesEpisode(f.name, targetEpisode));
    if (anyMatch) return anyMatch;
    if (all.some(f => extractEpisodesFromText(f.name).length > 0)) {
      throw episodeAbsentError();
    }
  }
  return preferredPool[preferredPool.length - 1];
}

// ====================================================================
// Folder target selection (F2a)
// ====================================================================

// How many DIFFERENT episodes does a list of cloud files offer?
export function countFolderEpisodes(files) {
  const eps = new Set();
  for (const f of files || []) {
    if (!f || !f.name) continue;
    for (const ep of extractEpisodesFromText(f.name)) eps.add(ep);
  }
  return eps.size;
}

// The one definition of "this file IS a subtitle file". The packer
// (packFolderToZip / packToZip) keeps the .ass/.srt files only, so an
// ARCHIVE can never be a member of a published batch — the two sides
// (listingOffersSubtitles and selectFolderSubtitleBatch) must agree (M3).
export const SUBTITLE_FILE_RE = /\.(ass|srt)$/i;

// The episode-range span cap (M4): a title may name at most this many
// episodes in one explicit range.
export const CLOUD_RANGE_MAX_SPAN = CLOUD_CAP_LIMITS.RANGE_MAX_SPAN;

// M4 — the EXPLICIT episode range of a title ("[01~03]", "Episodes 01-05").
//
// Only a real range is returned: two digit endpoints, start < end, a span of
// at most CLOUD_RANGE_MAX_SPAN, an endpoint that is not preceded by
// "S<digits>"/"Season" ("S01 - 02" is a season + an episode, not a range)
// and no endpoint that is a resolution ("1080p - 1081p"). Everything else
// returns [] — the caller then keeps its own behaviour.
//
// This is the ONLY narrowing rule of a cloud folder (m9): a title with a
// single episode number never narrows a multi-episode folder.
export function extractExplicitEpisodeRange(text) {
  if (!text) return [];
  const raw = String(text);
  const re = /(\d{1,4})\s*(?:[-~–]|\bto\b)\s*(\d{1,4})/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    // two endpoints, start < end
    if (!(start < end)) continue;
    // the span cap
    if (end - start > CLOUD_RANGE_MAX_SPAN) continue;
    // "S01 - 02" / "Season 1 - 02" / "Season2 - 05" is a season + an
    // episode, NOT a range (spelled-out season numbers included)
    const head = raw.slice(0, m.index) + m[1];
    if (/(?:S\d{1,2}|Season\s*\d{1,2}|Season)\s*$/i.test(head)) continue;
    // neither endpoint is a resolution ("1080p - 1081", "1080 - 1081p")
    if (/\dp/i.test(m[0])) continue;
    if (/^\s*p/i.test(raw.slice(m.index + m[0].length))) continue;
    const eps = [];
    for (let ep = start; ep <= end; ep++) eps.push(String(ep));
    return eps;
  }
  return [];
}

// The narrowing decision of a cloud folder, as ONE pure function.
//
// A folder that holds MORE THAN ONE episode is a BATCH by default: every
// episode of it belongs to the release, so the download must NOT be narrowed
// to the episode the post asks for. That narrowing is what silently dropped
// four episodes: the post said "الدفعة الأولى" ("the first BATCH"), the folder
// held 001-005, the title resolved to episode "01", and only "- 001" shipped.
//
// m9 (INVARIANT): a multi-episode folder is NEVER narrowed UNLESS the caller
// explicitly passes `batch: false` for a SINGLE-episode title. `batch`
// defaults to true so EVERY existing caller keeps the batch behaviour. The
// only other narrowing rule is an explicit episode range/list in the title
// ("01~05") — take exactly those episodes. A non-parsable filename never
// makes a release vanish: a failed narrow falls through to "take all".
export function selectFolderTargets(subFiles, { targetEpisode = null, extractedEps = [], batch = true } = {}) {
  const all = Array.isArray(subFiles) ? subFiles : [];
  if (all.length === 0) return [];

  // An explicit range/list of episodes in the title wins.
  if (Array.isArray(extractedEps) && extractedEps.length > 0) {
    const match = all.filter(f => extractedEps.some(ep => matchesEpisode(f.name, ep)));
    if (match.length > 0) return match;
    // Parseable names but none of the requested episodes: defer, never
    // substitute other episodes.
    if (all.some(f => extractEpisodesFromText(f.name).length > 0)) throw episodeAbsentError();
  }

  // A SINGLE-episode title (batch: false) narrows a multi-episode folder to
  // the requested episode. Zero matches fall through ONLY for non-parsable
  // names (such a folder is still downloaded whole); when the names ARE
  // parseable but the episode is absent, throw EPISODE_ABSENT so the caller
  // defers instead of publishing a different episode.
  if (batch !== true && targetEpisode) {
    const match = all.filter(f => matchesEpisode(f.name, targetEpisode));
    if (match.length > 0) return match;
    if (all.some(f => extractEpisodesFromText(f.name).length > 0)) throw episodeAbsentError();
  }

  // A multi-episode folder is a batch: take ALL of it (m9 — the requested
  // episode never narrows a batch unless batch: false was passed explicitly).
  if (countFolderEpisodes(all) > 1) return all;

  // A single-episode folder: the requested episode decides (as before).
  if (targetEpisode) {
    const match = all.filter(f => matchesEpisode(f.name, targetEpisode));
    if (match.length > 0) return match;
  }

  return all;
}

// F2d — the subtitle BATCH of a cloud folder: the subtitle files of a folder
// that holds MORE THAN ONE episode (they are published as ONE package).
// An empty result means "this folder is not a subtitle batch" — the caller
// then keeps its single-file behaviour (one episode, one file).
//
// M3: only a REAL subtitle file can be a batch member (the packer keeps the
// .ass/.srt files only) — the archives are filtered BEFORE the episode
// count, so an archive can be chosen as a SINGLE release but never as a
// batch member.
export function selectFolderSubtitleBatch(subFiles, { targetEpisode = null, extractedEps = [], batch = true } = {}) {
  const all = Array.isArray(subFiles) ? subFiles : [];
  if (all.length === 0) return [];
  const subs = all.filter(f => f && SUBTITLE_FILE_RE.test(f.name || ''));
  if (subs.length === 0) return [];
  if (countFolderEpisodes(subs) <= 1) return [];
  return selectFolderTargets(subs, { targetEpisode, extractedEps, batch });
}

// F2c — does this cloud folder listing offer SUBTITLE files?
export function listingOffersSubtitles(files) {
  return (files || []).some(f => f && !f.isFolder && SUBTITLE_FILE_RE.test(f.name || ''));
}

// F2c — the cloud sources of a post, ordered with the SUBTITLE-bearing ones
// FIRST. A post can offer the same batch twice: as a folder of .ass subtitles
// (light, publishable whole as ONE package) and as a folder of .mkv videos
// (heavy, publishable one episode at a time). The production log showed the
// video folder winning, and only episode 001 being published.
//
// `sources` = [{ kind, url, offersSubtitles }] — the input order is preserved
// between sources of the same kind (a stable sort).
export function orderCloudSources(sources) {
  return (sources || [])
    .filter(s => s && s.url)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const aSub = Boolean(a.s.offersSubtitles);
      const bSub = Boolean(b.s.offersSubtitles);
      if (aSub !== bSub) return aSub ? -1 : 1;
      return a.i - b.i;
    })
    .map(({ s }) => s);
}

// F2c — list a cloud folder (Drive / Mega / Mediafire) WITHOUT downloading
// anything: the listing decides which source of a post is preferred.
//
// A FAILED listing returns `null` (an empty folder returns `[]`): the caller
// must be able to tell "the folder is empty" from "the provider refused".
export async function listCloudFolderFiles(kind, folderUrl) {
  if (!folderUrl) return [];
  // X2: a source that already refused a listing cap is in cooldown (6 h) —
  // the folder is NOT fetched again.
  if (isCloudCapCooldownActive(kind, folderUrl)) return null;
  try {
    // M2: the Drive listing descends into the ONE subtitle subfolder.
    if (kind === 'drive') return await listDriveFolderWithSubtitles(folderUrl, { strict: true });
    if (kind === 'mega') return await listMegaFolderStrict(folderUrl);
    if (kind === 'mediafire') return await listMediafireFolderStrict(folderUrl);
    if (kind === 'pcloud') return await listPcloudFolderStrict(folderUrl);
  } catch (e) {
    // X2: a LISTING refusal (a cap) is not a soft failure: the source goes
    // into the 6 h cooldown so a hostile folder is not re-fetched every
    // cycle.
    if (isCloudCapError(e)) markCloudCapCooldown(kind, folderUrl);
    console.warn('   ⚠️ Cloud folder listing failed (' + kind + '): ' + logSafe(e && e.message));
    return null;
  }
  return [];
}

// ====================================================================
// Mega Folder & File Handler (Pure JS via megajs)
// ====================================================================

// The strict Mega lister: it THROWS on a failure so the caller can tell a
// failed listing from an empty folder.
async function listMegaFolderStrict(folderUrl) {
  if (/mega\.nz\/(file|#!)/i.test(folderUrl) && !/mega\.nz\/folder/i.test(folderUrl)) {
    const file = File.fromURL(folderUrl);
    await file.loadAttributes();
    return [{
      name: file.name || 'unknown',
      size: file.size || 0,
      node: file
    }];
  }

  const folder = File.fromURL(folderUrl);
  await folder.loadAttributes();

  const files = [];
  function walk(node) {
    // The listing cap (C12): a folder with 10 000 entries is refused.
    if (files.length >= CLOUD_LISTING_MAX_ENTRIES) return;
    if (node.children) {
      for (const child of node.children) {
        // M5: the cap also breaks the PARENT loop — the walk stops instead
        // of visiting every sibling of a full folder.
        if (files.length >= CLOUD_LISTING_MAX_ENTRIES) break;
        walk(child);
      }
    } else if (node.name) {
      files.push({
        name: node.name,
        size: node.size || 0,
        node
      });
    }
  }
  walk(folder);
  return files;
}

export async function listMegaFolder(folderUrl) {
  try {
    return await listMegaFolderStrict(folderUrl);
  } catch (e) {
    console.warn(`   ⚠️ Mega folder listing failed:`, logSafe(e && e.message));
    return [];
  }
}

export async function downloadMegaNode(megaNode, destPath, destDir, options = {}) {
  // Belt-and-braces: callers sanitize the remote-derived name before joining,
  // but the download sink itself refuses to write outside the destination
  // directory so a future caller cannot skip that check.
  if (!destDir || !isInsideDir(destPath, destDir)) {
    throw new Error('unsafe cloud file name: ' + destPath);
  }
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : null;
  const dlStream = megaNode.download();
  const fileStream = createWriteStream(destPath);
  let received = 0;

  // X1: an error of EITHER stream rejects the download. Without the
  // listeners an 'error' event would crash the process, and an error that
  // arrives while the write stream is full would leave the drain wait
  // hanging forever.
  const dlGuard = streamFailureGuard(dlStream);
  const fileGuard = streamFailureGuard(fileStream);

  const timeout = setTimeout(() => {
    const err = new Error(`Mega download timed out after ${MEGA_DOWNLOAD_TIMEOUT_MS / 60_000} minutes`);
    // The timeout REJECTS the download (it used to only destroy the
    // streams, which left the promise pending forever).
    try { dlGuard.onError(err); } catch { }
    try { fileGuard.onError(err); } catch { }
    try { dlStream.destroy(err); } catch { }
    try { fileStream.destroy(err); } catch { }
  }, MEGA_DOWNLOAD_TIMEOUT_MS);

  try {
    for await (const chunk of dlStream) {
      received += chunk.length;
      // The per-file cap is enforced WHILE the bytes arrive (C9): the
      // download is aborted and the partial file is removed.
      if (maxBytes && received > maxBytes) {
        throw cloudCapError('FILE_TOO_LARGE', `Mega download refused: more than ${maxBytes} bytes`);
      }
      if (!fileStream.write(chunk)) {
        // The drain wait is RACED with the failure (X1).
        await Promise.race([
          new Promise(resolve => fileStream.once('drain', resolve)),
          fileGuard.failure,
          dlGuard.failure
        ]);
      }
    }
    await new Promise((resolve, reject) => fileStream.end(err => (err ? reject(err) : resolve())));
    return destPath;
  } catch (e) {
    await destroyStreamAndRemove(fileStream, destPath);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// Helper to pack directory to zip with fonts organized in Fonts/
export function packToZip(srcDir, zipPath) {
  const zip = new AdmZip();
  function addRec(dir, subDir = '') {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      // Entry names ultimately derive from remote listings – sanitize again
      // on this walk so nothing can escape the source directory.
      const safeName = safeRemoteBaseName(item.name, 'entry');
      const full = path.join(dir, safeName);
      if (!isInsideDir(full, srcDir)) throw new Error('unsafe cloud file name: ' + item.name);
      if (item.isDirectory()) {
        addRec(full, subDir ? `${subDir}/${safeName}` : safeName);
      } else if (/\.(ass|srt)$/i.test(item.name)) {
        zip.addLocalFile(full, subDir);
      } else if (/\.(ttf|otf|woff2?|ttc)$/i.test(item.name)) {
        zip.addLocalFile(full, subDir || 'Fonts');
      }
    }
  }
  addRec(srcDir);
  zip.writeZip(zipPath);
  return zipPath;
}

// Shared cloud folder release downloader for Mega, Google Drive, and pCloud.
async function runCloudFolderRelease(config, folderUrl, destDir, targetEpisode = null, options = {}) {
  const {
    providerLabel,
    releaseLabel,
    tagPrefix,
    loadFiles,
    downloadItem,
  } = config;
  const {
    rawTitle = '',
    listedFiles = null,
    batch = true,
    skipFonts = false,
    fontsUrl = null,
  } = options || {};

  // The listing is injected by the caller (M1): the folder is listed ONCE
  // per post, not once for the ranking and once for the download.
  const files = (Array.isArray(listedFiles) && listedFiles.length > 0) ? listedFiles : await loadFiles(folderUrl);
  if (!files || files.length === 0) return null;
  fs.mkdirSync(destDir, { recursive: true });

  console.log(`   📂 ${providerLabel} folder: ${files.length} file(s) found`);
  const clean = files.filter(f => !/hardsub|hard[\s_-]*sub/i.test(f.name));

  const subFiles = clean.filter(f => /\.(ass|srt)$/i.test(f.name));
  const arcFiles = clean.filter(f => /\.(zip|7z|rar)$/i.test(f.name));
  const fontFiles = skipFonts ? [] : clean.filter(f => /\.(ttf|otf|woff2?|ttc)$/i.test(f.name));
  const mkvFiles = clean.filter(f => /\.(mkv|mp4|m4v)$/i.test(f.name)); // video containers the extractor supports

  // Separate Drive fonts folder URL if provided (used when subtitles omit fonts)
  if (!skipFonts && fontsUrl && isDriveFolderUrl(fontsUrl)) {
    console.log(`   📂 Fetching fonts from separate Drive folder: ${redactUrl(fontsUrl)}`);
    try {
      const fItems = await listDriveFolder(fontsUrl);
      const fontsFound = fItems.filter(f => /\.(ttf|otf|woff2?|ttc)$/i.test(f.name));
      if (fontsFound.length > 0) {
        fontFiles.push(...fontsFound);
      }
    } catch (e) {
      console.warn('   ⚠️ Drive fonts listing failed: ' + logSafe(e && e.message));
    }
  }

  // 1. Direct subtitle files (.ass/.srt)
  let episodeAbsent = false;
  try {
    if (subFiles.length > 0) {
      // M4/F2a: only an EXPLICIT episode range narrows a multi-episode folder;
      // single-episode titles narrow only when batch === false.
      const targetSubs = selectFolderTargets(subFiles, {
        targetEpisode,
        extractedEps: extractExplicitEpisodeRange(rawTitle || ''),
        batch,
      });
      console.log(`   🎯 [${releaseLabel}] ${targetSubs.length}/${subFiles.length} subtitle file(s) selected from the folder.`);

      const isBatch = targetSubs.length > 1;
      const hasFonts = fontFiles.length > 0;
      const fontCount = fontFiles.length;

      if (isBatch || hasFonts) {
        console.log(`   📦 [${releaseLabel}] Batch/Fonts detected (${targetSubs.length} sub(s), ${fontCount} font(s)). Downloading and packing to .zip...`);
        const narrowed = batch !== true && Boolean(targetEpisode) && targetSubs.length < subFiles.length;
        const seriesFolderCounts = `${targetSubs.length} sub(s) + ${fontCount} font(s) > ${CLOUD_CAP_LIMITS.MAX_FILES}`;
        if (narrowed && targetSubs.length + fontCount > CLOUD_CAP_LIMITS.MAX_FILES) {
          throw cloudCapError('SERIES_FOLDER_BATCH', seriesFolderCounts);
        }
        if (targetSubs.length === 1 && fontCount >= CLOUD_CAP_LIMITS.MAX_FILES) {
          throw cloudCapError('SERIES_FOLDER_BATCH', seriesFolderCounts);
        }
        assertCloudBatchCaps(targetSubs, fontFiles);

        const unpackDir = path.join(destDir, nextTempTag(`${tagPrefix}_unpack`));
        fs.mkdirSync(unpackDir, { recursive: true });
        const usedSubNames = new Set();
        const usedFontNames = new Set();

        try {
          const subTargets = targetSubs.map(sub => ({
            item: sub,
            name: sub.name,
            dest: path.join(unpackDir, uniqueFileName(safeRemoteBaseName(sub.name, nextTempTag(`${tagPrefix}_sub`)), usedSubNames)),
          }));
          for (const t of subTargets) {
            if (!isInsideDir(t.dest, unpackDir)) throw new Error('unsafe cloud file name: ' + t.name);
          }
          await mapWithConcurrency(subTargets, CLOUD_CAP_LIMITS.CONCURRENCY, async (t) => {
            console.log(`   📥 Downloading ${providerLabel} sub: ${logSafe(t.name)}`);
            await downloadItem(t.item, t.dest, unpackDir, { maxBytes: CLOUD_CAP_LIMITS.SUB_MAX_FILE_BYTES });
          });

          if (hasFonts) {
            const fontsDir = path.join(unpackDir, 'Fonts');
            fs.mkdirSync(fontsDir, { recursive: true });
            const fontTargets = fontFiles.map(font => ({
              item: font,
              name: font.name,
              dest: path.join(fontsDir, uniqueFileName(safeRemoteBaseName(font.name, nextTempTag(`${tagPrefix}_font`)), usedFontNames)),
            }));
            for (const t of fontTargets) {
              if (!isInsideDir(t.dest, fontsDir)) throw new Error('unsafe cloud file name: ' + t.name);
            }
            await mapWithConcurrency(fontTargets, CLOUD_CAP_LIMITS.CONCURRENCY, async (t) => {
              await downloadItem(t.item, t.dest, fontsDir, { maxBytes: CLOUD_CAP_LIMITS.SUB_MAX_FILE_BYTES });
            });
          }

          // Check actual byte total on disk after downloads (essential for providers without listing sizes)
          const totalBytes = unpackDirBytes(unpackDir);
          if (totalBytes > CLOUD_CAP_LIMITS.BATCH_MAX_TOTAL_BYTES) {
            throw cloudCapError(
              'BATCH_TOO_LARGE',
              `cloud batch refused: ${Math.round(totalBytes / 1024 / 1024)} MiB > ${Math.round(CLOUD_CAP_LIMITS.BATCH_MAX_TOTAL_BYTES / 1024 / 1024)} MiB`
            );
          }

          const repackedZip = path.join(destDir, `${nextTempTag(`${tagPrefix}_bundle`)}.zip`);
          try {
            packToZip(unpackDir, repackedZip);
          } catch (e) {
            try { fs.rmSync(repackedZip, { force: true }); } catch { }
            throw e;
          }

          return {
            filePath: repackedZip,
            isArchive: true,
            hasFonts,
            type: 'archive',
            subNames: targetSubs.map(s => s.name),
          };
        } finally {
          try { fs.rmSync(unpackDir, { recursive: true, force: true }); } catch { }
        }
      }

      // Single subtitle without fonts: download directly
      const singleSub = targetSubs[0];
      if (targetEpisode && extractEpisodesFromText(singleSub.name).length > 0 && !matchesEpisode(singleSub.name, targetEpisode)) {
        throw episodeAbsentError();
      }
      console.log(`   📥 Downloading single ${providerLabel} subtitle: ${logSafe(singleSub.name)}`);
      assertCloudBatchCaps([singleSub]);
      const destPath = path.join(destDir, uniqueFileName(safeRemoteBaseName(singleSub.name, nextTempTag(`${tagPrefix}_sub`))));
      if (!isInsideDir(destPath, destDir)) throw new Error('unsafe cloud file name: ' + singleSub.name);
      let ok = false;
      try {
        ok = await downloadItem(singleSub, destPath, destDir, { maxBytes: CLOUD_CAP_LIMITS.SUB_MAX_FILE_BYTES });
      } catch (e) {
        try { fs.rmSync(destPath, { force: true }); } catch { }
        throw e;
      }
      if (ok) {
        return {
          filePath: destPath,
          isArchive: false,
          hasFonts: false,
          type: 'subtitle',
          subNames: [singleSub.name],
        };
      }
    }

    // 2. Archive files (.zip/.rar/.7z)
    if (arcFiles.length > 0) {
      const chosen = chooseArchiveForEpisode(arcFiles, targetEpisode);
      console.log(`   📦 ${providerLabel}: found archive: ${logSafe(chosen.name)}`);
      const destPath = path.join(destDir, uniqueFileName(safeRemoteBaseName(chosen.name, nextTempTag(`${tagPrefix}_arc`))));
      if (!isInsideDir(destPath, destDir)) throw new Error('unsafe cloud file name: ' + chosen.name);
      const ok = await downloadItem(chosen, destPath, destDir, { maxBytes: CLOUD_CAP_LIMITS.CLOUD_FILE_MAX_BYTES });
      if (ok) {
        return {
          filePath: destPath,
          isArchive: true,
          hasFonts: null,
          type: 'archive',
          subNames: [chosen.name],
        };
      }
    }
  } catch (e) {
    if (e.code !== 'EPISODE_ABSENT') throw e;
    episodeAbsent = true;
  }

  // 3. Softsub MKV/video files (.mkv preferred over .mp4/.m4v)
  if (mkvFiles.length > 0) {
    const chosen = chooseVideoCandidate(mkvFiles, targetEpisode);
    if (chosen) {
      console.log(`   🎬 ${providerLabel}: found MKV: ${logSafe(chosen.name)}`);
      const destPath = path.join(destDir, uniqueFileName(safeRemoteBaseName(chosen.name, nextTempTag(`${tagPrefix}_mkv`))));
      if (!isInsideDir(destPath, destDir)) throw new Error('unsafe cloud file name: ' + chosen.name);
      const ok = await downloadItem(chosen, destPath, destDir, { maxBytes: CLOUD_CAP_LIMITS.CLOUD_FILE_MAX_BYTES });
      if (ok) {
        return {
          filePath: destPath,
          isArchive: false,
          hasFonts: false,
          type: 'mkv',
          subNames: [chosen.name],
        };
      }
    }
  }

  if (episodeAbsent) throw episodeAbsentError();
  return null;
}

export async function downloadMegaFolderRelease(folderUrl, destDir, targetEpisode = null, options = {}) {
  const { downloadNode = downloadMegaNode, ...rest } = options || {};
  return await runCloudFolderRelease(
    {
      providerLabel: 'Mega',
      releaseLabel: 'Mega Release',
      tagPrefix: 'mega',
      loadFiles: listMegaFolder,
      downloadItem: async (item, destPath, itemDir, dlOpts) => {
        await downloadNode(item.node, destPath, itemDir, dlOpts);
        return true;
      },
    },
    folderUrl,
    destDir,
    targetEpisode,
    rest
  );
}

export async function findBestFileInMegaFolder(folderUrl, targetEpisode = null, extractedEps = [], listedFiles = null, batch = true) {
  const files = listedFiles || await listMegaFolder(folderUrl);
  if (files.length === 0) return null;

  console.log(`   📂 Mega folder: ${files.length} file(s) found`);
  const clean = files.filter(f => !/hardsub|hard[\s_-]*sub/i.test(f.name));

  // 1. Direct subtitle files (.ass/.srt/.zip/.rar/.7z)
  const subFiles = clean.filter(f => /\.(ass|srt|zip|7z|rar)$/i.test(f.name));
  let episodeAbsent = false;
  try {
  if (subFiles.length > 0) {
    // M3: the batch holds the real subtitle files only (an ARCHIVE can be
    // chosen as a single release, never as a batch member — the packer drops
    // the archives).
    // F2d: a folder that holds MORE THAN ONE episode is a BATCH — return ALL
    // of its subtitle files so the caller publishes them as ONE package.
    // (The VIDEO branch below stays single-file — that case is still open.)
    const batchSel = selectFolderSubtitleBatch(subFiles, { targetEpisode, extractedEps, batch: batch === true });
    if (batchSel.length > 1) {
      console.log(`   📦 Mega: subtitle batch of ${batchSel.length} file(s) — one package.`);
      return {
        type: 'subtitles',
        files: batchSel.map(f => ({ node: f.node, name: f.name, size: f.size })),
        subNames: batchSel.map(f => f.name),
      };
    }
    if (targetEpisode) {
      const match = subFiles.find(f => matchesEpisode(f.name, targetEpisode));
      if (match) {
        console.log(`   ✅ Mega: subtitle matched EP ${targetEpisode}: ${logSafe(match.name)}`);
        return { node: match.node, name: match.name, type: 'subtitle', size: match.size };
      }
    }
    const latest = subFiles[subFiles.length - 1];
    // Never substitute a parseable DIFFERENT episode for the requested one.
    if (targetEpisode && extractEpisodesFromText(latest.name).length > 0 && !matchesEpisode(latest.name, targetEpisode)) {
      throw episodeAbsentError();
    }
    console.log(`   ✅ Mega: using latest subtitle: ${logSafe(latest.name)}`);
    return { node: latest.node, name: latest.name, type: 'subtitle', size: latest.size };
  }
  } catch (e) {
    if (e.code !== 'EPISODE_ABSENT') throw e;
    // Fall through to the softsub MKV branch (same contract as the download path).
    episodeAbsent = true;
  }

  // 2. Softsub MKV files
  const mkvFiles = clean.filter(f => /\.(mkv|mp4|m4v)$/i.test(f.name)); // video containers the extractor supports
  if (mkvFiles.length > 0) {
    const chosen = chooseVideoCandidate(mkvFiles, targetEpisode);
    if (chosen) {
      const detail = targetEpisode && matchesEpisode(chosen.name, targetEpisode)
        ? `MKV matched EP ${targetEpisode}: ${logSafe(chosen.name)} (${(chosen.size / 1024 / 1024).toFixed(0)} MB)`
        : `using latest MKV: ${logSafe(chosen.name)}`;
      console.log(`   🎬 Mega: ${detail}`);
      return { node: chosen.node, name: chosen.name, type: 'mkv', size: chosen.size };
    }
  }

  if (episodeAbsent) throw episodeAbsentError();
  return null;
}

// ====================================================================
// Mediafire Folder & File Handler (via Mediafire Public API & Cheerio)
// ====================================================================

export async function resolveMediafireDirectDownload(mfUrl) {
  // SSRF: `mfUrl` is scraped/user input. The HOSTNAME must be mediafire.com
  // (or a subdomain) BEFORE any request — a URL that merely mentions
  // mediafire.com in its query (e.g. http://169.254.169.254/?x=mediafire.com/file)
  // is NOT a mediafire URL and is refused with ZERO fetches.
  if (!isProviderHostUrl(mfUrl, 'mediafire')) return null;
  try {
    // fetchSafe keeps redirect:'manual' and re-validates EVERY hop with DNS,
    // so a public mediafire host cannot 302 us into a private/metadata address.
    // The initial URL uses the DNS-free static validator so a legitimate public
    // URL is still fetched even when DNS resolution is unavailable.
    const result = await fetchSafe(mfUrl, {
      sourceUrl: mfUrl,
      initialValidator: isStaticSafeUrl,
      headers: { 'User-Agent': UA },
    });
    const res = result?.response;
    if (!res?.ok) return null;
    const html = await res.text();
    const doc = cheerio.load(html);
    const dlBtn = doc('#downloadButton').attr('href') || doc('a[aria-label="Download file"]').attr('href');
    if (dlBtn && dlBtn.startsWith('http')) return dlBtn;
    return null;
  } catch {
    return null;
  }
}

// The strict Mediafire lister: it THROWS on a failure so the caller can
// tell a failed listing from an empty folder.
async function listMediafireFolderStrict(folderUrl) {
  const match = folderUrl.match(/folder\/([a-zA-Z0-9]+)/i);
  if (!match) return [];
  const folderKey = match[1];

  // SSRF audit: `apiUrl` is built from the FIXED first-party host
  // www.mediafire.com. `folderKey` is constrained to [a-zA-Z0-9]+ by the match
  // above, so it cannot inject a host, a path separator or a query separator —
  // no scraped hostname ever reaches this request. Documented safe; it stays
  // on fetchWithTimeout (the listing is a trusted first-party API call).
  const apiUrl = `https://www.mediafire.com/api/1.4/folder/get_content.php?folder_key=${folderKey}&content_type=files&response_format=json`;
  const res = await fetchWithTimeout(apiUrl, {
    headers: { 'User-Agent': UA }
  });
  // The listing response is read into the RAM: its size is capped (C12).
  const text = await readResponseTextCapped(res);
  const data = JSON.parse(text);
  const files = data?.response?.folder_content?.files || [];
  if (files.length > CLOUD_LISTING_MAX_ENTRIES) {
    throw cloudCapError('LISTING_TOO_LARGE', `listing refused: ${files.length} entries > ${CLOUD_LISTING_MAX_ENTRIES}`);
  }
  return files.map(f => ({
    name: f.filename,
    size: parseInt(f.size || 0, 10),
    quickkey: f.quickkey,
    directUrl: f.links?.normal_download || `https://www.mediafire.com/file/${f.quickkey}/${encodeURIComponent(f.filename)}/file`
  }));
}

export async function listMediafireFolder(folderUrl) {
  try {
    return await listMediafireFolderStrict(folderUrl);
  } catch (e) {
    console.warn(`   ⚠️ Mediafire folder listing failed:`, logSafe(e && e.message));
    return [];
  }
}

export async function findBestFileInMediafire(mfUrl, targetEpisode = null, extractedEps = [], listedFiles = null, batch = true) {
  // If single file URL
  if (!mfUrl.includes('/folder/')) {
    const direct = await resolveMediafireDirectDownload(mfUrl);
    if (direct) {
      const isMkv = /\.mkv$/i.test(mfUrl) || /\.mkv$/i.test(direct);
      return {
        name: path.basename(new URL(direct).pathname),
        directUrl: direct,
        type: isMkv ? 'mkv' : 'subtitle'
      };
    }
    return null;
  }

  // If folder URL
  const files = listedFiles || await listMediafireFolder(mfUrl);
  if (files.length === 0) return null;

  console.log(`   📂 Mediafire folder: ${files.length} file(s) found`);
  const clean = files.filter(f => !/hardsub|hard[\s_-]*sub/i.test(f.name));

  // 1. Direct subtitle files (.ass/.srt/.zip/.rar/.7z)
  const subFiles = clean.filter(f => /\.(ass|srt|zip|7z|rar)$/i.test(f.name));
  let episodeAbsent = false;
  try {
  if (subFiles.length > 0) {
    // M3: the batch holds the real subtitle files only (an ARCHIVE can be
    // chosen as a single release, never as a batch member — the packer drops
    // the archives).
    // F2d: a folder that holds MORE THAN ONE episode is a BATCH — return ALL
    // of its subtitle files so the caller publishes them as ONE package.
    // (The VIDEO branch below stays single-file — that case is still open.)
    const batchSel = selectFolderSubtitleBatch(subFiles, { targetEpisode, extractedEps, batch: batch === true });
    if (batchSel.length > 1) {
      console.log(`   📦 Mediafire: subtitle batch of ${batchSel.length} file(s) — one package.`);
      // The cap is checked BEFORE the per-file round-trips (M6).
      assertCloudBatchCaps(batchSel);
      const files = [];
      for (const f of batchSel) {
        const resolved = await resolveMediafireDirectDownload(f.directUrl);
        files.push({ name: f.name, size: f.size, directUrl: resolved || f.directUrl });
      }
      return {
        type: 'subtitles',
        files,
        subNames: batchSel.map(f => f.name),
      };
    }
    let chosen = subFiles[subFiles.length - 1];
    if (targetEpisode) {
      const match = subFiles.find(f => matchesEpisode(f.name, targetEpisode));
      if (match) chosen = match;
    }
    if (targetEpisode && extractEpisodesFromText(chosen.name).length > 0 && !matchesEpisode(chosen.name, targetEpisode)) {
      throw episodeAbsentError();
    }
    console.log(`   ✅ Mediafire: found subtitle ` + logSafe(chosen.name));
    // The per-file cap of a single file (C7b/C10).
    assertCloudBatchCaps([chosen]);
    const resolved = await resolveMediafireDirectDownload(chosen.directUrl);
    return {
      name: chosen.name,
      directUrl: resolved || chosen.directUrl,
      type: 'subtitle',
      size: chosen.size
    };
  }
  } catch (e) {
    if (e.code !== 'EPISODE_ABSENT') throw e;
    // The requested episode has no subtitle here — fall through to the
    // softsub MKV branch. Never substitute a different episode: if the MKV
    // branch also has no match, it re-throws EPISODE_ABSENT.
    episodeAbsent = true;
  }

  // 2. MKV files
  const mkvFiles = clean.filter(f => /\.(mkv|mp4|m4v)$/i.test(f.name)); // video containers the extractor supports
  if (mkvFiles.length > 0) {
    const chosen = chooseVideoCandidate(mkvFiles, targetEpisode);
    if (chosen) {
      console.log(`   🎬 Mediafire: found MKV ` + logSafe(chosen.name));
      const resolved = await resolveMediafireDirectDownload(chosen.directUrl);
      return {
        name: chosen.name,
        directUrl: resolved || chosen.directUrl,
        type: 'mkv',
        size: chosen.size
      };
    }
  }

  if (episodeAbsent) throw episodeAbsentError();
  return null;
}

// ====================================================================
// Google Drive Folder & File Handler
// ====================================================================

export function isDriveFolderUrl(url) {
  if (!url) return false;
  return /(?:drive|docs)\.google\.com\/(?:drive\/)?(?:folders\/|folderview\?id=)/i.test(url);
}

export function extractDriveFileId(url) {
  if (!url) return null;
  const match = url.match(/(?:file\/d\/|id=)([\w-]{20,})/);
  return match ? match[1] : null;
}

export function getDriveDirectUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;
}

export async function downloadGoogleDriveFileToDisk(fileId, destPath, fileName = '', options = {}) {
  const url = getDriveDirectUrl(fileId);
  const cookie = process.env.GOOGLE_DRIVE_COOKIE || '';
  const headers = {
    'User-Agent': UA,
    ...(cookie ? { 'Cookie': cookie } : {})
  };
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : null;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DRIVE_DOWNLOAD_TIMEOUT_MS;

  try {
    // SSRF audit: `url` is produced by getDriveDirectUrl(fileId), whose host is
    // the FIXED drive.google.com; `fileId` is interpolated only into the `id=`
    // query value, so it cannot rewrite the request host. Documented safe.
    let res = await fetchWithTimeout(url, { headers }, timeoutMs);
    if (!res.ok) {
      console.warn(`   ⚠️ Google Drive HTTP ${res.status} for file: ${logSafe(fileName || fileId)}`);
      return false;
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
      const html = await res.text();
      // Check if it's a large file confirmation form (virus-scan warning)
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
        // SSRF audit: the form `action` is HTML-derived (second-order input).
        // Only an official Google host may be fetched — a poisoned form must
        // never turn the confirmation into an internal HTTP client. fetchSafe
        // then keeps redirect:'manual' and DNS-validates every hop.
        const confirmedHost = cloudHostOf(confirmedUrl.toString());
        if (!confirmedHost || !(confirmedHost === 'drive.google.com' ||
              confirmedHost.endsWith('.google.com') || confirmedHost.endsWith('.googleusercontent.com'))) {
          console.warn(`   ⚠️ Google Drive confirmation refused: foreign host`);
          return false;
        }
        const confirmed = await fetchSafe(confirmedUrl.toString(), {
          sourceUrl: confirmedUrl.toString(),
          cookieHeader: cookie,
          initialValidator: isStaticSafeUrl,
          headers,
          timeoutMs,
        });
        res = confirmed?.response;
        if (!res) {
          console.warn(`   ⚠️ Google Drive confirmation refused: unsafe redirect`);
          return false;
        }
        const nextType = (res.headers.get('content-type') || '').toLowerCase();
        if (res.ok && !nextType.includes('text/html')) {
          // The file is STREAMED to the disk with a byte cap (C9): the old
          // arrayBuffer() read the whole file into the RAM.
          await writeStreamToFileWithCap(Readable.fromWeb(res.body), destPath, maxBytes);
          return true;
        }
      }

      if (html.includes('Quota exceeded')) {
        console.warn(`   ⚠️ Google Drive download quota exceeded for file: "${logSafe(fileName || fileId)}"`);
      } else {
        console.warn(`   ⚠️ Google Drive returned HTML instead of binary for file: "${logSafe(fileName || fileId)}"`);
      }
      return false;
    }

    await writeStreamToFileWithCap(Readable.fromWeb(res.body), destPath, maxBytes);
    return true;
  } catch (e) {
    // A cap refusal is a REFUSAL, not a soft failure: it is counted and it
    // propagates to the caller (which cleans the batch up).
    if (isCloudCapError(e)) throw e;
    console.warn(`   ⚠️ Google Drive download failed for file "${logSafe(fileName || fileId)}":`, logSafe(e && e.message));
    return false;
  }
}


// The strict Drive lister: it THROWS on a failure so the caller can tell a
// failed listing from an empty folder.
async function listDriveFolderStrict(folderUrl) {
  const idMatch = folderUrl.match(/(?:folders|folderview\?id=)\/?([\w-]{20,})/);
  if (!idMatch) return [];
  const folderId = idMatch[1];

  const listUrl = `https://drive.google.com/embeddedfolderview?id=${folderId}#list`;
  // SSRF audit: `folderId` is scraped/user input, so this request is hardened
  // rather than left on a raw redirect-following fetch. The fixed host is
  // asserted first and fetchSafe DNS-validates every redirect hop while the
  // initial (fixed-host) URL uses the DNS-free static validator.
  if (!isProviderHostUrl(listUrl, 'drive')) return [];
  const listed = await fetchSafe(listUrl, {
    sourceUrl: listUrl,
    initialValidator: isStaticSafeUrl,
    headers: { 'User-Agent': UA },
  });
  if (!listed) throw new Error('Google Drive listing fetch refused');
  const res = listed.response;

  if (!res.ok) return [];
  // The listing response is read into the RAM: its size is capped (C12).
  const html = await readResponseTextCapped(res);
  const $ = cheerio.load(html);
  const files = [];

  // Google Drive's embedded view used to expose data-id attributes.  It now
  // puts the item ID in `id="entry-<id>"` and the canonical item link in the
  // nested anchor, so support both page layouts.
  $('[data-id], .flip-entry').each((_, el) => {
    if (files.length >= CLOUD_LISTING_MAX_ENTRIES) return false;
    const entry = $(el);
    const href = entry.find('a[href]').first().attr('href') || '';
    const entryId = (entry.attr('id') || '').match(/^entry-([\w-]{20,})$/)?.[1];
    const hrefId = href.match(/(?:file\/d\/|folders\/)([\w-]{20,})/)?.[1];
    const id = entry.attr('data-id') || entryId || hrefId;
    const name = entry.find('.flip-entry-title').text().trim() ||
                 entry.attr('data-tooltip') ||
                 entry.text().trim();
    if (id && name && name.length > 1 && !files.some(f => f.id === id)) {
      files.push({
        name,
        id,
        isFolder: /\/folders\//i.test(href) || entry.hasClass('flip-entry-list-folder') || entry.find('.flip-entry-list-folder').length > 0
      });
    }
  });

  if (files.length === 0) {
    const dataRegex = /\["([\w-]{25,})","([^"]+)"/g;
    let m;
    while ((m = dataRegex.exec(html)) !== null) {
      if (files.length >= CLOUD_LISTING_MAX_ENTRIES) break;
      const id = m[1];
      const name = m[2];
      if (!files.some(f => f.id === id)) {
        files.push({ name, id, isFolder: false });
      }
    }
  }

  return files;
}

export async function listDriveFolder(folderUrl) {
  try {
    return await listDriveFolderStrict(folderUrl);
  } catch (e) {
    console.warn(`   ⚠️ Google Drive listing failed:`, logSafe(e && e.message));
    return [];
  }
}

// M2 (F2c) — the Drive folder that holds the subtitles: the ONE subfolder
// whose name says "subtitles"/"softsub"/"الترجمة".
export function findDriveSubtitleFolder(files) {
  return (files || []).find(f => f && f.isFolder &&
    /(?:soft\s*sub|subtitles?|ملفات\s*الترجمة|الترجمة)/i.test(f.name || '')) || null;
}

// M2 (F2c) — the Drive listing WITH the subtitle-subfolder descent.
//
// The top level of a release folder usually holds the VIDEO and a
// "Subtitles/" folder; the subtitle files live one level deeper. The descent
// is ONE level deep and costs at most TWO listings:
//   1. the top listing,
//   2. the ONE subtitle-ish subfolder — and ONLY when the top level holds no
//      subtitle file of its own.
//
// C5: an empty or failed subfolder listing falls back to the TOP listing —
// the caller never gets an empty list when the top had entries.
export async function listDriveFolderWithSubtitles(folderUrl, { strict = false } = {}) {
  const top = strict ? await listDriveFolderStrict(folderUrl) : await listDriveFolder(folderUrl);
  if (!top || top.length === 0) return top || [];

  // The top level already holds a subtitle file — no descent.
  if (top.some(f => f && !f.isFolder && SUBTITLE_FILE_RE.test(f.name || ''))) return top;

  const subFolder = findDriveSubtitleFolder(top);
  if (!subFolder) return top;

  try {
    const subFiles = await listDriveFolder(`https://drive.google.com/drive/folders/${subFolder.id}`);
    if (Array.isArray(subFiles) && subFiles.length > 0) return subFiles;
    console.warn(`   ⚠️ Google Drive subtitle folder "${logSafe(subFolder.name)}" is empty — using the top listing.`);
  } catch (e) {
    console.warn(`   ⚠️ Google Drive subtitle folder listing failed: ${logSafe(e && e.message)}`);
  }

  // C5: fall back to the TOP listing.
  return top;
}

export async function findBestFileInDrive(driveUrl, targetEpisode = null, extractedEps = [], listedFiles = null, batch = true) {
  // If single file
  if (!isDriveFolderUrl(driveUrl)) {
    const id = extractDriveFileId(driveUrl);
    if (id) {
      return {
        id,
        name: `drive_file_${id}`,
        directUrl: getDriveDirectUrl(id),
        type: 'unknown'
      };
    }
    return null;
  }

  // M2: the listing comes from the shared lister (the "Subtitles/" subfolder
  // descent is inside it) — the inline descent block is gone.
  const files = listedFiles || await listDriveFolderWithSubtitles(driveUrl);
  if (!files || files.length === 0) return null;

  const clean = files.filter(f => !f.isFolder && !/hardsub|hard[\s_-]*sub/i.test(f.name));

  // 1. Subtitles
  const subFiles = clean.filter(f => /\.(ass|srt|zip|7z|rar)$/i.test(f.name));
  let episodeAbsent = false;
  try {
  if (subFiles.length > 0) {
    // M3: the batch holds the real subtitle files only (an ARCHIVE can be
    // chosen as a single release, never as a batch member — the packer drops
    // the archives).
    // F2d: a folder that holds MORE THAN ONE episode is a BATCH — return ALL
    // of its subtitle files so the caller publishes them as ONE package.
    // (The VIDEO branch below stays single-file — that case is still open.)
    const batchSel = selectFolderSubtitleBatch(subFiles, { targetEpisode, extractedEps, batch: batch === true });
    if (batchSel.length > 1) {
      console.log(`   📦 Drive: subtitle batch of ${batchSel.length} file(s) — one package.`);
      return {
        type: 'subtitles',
        files: batchSel.map(f => ({ id: f.id, name: f.name, directUrl: getDriveDirectUrl(f.id), size: f.size })),
        subNames: batchSel.map(f => f.name),
      };
    }
    let chosen = subFiles[subFiles.length - 1];
    if (targetEpisode) {
      const match = subFiles.find(f => matchesEpisode(f.name, targetEpisode));
      if (match) chosen = match;
    }
    if (targetEpisode && extractEpisodesFromText(chosen.name).length > 0 && !matchesEpisode(chosen.name, targetEpisode)) {
      throw episodeAbsentError();
    }
    console.log(`   ✅ Drive: subtitle ${logSafe(chosen.name)}`);
    return {
      id: chosen.id,
      name: chosen.name,
      directUrl: getDriveDirectUrl(chosen.id),
      type: 'subtitle'
    };
  }
  } catch (e) {
    if (e.code !== 'EPISODE_ABSENT') throw e;
    // The requested episode has no subtitle here — fall through to the
    // softsub MKV branch. Never substitute a different episode: if the MKV
    // branch also has no match, it re-throws EPISODE_ABSENT.
    episodeAbsent = true;
  }

  // 2. MKV files
  const mkvFiles = clean.filter(f => /\.(mkv|mp4|m4v)$/i.test(f.name)); // video containers the extractor supports
  if (mkvFiles.length > 0) {
    const chosen = chooseVideoCandidate(mkvFiles, targetEpisode);
    if (chosen) {
      console.log(`   🎬 Drive: MKV ${logSafe(chosen.name)}`);
      return {
        id: chosen.id,
        name: chosen.name,
        directUrl: getDriveDirectUrl(chosen.id),
        type: 'mkv'
      };
    }
  }

  if (episodeAbsent) throw episodeAbsentError();
  return null;
}

// The total size of a DIRECTORY (the downloaded files). The Drive listing
// carries NO sizes, so the batch total can only be checked AFTER the files
// were written (C7c).
export function unpackDirBytes(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const item of entries) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      total += unpackDirBytes(full);
    } else {
      try { total += fs.statSync(full).size; } catch { }
    }
  }
  return total;
}

export async function downloadDriveFolderRelease(folderUrl, destDir, targetEpisode = null, fontsUrl = null, rawTitle = '', options = {}) {
  const { downloadFile = downloadGoogleDriveFileToDisk, ...rest } = options || {};
  return await runCloudFolderRelease(
    {
      providerLabel: 'Google Drive',
      releaseLabel: 'Drive Release',
      tagPrefix: 'drive',
      loadFiles: listDriveFolderWithSubtitles,
      downloadItem: async (item, destPath, _itemDir, dlOpts) => {
        return await downloadFile(item.id, destPath, item.name, dlOpts);
      },
    },
    folderUrl,
    destDir,
    targetEpisode,
    {
      ...rest,
      fontsUrl: fontsUrl ?? rest.fontsUrl ?? null,
      rawTitle: rawTitle || rest.rawTitle || '',
    }
  );
}

// Extract font family names declared in ASS/SSA subtitle Style lines
export function extractAssFontNames(assText) {
  if (!assText || typeof assText !== 'string') return [];
  const fontNames = new Set();
  for (const line of assText.split(/\r?\n/)) {
    if (/^Style:\s*/i.test(line)) {
      const parts = line.split(',');
      if (parts[1]) {
        const fn = parts[1].trim();
        if (fn) fontNames.add(fn);
      }
    }
  }
  return [...fontNames];
}

// Match font family names against available font file objects ({ name, node/id, ... })
export function findMatchingFontFiles(assFontNames, availableFontFiles) {
  if (!Array.isArray(assFontNames) || !Array.isArray(availableFontFiles)) return [];
  const matched = [];
  const used = new Set();
  for (const fontName of assFontNames) {
    const cleanFont = fontName.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (!cleanFont || cleanFont.length < 2) continue;
    for (const f of availableFontFiles) {
      if (!f || !f.name || used.has(f.name)) continue;
      const fBase = f.name.replace(/\.(ttf|otf|woff2?|ttc)$/i, '');
      const cleanFile = fBase.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      if (!cleanFile) continue;
      if (cleanFile.includes(cleanFont) || cleanFont.includes(cleanFile)) {
        matched.push(f);
        used.add(f.name);
      }
    }
  }
  return matched;
}

function decodeAssZipEntry(entry) {
  if (!entry || entry.isDirectory) return '';
  if (entry.header && Number.isFinite(entry.header.size) && entry.header.size > CLOUD_CAP_LIMITS.SUB_MAX_FILE_BYTES) {
    return '';
  }
  const buf = entry.getData();
  if (!Buffer.isBuffer(buf) || buf.length > CLOUD_CAP_LIMITS.SUB_MAX_FILE_BYTES) return '';
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return buf.subarray(2).toString('utf16le');
  }
  return buf.toString('utf8');
}

// Try to bundle matching fonts for a single ASS subtitle or a subtitle .zip bundle when available
export async function tryBundleMatchingFonts(subFilePath, fontFiles, destDir, downloadFontFn, options = {}) {
  const isAss = Boolean(subFilePath) && /\.(ass|ssa)$/i.test(subFilePath);
  const isZip = Boolean(subFilePath) && /\.zip$/i.test(subFilePath);
  if (!subFilePath || !fs.existsSync(subFilePath) || (!isAss && !isZip)) {
    return subFilePath;
  }
  if (!Array.isArray(fontFiles) || fontFiles.length === 0 || typeof downloadFontFn !== 'function') {
    return subFilePath;
  }
  try {
    const existingFontNames = new Set();
    let neededFonts = [];
    let existingZip = null;
    if (isAss) {
      neededFonts = extractAssFontNames(fs.readFileSync(subFilePath, 'utf8'));
    } else {
      existingZip = new AdmZip(subFilePath);
      const neededSet = new Set();
      for (const entry of existingZip.getEntries()) {
        if (!entry || entry.isDirectory) continue;
        const baseName = path.basename(entry.entryName || '');
        if (/\.(ttf|otf|woff2?|ttc)$/i.test(baseName)) {
          existingFontNames.add(baseName.toLowerCase());
          continue;
        }
        if (/\.(ass|ssa)$/i.test(baseName)) {
          for (const fn of extractAssFontNames(decodeAssZipEntry(entry))) {
            neededSet.add(fn);
          }
        }
      }
      neededFonts = [...neededSet];
    }
    if (neededFonts.length === 0) return subFilePath;

    const rawMatched = findMatchingFontFiles(neededFonts, fontFiles);
    const matched = isZip
      ? rawMatched.filter(f => f && f.name && !existingFontNames.has(path.basename(f.name).toLowerCase()))
      : rawMatched;
    if (matched.length === 0) return subFilePath;

    const maxFonts = isZip
      ? (Number.isFinite(options?.maxMatchedFonts) ? options.maxMatchedFonts : 40)
      : CLOUD_CAP_LIMITS.MAX_FILES - 1;
    if (matched.length > maxFonts) return subFilePath;

    const unpackDir = path.join(destDir, nextTempTag('bundle_unpack'));
    fs.mkdirSync(unpackDir, { recursive: true });
    const fontsDir = path.join(unpackDir, 'Fonts');
    fs.mkdirSync(fontsDir, { recursive: true });

    try {
      const usedNames = new Set(existingFontNames);
      const fontTargets = matched.map(f => ({
        font: f,
        name: f.name,
        dest: path.join(fontsDir, uniqueFileName(safeRemoteBaseName(f.name, nextTempTag('font')), usedNames)),
      }));

      for (const t of fontTargets) {
        if (!isInsideDir(t.dest, fontsDir)) throw new Error('unsafe cloud font name: ' + t.name);
      }

      await mapWithConcurrency(fontTargets, CLOUD_CAP_LIMITS.CONCURRENCY, async (t) => {
        await downloadFontFn(t.font, t.dest, fontsDir);
      });

      let totalBytes = fs.statSync(subFilePath).size;
      let anyFontDownloaded = false;
      for (const t of fontTargets) {
        if (fs.existsSync(t.dest)) {
          anyFontDownloaded = true;
          totalBytes += fs.statSync(t.dest).size;
        }
      }
      if (!anyFontDownloaded || totalBytes > CLOUD_CAP_LIMITS.BATCH_MAX_TOTAL_BYTES) {
        return subFilePath;
      }

      const repackedZip = path.join(destDir, `${nextTempTag('matched_bundle')}.zip`);
      try {
        if (isZip) {
          for (const t of fontTargets) {
            if (fs.existsSync(t.dest)) {
              existingZip.addLocalFile(t.dest, 'Fonts');
            }
          }
          existingZip.writeZip(repackedZip);
        } else {
          const subDest = path.join(unpackDir, path.basename(subFilePath));
          fs.copyFileSync(subFilePath, subDest);
          packToZip(unpackDir, repackedZip);
        }
      } catch (zipErr) {
        try { fs.rmSync(repackedZip, { force: true }); } catch { }
        throw zipErr;
      }
      if (fs.existsSync(repackedZip) && fs.statSync(repackedZip).size > 100) {
        try { fs.rmSync(subFilePath, { force: true }); } catch { }
        return repackedZip;
      }
    } finally {
      try { fs.rmSync(unpackDir, { recursive: true, force: true }); } catch { }
    }
  } catch (err) {
    console.warn(`   ⚠️ Font bundling fallback failed, using naked subtitle: ${logSafe(err && err.message)}`);
  }
  return subFilePath;
}

// ====================================================================
// pCloud Public Link Handler (u.pcloud.link / e.pcloud.link / my.pcloud.com)
// ====================================================================

const PCLOUD_API_HOSTS = {
  us: 'api.pcloud.com',
  eu: 'eapi.pcloud.com',
};

function getPcloudApiHostOrder(folderUrl) {
  const host = cloudHostOf(folderUrl) || '';
  if (host === 'e.pcloud.link' || host.endsWith('.e.pcloud.link') || host === 'eapi.pcloud.com') {
    return [PCLOUD_API_HOSTS.eu, PCLOUD_API_HOSTS.us];
  }
  return [PCLOUD_API_HOSTS.us, PCLOUD_API_HOSTS.eu];
}

function isAllowedPcloudCdnHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  const host = hostname.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) return false;
  return host === 'pcloud.com' || host.endsWith('.pcloud.com')
    || host === 'pcloud.link' || host.endsWith('.pcloud.link');
}

function collectPcloudEntries(node, code, apiHost, out) {
  if (!node || out.length >= CLOUD_LISTING_MAX_ENTRIES) return;
  if (node.isfolder) {
    for (const child of node.contents || []) {
      if (out.length >= CLOUD_LISTING_MAX_ENTRIES) break;
      collectPcloudEntries(child, code, apiHost, out);
    }
    return;
  }
  if (!node.name) return;
  out.push({
    name: node.name,
    size: Number(node.size) || 0,
    fileid: node.fileid,
    code,
    apiHost,
    isSingleFile: false,
  });
}

export async function listPcloudFolderStrict(folderUrl, options = {}) {
  if (!isProviderHostUrl(folderUrl, 'pcloud')) {
    throw new Error('pCloud listing refused: unsafe host');
  }
  const code = extractPcloudPublinkCode(folderUrl);
  if (!code) return [];
  const fetchFn = typeof options.fetchImpl === 'function' ? options.fetchImpl : null;
  let lastErr = null;
  for (const apiHost of getPcloudApiHostOrder(folderUrl)) {
    const apiUrl = `https://${apiHost}/showpublink?code=${encodeURIComponent(code)}`;
    try {
      let res;
      if (fetchFn) {
        res = await fetchFn(apiUrl, { headers: { 'User-Agent': UA } });
      } else {
        const safe = await fetchSafe(apiUrl, {
          sourceUrl: apiUrl,
          initialValidator: isStaticSafeUrl,
          headers: { 'User-Agent': UA },
          timeoutMs: HTTP_TIMEOUT_MS,
        });
        res = safe?.response;
      }
      if (!res || !res.ok) {
        lastErr = new Error(`pCloud HTTP ${res ? res.status : 'blocked'}`);
        continue;
      }
      const text = await readResponseTextCapped(res, CLOUD_LISTING_MAX_BYTES);
      const data = JSON.parse(text);
      if (data && data.result === 0 && data.metadata) {
        if (!data.metadata.isfolder) {
          if (!data.metadata.name) return [];
          return [{
            name: data.metadata.name,
            size: Number(data.metadata.size) || 0,
            fileid: data.metadata.fileid,
            code,
            apiHost,
            isSingleFile: true,
          }];
        }
        const files = [];
        collectPcloudEntries(data.metadata, code, apiHost, files);
        return files;
      }
      lastErr = new Error(`pCloud API error ${(data && data.result) ?? 'unknown'}`);
      if (![7001, 7002, 7014].includes(data?.result)) break;
    } catch (e) {
      if (isCloudCapError(e)) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('pCloud listing failed');
}

export async function listPcloudFolder(folderUrl, options = {}) {
  try {
    return await listPcloudFolderStrict(folderUrl, options);
  } catch (e) {
    console.warn(`   ⚠️ pCloud folder listing failed: ${logSafe(e && e.message)}`);
    return [];
  }
}

export async function downloadPcloudEntryToDisk(entry, destPath, options = {}) {
  const code = entry && entry.code;
  const apiHost = entry?.apiHost === PCLOUD_API_HOSTS.eu ? PCLOUD_API_HOSTS.eu : PCLOUD_API_HOSTS.us;
  if (!code || !/^[a-zA-Z0-9]+$/.test(String(code))) return false;
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : null;
  const fetchFn = typeof options.fetchImpl === 'function' ? options.fetchImpl : null;
  const requestUrl = async (url, timeoutMs = HTTP_TIMEOUT_MS) => {
    if (fetchFn) return await fetchFn(url, { headers: { 'User-Agent': UA } });
    const safe = await fetchSafe(url, {
      sourceUrl: url,
      initialValidator: isStaticSafeUrl,
      headers: { 'User-Agent': UA },
      timeoutMs,
    });
    return safe?.response || null;
  };
  try {
    const fileParam = !entry.isSingleFile && entry.fileid != null
      ? `&fileid=${encodeURIComponent(String(entry.fileid))}`
      : '';
    const dlApiUrl = `https://${apiHost}/getpublinkdownload?code=${encodeURIComponent(String(code))}${fileParam}`;
    const metaRes = await requestUrl(dlApiUrl, HTTP_TIMEOUT_MS);
    if (!metaRes || !metaRes.ok) {
      console.warn(`   ⚠️ pCloud download metadata HTTP ${metaRes ? metaRes.status : 'blocked'} for: ${logSafe(entry.name || code)}`);
      return false;
    }
    const metaText = await readResponseTextCapped(metaRes, CLOUD_LISTING_MAX_BYTES);
    const meta = JSON.parse(metaText);
    const relPath = typeof meta?.path === 'string' ? meta.path : '';
    const hosts = Array.isArray(meta?.hosts) ? meta.hosts.filter(isAllowedPcloudCdnHost) : [];
    if (meta?.result !== 0 || !relPath.startsWith('/') || relPath.startsWith('//') || hosts.length === 0) {
      console.warn(`   ⚠️ pCloud invalid download response for: ${logSafe(entry.name || code)}`);
      return false;
    }

    for (const cdnHost of hosts) {
      const cdnUrl = `https://${cdnHost}${relPath}`;
      const fileRes = await requestUrl(cdnUrl, DRIVE_DOWNLOAD_TIMEOUT_MS);
      if (!fileRes || !fileRes.ok || !fileRes.body) continue;
      const bodyStream = typeof fileRes.body.getReader === 'function'
        ? Readable.fromWeb(fileRes.body)
        : fileRes.body;
      await writeStreamToFileWithCap(bodyStream, destPath, maxBytes);
      return true;
    }
    console.warn(`   ⚠️ pCloud CDN download failed for: ${logSafe(entry.name || code)}`);
    return false;
  } catch (e) {
    if (isCloudCapError(e)) throw e;
    console.warn(`   ⚠️ pCloud download failed for "${logSafe(entry?.name || code)}": ${logSafe(e && e.message)}`);
    return false;
  }
}

export async function findBestFileInPcloud(folderUrl, targetEpisode = null, extractedEps = [], listedFiles = null, batch = true) {
  const files = listedFiles || await listPcloudFolder(folderUrl);
  if (!files || files.length === 0) return null;

  console.log(`   📂 pCloud folder: ${files.length} file(s) found`);
  const clean = files.filter(f => !/hardsub|hard[\s_-]*sub/i.test(f.name));

  const subFiles = clean.filter(f => /\.(ass|srt|zip|7z|rar)$/i.test(f.name));
  let episodeAbsent = false;
  try {
    if (subFiles.length > 0) {
      const batchSel = selectFolderSubtitleBatch(subFiles, { targetEpisode, extractedEps, batch: batch === true });
      if (batchSel.length > 1) {
        console.log(`   📦 pCloud: subtitle batch of ${batchSel.length} file(s) — one package.`);
        return {
          type: 'subtitles',
          files: batchSel.map(f => ({
            fileid: f.fileid,
            code: f.code,
            apiHost: f.apiHost,
            isSingleFile: f.isSingleFile,
            name: f.name,
            size: f.size,
          })),
          subNames: batchSel.map(f => f.name),
        };
      }
      if (targetEpisode) {
        const match = subFiles.find(f => matchesEpisode(f.name, targetEpisode));
        if (match) {
          console.log(`   ✅ pCloud: subtitle matched EP ${targetEpisode}: ${logSafe(match.name)}`);
          return { ...match, type: 'subtitle' };
        }
      }
      const latest = subFiles[subFiles.length - 1];
      if (targetEpisode && extractEpisodesFromText(latest.name).length > 0 && !matchesEpisode(latest.name, targetEpisode)) {
        throw episodeAbsentError();
      }
      console.log(`   ✅ pCloud: subtitle ${logSafe(latest.name)}`);
      return { ...latest, type: 'subtitle' };
    }
  } catch (e) {
    if (e.code !== 'EPISODE_ABSENT') throw e;
    episodeAbsent = true;
  }

  const mkvFiles = clean.filter(f => /\.(mkv|mp4|m4v)$/i.test(f.name));
  if (mkvFiles.length > 0) {
    const chosen = chooseVideoCandidate(mkvFiles, targetEpisode);
    if (chosen) {
      console.log(`   🎬 pCloud: MKV ${logSafe(chosen.name)}`);
      return { ...chosen, type: 'mkv' };
    }
  }

  if (episodeAbsent) throw episodeAbsentError();
  return null;
}

export async function downloadPcloudFolderRelease(folderUrl, destDir, targetEpisode = null, options = {}) {
  const { downloadEntry = downloadPcloudEntryToDisk, fetchImpl = null, ...rest } = options || {};
  return await runCloudFolderRelease(
    {
      providerLabel: 'pCloud',
      releaseLabel: 'pCloud Release',
      tagPrefix: 'pcloud',
      loadFiles: (url) => listPcloudFolder(url, fetchImpl ? { fetchImpl } : {}),
      downloadItem: async (item, destPath, _itemDir, dlOpts) => {
        return await downloadEntry(item, destPath, fetchImpl ? { ...dlOpts, fetchImpl } : dlOpts);
      },
    },
    folderUrl,
    destDir,
    targetEpisode,
    rest
  );
}


