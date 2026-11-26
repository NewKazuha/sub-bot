import * as cheerio from 'cheerio';
import { execFileSync } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { matchesEpisode, logSafe } from './cloud-folders.mjs';
import { getCachedCanonical } from './title-identity.mjs';
import { fetchRenderedHtml, isRocksDdlHost, isRocksHost } from './browser-fetch.mjs';
import {
  RECOVERY_CODES, isRecoveryRedirectOption, recoveryFatalCodeFor
} from './recovery.mjs';
import {
  UA, HTTP_TIMEOUT_MS, META_REFRESH_MAX_HOPS,
  isStaticSafeUrl, isAllowedMetaRefreshTarget, cookieHeaderForRedirect, extractMetaRefreshTarget,
  isPrivateAddress, fetchSafe,
} from './url-safety.mjs';

// Re-export the safety helpers so existing importers of site-scrapers keep
// resolving. The single implementation now lives in ./url-safety.mjs.
export {
  isPrivateAddress, isAllowedMetaRefreshTarget, cookieHeaderForRedirect, extractMetaRefreshTarget,
};

// X3 — the HOSTNAME of a link decides its provider (guarded for a malformed
// href). A link that merely mentions "mediafire.com" in its query or in its
// path is NOT a mediafire link: it would otherwise be fetched server-side.
function linkHost(href) {
  try {
    return new URL(String(href)).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isHostOf(href, domain) {
  const host = linkHost(href);
  if (!host) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

function isAnyHostOf(href, domains) {
  return domains.some(d => isHostOf(href, d));
}

// M4: the host helpers are exported so the classification can be tested.
export { isHostOf, isAnyHostOf };

// ---------------------------------------------------------------------------
// HTML meta-refresh guard.
//
// A remote page controls the `content="...url=..."` target of a
// <meta http-equiv=refresh> tag. Fetching that target blindly would turn this
// runner into an internal HTTP client (SSRF) and could hand the site Cookie to
// a different host. The pure decision helpers now live in ./url-safety.mjs and
// are imported/re-exported above; the DNS lookup is injectable there so the
// decision can be unit-tested offline.
//
// A meta-refresh follow may itself be redirected. fetch's default
// `redirect: 'follow'` would silently traverse an UNCHECKED second hop (a
// public host 302-ing straight into an internal address), so every hop is
// fetched with `redirect: 'manual'` and every Location is re-validated.
// ---------------------------------------------------------------------------

/**
 * Fetch an already-validated meta-refresh URL and follow at most `maxHops`
 * HTTP redirects, re-validating EACH hop with isAllowedMetaRefreshTarget and
 * re-scoping the Cookie against the original site on every hop.
 *
 * Returns { html, url } only from a fully validated final (2xx) response —
 * `html`/`pageUrl` at the call site must not be touched on any invalid hop.
 * Returns null on any blocked/invalid hop, missing Location, hop-cap or fetch
 * error. `fetchImpl` and `lookup` are injectable so the whole loop is testable
 * offline.
 */
export async function fetchValidatedMetaRefreshChain(initialUrl, sourceUrl, cookieHeader, {
  fetchImpl = (...args) => globalThis.fetch(...args),
  lookup = dnsLookup,
  maxHops = META_REFRESH_MAX_HOPS,
} = {}) {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    // Re-scope the Cookie on EVERY hop against the ORIGINAL site: it may only
    // travel to the original host+scheme, never to a redirect target (even a
    // redirect that leaves and later returns must not leak it).
    const cookieHeaders = cookieHeaderForRedirect(cookieHeader, currentUrl, sourceUrl);
    let res;
    try {
      res = await fetchImpl(currentUrl, {
        headers: { 'User-Agent': UA, ...cookieHeaders },
        redirect: 'manual',
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch {
      return null;
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers?.get?.('location');
      let nextUrl = null;
      try {
        if (loc) nextUrl = new URL(loc, currentUrl).toString();
      } catch { nextUrl = null; }
      try { await res.body?.cancel(); } catch { }
      if (!nextUrl || hop >= maxHops || nextUrl === currentUrl) return null;
      // NEVER follow an unchecked hop: validate the Location before fetching.
      if (!(await isAllowedMetaRefreshTarget(nextUrl, currentUrl, lookup))) return null;
      currentUrl = nextUrl;
      continue;
    }

    if (!res.ok) {
      try { await res.body?.cancel(); } catch { }
      return null;
    }

    try {
      return { html: await res.text(), url: currentUrl };
    } catch {
      return null;
    }
  }
  return null;
}

// Mugi-Subs publishes its subtitle folders through a public Cloudflare Worker
// (a GoIndex-style browser over a shared Drive). The main site (mugi-subs.com)
// is Cloudflare-403 for datacenter IPs, so we resolve releases via the worker
// API instead of scraping the blocked page.
const MUGI_WORKER_BASE = 'https://subs.mugisubs.workers.dev';
const MUGI_WORKER_TIMEOUT_MS = 15_000;
// Root listing TTL is 120 s so it survives a full 60 s poll cycle (the previous
// 60 s TTL expired mid-cycle and re-fetched the root on every poll).
const MUGI_ROOT_TTL_MS = 120_000;
const MUGI_MAX_PAGES = 5;
const MUGI_MAX_CANDIDATES = 8;
const MUGI_MAX_JSON_BYTES = 2_000_000;
const MUGI_MAX_NAME_LENGTH = 1_024;
const MUGI_BREAKER_THRESHOLD = 3;

let mugiFetchImpl = (...args) => globalThis.fetch(...args);
let mugiRootCache = null;
// Circuit breaker: after MUGI_BREAKER_THRESHOLD consecutive worker request
// failures, stop hammering the worker for the rest of the process lifetime.
let mugiConsecutiveFailures = 0;
let mugiBreakerWarned = false;

// Test hooks. Not used by production code paths.
export function __setFetchImpl(fn) {
  mugiFetchImpl = fn;
}

export function __resetMugiWorkerState() {
  mugiRootCache = null;
  mugiConsecutiveFailures = 0;
  mugiBreakerWarned = false;
  mugiFetchImpl = (...args) => globalThis.fetch(...args);
}

// ---------------------------------------------------------------------------
// P1-1b: the negative cache for "no download links".
//
// The live P0 run re-scraped the SAME ~12 URLs every 60 s because their pages
// carry no usable download link: every one of those fetches was pure waste
// (and load on the fansub site). A URL that was fetched and found to have no
// link is therefore remembered for SCRAPE_NEGATIVE_TTL_MINUTES and answered
// from memory — with NO network request — until its entry expires.
//
// The cache lives in the process only: nothing is persisted (the runner is
// short-lived) and the map is bounded, so it can never grow without limit.
// ---------------------------------------------------------------------------

export const DEFAULT_SCRAPE_NEGATIVE_TTL_MINUTES = 15;
export const SCRAPE_NEGATIVE_CACHE_MAX_ENTRIES = 500;

// url -> expiry epoch ms
const negativeCache = new Map();
let negativeCacheHits = 0;
let negativeCacheMisses = 0;
let negativeNowImpl = () => Date.now();
// The last invalid TTL value that was warned about (one warning per value,
// never one per scrape).
let lastInvalidTtlWarning = null;

/** The warning an invalid TTL produces (one message, two callers). */
function negativeTtlWarning(raw) {
  return `⚠️ invalid SCRAPE_NEGATIVE_TTL_MINUTES (${raw}) — falling back to ${DEFAULT_SCRAPE_NEGATIVE_TTL_MINUTES}`;
}

/**
 * Resolve the negative-cache TTL (in minutes).
 * An invalid value NEVER disables the cache: it falls back to 15 minutes with
 * a warning — the same contract as MAX_CONSECUTIVE_CYCLE_FAILURES.
 */
export function resolveScrapeNegativeTtlMinutes({ value, env = process.env, warn = (m) => console.warn(m) } = {}) {
  const injected = value !== undefined && value !== null && value !== '';
  const raw = injected ? value : (env && env.SCRAPE_NEGATIVE_TTL_MINUTES);
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_SCRAPE_NEGATIVE_TTL_MINUTES;
  }
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 1) {
    warn(negativeTtlWarning(raw));
    return DEFAULT_SCRAPE_NEGATIVE_TTL_MINUTES;
  }
  return n;
}

/** The TTL in force right now (warns once per distinct invalid value). */
function currentNegativeTtlMinutes() {
  const raw = process.env.SCRAPE_NEGATIVE_TTL_MINUTES;
  const trimmed = String(raw ?? '').trim();
  const n = trimmed === '' ? NaN : Number(trimmed);
  if (trimmed !== '' && Number.isFinite(n) && n >= 1) {
    lastInvalidTtlWarning = null; // a valid value resets the one-shot warning
  }
  return resolveScrapeNegativeTtlMinutes({
    env: process.env,
    warn: (msg) => {
      // One warning per distinct invalid value — never one per scrape.
      if (lastInvalidTtlWarning === trimmed) return;
      lastInvalidTtlWarning = trimmed;
      console.warn(msg);
    },
  });
}

/** A live negative entry for this URL (its expiry in epoch ms), or null. */
function negativeCacheLookup(url, nowMs) {
  if (!negativeCache.has(url)) {
    negativeCacheMisses++;
    return null;
  }
  const expiry = negativeCache.get(url);
  if (expiry <= nowMs) {
    negativeCache.delete(url); // lazy expiry
    negativeCacheMisses++;
    return null;
  }
  negativeCacheHits++;
  return expiry;
}

/** Remember a no-link URL. The map is bounded: the oldest entry is evicted. */
function negativeCacheStore(url, nowMs, ttlMinutes) {
  const expiry = nowMs + ttlMinutes * 60_000;
  negativeCache.delete(url); // re-insert: the newest entry is evicted last
  while (negativeCache.size >= SCRAPE_NEGATIVE_CACHE_MAX_ENTRIES) {
    const oldest = negativeCache.keys().next().value;
    if (oldest === undefined) break;
    negativeCache.delete(oldest);
  }
  negativeCache.set(url, expiry);
  return expiry;
}

// Test hooks for the negative cache. Not used by production code paths.
export function __setNowImpl(fn) {
  negativeNowImpl = typeof fn === 'function' ? fn : () => Date.now();
}

/** Reset the cache, its counters AND the injected clock. */
export function __resetNegativeCache() {
  negativeCache.clear();
  negativeCacheHits = 0;
  negativeCacheMisses = 0;
  negativeNowImpl = () => Date.now();
  lastInvalidTtlWarning = null;
}

export function __getNegativeCacheStats() {
  return {
    hits: negativeCacheHits,
    misses: negativeCacheMisses,
    size: negativeCache.size,
    maxEntries: SCRAPE_NEGATIVE_CACHE_MAX_ENTRIES,
  };
}

// True only for mugi-subs.com and its subdomains. Uses the parsed hostname so
// lookalikes (notmugi-subs.com, mugi-subs.com.evil.com) never match.
export function isMugiHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'mugi-subs.com' || host.endsWith('.mugi-subs.com');
  } catch {
    return false;
  }
}

// Normalize a release title or folder name into comparable tokens. Bracket
// contents are removed entirely so a fansub tag like "[Mugi-Subs]" does not
// leak "mugi"/"subs" tokens that would otherwise match every Mugi folder.
export function mugiNormalizeTokens(input, targetEp = '') {
  let s = String(input ?? '');
  s = s.replace(/https?:\/\/[^\s]+/gi, ' ');
  s = s.replace(/\[[^\]]*\]/g, ' ');
  s = s.replace(/\([^)]*\)/g, ' ');
  s = s.replace(/\bep(?:isode)?\s*\.?\s*\d{1,4}(?:v\d+)?\b/gi, ' ');
  s = s.toLowerCase();
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ');
  const tokens = s.split(/\s+/).filter(Boolean);

  const epNorm = String(targetEp).replace(/^0+/, '') || (String(targetEp) === '0' ? '0' : '');
  const fileTokenRegex = /^(?:1080p|720p|480p|2160p|4k|bd|bdrip|web-?dl|web|hevc|h264|x264|x265|aac|flac|mkv|mp4|ass|srt)$/;
  const seasonTokenRegex = /^(?:season|part|cour)\d*$/;

  return tokens.filter(t => {
    if (/(?:19|20)\d{2}/.test(t)) return false;
    if (epNorm && (t.replace(/^0+/, '') || '0') === epNorm) return false;
    if (t === 'episode' || t === 'ep' || t === 'e') return false;
    if (fileTokenRegex.test(t)) return false;
    if (seasonTokenRegex.test(t)) return false;
    if (t.length === 1) return false;
    return true;
  });
}

async function mugiPostJson(urlPath, body, timeoutMs = MUGI_WORKER_TIMEOUT_MS) {
  try {
    const res = await mugiFetchImpl(`${MUGI_WORKER_BASE}${urlPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify(body),
      // Never follow a redirect: a 3xx throws and is caught below. The worker
      // API is a fixed origin; a redirect could steer us to another host.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res || !res.ok) {
      console.warn(`   ⚠️ Mugi worker request failed (${res ? res.status : 'no response'}) for ${urlPath}`);
      mugiConsecutiveFailures++;
      return null;
    }
    const declaredLength = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MUGI_MAX_JSON_BYTES) {
      console.warn(`   ⚠️ Mugi worker response for ${urlPath} declared ${declaredLength} bytes; refusing to read`);
      mugiConsecutiveFailures++;
      return null;
    }
    const text = await res.text();
    if (text.length > MUGI_MAX_JSON_BYTES) {
      console.warn(`   ⚠️ Mugi worker response for ${urlPath} exceeded ${MUGI_MAX_JSON_BYTES} bytes; refusing to parse`);
      mugiConsecutiveFailures++;
      return null;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      console.warn(`   ⚠️ Mugi worker response for ${urlPath} was not valid JSON: ${e.message}`);
      mugiConsecutiveFailures++;
      return null;
    }
    mugiConsecutiveFailures = 0;
    return json;
  } catch (e) {
    console.warn(`   ⚠️ Mugi worker request error for ${urlPath}: ${e.message}`);
    mugiConsecutiveFailures++;
    return null;
  }
}

function mugiEntriesFromJson(json) {
  const files = json?.data?.files ?? json?.files;
  return Array.isArray(files) ? files : [];
}

// Walk a worker folder listing, following nextPageToken up to MUGI_MAX_PAGES.
// Returns the accumulated entries, or null when a page could not be fetched.
async function fetchMugiListing(urlPath, deadline) {
  const entries = [];
  const seenNames = new Set();
  let pageToken = null;
  let pageIndex = 0;

  for (let page = 0; page < MUGI_MAX_PAGES; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.warn(`   ⚠️ Mugi worker deadline exceeded while listing ${urlPath}`);
      return null;
    }
    const body = page === 0
      ? { password: '' }
      : { password: '', page_token: pageToken, page_index: pageIndex };
    const json = await mugiPostJson(urlPath, body, Math.min(MUGI_WORKER_TIMEOUT_MS, Math.max(1, remaining)));
    if (!json) return null;

    let added = 0;
    for (const entry of mugiEntriesFromJson(json)) {
      // Skip nameless entries and de-duplicate by name so a repeated folder
      // entry is only counted (and later requested) once.
      if (!entry || typeof entry.name !== 'string' || entry.name.length === 0) continue;
      if (seenNames.has(entry.name)) continue;
      seenNames.add(entry.name);
      entries.push(entry);
      added++;
    }
    if (page > 0 && added === 0) {
      console.warn(`   ⚠️ Mugi worker page ${page + 1} of ${urlPath} returned no new names; stopping pagination`);
      break;
    }
    if (!json.nextPageToken) return entries;
    pageToken = json.nextPageToken;
    pageIndex = (json.curPageIndex ?? 0) + 1;
  }

  console.warn(`   ⚠️ Mugi worker listing ${urlPath} reached the ${MUGI_MAX_PAGES}-page cap; stopping pagination`);
  return entries;
}

async function getMugiRootNames(deadline) {
  const now = Date.now();
  if (mugiRootCache && (now - mugiRootCache.ts) < MUGI_ROOT_TTL_MS) {
    return mugiRootCache.names;
  }
  const entries = await fetchMugiListing('/0:/', deadline);
  if (!entries) return null;

  const names = entries
    .filter(f => !(f && f.mimeType && f.mimeType !== 'application/vnd.google-apps.folder'))
    .map(f => f?.name)
    .filter(n => typeof n === 'string' && n.length > 0);

  if (names.length === 0) {
    console.warn('   ⚠️ Mugi worker root listing returned no folder names');
    return null;
  }
  mugiRootCache = { ts: now, names };
  return names;
}

function isUnsafeMugiName(name) {
  if (typeof name !== 'string' || name.length === 0) return true;
  if (name.length > MUGI_MAX_NAME_LENGTH) return true;
  return name.includes('/') || name.includes('\\') || name.includes('..');
}

function pickMugiSubtitleFile(files) {
  const byExt = ext => files.find(f => new RegExp(`\\.${ext}$`, 'i').test(f.name));
  // Mugi's 42 MB .ass embeds fonts, so .ass is the right single-file choice.
  return byExt('ass') || byExt('srt') || files.find(f => /\.(?:zip|rar|7z)$/i.test(f.name)) || files[0] || null;
}

// Resolve a release to a single worker download URL. Never throws: any failure
// logs a specific reason and returns null so the caller can fall through.
export async function resolveMugiSubtitleFromWorker(releaseTitle, targetEp = null) {
  try {
    if (mugiConsecutiveFailures >= MUGI_BREAKER_THRESHOLD) {
      if (!mugiBreakerWarned) {
        mugiBreakerWarned = true;
        console.warn(`   ⚠️ Mugi worker circuit breaker open after ${mugiConsecutiveFailures} consecutive failures; skipping worker resolution`);
      }
      return null;
    }

    const deadline = Date.now() + 60_000;
    const targetEpStr = targetEp == null ? '' : String(targetEp);

    const releaseTokens = mugiNormalizeTokens(releaseTitle, targetEpStr);
    if (releaseTokens.length === 0) {
      console.warn(`   ⚠️ Mugi worker: title "${releaseTitle}" produced no searchable tokens`);
      return null;
    }

    const rootNames = await getMugiRootNames(deadline);
    if (!rootNames) return null;

    const candidates = rootNames
      .map(name => ({ name, tokens: mugiNormalizeTokens(name, '') }))
      .filter(c => releaseTokens.every(t => c.tokens.includes(t)))
      .sort((a, b) => {
        const diff = (a.tokens.length - releaseTokens.length) - (b.tokens.length - releaseTokens.length);
        return diff !== 0 ? diff : a.name.localeCompare(b.name);
      })
      .slice(0, MUGI_MAX_CANDIDATES);

    if (candidates.length === 0) {
      console.warn(`   ⚠️ Mugi worker: no folder matched "${releaseTitle}" (${releaseTokens.join(' ')})`);
      return null;
    }

    const targetEpNorm = targetEpStr.replace(/^0+/, '') || (targetEpStr === '0' ? '0' : '');

    for (const candidate of candidates) {
      if (Date.now() > deadline) {
        console.warn(`   ⚠️ Mugi worker deadline exceeded before candidate "${candidate.name}"`);
        return null;
      }
      if (isUnsafeMugiName(candidate.name)) {
        console.warn(`   ⚠️ Mugi worker: skipping unsafe folder name "${candidate.name}"`);
        continue;
      }

      const entries = await fetchMugiListing(`/0:/${encodeURIComponent(candidate.name)}/`, deadline);
      if (!entries) continue;

      const files = entries
        .filter(f => f && typeof f.name === 'string' && /\.(ass|srt|zip|rar|7z)$/i.test(f.name))
        .filter(f => {
          if (isUnsafeMugiName(f.name)) {
            console.warn(`   ⚠️ Mugi worker: skipping unsafe file name "${f.name}"`);
            return false;
          }
          return true;
        });

      let matched;
      if (targetEpNorm) {
        matched = files.filter(f => matchesEpisode(f.name, targetEpNorm));
        if (matched.length === 0) continue;
      } else {
        if (files.length === 0) continue;
        if (files.length > 1) {
          console.warn(`   ⚠️ Mugi worker: multiple subtitle files in "${candidate.name}" with no target episode; ambiguous`);
          return null;
        }
        matched = files;
      }

      const chosen = pickMugiSubtitleFile(matched);
      if (!chosen) continue;

      const url = `${MUGI_WORKER_BASE}/0:/${encodeURIComponent(candidate.name)}/${encodeURIComponent(chosen.name)}`;
      if (!url.startsWith(`${MUGI_WORKER_BASE}/0:/`)) {
        console.warn(`   ⚠️ Mugi worker: refusing to build unexpected URL for "${chosen.name}"`);
        continue;
      }
      return { url, fileName: chosen.name, folderName: candidate.name };
    }

    console.warn(`   ⚠️ Mugi worker: no matching subtitle file in Mugi worker for "${releaseTitle}" ep ${targetEpStr}`);
    return null;
  } catch (e) {
    console.warn(`   ⚠️ Mugi worker fallback failed for "${releaseTitle}": ${e.message}`);
    return null;
  }
}

const CELESTIAL_INDEX_BASE = 'https://subs.celestial-dragons.com/0:/';
const CELESTIAL_CATEGORY_FOLDERS = ['الأعمال الحالية', 'الأعمال المكتملة'];
const CELESTIAL_TIMEOUT_MS = 15_000;
const CELESTIAL_LISTING_TTL_MS = 120_000;
const CELESTIAL_MAX_PAGES = 5;
const CELESTIAL_MAX_JSON_BYTES = 2_000_000;
const CELESTIAL_MAX_NAME_LENGTH = 1_024;
const CELESTIAL_MAX_CACHE_ENTRIES = 32;
const CELESTIAL_MAX_TREE_FOLDERS = 12;
const CELESTIAL_MAX_TREE_DEPTH = 2;
const CELESTIAL_BREAKER_THRESHOLD = 3;
const CELESTIAL_BREAKER_COOLDOWN_MS = 60_000;

let celestialFetchImpl = (...args) => globalThis.fetch(...args);
const celestialListingCache = new Map();
let celestialConsecutiveFailures = 0;
let celestialBreakerOpenedAt = 0;
let celestialBreakerWarned = false;

export function isCelestialHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'celestial-dragons.com' || host.endsWith('.celestial-dragons.com');
  } catch {
    return false;
  }
}

export function isCelestialIndexHost(url) {
  try {
    return new URL(url).hostname.toLowerCase() === 'subs.celestial-dragons.com';
  } catch {
    return false;
  }
}

export function __setCelestialFetchImpl(fn) {
  celestialFetchImpl = fn;
}

export function __resetCelestialIndexState() {
  celestialListingCache.clear();
  celestialConsecutiveFailures = 0;
  celestialBreakerOpenedAt = 0;
  celestialBreakerWarned = false;
  celestialFetchImpl = (...args) => globalThis.fetch(...args);
}

function isSafeCelestialName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= CELESTIAL_MAX_NAME_LENGTH &&
    !/[\/\\\0-\x1f]/.test(name) && !name.includes('..');
}

function isCelestialFolderEntry(entry) {
  return entry?.mimeType === 'application/vnd.google-apps.folder' || entry?.type === 'folder' || entry?.isFolder === true;
}

function isPureCelestialFontName(name) {
  return /(?:^|[_\s.\[\]-])fonts?(?=[_\s.\[\]-]|$)|(?:^|[_\s.\[\]-])خطوط(?=[_\s.\[\]-]|$)/i.test(name) && !/(?:sub|ترجم)/i.test(name);
}

function celestialChildUrl(parentUrl, name) {
  if (!isSafeCelestialName(name)) return null;
  const base = parentUrl.endsWith('/') ? parentUrl : parentUrl + '/';
  return `${base}${encodeURIComponent(name)}/`;
}

function recordCelestialFailure(message) {
  celestialConsecutiveFailures++;
  if (celestialConsecutiveFailures === CELESTIAL_BREAKER_THRESHOLD) celestialBreakerOpenedAt = Date.now();
  console.warn(`   ⚠️ Celestial index: ${logSafe(message)}`);
}

async function fetchCelestialListing(directoryUrl, options = {}) {
  const now = Date.now();
  const cached = celestialListingCache.get(directoryUrl);
  if (cached && now - cached.ts < CELESTIAL_LISTING_TTL_MS) return cached.entries;

  const deadline = options.deadline || Date.now() + 60_000;
  const timeoutMs = options.timeoutMs || CELESTIAL_TIMEOUT_MS;
  const validateUrl = options.validateUrl || isStaticSafeUrl;
  const lookup = options.lookup || dnsLookup;
  const fetchImpl = options.fetchImpl || celestialFetchImpl;
  const recoveryMode = isRecoveryRedirectOption(options.redirect);
  const entries = [];
  const seenNames = new Set();
  let pageToken = null;
  let pageIndex = 0;
  let hasMore = false;

  try {
    for (let page = 0; page < CELESTIAL_MAX_PAGES; page++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        recordCelestialFailure(`deadline exceeded while listing ${directoryUrl}`);
        return null;
      }
      const body = page === 0
        ? { page_token: null, page_index: 0 }
        : { page_token: pageToken, page_index: pageIndex };
      const safe = await fetchSafe(directoryUrl, {
        sourceUrl: directoryUrl,
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        initialValidator: validateUrl,
        lookup,
        fetchImpl,
        timeoutMs: Math.min(timeoutMs, Math.max(1, remaining)),
        recovery: recoveryMode,
      });
      const res = safe?.response;
      if (!res) {
        recordCelestialFailure(`listing request failed for ${directoryUrl}`);
        return null;
      }
      const declaredLength = Number(res.headers?.get?.('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > CELESTIAL_MAX_JSON_BYTES) {
        try { await res.body?.cancel(); } catch { }
        recordCelestialFailure(`listing response exceeded the size cap for ${directoryUrl}`);
        return null;
      }

      let rawText = '';
      if (typeof res.text === 'function') rawText = await res.text();
      else if (typeof res.json === 'function') rawText = JSON.stringify(await res.json());
      else {
        recordCelestialFailure(`listing response was unreadable for ${directoryUrl}`);
        return null;
      }
      if (Buffer.byteLength(rawText, 'utf8') > CELESTIAL_MAX_JSON_BYTES) {
        recordCelestialFailure(`listing response exceeded the size cap for ${directoryUrl}`);
        return null;
      }

      let json;
      try {
        json = JSON.parse(rawText);
      } catch {
        recordCelestialFailure(`listing response was not valid JSON for ${directoryUrl}`);
        return null;
      }
      const files = json?.data?.files;
      if (!Array.isArray(files)) {
        recordCelestialFailure(`listing response had no files array for ${directoryUrl}`);
        return null;
      }

      let added = 0;
      for (const entry of files) {
        if (!entry || !isSafeCelestialName(entry.name) || seenNames.has(entry.name)) continue;
        seenNames.add(entry.name);
        entries.push(entry);
        added++;
      }
      if (page > 0 && added === 0) {
        hasMore = false;
        break;
      }

      const nextToken = json.nextPageToken ?? json.data?.nextPageToken;
      hasMore = Boolean(nextToken && nextToken !== pageToken);
      if (!hasMore) break;
      pageToken = nextToken;
      pageIndex = (json.curPageIndex ?? json.data?.curPageIndex ?? pageIndex) + 1;
    }

    if (hasMore) {
      console.warn(`   ⚠️ Celestial index listing reached the page cap for ${directoryUrl}`);
    }
    celestialConsecutiveFailures = 0;
    celestialBreakerOpenedAt = 0;
    celestialBreakerWarned = false;
    celestialListingCache.set(directoryUrl, { ts: now, entries });
    while (celestialListingCache.size > CELESTIAL_MAX_CACHE_ENTRIES) {
      celestialListingCache.delete(celestialListingCache.keys().next().value);
    }
    return entries;
  } catch (error) {
    if (recoveryFatalCodeFor(error)) throw error;
    recordCelestialFailure(`listing request failed for ${directoryUrl}: ${error.message}`);
    return null;
  }
}

function celestialTitleTokenSets(releaseTitle, targetEp) {
  const titles = [releaseTitle];
  const canonical = getCachedCanonical(releaseTitle);
  if (canonical?.romaji) titles.push(canonical.romaji);
  if (canonical?.english) titles.push(canonical.english);
  const sets = [];
  const seen = new Set();
  for (const title of titles) {
    const tokens = mugiNormalizeTokens(title, targetEp || '');
    if (!tokens.length) continue;
    const key = tokens.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    sets.push(tokens);
  }
  return sets;
}

function celestialFolderMatch(name, tokenSets) {
  if (!isSafeCelestialName(name)) return null;
  const folderTokens = mugiNormalizeTokens(name, '');
  if (!folderTokens.length) return null;
  for (const tokens of tokenSets) {
    if (tokens.length === 1) {
      if (folderTokens.length === 1 && folderTokens[0] === tokens[0]) return 'exact';
      continue;
    }
    if (tokens.every(token => folderTokens.includes(token))) {
      return folderTokens.length === tokens.length ? 'exact' : 'partial';
    }
  }
  return null;
}

async function findCelestialSeriesFolder(releaseTitle, targetEp, options) {
  const tokenSets = celestialTitleTokenSets(releaseTitle, targetEp);
  if (!tokenSets.length) return null;
  const root = await fetchCelestialListing(CELESTIAL_INDEX_BASE, options);
  if (!root) return null;

  const categoryUrls = new Map();
  for (const entry of root) {
    if (!isCelestialFolderEntry(entry)) continue;
    const category = String(entry.name).trim();
    if (!CELESTIAL_CATEGORY_FOLDERS.includes(category)) continue;
    const url = celestialChildUrl(CELESTIAL_INDEX_BASE, category);
    if (url) categoryUrls.set(category, url);
  }

  const candidates = [];
  const seenUrls = new Set();
  for (const category of CELESTIAL_CATEGORY_FOLDERS) {
    const categoryUrl = categoryUrls.get(category);
    if (!categoryUrl) continue;
    const entries = await fetchCelestialListing(categoryUrl, options);
    if (!entries) continue;
    for (const entry of entries) {
      if (!isCelestialFolderEntry(entry)) continue;
      const match = celestialFolderMatch(entry.name, tokenSets);
      if (!match) continue;
      const url = celestialChildUrl(categoryUrl, entry.name);
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      candidates.push({ name: entry.name, url, category, exact: match === 'exact' });
      if (candidates.length > 8) return null;
    }
  }

  const exact = candidates.filter(candidate => candidate.exact);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1 || candidates.length > 1) {
    console.warn(`   ⚠️ Celestial index: ambiguous series folders for ${logSafe(releaseTitle)}`);
    return null;
  }
  return candidates[0] || null;
}

async function scanCelestialFolderTree(rootUrl, options) {
  const queue = [{ url: rootUrl, pathNames: [], depth: 0 }];
  const visited = new Set();
  const files = [];
  let foldersFetched = 0;

  while (queue.length && foldersFetched < CELESTIAL_MAX_TREE_FOLDERS) {
    const current = queue.shift();
    if (visited.has(current.url)) continue;
    visited.add(current.url);
    const entries = await fetchCelestialListing(current.url, options);
    foldersFetched++;
    if (!entries) continue;

    for (const entry of entries) {
      if (!isSafeCelestialName(entry.name)) continue;
      if (isCelestialFolderEntry(entry)) {
        if (current.depth >= CELESTIAL_MAX_TREE_DEPTH) continue;
        const childUrl = celestialChildUrl(current.url, entry.name);
        if (childUrl && !visited.has(childUrl)) {
          queue.push({ url: childUrl, pathNames: [...current.pathNames, entry.name], depth: current.depth + 1 });
        }
        continue;
      }
      if (/\.(?:ass|srt|zip|rar|7z|ttf|otf)$/i.test(entry.name)) {
        files.push({ entry, directoryUrl: current.url, pathNames: current.pathNames });
      }
    }
  }
  return files;
}

function pickCelestialSubtitle(files, targetEp, batch) {
  const candidates = files.filter(file =>
    /\.(?:ass|srt|zip|rar|7z)$/i.test(file.entry.name) &&
    !isPureCelestialFontName(file.entry.name) &&
    !file.pathNames.some(isPureCelestialFontName)
  );
  let matched = candidates;
  if (targetEp != null && String(targetEp) !== '') {
    matched = candidates.filter(file => matchesEpisode(file.entry.name, String(targetEp)));
  } else if (batch) {
    const archives = candidates.filter(file => /\.(?:zip|rar|7z)$/i.test(file.entry.name));
    const batchArchives = archives.filter(file => /\b\d{1,4}\s*(?:~|–|—|-)\s*\d{1,4}\b|\bbatch\b|\bcomplete\b/i.test(file.entry.name));
    matched = batchArchives.length === 1 ? batchArchives : [];
  } else {
    matched = candidates.length === 1 ? candidates : [];
  }
  if (!matched.length) return null;

  for (const extension of ['ass', 'srt', 'zip', 'rar', '7z']) {
    const extensionMatches = matched.filter(file => new RegExp(`\\.${extension}$`, 'i').test(file.entry.name));
    if (extensionMatches.length === 1) return extensionMatches[0];
  }
  return matched.length === 1 ? matched[0] : null;
}

function pickCelestialFont(files) {
  const fonts = files.filter(file =>
    /\.(?:zip|rar|7z|ttf|otf)$/i.test(file.entry.name) &&
    (isPureCelestialFontName(file.entry.name) || file.pathNames.some(isPureCelestialFontName))
  );
  const archives = fonts.filter(file => /\.(?:zip|rar|7z)$/i.test(file.entry.name));
  if (archives.length === 1) return archives[0];
  if (fonts.length === 1) return fonts[0];
  return null;
}

export async function resolveCelestialSubtitleFromIndex(releaseTitle, targetEp = null, options = {}) {
  try {
    if (celestialConsecutiveFailures >= CELESTIAL_BREAKER_THRESHOLD) {
      if (Date.now() - celestialBreakerOpenedAt >= CELESTIAL_BREAKER_COOLDOWN_MS) {
        celestialConsecutiveFailures = 0;
        celestialBreakerOpenedAt = 0;
        celestialBreakerWarned = false;
      } else {
        if (!celestialBreakerWarned) {
          celestialBreakerWarned = true;
          console.warn('   ⚠️ Celestial index circuit breaker open after consecutive failures; skipping resolution');
        }
        return null;
      }
    }
    const context = { ...options, deadline: options.deadline || Date.now() + 60_000 };
    const folder = await findCelestialSeriesFolder(releaseTitle, targetEp, context);
    if (!folder) return null;
    const files = await scanCelestialFolderTree(folder.url, context);
    const subtitle = pickCelestialSubtitle(files, targetEp, options.batch === true);
    if (!subtitle) {
      console.warn(`   ⚠️ Celestial index: no unambiguous subtitle for ${logSafe(releaseTitle)} ep ${logSafe(targetEp ?? '')}`);
      return null;
    }
    const font = pickCelestialFont(files);
    return {
      url: goIndexEntryUrl(subtitle.directoryUrl, subtitle.entry),
      fontsUrl: font ? goIndexEntryUrl(font.directoryUrl, font.entry) : null,
      fileName: subtitle.entry.name,
      folderName: folder.name,
      category: folder.category,
    };
  } catch (error) {
    if (recoveryFatalCodeFor(error)) throw error;
    console.warn(`   ⚠️ Celestial index resolver failed: ${logSafe(error.message)}`);
    return null;
  }
}

function typedRecoveryError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function fetchWithTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  return fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(timeoutMs) })
    .then((res) => {
      // F4: a 3xx on the recovery path must fail LOUDLY — never publish from a
      // page we were redirected to (an SSRF second hop).
      if (options.recovery === true && res.status >= 300 && res.status < 400) {
        throw typedRecoveryError(RECOVERY_CODES.REDIRECT, 'redirect refused on recovery path');
      }
      return res;
    });
}

function isCertificateValidationError(error) {
  const detail = `${error?.code || ''} ${error?.cause?.code || ''} ${error?.message || ''} ${error?.cause?.message || ''}`;
  return /(?:CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|UNTRUSTED)/i.test(detail);
}

function fetchHtmlWithCurl(url, cookieHeader = '') {
  // curl uses the runner's maintained system CA bundle. This is a secure
  // fallback for Rhythm only when Node's bundled CA store rejects its chain.
  const command = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const args = [
    '--fail', '--silent', '--show-error', '--max-time', '60',
    '--user-agent', UA
  ];
  if (cookieHeader) args.push('--cookie', cookieHeader);
  args.push(url);
  return execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 65_000,
    maxBuffer: 10 * 1024 * 1024
  });
}

export function fetchHtmlWithImpersonation(url, cookieHeader = '') {
  try {
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const scriptPath = path.resolve('scripts/cf_fetch.py');
    if (!fs.existsSync(scriptPath)) return null;
    const args = [scriptPath, url];
    if (cookieHeader) args.push('--cookie', cookieHeader);
    const result = execFileSync(pythonCmd, args, {
      encoding: 'utf8',
      timeout: 45_000,
      maxBuffer: 10 * 1024 * 1024
    });
    if (result && result.length > 500) {
      return result;
    }
    if (result != null && result.length <= 500) {
      console.warn(`   ⚠️ curl_cffi returned ${result.length} chars for ${url} — likely blocked`);
    }
  } catch (e) {
    console.warn(`   ⚠️ curl_cffi impersonation failed for ${url}:`, e.message);
  }
  return null;
}

class SessionJar {
  constructor() {
    this.cookies = new Map();
  }
  absorb(res) {
    let setCookies = [];
    if (typeof res.headers.getSetCookie === 'function') {
      setCookies = res.headers.getSetCookie() || [];
    } else if (res.headers.get('set-cookie')) {
      setCookies = [res.headers.get('set-cookie')];
    }
    for (const line of setCookies) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

const siteSessions = new Map();
const SESSION_TTL = 2 * 60 * 60 * 1000; // Refresh session cookie every 2 hours

// G1: on the recovery path login GETs must not follow redirects — SessionJar.absorb is not domain-scoped, so a 3xx target's cookies would be absorbed and sent as Cookie to the page. Normal callers (undefined redirect) are byte-identical.
async function ensureSiteSession(siteConfig, { redirect } = {}) {
  if (!siteConfig) return null;
  const now = Date.now();
  const cached = siteSessions.get(siteConfig.id);
  if (cached && (now - cached.created < SESSION_TTL)) {
    return cached.jar;
  }
  const jar = new SessionJar();
  siteSessions.set(siteConfig.id, { jar, created: now });

  // 0. Manual REVIVE_COOKIE from environment / GitHub Secrets
  if (siteConfig.id === 'revive' || (siteConfig.base && siteConfig.base.includes('revivesubs'))) {
    const rawCookie = process.env.REVIVE_COOKIE;
    if (rawCookie) {
      console.log(`   🔑 Using manual REVIVE_COOKIE for ${siteConfig.name}`);
      for (const pair of rawCookie.split(';')) {
        const eq = pair.indexOf('=');
        if (eq > 0) jar.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      return jar;
    }
  }

  // 0.1 Manual CELESTIAL_COOKIE from environment / GitHub Secrets (bypasses Google reCAPTCHA v3)
  if (siteConfig.id === 'celestial' || (siteConfig.base && siteConfig.base.includes('celestial-dragons'))) {
    const rawCookie = process.env.CELESTIAL_COOKIE;
    if (rawCookie) {
      console.log(`   🔑 Using manual CELESTIAL_COOKIE for ${siteConfig.name}`);
      for (const pair of rawCookie.split(';')) {
        const eq = pair.indexOf('=');
        if (eq > 0) jar.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      return jar;
    }
  }

  if (!siteConfig.user || !siteConfig.pass) return null;

  // 1. Check if site is Laravel / Custom Auth (e.g. Revive Subs)
  if (siteConfig.id === 'revive' || (siteConfig.base && siteConfig.base.includes('revivesubs'))) {
    try {
      const getRes = await fetchWithTimeout(`${siteConfig.base}/login`, {
        headers: { 'User-Agent': UA },
        ...(redirect ? { redirect } : {})
      });
      jar.absorb(getRes);
      const html = await getRes.text();
      const $ = cheerio.load(html);
      const token = $('meta[name="csrf-token"]').attr('content') || $('input[name="_token"]').val();

      // Revive protects its login with Cloudflare Turnstile.  A GitHub Actions
      // runner cannot legitimately complete an interactive challenge, so a
      // password-only POST is guaranteed to be rejected even when the
      // credentials are valid.  Keep the anonymous session (public posts may
      // still be readable) and let the caller try the next URL in a joint post.
      if ($('input[name="cf-turnstile-response"]').length) {
        console.warn(`Login to ${siteConfig.name} requires Cloudflare Turnstile; skipping automated login and using public pages only.`);
        return jar;
      }

      const params = new URLSearchParams();
      if (token) params.append('_token', token);
      params.append('email', siteConfig.user);
      params.append('password', siteConfig.pass);
      params.append('remember', 'on');

      const postRes = await fetchWithTimeout(`${siteConfig.base}/login`, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': jar.header(),
          'Referer': `${siteConfig.base}/login`
        },
        body: params.toString(),
        redirect: 'manual'
      });
      jar.absorb(postRes);
      return jar;
    } catch (e) {
      console.warn(`Login to Laravel site ${siteConfig.name} failed:`, e.message);
      return jar;
    }
  }

  // 2. Standard WordPress Authentication (Rhythm, LazySano, Anime-San, Celestial)
  try {
    const wpInit = await fetchWithTimeout(`${siteConfig.base}/wp-login.php`, {
      headers: { 'User-Agent': UA },
      ...(redirect ? { redirect } : {})
    });
    jar.absorb(wpInit);

    const params = new URLSearchParams({
      log: siteConfig.user,
      pwd: siteConfig.pass,
      rememberme: 'forever',
      'wp-submit': 'Log In',
      testcookie: '1',
      redirect_to: `${siteConfig.base}/`
    });

    const res = await fetchWithTimeout(`${siteConfig.base}/wp-login.php`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': jar.header(),
        'Referer': `${siteConfig.base}/wp-login.php`
      },
      body: params.toString(),
      redirect: 'manual'
    });
    jar.absorb(res);
    const loggedIn = [...jar.cookies.keys()].some(name => /^wordpress_(?:sec_|logged_in_)/i.test(name));
    if (!loggedIn) {
      console.warn(`Login to WordPress site ${siteConfig.name} was not accepted; protected posts cannot be read.`);
    }
  } catch (e) {
    console.warn(`Login to WordPress site ${siteConfig.name} failed:`, e.message);
  }
  return jar;
}

const IGNORED_DOMAINS = [
  'maz-software.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'instagram.com',
  'discord.gg',
  'discord.com',
  't.me',
  'telegram.me',
  'wordpress.org',
  'blogger.com',
  'google.com/url',
  'support.google.com',
  'policies.google.com'
];

export async function followRedirectUrl(url, options = {}) {
  // Numeric second argument (the historical `maxHops`) stays supported.
  if (typeof options === 'number') options = { maxHops: options };
  const {
    maxHops = 3,
    lookup,
    validateUrl = isStaticSafeUrl,
    fetchImpl = (u, o) => fetchWithTimeout(u, o),
  } = options;
  if (!url || !url.startsWith('http')) return url;
  // N2: the INITIAL shortener URL was fetched (HEAD, then GET) before any
  // validation. Location hops are re-checked below, but the first URL is
  // remote-controlled too: refuse a private/metadata target BEFORE the first
  // request and return it unchanged. `validateUrl` is injectable and a throwing
  // validator fails closed.
  let initialAllowed = false;
  try {
    initialAllowed = await validateUrl(url, url);
  } catch { initialAllowed = false; }
  if (!initialAllowed) {
    console.warn(`Refusing unsafe shortener URL (host ${linkHost(url) || 'unknown'})`);
    return url;
  }
  let curr = url;
  for (let i = 0; i < maxHops; i++) {
    try {
      // Many link shorteners (including Blogger redirect pages) reject HEAD.
      // Try HEAD first, then use a redirect-only GET without downloading the body.
      let res = await fetchImpl(curr, {
        method: 'HEAD',
        redirect: 'manual',
        headers: { 'User-Agent': UA }
      });
      if (![301, 302, 303, 307, 308].includes(res.status)) {
        try { await res.body?.cancel(); } catch {}
        res = await fetchImpl(curr, {
          method: 'GET',
          redirect: 'manual',
          headers: { 'User-Agent': UA, 'Range': 'bytes=0-0' }
        });
      }
      const loc = res.headers.get('location');
      if (loc && (res.status >= 300 && res.status < 400)) {
        const nextUrl = new URL(loc, curr).toString();
        // A public shortener must never 302 us into a private/metadata host;
        // validate BEFORE the next request, and refuse without following it.
        if (!(await isAllowedMetaRefreshTarget(nextUrl, curr, lookup))) {
          try { await res.body?.cancel(); } catch {}
          break;
        }
        curr = nextUrl;
      } else {
        break;
      }
      try { await res.body?.cancel(); } catch {}
    } catch {
      break;
    }
  }
  return curr;
}

function normaliseLinkUrl(rawUrl, pageUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl.trim(), pageUrl);
    return /^https?:$/i.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function goIndexEntryUrl(directoryUrl, entry) {
  const base = directoryUrl.endsWith('/') ? directoryUrl : directoryUrl + '/';
  if (entry?.link) {
    try {
      const linked = new URL(entry.link, base);
      const source = new URL(directoryUrl);
      if (/^https?:$/i.test(linked.protocol) && linked.origin === source.origin && !linked.username && !linked.password) {
        return linked.toString();
      }
    } catch { }
  }
  return `${base}${encodeURIComponent(entry?.name || '')}`;
}

function getLinkTarget($, el, pageUrl) {
  // Some Arabic fansub themes place the target in a data attribute or an
  // onclick handler instead of href. Support both forms used by their buttons.
  const raw = $(el).attr('href') || $(el).attr('data-href') ||
    $(el).attr('data-url') || $(el).attr('data-link');
  const normal = normaliseLinkUrl(raw, pageUrl);
  if (normal) return normal;

  const onclick = $(el).attr('onclick') || '';
  const match = onclick.match(/(?:window\.location(?:\.href)?|location\.href)\s*=\s*['"]([^'"]+)['"]/i);
  return normaliseLinkUrl(match?.[1], pageUrl);
}

export async function resolveGoIndexSubtitle(directoryUrl, targetEp = null, { batch = false, redirect, validateUrl = isStaticSafeUrl, lookup = dnsLookup } = {}) {
  const recoveryMode = isRecoveryRedirectOption(redirect);

  // N3: the directory URL comes from a scraped link and is POSTed to directly.
  // Validate it before ANY request — the metadata/loopback host must never be
  // reached. `validateUrl` is injectable; a throwing validator fails closed.
  let urlAllowed = false;
  try {
    urlAllowed = await validateUrl(directoryUrl, directoryUrl);
  } catch { urlAllowed = false; }
  if (!urlAllowed) {
    console.warn(`Refusing unsafe GoIndex directory URL (host ${linkHost(directoryUrl) || 'unknown'})`);
    return null;
  }

  try {
    let files = [];

    // 1. Try application/json (Mejaow / modern GoIndex workers)
    try {
      // N6: POST via fetchSafe — a 302 from a public worker is re-validated
      // (DNS-aware) before any second request, so it can never reach an
      // internal address. Recovery mode still throws a typed 3xx refusal.
      const safeJson = await fetchSafe(directoryUrl, {
        sourceUrl: directoryUrl,
        method: 'POST',
        body: JSON.stringify({ page_token: null, page_index: 0 }),
        headers: { 'Content-Type': 'application/json' },
        initialValidator: validateUrl,
        lookup,
        recovery: recoveryMode,
      });
      const resJson = safeJson?.response;
      if (resJson) {
        const json = await resJson.json().catch(() => null);
        if (json?.data?.files) files = json.data.files;
      }
    } catch (e) {
      // F3/F4: a typed recovery refusal must never be swallowed by a fallback.
      if (recoveryFatalCodeFor(e)) throw e;
    }

    // 2. Try application/x-www-form-urlencoded (Rocks-Team / HashHackers GDI workers)
    if (!files.length) {
      try {
        const formParams = new URLSearchParams();
        formParams.append('password', '');
        formParams.append('page_token', '');
        formParams.append('page_index', '0');

        const safeForm = await fetchSafe(directoryUrl, {
          sourceUrl: directoryUrl,
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formParams.toString(),
          initialValidator: validateUrl,
          lookup,
          recovery: recoveryMode,
        });

        const resForm = safeForm?.response;
        if (resForm) {
          const rawText = await resForm.text();
          let json = null;
          try {
            json = JSON.parse(rawText);
          } catch {
            // HashHackers GDI obfuscation: reverse string, cut 24 chars prefix & 20 chars suffix, then base64 decode
            try {
              const rev = rawText.split('').reverse().join('');
              const sliced = rev.substr(24).slice(0, -20);
              const decoded = Buffer.from(sliced, 'base64').toString('utf-8');
              json = JSON.parse(decoded);
            } catch {
              const rev = rawText.split('').reverse().join('');
              const sliced = rev.substr(24).slice(0, -20);
              const b64 = atob(sliced);
              const uri = b64.split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('');
              json = JSON.parse(decodeURIComponent(uri));
            }
          }
          if (json?.data?.files) files = json.data.files;
        }
      } catch (e) {
        // F3/F4: a typed recovery refusal must never be swallowed by a fallback.
        if (recoveryFatalCodeFor(e)) throw e;
      }
    }

    if (!files.length) return null;

    const subFiles = files.filter(f => /\.(ass|srt|zip|rar|7z)$/i.test(f.name || ''));
    if (!subFiles.length) return null;

    const isPureFont = (name) => /(?:^|[_\s.\[\]-])fonts?(?=[_\s.\[\]-]|$)|(?:^|[_\s.\[\]-])خطوط(?=[_\s.\[\]-]|$)/i.test(name) && !/(?:sub|ترجم)/i.test(name);
    const nonFontSubFiles = subFiles.filter(f => !isPureFont(f.name || ''));
    const candidateFiles = nonFontSubFiles.length > 0 ? nonFontSubFiles : subFiles;

    let chosen = null;
    if (targetEp) {
      const epNorm = String(targetEp).replace(/^0+/, '');
      chosen = candidateFiles.find(f => {
        const found = (f.name || '').match(/(\d{1,4})/g) || [];
        return found.some(n => n.replace(/^0+/, '') === epNorm);
      });
    }

    if (!chosen && batch) {
      // For batch releases, prefer the batch archive (.zip/.rar/.7z)
      const archives = candidateFiles.filter(f => /\.(zip|rar|7z)$/i.test(f.name || ''));
      if (archives.length > 0) {
        // A lone hyphen also appears in per-episode names; require a numeric range.
        const batchArchivePattern = /\b\d{1,4}\s*(?:~|–|—|-)\s*\d{1,4}\b|\bbatch\b|\bcomplete\b/i;
        chosen = archives.find(f => batchArchivePattern.test(f.name || '')) || archives[0];
      }
    }

    if (!chosen) {
      const archives = candidateFiles.filter(f => /\.(zip|rar|7z)$/i.test(f.name || ''));
      chosen = archives.length > 0 ? archives[archives.length - 1] : candidateFiles[candidateFiles.length - 1];
    }

    return goIndexEntryUrl(directoryUrl, chosen);
  } catch (e) {
    // F3/F4: a typed recovery refusal must never be turned into a null result.
    if (recoveryFatalCodeFor(e)) throw e;
    return null;
  }
}

// m7 — the DDL directory of a BATCH post ("الدفعة الأولى", "[01~05]") holds one
// archive PER EPISODE. When no episode is asked for, the archive that carries
// NO episode token is the whole batch and must be preferred; when the
// directory holds only per-episode archives, the first one is used and the
// limitation is logged.
export async function resolveSubtitleFromDirectory(directoryUrl, targetEp = null, { batch = false, redirect, validateUrl = isStaticSafeUrl, lookup = dnsLookup } = {}) {
  // Rocks-Team DDL is Cloudflare-protected: the listing only exists in a
  // browser, so it is rendered with headless Chromium instead of fetched.
  const isRocks = isRocksDdlHost(directoryUrl);
  const recoveryMode = isRecoveryRedirectOption(redirect);

  // F3: a browser follows redirects internally — fail closed on the recovery
  // path instead of calling it (no publish from a second hop).
  if (recoveryMode && isRocks) {
    throw typedRecoveryError(RECOVERY_CODES.FETCH_UNSAFE, 'browser render refused on recovery path');
  }

  if (!isRocks && /(?:workers\.dev|ddl\.[^/]+|\/0:)/i.test(directoryUrl)) {
    const goIndexFile = await resolveGoIndexSubtitle(directoryUrl, targetEp, { batch, redirect, validateUrl, lookup });
    if (goIndexFile) return goIndexFile;
  }

  try {
    let html = null;
    if (isRocks) {
      html = await fetchRenderedHtml(directoryUrl);
      if (!html) return null;
    } else {
      // N6: the directory URL is scraped input. Route the plain HTML fallback
      // through fetchSafe too, so a 302 from a public host is re-validated
      // (DNS-aware) before ANY second request — otherwise undici auto-follows
      // it straight into an internal address. Recovery mode throws a typed
      // RECOVERY_REDIRECT before the redirect target is fetched.
      const safeGet = await fetchSafe(directoryUrl, {
        sourceUrl: directoryUrl,
        method: 'GET',
        initialValidator: validateUrl,
        lookup,
        recovery: recoveryMode,
      });
      const res = safeGet?.response;
      if (!res?.ok) return null;
      const contentType = res.headers.get('content-type') || '';
      if (!/html|text\//i.test(contentType)) return null;
      html = await res.text();
    }

    const $ = cheerio.load(html);
    const candidates = [];
    $('a[href]').each((_, el) => {
      const href = normaliseLinkUrl($(el).attr('href'), directoryUrl);
      const label = $(el).text().trim();
      if (href && (/\.(?:ass|srt|zip|rar|7z)(?:$|[?#])/i.test(href) || /\.(?:ass|srt|zip|rar|7z)\b/i.test(label))) {
        candidates.push(href);
      }
    });

    // A "?a=view" link opens the file viewer, not the file itself, and the DDL
    // index lists every file twice (viewer + direct). Sorting is stable, so
    // this only moves viewer links behind their direct twins.
    candidates.sort((a, b) => Number(/[?&]a=view/i.test(a)) - Number(/[?&]a=view/i.test(b)));

    if (targetEp) {
      const epNorm = String(targetEp).replace(/^0+/, '');
      const match = candidates.find(u => {
        // Match against the DECODED url: in a percent-encoded path the escape
        // "%20" fuses with the episode number ("%2041" -> "2041"), so the real
        // number never appears and every lookup silently fell back to the
        // first archive (picked episode 41 for episode 49).
        let decoded = u;
        try { decoded = decodeURIComponent(u); } catch { }
        const found = decoded.match(/(\d{1,4})/g) || [];
        return found.some(n => n.replace(/^0+/, '') === epNorm);
      });
      if (match) return match;
    }

    // m7: a BATCH directory without an episode — prefer the archive that
    // carries NO episode token (the whole batch in one archive).
    const isPureFont = (name) => /(?:^|[_\s.\[\]-])fonts?(?=[_\s.\[\]-]|$)|(?:^|[_\s.\[\]-])خطوط(?=[_\s.\[\]-]|$)/i.test(name) && !/(?:sub|ترجم)/i.test(name);
    const nonFontCandidates = candidates.filter(u => {
      let decoded = u;
      try { decoded = decodeURIComponent(u); } catch { }
      const fn = decoded.split(/[?#]/)[0].split('/').pop() || decoded;
      return !isPureFont(fn);
    });
    const pool = nonFontCandidates.length > 0 ? nonFontCandidates : candidates;

    if (batch && !targetEp) {
      const archives = pool.filter(url => /\.(?:zip|rar|7z)(?:$|[?#])/i.test(url));
      const decodedName = (url) => {
        let decoded = url;
        try { decoded = decodeURIComponent(url); } catch { }
        const clean = decoded.split(/[?#]/)[0];
        return clean.split('/').pop() || clean;
      };
      const wholeBatch = archives.find(url => !/\d/.test(decodedName(url)));
      if (wholeBatch) return wholeBatch;
      if (archives.length > 0) {
        // X6: the name is a scraped href — it must never forge a log line.
        console.warn(`⚠️ batch directory has only per-episode archives — using ${logSafe(decodedName(archives[0]))}`);
        return archives[0];
      }
    }

    // Prefer an archive because fansub releases commonly bundle fonts with it.
    return pool.find(url => /\.(?:zip|rar|7z)(?:$|[?#])/i.test(url)) || pool[0] || null;
  } catch (e) {
    // F3/F4: never convert a typed recovery refusal into a link/no-link result.
    if (recoveryFatalCodeFor(e)) throw e;
    console.warn(`Could not inspect subtitle directory ${directoryUrl}:`, e.message);
    return null;
  }
}

export async function resolveFontFromDirectory(directoryUrl, options = {}) {
  // F4: a marked recovery message must use the same no-redirect mode as its
  // sibling subtitle resolver. fetchSafe with `recovery: true` throws a typed
  // refusal on any 3xx before the redirect target can be fetched.
  const recoveryMode = isRecoveryRedirectOption(options.redirect) || options.recovery === true;
  const lookup = typeof options.lookup === 'function' ? options.lookup : dnsLookup;
  if (!directoryUrl || !/(?:workers\.dev|ddl\.[^/]+|\/0:)/i.test(directoryUrl)) return null;

  // N3: validate the directory URL before the JSON / form / HTML fetches.
  // A scraped metadata URL (e.g. http://169.254.169.254/0:/) would otherwise
  // pass the shape check above and be fetched three times. Injectable and
  // fail-closed, matching the subtitle resolver's pre-flight guard.
  const validateUrl = typeof options.validateUrl === 'function' ? options.validateUrl : isStaticSafeUrl;
  let urlAllowed = false;
  try {
    urlAllowed = await validateUrl(directoryUrl, directoryUrl);
  } catch { urlAllowed = false; }
  if (!urlAllowed) {
    console.warn(`Refusing unsafe font directory URL (host ${linkHost(directoryUrl) || 'unknown'})`);
    return null;
  }

  const isPureFont = (name) => /(?:^|[_\s.\[\]-])fonts?(?=[_\s.\[\]-]|$)|(?:^|[_\s.\[\]-])خطوط(?=[_\s.\[\]-]|$)/i.test(name) && !/(?:sub|ترجم)/i.test(name);

  // 1. Try application/json (Mejaow / modern GoIndex workers)
  try {
    // N6: every listing request goes through fetchSafe, including this POST,
    // so a public worker's 302 is re-validated before a second request.
    const safeJson = await fetchSafe(directoryUrl, {
      sourceUrl: directoryUrl,
      method: 'POST',
      body: JSON.stringify({ page_token: null, page_index: 0 }),
      headers: { 'Content-Type': 'application/json' },
      initialValidator: validateUrl,
      lookup,
      recovery: recoveryMode,
    });
    const resJson = safeJson?.response;
    if (resJson) {
      let json = null;
      if (typeof resJson.json === 'function') {
        json = await resJson.json().catch(() => null);
      }
      if (!json && typeof resJson.text === 'function') {
        const rawText = await resJson.text();
        try { json = JSON.parse(rawText); } catch {}
      }
      const files = json?.data?.files || [];
      const fontFile = files.find(f => isPureFont(f.name || '') && /\.(?:zip|rar|7z|ttf|otf)$/i.test(f.name || ''));
      if (fontFile) return goIndexEntryUrl(directoryUrl, fontFile);
    }
  } catch (e) {
    // A typed recovery refusal (e.g. a 3xx on the no-redirect path) must fail
    // fatal rather than being swallowed by this fallback attempt.
    if (recoveryFatalCodeFor(e)) throw e;
  }

  // 2. Try application/x-www-form-urlencoded (Rocks-Team / HashHackers GDI workers)
  try {
    const formParams = new URLSearchParams({ q: '', password: '', page_token: '', page_index: '0' });
    const safeForm = await fetchSafe(directoryUrl, {
      sourceUrl: directoryUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formParams.toString(),
      initialValidator: validateUrl,
      lookup,
      recovery: recoveryMode,
    });
    const res = safeForm?.response;
    if (res) {
      let json = null;
      if (typeof res.json === 'function') {
        json = await res.json().catch(() => null);
      }
      if (!json && typeof res.text === 'function') {
        const rawText = await res.text();
        try { json = JSON.parse(rawText); } catch {
          const rev = rawText.split('').reverse().join('');
          const sliced = rev.substr(24).slice(0, -20);
          const b64 = atob(sliced);
          const uri = b64.split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('');
          json = JSON.parse(decodeURIComponent(uri));
        }
      }
      const files = json?.data?.files || [];
      const fontFile = files.find(f => isPureFont(f.name || '') && /\.(?:zip|rar|7z|ttf|otf)$/i.test(f.name || ''));
      if (fontFile) return goIndexEntryUrl(directoryUrl, fontFile);
    }
  } catch (e) {
    // A typed recovery refusal must fail fatal, not fall through.
    if (recoveryFatalCodeFor(e)) throw e;
  }

  try {
    // The HTML fallback GET is validated too — otherwise a worker that
    // refuses both POSTs could still 302 us into an internal address here.
    const safeHtml = await fetchSafe(directoryUrl, {
      sourceUrl: directoryUrl,
      initialValidator: validateUrl,
      lookup,
      recovery: recoveryMode,
    });
    const res = safeHtml?.response;
    if (res) {
      const html = await res.text();
      const $ = cheerio.load(html);
      let fontHref = null;
      $('a[href]').each((_, el) => {
        const href = normaliseLinkUrl($(el).attr('href'), directoryUrl);
        const label = $(el).text().trim();
        let decoded = href || '';
        try { decoded = decodeURIComponent(decoded); } catch { }
        const fn = decoded.split(/[?#]/)[0].split('/').pop() || decoded;
        if (href && (isPureFont(fn) || isPureFont(label)) && /\.(?:zip|rar|7z|ttf|otf)(?:$|[?#])/i.test(href)) {
          fontHref = href;
          return false;
        }
      });
      return fontHref;
    }
  } catch (e) {
    // A typed recovery refusal must fail fatal, not become a null result.
    if (recoveryFatalCodeFor(e)) throw e;
  }

  return null;
}

export async function scrapePostPage(pageUrl, siteConfig = null, targetEp = null, releaseTitle = null, options = {}) {
  // F2/F4: single mode decision for the whole page-scrape path. Normal callers
  // (no redirect option) are byte-identical to before.
  const recoveryMode = isRecoveryRedirectOption(options.redirect);

  // V1: the FIRST page URL is remote-controlled too. Refuse private/loopback/
  // metadata targets BEFORE any fetch path (browser, impersonation, Node fetch
  // or curl) can run. `validateUrl` is injectable for offline tests; a throwing
  // validator fails closed. Recovery mode keeps its own no-redirect rules.
  let urlAllowed = false;
  try {
    urlAllowed = await (options.validateUrl || isStaticSafeUrl)(pageUrl, pageUrl);
  } catch { urlAllowed = false; }
  if (!urlAllowed) {
    console.warn(`Refusing unsafe post page URL (host ${linkHost(pageUrl) || 'unknown'})`);
    return null;
  }

  if (isCelestialHost(pageUrl)) {
    let effectiveTitle = releaseTitle;
    if (!effectiveTitle) {
      const segments = pageUrl.split(/[?#]/)[0].split('/').filter(Boolean);
      const rawSegment = segments[segments.length - 1] || '';
      const spaced = rawSegment.replace(/[-_]/g, ' ');
      try {
        effectiveTitle = decodeURIComponent(spaced);
      } catch {
        effectiveTitle = spaced;
      }
    }
    const effectiveEp = targetEp ?? (pageUrl.match(/[-_](\d{1,4})(?:\.html)?\/?(?:[?#]|$)/)?.[1] ?? null);
    const resolved = await resolveCelestialSubtitleFromIndex(effectiveTitle, effectiveEp, {
      redirect: options.redirect,
      validateUrl: options.validateUrl,
      lookup: options.lookup,
      fetchImpl: options.fetchImpl,
      batch: options.batch,
    });
    if (!resolved) {
      console.warn(`   ⚠️ Celestial index fallback found no subtitle for ${pageUrl}`);
      return null;
    }
    return {
      title: effectiveTitle,
      pageUrl,
      bestDownloadUrl: resolved.url,
      fileName: resolved.fileName,
      source: 'celestial-index',
      videoLinks: {
        directSub: resolved.url,
        fonts: resolved.fontsUrl,
        top4top: null,
        mediafire: null,
        mega: null,
        drive: null,
        proton: null,
        pixeldrain: null,
        torrent: null,
        buzzheavier: null,
        hevc: null,
        h264: null
      }
    };
  }

  // P1-1b: a URL that was already fetched and found to have NO download link
  // is answered from the negative cache — with NO network request at all —
  // until its entry expires. This is what stops the same pages from being
  // re-scraped every 60 s.
  const cachedExpiry = negativeCacheLookup(pageUrl, negativeNowImpl());
  if (cachedExpiry) {
    const until = new Date(cachedExpiry).toISOString();
    console.log(`⏭️ Negative cache: no links for ${pageUrl} (skipping until ${until})`);
    return {
      bestDownloadUrl: null,
      videoLinks: null,
      negativeCached: true,
      negativeCachedUntil: until,
    };
  }

  // Mugi-Subs is Cloudflare-403 for datacenter IPs, so scrapePostPage must not
  // fetch the article. Resolve the subtitle through the public worker API and
  // never fall through to the blocked page.
  // This path is deliberately NOT negative-cached: the worker lookup has its
  // own root-listing cache and circuit breaker, and a worker OUTAGE must
  // never be remembered as "this page has no links".
  if (isMugiHost(pageUrl)) {
    let effectiveTitle = releaseTitle;
    if (!effectiveTitle) {
      const segments = pageUrl.split(/[?#]/)[0].split('/').filter(Boolean);
      const rawSegment = segments[segments.length - 1] || '';
      const spaced = rawSegment.replace(/[-_]/g, ' ');
      try {
        effectiveTitle = decodeURIComponent(spaced);
      } catch {
        effectiveTitle = spaced;
      }
    }

    // Fallback for callers (e.g. LazySano) that do not pass a target episode:
    // derive it from the page URL slug before resolving.
    let effectiveEp = targetEp;
    if (effectiveEp == null) {
      effectiveEp = pageUrl.match(/[-_](\d{1,4})(?:\.html)?\/?(?:[?#]|$)/)?.[1] ?? null;
    }

    const resolved = await resolveMugiSubtitleFromWorker(effectiveTitle, effectiveEp);
    if (resolved) {
      return {
        title: effectiveTitle,
        pageUrl,
        bestDownloadUrl: resolved.url,
        source: 'mugi-worker',
        videoLinks: {
          directSub: resolved.url,
          fonts: null,
          top4top: null,
          mediafire: null,
          mega: null,
          drive: null,
          proton: null,
          pixeldrain: null,
          torrent: null,
          buzzheavier: null,
          hevc: null,
          h264: null
        }
      };
    }

    console.warn(`   ⚠️ Mugi worker fallback found no subtitle for ${pageUrl}`);
    return null;
  }

  let cookieHeader = '';
  if (siteConfig && (siteConfig.user || process.env.REVIVE_COOKIE || process.env.CELESTIAL_COOKIE)) {
    const jar = await ensureSiteSession(siteConfig, { redirect: options.redirect });
    if (jar) cookieHeader = jar.header();
  }

  const effectiveEp = targetEp || (pageUrl.match(/[-_](\d{1,4})(?:\.html)?$/i)?.[1]) || null;

  // Post-process a VALIDATED page: Cloudflare challenge impersonation and an
  // HTML <meta http-equiv=refresh> follow. Shared by the direct-2xx path and
  // the final URL of a validated HTTP redirect chain so neither loses a
  // release. The meta target is resolved against the validated current URL,
  // re-checked with DNS-aware validation, and fetched only with manual,
  // re-validated hops; html/currentUrl advance only on a validated final 2xx.
  const postProcessPageHtml = async (currentHtml, currentUrl, responseStatus) => {
    // If Cloudflare challenge returned (challenge page / 403 / 503), try impersonation fallback
    if (currentHtml.includes('Just a moment...') || currentHtml.includes('cf-chl-') ||
        responseStatus === 403 || responseStatus === 503) {
      // F2: curl_cffi follows redirects internally — fail closed on the
      // recovery path instead of bypassing the no-redirect policy.
      if (recoveryMode) {
        throw typedRecoveryError(RECOVERY_CODES.FETCH_UNSAFE, 'impersonation fallback refused on recovery path');
      }
      console.log(`   🛡️ Cloudflare challenge detected (${responseStatus}), attempting curl_cffi fallback...`);
      const cfHtml = fetchHtmlWithImpersonation(currentUrl, cookieHeader);
      if (cfHtml) currentHtml = cfHtml;
    }

    if (currentHtml && !recoveryMode) {
      // Follow HTML meta refresh redirect (e.g. Staatic static site redirects on Cloudflare Pages).
      // The target is remote-controlled: validate it before fetching, and only
      // carry the site Cookie when the target host is the original page host.
      const redirectTarget = extractMetaRefreshTarget(currentHtml);
      if (redirectTarget) {
        try {
          const resolvedRedirect = new URL(redirectTarget, currentUrl).toString();
          if (resolvedRedirect !== currentUrl &&
              await isAllowedMetaRefreshTarget(resolvedRedirect, currentUrl, options.lookup)) {
            console.log(`   🔀 HTML meta refresh detected: redirecting to ${resolvedRedirect}`);
            const followed = await fetchValidatedMetaRefreshChain(
              resolvedRedirect, currentUrl, cookieHeader, { lookup: options.lookup }
            );
            if (followed) {
              currentHtml = followed.html;
              currentUrl = followed.url;
            }
          }
        } catch { }
      }
    }
    return { html: currentHtml, pageUrl: currentUrl };
  };

  let html = '';
  // Revive Subs is behind Cloudflare which blocks datacenter IPs.
  // Use curl_cffi with Chrome impersonation if available.
  // C1/F2: the recovery path forbids redirects; these alternate fetchers follow
  // them internally, so they are skipped entirely in recovery mode.
  if (!recoveryMode && (siteConfig?.id === 'revive' || (siteConfig?.base && siteConfig.base.includes('revivesubs')))) {
    const cfHtml = fetchHtmlWithImpersonation(pageUrl, cookieHeader);
    if (cfHtml) {
      console.log(`   🛡️ Successfully bypassed Cloudflare for ${siteConfig.name} via curl_cffi!`);
      html = cfHtml;
    }
  }

  // Rocks-Team blog is Cloudflare-403 for datacenter IPs; curl_cffi wins only
  // ~29% of the time. Render it in the same browser used for its DDL index.
  // C1: a browser follows redirects — never use it on the recovery path.
  if (!html && !recoveryMode && isRocksHost(pageUrl)) {
    html = await fetchRenderedHtml(pageUrl);
    if (html) console.log(`   🛡️ Rendered ${siteConfig?.name || 'Rocks-Team'} via headless Chromium.`);
  }

  if (!html) {
    // The first page URL is remote-controlled too. fetchSafe validates EVERY
    // hop before fetching and never auto-follows a Location: the initial URL
    // uses the same DNS-free `validateUrl` escape hatch as the pre-flight
    // guard above (so the recovery test-local URL and `unsafe` test names keep
    // working), while redirect hops remain DNS-aware via lookup. Recovery mode
    // throws a typed RECOVERY_REDIRECT on any 3xx before a second request.
    const pageUrlValidator = options.validateUrl || isStaticSafeUrl;
    try {
      const safe = await fetchSafe(pageUrl, {
        sourceUrl: pageUrl,
        cookieHeader,
        lookup: options.lookup,
        recovery: recoveryMode,
        initialValidator: pageUrlValidator,
        allowNonOk: true, // 403/503 Cloudflare challenges must reach postProcessPageHtml
      });

      if (!safe) {
        console.warn(`Refusing unsafe redirect from post page (host ${linkHost(pageUrl) || 'unknown'})`);
        return null;
      }

      html = await safe.response.text();
      // The validated final URL — whether a direct 2xx or the end of a
      // re-validated redirect chain — may carry a meta refresh or a Cloudflare
      // challenge. Apply the same post-processing to BOTH so neither loses a
      // release.
      ({ html, pageUrl } = await postProcessPageHtml(html, safe.url, safe.response.status));
    } catch (e) {
      // C1: on the recovery path NO fallback may follow a redirect or bypass
      // the check (curl uses a different redirect policy). Propagate so the
      // caller turns it into a fatal — a redirect must never publish.
      if (recoveryMode) throw e;
      if (siteConfig && isCertificateValidationError(e)) {
        try {
          console.warn(`Node TLS validation failed for ${siteConfig.name}; using the system CA bundle.`);
          html = fetchHtmlWithCurl(pageUrl, cookieHeader);
        } catch (curlError) {
          // F8: never log the full pageUrl (it may carry tokens) — host only.
          console.error(`Failed to fetch ${siteConfig.name} page with system CA bundle (host ${linkHost(pageUrl) || 'unknown'}):`, curlError.message);
          return null;
        }
      } else {
        // F8: host only here too (same non-recovery failure path).
        console.error(`Failed to fetch page (host ${linkHost(pageUrl) || 'unknown'}):`, e.message);
        return null;
      }
    }
  }

  const $ = cheerio.load(html);

  const title = $('h1.entry-title').text().trim() || 
                $('h1.post-title').text().trim() || 
                $('title').text().replace(/[-–|].*$/, '').trim() || 
                'Anime Release';

  const allLinks = [];
  $('a, [data-href], [data-url], [data-link], [onclick]').each((_, el) => {
    const href = getLinkTarget($, el, pageUrl);
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (href) {
      const isIgnored = IGNORED_DOMAINS.some(d => href.includes(d));
      const isSelf = href.replace(/#.*$/, '') === pageUrl.replace(/#.*$/, '');
      const tag = (el.tagName || '').toLowerCase();
      const isContainer = ['article', 'section', 'body', 'main'].includes(tag) || text.length > 120;
      if (!isIgnored && !isSelf && !isContainer) {
        // Check parent/surrounding context text
        const parentContext = $(el).closest('div, section, article, p, table, tr, td, li').text().trim().replace(/\s+/g, ' ');

        // Check container heading (ancestor heading or preceding sibling heading)
        let containerHeading = '';
        let curr = $(el).parent();
        while (curr.length && !curr.is('body, html, main, .content-section')) {
          const h = curr.children('h1, h2, h3, h4, h5, h6, strong, b, p > strong').first();
          if (h.length) {
            containerHeading = h.text().trim();
            break;
          }
          const prev = curr.prevAll('h1, h2, h3, h4, h5, h6, strong, b, p').first();
          if (prev.length) {
            containerHeading = prev.text().trim();
            break;
          }
          curr = curr.parent();
        }

        allLinks.push({ href, text, parentContext, containerHeading, el });
      }
    }
  });

  // 1. Check for dedicated Subtitle / Font links
  // Patterns used by the fansub sites: "ملف الترجمة والخطوط", "ملف الترجمة",
  // "Softsub", and buttons labelled "هنا" or "التحميل" under these headings.
  const subExplicitRegex = /(?:ملف\s*(?:الترجمة|الترجمات|الخطوط)|(?:الترجمة|الترجمات)\s*(?:و\s*الخطوط)?|(?:الخطوط)\s*و\s*(?:الترجمة|الترجمات)|subtitles?)/i;
  const subHeadingRegex = /(?:ملف(?:ات)?\s*(?:الترجمة|الترجمات)(?:\s*و\s*الخطوط)?|(?:الترجمة|الترجمات)\s*و?\s*الخطوط|ملف\s*الخطوط|soft\s*sub|subtitles?)/i;
  const actionButtonRegex = /^(?:هنا|اضغط\s*هنا|إضغط\s*هنا|اضغط|إضغط|التحميل|تحميل|تنزيل|download|direct|ddl)$/i;

  let directSubLink = null;

  // A. Link points directly to subtitle/archive file extension
  for (const l of allLinks) {
    if (/\.(ass|srt|zip|rar|7z)$/i.test(l.href)) {
      directSubLink = l.href;
      break;
    }
  }

  // B. Link text explicitly indicates subtitle file (excluding root index /0:/)
  if (!directSubLink) {
    for (const l of allLinks) {
      const isRoot = /(?:workers\.dev|ddl\.[^/]+)\/0:\/?$/i.test(l.href);
      if (!isRoot && subExplicitRegex.test(l.text)) {
        directSubLink = l.href;
        break;
      }
    }
  }

  // C. General subtitle links or dedicated workers.dev links
  if (!directSubLink) {
    for (const l of allLinks) {
      const isRoot = /(?:workers\.dev|ddl\.[^/]+)\/0:\/?$/i.test(l.href);
      if (!isRoot && (subHeadingRegex.test(l.text) || /subs-[^/]+\.workers\.dev/i.test(l.href))) {
        directSubLink = l.href;
        break;
      }
    }
  }

  // D0. The label immediately BEFORE the link's block (walking up a few
  // wrapper levels): blogspot puts "ملف الترجمة والخطوط" in its own div and
  // the link in the NEXT div — the ancestor-heading walk never sees it.
  if (!directSubLink) {
    for (const l of allLinks) {
      const isRoot = /(?:workers\.dev|ddl\.[^/]+)\/0:\/?$/i.test(l.href);
      if (isRoot || !l.el) continue;
      if (!isAnyHostOf(l.href, ['drive.google.com', 'mega.nz', 'mediafire.com', 'top4top.io'])) continue;
      const head = $(l.el).closest('h1, h2, h3, h4, h5, h6');
      const scope = head.length ? head : $(l.el).closest('p, div');
      let nearLabel = '';
      let cur = scope;
      for (let depth = 0; depth < 4 && cur.length && !nearLabel; depth++) {
        const par = cur.parent();
        if (!par.length) break;
        const nodes = par.contents().toArray();
        const idx = nodes.indexOf(cur[0]);
        for (let j = idx - 1; j >= 0; j--) {
          const n = nodes[j];
          const t = (n.type === 'text' ? (n.data || '') : $(n).text()).trim().replace(/\s+/g, ' ');
          if (t) { nearLabel = t; break; }
        }
        cur = par;
      }
      if (nearLabel && nearLabel.length <= 80 && subExplicitRegex.test(nearLabel)) {
        directSubLink = l.href;
        break;
      }
    }
  }

  // D1. A heading that EXPLICITLY names the subtitle/fonts file wins over a
  // generic "Softsub" video heading: a post can offer both as Drive folders,
  // and picking the video first left the dedicated subs folder unused.
  if (!directSubLink) {
    for (const l of allLinks) {
      const isRoot = /(?:workers\.dev|ddl\.[^/]+)\/0:\/?$/i.test(l.href);
      if (!isRoot && l.containerHeading && subExplicitRegex.test(l.containerHeading) &&
          (actionButtonRegex.test(l.text) || subHeadingRegex.test(l.text) ||
           isHostOf(l.href, 'top4top.io') || isHostOf(l.href, 'mediafire.com') ||
           isHostOf(l.href, 'urls.mugi-subs.com') || isHostOf(l.href, 'tinyurl.com') ||
           isAnyHostOf(l.href, ['drive.google.com', 'mega.nz']))) {
        directSubLink = l.href;
        break;
      }
    }
  }

  // D. Contextual match: link inside a container/heading about subtitle
  if (!directSubLink) {
    for (const l of allLinks) {
      const isRoot = /(?:workers\.dev|ddl\.[^/]+)\/0:\/?$/i.test(l.href);
      if (!isRoot && l.containerHeading && subHeadingRegex.test(l.containerHeading) &&
          (actionButtonRegex.test(l.text) || subHeadingRegex.test(l.text) ||
           isHostOf(l.href, 'top4top.io') || isHostOf(l.href, 'mediafire.com') ||
           isHostOf(l.href, 'urls.mugi-subs.com') || isHostOf(l.href, 'tinyurl.com') ||
           isAnyHostOf(l.href, ['drive.google.com', 'mega.nz']))) {
        directSubLink = l.href;
        break;
      }
    }
  }

  // Fallback to parentContext
  if (!directSubLink) {
    for (const l of allLinks) {
      const isRoot = /(?:workers\.dev|ddl\.[^/]+)\/0:\/?$/i.test(l.href);
      if (!isRoot && subHeadingRegex.test(l.parentContext) && (actionButtonRegex.test(l.text) || subHeadingRegex.test(l.text) || isHostOf(l.href, 'top4top.io') || isHostOf(l.href, 'mediafire.com'))) {
        directSubLink = l.href;
        break;
      }
    }
  }

  // C. Find specific cloud & direct download providers (HEVC, H264, Softsub, Buzzheavier)
  let top4top = null;
  let mediafire = null;
  let mega = null;
  let drive = null;
  let fontsLink = null;
  let proton = null;
  let pixeldrain = null;
  let torrent = null;
  let buzzheavier = null;
  let hevcLink = null;
  let h264Link = null;

  if (pageUrl.toLowerCase().includes('buzzheavier.com')) {
    buzzheavier = pageUrl;
  }

  for (const l of allLinks) {
    const hrefLower = l.href.toLowerCase();
    const textLower = l.text.toLowerCase();
    const ctxLower = (l.containerHeading ? `${l.containerHeading} ${l.parentContext}` : l.parentContext).toLowerCase();

    const isSoft = textLower.includes('soft') || ctxLower.includes('soft') || !ctxLower.includes('hard');
    const isFont = (textLower.includes('الخطوط') || textLower === 'fonts' || (ctxLower.includes('الخطوط') && !ctxLower.includes('ترجم'))) &&
      !textLower.includes('ترجم') && !textLower.includes('sub');

    if (isFont && !fontsLink && !hrefLower.includes('.torrent') && !hrefLower.includes('twitter') && !hrefLower.includes('t.me')) {
      fontsLink = l.href;
    }

    if (isHostOf(l.href, 'top4top.io') && !top4top) top4top = l.href;
    if (isHostOf(l.href, 'mediafire.com') && isSoft && !mediafire) mediafire = l.href;
    if (isAnyHostOf(l.href, ['mega.nz', 'mega.co.nz']) && isSoft && !mega) mega = l.href;
    if (isAnyHostOf(l.href, ['drive.google.com', 'docs.google.com']) && isSoft && !drive) drive = l.href;
    if (isHostOf(l.href, 'proton.me') && isSoft && !proton) proton = l.href;
    if (isHostOf(l.href, 'pixeldrain.com') && isSoft && !pixeldrain) pixeldrain = l.href;
    if ((hrefLower.includes('.torrent') || hrefLower.includes('nyaa.si')) && !torrent) torrent = l.href;
    if (isHostOf(l.href, 'buzzheavier.com') && isSoft && !buzzheavier) buzzheavier = l.href;

    if ((textLower.includes('hevc') || textLower.includes('x265')) && isSoft && !hevcLink) hevcLink = l.href;
    if ((textLower.includes('h264') || textLower.includes('h.264') || textLower.includes('x264')) && isSoft && !h264Link) h264Link = l.href;
  }

  // Resolve shorteners before choosing a download method. This covers the
  // buttons used by Mugi, Mejaow and Blogger sites (TinyURL/URLs/go links).
  if (directSubLink && /(?:urls\.|redirect|go\.|link\.|tinyurl\.com|bit\.ly|t\.co|ouo\.|shrink)/i.test(directSubLink)) {
    directSubLink = await followRedirectUrl(directSubLink);
  }

  // Rocks-Team and Mugi style DDL/worker links lead to a directory or GoIndex.
  // Pick the actual subtitle/archive from that listing.
  if (directSubLink && /(?:workers\.dev|ddl\.[^/]+\/0:|\/0:|(?:subtitle|subtitles|ملفات(?:%20|\s)*الترجمة))/i.test(directSubLink) &&
      !/\.(?:ass|srt|zip|rar|7z)(?:$|[?#])/i.test(directSubLink)) {
    // F3: thread the no-redirect mode into the DDL/GoIndex resolver. The batch
    // options object stays verbatim so normal (non-recovery) callers are unchanged.
    const directoryOptions = { batch: Boolean(options.batch) };
    directoryOptions.redirect = options.redirect;
    const dirUrl = directSubLink;
    const resolvedFile = await resolveSubtitleFromDirectory(dirUrl, effectiveEp, directoryOptions);
    if (resolvedFile) {
      directSubLink = resolvedFile;
      if (!fontsLink) {
        const fontFile = await resolveFontFromDirectory(dirUrl, directoryOptions);
        if (fontFile) fontsLink = fontFile;
      }
    }
  }

  // A subtitle button can itself be a short link. Once expanded, expose the
  // underlying provider as well so the caller can use its folder/file resolver
  // after a plain HTTP download is unsuitable (notably Drive and MediaFire).
  const resolvedLower = (directSubLink || '').toLowerCase();
  if (isHostOf(directSubLink, 'top4top.io') && !top4top) top4top = directSubLink;
  if (isHostOf(directSubLink, 'mediafire.com') && !mediafire) mediafire = directSubLink;
  if (isAnyHostOf(directSubLink, ['drive.google.com', 'docs.google.com'])) drive = directSubLink;
  if (isAnyHostOf(directSubLink, ['mega.nz', 'mega.co.nz']) && !mega) mega = directSubLink;
  if (isHostOf(directSubLink, 'proton.me') && !proton) proton = directSubLink;
  if (isHostOf(directSubLink, 'pixeldrain.com') && !pixeldrain) pixeldrain = directSubLink;
  if ((resolvedLower.includes('.torrent') || resolvedLower.includes('nyaa.si')) && !torrent) torrent = directSubLink;
  if (isHostOf(directSubLink, 'buzzheavier.com') && !buzzheavier) buzzheavier = directSubLink;

  const bestDownloadUrl = directSubLink || (top4top || mediafire || hevcLink || h264Link || mega || drive || proton || pixeldrain || torrent || buzzheavier || null);

  const result = {
    title,
    pageUrl,
    bestDownloadUrl,
    videoLinks: {
      directSub: directSubLink,
      fonts: fontsLink,
      top4top,
      mediafire,
      mega,
      drive,
      proton,
      pixeldrain,
      torrent,
      buzzheavier,
      hevc: hevcLink,
      h264: h264Link
    }
  };

  // P1-1b: remember a page WITHOUT a usable link, so the next cycle answers
  // from the cache instead of re-fetching it. A failed fetch never reaches
  // this point (it returns null earlier), so only a genuinely link-less page
  // is remembered — a transient error can never poison the cache.
  if (!result.bestDownloadUrl && !result.videoLinks?.directSub) {
    negativeCacheStore(pageUrl, negativeNowImpl(), currentNegativeTtlMinutes());
  }

  return result;
}

// S1 — the hosts a Buzzheavier download may come from. The code only ever
// references buzzheavier.com, so that is the ONLY known host: an unknown
// host is NEVER fetched (fail closed).
const BUZZHEAVIER_HOSTS = ['buzzheavier.com'];

export function isBuzzheavierHost(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return BUZZHEAVIER_HOSTS.some(d => host === d || host.endsWith(`.${d}`));
}

// The absolute form of a Buzzheavier path (the page uses relative paths).
function buzzheavierAbsolute(pathOrUrl) {
  if (!pathOrUrl) return null;
  const raw = String(pathOrUrl).trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  return `https://buzzheavier.com${raw.startsWith('/') ? '' : '/'}${raw}`;
}

export async function resolveBuzzheavierDownloadUrl(buzzUrl) {
  // S1: the page url itself must be an https url of a known host.
  if (!buzzUrl || !isBuzzheavierHost(buzzUrl)) {
    console.warn(`   ⚠️ Buzzheavier link ignored: it is not hosted by buzzheavier.com (${logSafe(String(buzzUrl || ''))})`);
    return null;
  }

  try {
    const idMatch = buzzUrl.match(/buzzheavier\.com\/([a-zA-Z0-9_-]+)/i);
    const fileId = idMatch ? idMatch[1] : null;
    if (!fileId) return null;

    let downloadPath = null;
    const command = process.platform === 'win32' ? 'curl.exe' : 'curl';

    // 1. Fetch HTML of the buzzheavier page using curl with browser headers.
    // S1/SSRF: NO `-L` here. A 3xx is deliberately NOT followed: a public
    // buzzheavier page must never be able to redirect this process into an
    // internal/metadata address. The host guard above already refuses any
    // lookalike hostname before curl is spawned; the download endpoint below
    // uses `-I` (no -L) and validates every hx-redirect/location itself.
    let html = '';
    try {
      html = execFileSync(command, [
        '-s',
        '--max-time', '30',
        '--user-agent', UA,
        '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        '-H', 'Accept-Language: en-US,en;q=0.9',
        buzzUrl
      ], { encoding: 'utf8', timeout: 35000 });
    } catch (e) {
      console.warn(`Curl fetch error for Buzzheavier page:`, e.message);
    }

    if (html) {
      const hxMatch = html.match(/hx-get=["']([^"']*\/download[^"']*)["']/i);
      if (hxMatch) {
        downloadPath = hxMatch[1];
      } else {
        const copyMatch = html.match(/copyDownloadLink\(['"]([^'"]+)['"]\)/i);
        if (copyMatch) {
          downloadPath = copyMatch[1].replace(/\\/g, '');
        }
      }
    }

    if (!downloadPath) {
      downloadPath = `/${fileId}/download`;
    }

    const fullDlUrl = buzzheavierAbsolute(downloadPath);
    // S1: the download endpoint must be an https url of a known host.
    if (!isBuzzheavierHost(fullDlUrl)) {
      console.warn(`   ⚠️ Buzzheavier download endpoint ignored: unknown host (${logSafe(String(fullDlUrl || ''))})`);
      return null;
    }

    // 2. Request the download endpoint with HX-Request: true to obtain the direct CDN URL
    let headerText = '';
    try {
      headerText = execFileSync(command, [
        '-s', '-I',
        '--max-time', '30',
        '--user-agent', UA,
        '-H', 'HX-Request: true',
        '-H', `Referer: ${buzzUrl}`,
        fullDlUrl
      ], { encoding: 'utf8', timeout: 35000 });
    } catch (e) {
      console.warn(`Curl header error for Buzzheavier download endpoint:`, e.message);
    }

    if (headerText) {
      const hxRedirectMatch = headerText.match(/^hx-redirect:\s*(.+)$/im);
      if (hxRedirectMatch) {
        const redirectUrl = buzzheavierAbsolute(hxRedirectMatch[1]);
        // S1: the redirect target must be an https url of a known host — an
        // unknown host is NEVER fetched.
        if (redirectUrl && !isBuzzheavierHost(redirectUrl)) {
          console.warn(`   ⚠️ Buzzheavier redirect ignored: unknown host (${logSafe(redirectUrl)})`);
          return null;
        }
        if (redirectUrl && !redirectUrl.endsWith(`/${fileId}`) && !redirectUrl.endsWith(`/${fileId}/`) && redirectUrl !== buzzUrl) {
          return redirectUrl;
        }
      }

      const locationMatch = headerText.match(/^location:\s*(.+)$/im);
      if (locationMatch) {
        const locUrl = buzzheavierAbsolute(locationMatch[1]);
        if (locUrl && !isBuzzheavierHost(locUrl)) {
          console.warn(`   ⚠️ Buzzheavier redirect ignored: unknown host (${logSafe(locUrl)})`);
          return null;
        }
        if (locUrl && !locUrl.endsWith(`/${fileId}`) && !locUrl.endsWith(`/${fileId}/`) && locUrl !== buzzUrl) {
          return locUrl;
        }
      }
    }

    return fullDlUrl;
  } catch (err) {
    console.warn(`Could not resolve Buzzheavier link ${buzzUrl}:`, err.message);
    return null;
  }
}
