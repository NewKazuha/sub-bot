import * as cheerio from 'cheerio';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { matchesEpisode } from './cloud-folders.mjs';
import { fetchRenderedHtml, isRocksDdlHost } from './browser-fetch.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const HTTP_TIMEOUT_MS = 60_000;

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
    if (epNorm && t === epNorm) return false;
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

function fetchWithTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  return fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(timeoutMs) });
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

async function ensureSiteSession(siteConfig) {
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
        headers: { 'User-Agent': UA }
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
      headers: { 'User-Agent': UA }
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

export async function followRedirectUrl(url, maxHops = 3) {
  if (!url || !url.startsWith('http')) return url;
  let curr = url;
  for (let i = 0; i < maxHops; i++) {
    try {
      // Many link shorteners (including Blogger redirect pages) reject HEAD.
      // Try HEAD first, then use a redirect-only GET without downloading the body.
      let res = await fetchWithTimeout(curr, {
        method: 'HEAD',
        redirect: 'manual',
        headers: { 'User-Agent': UA }
      });
      if (![301, 302, 303, 307, 308].includes(res.status)) {
        try { await res.body?.cancel(); } catch {}
        res = await fetchWithTimeout(curr, {
          method: 'GET',
          redirect: 'manual',
          headers: { 'User-Agent': UA, 'Range': 'bytes=0-0' }
        });
      }
      const loc = res.headers.get('location');
      if (loc && (res.status >= 300 && res.status < 400)) {
        curr = new URL(loc, curr).toString();
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

export async function resolveGoIndexSubtitle(directoryUrl, targetEp = null) {
  try {
    const base = directoryUrl.endsWith('/') ? directoryUrl : directoryUrl + '/';

    let files = [];

    // 1. Try application/json (Mejaow / modern GoIndex workers)
    try {
      const resJson = await fetchWithTimeout(directoryUrl, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_token: null, page_index: 0 })
      });
      if (resJson.ok) {
        const json = await resJson.json().catch(() => null);
        if (json?.data?.files) files = json.data.files;
      }
    } catch {}

    // 2. Try application/x-www-form-urlencoded (Rocks-Team / HashHackers GDI workers)
    if (!files.length) {
      try {
        const formParams = new URLSearchParams();
        formParams.append('password', '');
        formParams.append('page_token', '');
        formParams.append('page_index', '0');

        const resForm = await fetchWithTimeout(directoryUrl, {
          method: 'POST',
          headers: {
            'User-Agent': UA,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: formParams.toString()
        });

        if (resForm.ok) {
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
      } catch {}
    }

    if (!files.length) return null;

    const subFiles = files.filter(f => /\.(ass|srt|zip|rar|7z)$/i.test(f.name || ''));
    if (!subFiles.length) return null;

    let chosen = subFiles[subFiles.length - 1];
    if (targetEp) {
      const epNorm = String(targetEp).replace(/^0+/, '');
      const match = subFiles.find(f => {
        const found = (f.name || '').match(/(\d{1,4})/g) || [];
        return found.some(n => n.replace(/^0+/, '') === epNorm);
      });
      if (match) chosen = match;
    }

    return `${base}${encodeURIComponent(chosen.name)}`;
  } catch {
    return null;
  }
}

export async function resolveSubtitleFromDirectory(directoryUrl, targetEp = null) {
  // Rocks-Team DDL is Cloudflare-protected: the listing only exists in a
  // browser, so it is rendered with headless Chromium instead of fetched.
  const isRocks = isRocksDdlHost(directoryUrl);

  if (!isRocks && /(?:workers\.dev|ddl\.[^/]+|\/0:)/i.test(directoryUrl)) {
    const goIndexFile = await resolveGoIndexSubtitle(directoryUrl, targetEp);
    if (goIndexFile) return goIndexFile;
  }

  try {
    let html = null;
    if (isRocks) {
      html = await fetchRenderedHtml(directoryUrl);
      if (!html) return null;
    } else {
      const res = await fetchWithTimeout(directoryUrl, { headers: { 'User-Agent': UA } });
      if (!res.ok) return null;
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

    if (targetEp) {
      const epNorm = String(targetEp).replace(/^0+/, '');
      const match = candidates.find(u => {
        const found = u.match(/(\d{1,4})/g) || [];
        return found.some(n => n.replace(/^0+/, '') === epNorm);
      });
      if (match) return match;
    }

    // Prefer an archive because fansub releases commonly bundle fonts with it.
    return candidates.find(url => /\.(?:zip|rar|7z)(?:$|[?#])/i.test(url)) || candidates[0] || null;
  } catch (e) {
    console.warn(`Could not inspect subtitle directory ${directoryUrl}:`, e.message);
    return null;
  }
}

export async function scrapePostPage(pageUrl, siteConfig = null, targetEp = null, releaseTitle = null) {
  // Mugi-Subs is Cloudflare-403 for datacenter IPs, so scrapePostPage must not
  // fetch the article. Resolve the subtitle through the public worker API and
  // never fall through to the blocked page.
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
    const jar = await ensureSiteSession(siteConfig);
    if (jar) cookieHeader = jar.header();
  }

  const effectiveEp = targetEp || (pageUrl.match(/[-_](\d{1,4})(?:\.html)?$/i)?.[1]) || null;

  let html = '';
  // Revive Subs is behind Cloudflare which blocks datacenter IPs.
  // Use curl_cffi with Chrome impersonation if available.
  if (siteConfig?.id === 'revive' || (siteConfig?.base && siteConfig.base.includes('revivesubs'))) {
    const cfHtml = fetchHtmlWithImpersonation(pageUrl, cookieHeader);
    if (cfHtml) {
      console.log(`   🛡️ Successfully bypassed Cloudflare for ${siteConfig.name} via curl_cffi!`);
      html = cfHtml;
    }
  }

  if (!html) {
    try {
      const res = await fetchWithTimeout(pageUrl, {
        headers: { 'User-Agent': UA, 'Cookie': cookieHeader }
      });
      html = await res.text();
      // If Cloudflare challenge returned (challenge page / 403 / 503), try impersonation fallback
      if (html.includes('Just a moment...') || html.includes('cf-chl-') || res.status === 403 || res.status === 503) {
        console.log(`   🛡️ Cloudflare challenge detected (${res.status}), attempting curl_cffi fallback...`);
        const cfHtml = fetchHtmlWithImpersonation(pageUrl, cookieHeader);
        if (cfHtml) html = cfHtml;
      }
    } catch (e) {
      if (siteConfig && isCertificateValidationError(e)) {
        try {
          console.warn(`Node TLS validation failed for ${siteConfig.name}; using the system CA bundle.`);
          html = fetchHtmlWithCurl(pageUrl, cookieHeader);
        } catch (curlError) {
          console.error(`Failed to fetch ${siteConfig.name} page with system CA bundle: ${pageUrl}`, curlError.message);
          return null;
        }
      } else {
        console.error(`Failed to fetch page: ${pageUrl}`, e.message);
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
      if (!isIgnored) {
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

        allLinks.push({ href, text, parentContext, containerHeading });
      }
    }
  });

  // 1. Check for dedicated Subtitle / Font links
  // Patterns used by the fansub sites: "ملف الترجمة والخطوط", "ملف الترجمة",
  // "Softsub", and buttons labelled "هنا" or "التحميل" under these headings.
  const subExplicitRegex = /(?:ملف\s*(?:الترجمة|الترجمات|الخطوط)|(?:الترجمة|الترجمات)\s*(?:و\s*الخطوط)?|subtitles?)/i;
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

  // D. Contextual match: link inside a container/heading about subtitle
  if (!directSubLink) {
    for (const l of allLinks) {
      const isRoot = /(?:workers\.dev|ddl\.[^/]+)\/0:\/?$/i.test(l.href);
      if (!isRoot && l.containerHeading && subHeadingRegex.test(l.containerHeading) &&
          (actionButtonRegex.test(l.text) || subHeadingRegex.test(l.text) ||
           l.href.includes('top4top.io') || l.href.includes('mediafire.com') ||
           l.href.includes('urls.mugi-subs.com') || l.href.includes('tinyurl.com') ||
           l.href.includes('drive.google.com') || l.href.includes('mega.nz'))) {
        directSubLink = l.href;
        break;
      }
    }
  }

  // Fallback to parentContext
  if (!directSubLink) {
    for (const l of allLinks) {
      const isRoot = /(?:workers\.dev|ddl\.[^/]+)\/0:\/?$/i.test(l.href);
      if (!isRoot && subHeadingRegex.test(l.parentContext) && (actionButtonRegex.test(l.text) || subHeadingRegex.test(l.text) || l.href.includes('top4top.io') || l.href.includes('mediafire.com'))) {
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

    if (hrefLower.includes('top4top.io') && !top4top) top4top = l.href;
    if (hrefLower.includes('mediafire.com') && isSoft && !mediafire) mediafire = l.href;
    if (hrefLower.includes('mega.nz') && isSoft && !mega) mega = l.href;
    if ((hrefLower.includes('drive.google.com') || hrefLower.includes('docs.google.com')) && isSoft && !drive) drive = l.href;
    if (hrefLower.includes('proton.me') && isSoft && !proton) proton = l.href;
    if (hrefLower.includes('pixeldrain.com') && isSoft && !pixeldrain) pixeldrain = l.href;
    if ((hrefLower.includes('.torrent') || hrefLower.includes('nyaa.si')) && !torrent) torrent = l.href;
    if (hrefLower.includes('buzzheavier.com') && isSoft && !buzzheavier) buzzheavier = l.href;

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
    const resolvedFile = await resolveSubtitleFromDirectory(directSubLink, effectiveEp);
    if (resolvedFile) directSubLink = resolvedFile;
  }

  // A subtitle button can itself be a short link. Once expanded, expose the
  // underlying provider as well so the caller can use its folder/file resolver
  // after a plain HTTP download is unsuitable (notably Drive and MediaFire).
  const resolvedLower = (directSubLink || '').toLowerCase();
  if (resolvedLower.includes('top4top.io') && !top4top) top4top = directSubLink;
  if (resolvedLower.includes('mediafire.com') && !mediafire) mediafire = directSubLink;
  if (resolvedLower.includes('drive.google.com') || resolvedLower.includes('docs.google.com')) drive = directSubLink;
  if (resolvedLower.includes('mega.nz') && !mega) mega = directSubLink;
  if (resolvedLower.includes('proton.me') && !proton) proton = directSubLink;
  if (resolvedLower.includes('pixeldrain.com') && !pixeldrain) pixeldrain = directSubLink;
  if ((resolvedLower.includes('.torrent') || resolvedLower.includes('nyaa.si')) && !torrent) torrent = directSubLink;
  if (resolvedLower.includes('buzzheavier.com') && !buzzheavier) buzzheavier = directSubLink;

  const bestDownloadUrl = directSubLink || (top4top || mediafire || hevcLink || h264Link || mega || drive || proton || pixeldrain || torrent || buzzheavier || null);

  return {
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
}

export async function resolveBuzzheavierDownloadUrl(buzzUrl) {
  if (!buzzUrl || !buzzUrl.includes('buzzheavier.com')) return null;

  try {
    const idMatch = buzzUrl.match(/buzzheavier\.com\/([a-zA-Z0-9_-]+)/i);
    const fileId = idMatch ? idMatch[1] : null;
    if (!fileId) return null;

    let downloadPath = null;
    const command = process.platform === 'win32' ? 'curl.exe' : 'curl';

    // 1. Fetch HTML of the buzzheavier page using curl with browser headers
    let html = '';
    try {
      html = execFileSync(command, [
        '-s', '-L',
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

    const fullDlUrl = downloadPath.startsWith('http')
      ? downloadPath
      : `https://buzzheavier.com${downloadPath.startsWith('/') ? '' : '/'}${downloadPath}`;

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
        const redirectUrl = hxRedirectMatch[1].trim();
        if (redirectUrl && !redirectUrl.endsWith(`/${fileId}`) && !redirectUrl.endsWith(`/${fileId}/`) && redirectUrl !== buzzUrl) {
          return redirectUrl;
        }
      }

      const locationMatch = headerText.match(/^location:\s*(.+)$/im);
      if (locationMatch) {
        const locUrl = locationMatch[1].trim();
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
