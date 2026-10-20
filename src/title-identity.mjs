// ====================================================================
// Title Identity Layer (additive-only)
//
// Prevents duplicate publishing of the same episode under different
// language titles (same official source) via a resolve-on-miss AniList
// lookup, plus fansub team-name normalization (aliases + year-suffix
// strip). Design constraints:
//   - AniList failure NEVER stops publishing (fail-open; callers fall
//     back to text keys when the resolver returns null).
//   - Transient failures (fetch throw/timeout/non-200/parse) are NOT
//     cached; only genuine negatives (successful fetch, no trusted
//     candidate) are negative-cached (24h TTL).
//   - Wrong mapping is worse than a duplicate: the trust guard biases
//     REJECT (single-token queries require exact token-set equality).
// Node builtins + global fetch only — no heavy imports.
// ====================================================================
import fs from 'node:fs';
import path from 'node:path';

export const QUERY_BUDGET = 20;        // AniList fetches per cycle
export const MAX_CONCURRENCY = 3;      // parallel AniList fetches
export const FETCH_TIMEOUT_MS = 5000;
export const NEGATIVE_TTL_MS = 86_400_000; // 24h
export const CYCLE_BUDGET_MS = 20_000; // wall-clock deadline per check cycle
export const MAX_CONSECUTIVE_FAILURES = 3; // transport failures -> breaker opens

const ANILIST_URL = 'https://graphql.anilist.co';
// NOTE: deliberately no `native` field (see guard corrections C4).
// Enrichment (episode-numbering fix): `episodes` powers the sequel-overflow
// gate; `relations` exposes the SEQUEL edge so cumulative episode counts
// (e.g. "2nd Season - 13" on a 12-episode season) can be cross-linked.
const ANILIST_QUERY =
  'query ($search: String) { Page(perPage: 5) { media(search: $search, type: ANIME) { id title { romaji english } synonyms episodes relations { edges { relationType node { id episodes title { romaji english } } } } } } }';

// Fansub team alias map (exact-match on the normalized token; year suffix is
// stripped BEFORE alias lookup so "[bam (2025)]" -> bam -> bam25).
const TEAM_ALIASES = {
  bam: 'bam25',
  celectial: 'celestial',
  zaraxsubs: 'zaraxsub',
  netfli: 'netflix',
};

// Injectable fetch impl (default: global fetch). Never throws.
let fetchImpl = (...args) => globalThis.fetch(...args);
let titleMapFile = path.resolve('data', 'title-map.json');
let titleMap = null; // lazy, loaded once per process
let budgetUsed = 0;
let cycleStart = Date.now();
let consecutiveFailures = 0;
let activeFetches = 0;
const waitQueue = [];

// --------------------------------------------------------------------
// Test hooks
// --------------------------------------------------------------------
export function __setFetchImpl(fn) {
  fetchImpl = typeof fn === 'function' ? fn : (...args) => globalThis.fetch(...args);
}
export function __setTitleMapFile(p) {
  titleMapFile = String(p);
  titleMap = null;
}
export function __resetTitleIdentityState() {
  titleMap = null;
  budgetUsed = 0;
  activeFetches = 0;
  waitQueue.length = 0;
  fetchImpl = (...args) => globalThis.fetch(...args);
}

export function resetCycleBudget() {
  budgetUsed = 0;
  cycleStart = Date.now();
  consecutiveFailures = 0;
}

// --------------------------------------------------------------------
// Persistent cache (data/title-map.json), keyed by normalized query:
//   { id, romaji, english, synonyms: [...], negative: false, ts }
//   or { negative: true, ts }
// Absent/corrupt file -> treated as empty, never throws.
// --------------------------------------------------------------------
export function loadTitleMap() {
  if (titleMap) return titleMap;
  try {
    const raw = fs.readFileSync(titleMapFile, 'utf8');
    const parsed = JSON.parse(raw);
    titleMap = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    console.warn('title-map.json unreadable/corrupt — starting with empty cache:', e.message);
    titleMap = {};
  }
  return titleMap;
}

export function saveTitleMap() {
  try {
    // Prune expired negative entries (kept 2x TTL as a grace window) so the
    // file cannot grow without bound.
    const out = {};
    for (const [key, entry] of Object.entries(titleMap || {})) {
      if (entry && entry.negative === true && Date.now() - (Number(entry.ts) || 0) > NEGATIVE_TTL_MS * 2) continue;
      out[key] = entry;
    }
    fs.mkdirSync(path.dirname(titleMapFile), { recursive: true });
    // Write-then-rename on the same filesystem: readers never observe a
    // partially written file.
    const tmp = `${titleMapFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, titleMapFile);
  } catch {
    // Cache persistence is best-effort; never let it break resolution.
  }
}

// --------------------------------------------------------------------
// normalizeQuery — ordered pipeline (binding contract; see tests).
// --------------------------------------------------------------------
export function normalizeQuery(rawTitle) {
  let s = String(rawTitle ?? '');
  // 0. strip URLs (a URL fragment must never become a cache key)
  s = s.replace(/https?:\/\/[^\s]+/gi, ' ');
  // 1. strip leading platform bracket (first one only)
  s = s.replace(/^\[[^\]]*\]\s*/, '');
  // 2. strip file extensions
  s = s.replace(/\.(ass|srt|zip|rar|7z)\b/gi, '');
  // 3. strip remaining [brackets]
  s = s.replace(/\[[^\]]*\]/g, ' ');
  // 4. strip (parentheses)
  s = s.replace(/\([^)]*\)/g, ' ');
  // Strip trailing scene/platform/language tags ONLY after episode or quality tokens
  s = s.replace(/(\b(?:s\d{1,2}e\d{1,4}|\d{1,4}|web-?dl|webrip|1080p|720p|bdrip|hevc)\b)(?:\s+[\(\[]?(?:cr|hidive|nf|netflix|dsnp|amzn|web-?dl|web-?rip|1080p|720p|480p|arabic|ara\s+ar|ar|multi-?subs?)[\)\]]?)+\s*$/i, '$1');
  // 5. strip quality/codec tokens
  s = s.replace(/\b(1080p|720p|480p|2160p|4k|bd|bdrip|web-?dl|webrip|hevc|h264|x264|x265|aac|flac)\b/gi, ' ');
  // 6. strip SxxEyy
  s = s.replace(/\bS\d{1,2}E\d{1,3}\b/gi, ' ');
  // 7. strip "ep 04" / "episode 4" / "e04" forms
  s = s.replace(/\b(ep(isode)?|e)\s*\.?\s*\d{1,4}(v\d+)?\b/gi, ' ');
  // 8. strip trailing episode forms " - 04"
  s = s.replace(/\s*-\s*\d{1,4}(v\d+)?\b/g, ' ');
  // 9. strip versioned numbers "04v2"
  s = s.replace(/\b\d{1,4}v\d+\b/gi, ' ');
  // 10. strip batch ranges "01 - 12" / "01 ~ 12"
  s = s.replace(/\b\d{1,4}\s*[-~]\s*\d{1,4}\b/g, ' ');
  // 11. strip years
  s = s.replace(/\b(19|20)\d{2}\b/g, ' ');
  // 12. strip season/part/cour words
  s = s.replace(/\b(season|part|cour)\s*\d*\b/gi, ' ');
  s = s.replace(/\d+(st|nd|rd|th)\s+season\b/gi, ' ');
  // 13. replace remaining non-letter/non-digit (keep whitespace) with space
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  // 14. collapse whitespace + trim
  return s.replace(/\s+/g, ' ').trim();
}

// --------------------------------------------------------------------
// normalizeTeamName — ORDER IS BINDING (correction C4):
//   (1) lowercase + trim
//   (2) strip parenthetical years  /\((?:19|20)\d{2}\)/g
//   (3) non-letter/non-digit runs -> '_', collapse, trim '_'
//   (4) strip trailing 4-digit year /(?:19|20)\d{2}$/ (no separator needed;
//      no alias target ends with a 19xx/20xx year — 'bam25' is 2 digits)
//   (5) exact alias lookup on the resulting token
// Year strip BEFORE alias is mandatory (fixes "[bam (2025)]" -> bam -> bam25).
// --------------------------------------------------------------------
export function normalizeTeamName(raw) {
  let s = String(raw ?? '').toLowerCase().trim();
  s = s.replace(/\((?:19|20)\d{2}\)/g, '');
  s = s.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
  s = s.replace(/(?:19|20)\d{2}$/, '').replace(/^_+|_+$/g, '');
  if (TEAM_ALIASES[s]) s = TEAM_ALIASES[s];
  return s;
}

// --------------------------------------------------------------------
// Trust guard — bias REJECT (constraint د). Compares the normalized
// query tokens against candidate fields [title.romaji, title.english,
// ...synonyms] ONLY (NO native).
// --------------------------------------------------------------------
function tokenize(s) {
  return String(s ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function passesTrustGuard(qTokens, candidate) {
  const fields = [
    candidate?.title?.romaji,
    candidate?.title?.english,
    ...(Array.isArray(candidate?.synonyms) ? candidate.synonyms : []),
  ].filter(f => typeof f === 'string' && f.trim());

  for (const field of fields) {
    const fTokens = Array.from(new Set(tokenize(field)));
    if (fTokens.length === 0) continue;

    if (qTokens.length === 1) {
      // Single-token queries: exact token-set equality ONLY (no Jaccard path).
      if (fTokens.length === 1 && fTokens[0] === qTokens[0]) return true;
      continue;
    }

    // qTokens.length >= 2: Jaccard >= 0.3 OR subset either way.
    const qSet = new Set(qTokens);
    let inter = 0;
    for (const t of qSet) if (fTokens.includes(t)) inter++;
    const union = qSet.size + fTokens.length - inter;
    if (union > 0 && inter / union >= 0.3) return true;
    if (fTokens.every(t => qSet.has(t))) return true; // fieldTokens ⊆ qTokens
    if (qTokens.every(t => fTokens.includes(t))) return true; // qTokens ⊆ fieldTokens
  }
  return false;
}

// --------------------------------------------------------------------
// Semaphore (max MAX_CONCURRENCY concurrent AniList fetches)
// --------------------------------------------------------------------
async function acquireSlot() {
  if (activeFetches < MAX_CONCURRENCY) {
    activeFetches++;
    return;
  }
  await new Promise(res => waitQueue.push(res));
  // slot handed over by releaseSlot()
}
function releaseSlot() {
  const next = waitQueue.shift();
  if (next) next(); // transfer the slot to the next waiter
  else activeFetches--;
}

function tryConsumeBudget() {
  if (budgetUsed >= QUERY_BUDGET) return false;
  budgetUsed++;
  return true;
}

// --------------------------------------------------------------------
// buildCanonicalResult — CONDITIONAL enrichment of a positive cache entry
// (binding contract, episode-numbering fix):
//   - base output is ALWAYS exactly { romaji, english };
//   - `episodes`   — only when a positive integer (null/0/absent = unknown);
//   - `relations`  — the edges array, only when present/non-empty;
//   - `sequel`     — first SEQUEL edge as { id, episodes, romaji, english };
//   - NEVER null placeholders: old-shaped entries (no episodes/relations)
//     must keep returning EXACTLY { romaji, english } (strict deepEqual).
// --------------------------------------------------------------------
function buildCanonicalResult(entry) {
  if (!entry || entry.negative) return null;
  const out = {
    romaji: entry.romaji ?? null,
    english: entry.english ?? null,
  };
  if (Number.isInteger(entry.episodes) && entry.episodes > 0) {
    out.episodes = entry.episodes;
  }
  if (Array.isArray(entry.relations) && entry.relations.length > 0) {
    out.relations = entry.relations;
  }
  const edges = Array.isArray(entry.relations) ? entry.relations : [];
  const sequelEdge = edges.find(e => e && e.relationType === 'SEQUEL' && e.node);
  const sequelSrc = sequelEdge ? sequelEdge.node : (entry.sequel && entry.sequel.id != null ? entry.sequel : null);
  if (sequelSrc && sequelSrc.id != null) {
    out.sequel = {
      id: sequelSrc.id,
      episodes: Number.isInteger(sequelSrc.episodes) ? sequelSrc.episodes : null,
      romaji: sequelSrc.romaji ?? sequelSrc.title?.romaji ?? null,
      english: sequelSrc.english ?? sequelSrc.title?.english ?? null,
    };
  }
  return out;
}

// --------------------------------------------------------------------
// resolveCanonicalTitle — never throws. Cache hit / negative hit /
// budget exhaustion return without fetching.
// --------------------------------------------------------------------
export async function resolveCanonicalTitle(rawTitle) {
  try {
    const q = normalizeQuery(rawTitle);
    if (q.length < 2) return null;

    const map = loadTitleMap();
    const entry = map[q];
    if (entry && !entry.negative) {
      return buildCanonicalResult(entry);
    }
    if (entry && entry.negative) {
      // FIX-5 [future-ts clamp]: clamp the stored ts to "now"; a ts that was
      // still ahead of the clock is stale/corrupt and is treated as expired
      // (fail-open to a refetch) instead of suppressing the title forever.
      const rawTs = Number(entry?.ts) || 0;
      const ts = Math.min(rawTs, Date.now());
      const wasFutureDated = ts !== rawTs;
      if (!wasFutureDated && Date.now() - ts < NEGATIVE_TTL_MS) {
        return null; // negative cache hit (fresh)
      }
    }
    // expired (or future-dated) negative falls through to a fresh fetch

    // FIX-1: cycle wall-clock deadline — fail-open: no budget, no fetch.
    if (Date.now() - cycleStart > CYCLE_BUDGET_MS) return null;
    // FIX-2: consecutive transport failures — breaker open for this cycle.
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return null;

    if (!tryConsumeBudget()) return null; // budget exhausted: nothing cached

    await acquireSlot();
    let res;
    try {
      res = await fetchImpl(ANILIST_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query: ANILIST_QUERY, variables: { search: q } }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'error', // FIX-3: never follow a redirect to an unknown host
      });
    } catch (e) {
      consecutiveFailures++; // FIX-2: transport throw / timeout
      throw e;               // -> outer catch returns null (nothing cached)
    } finally {
      releaseSlot();
    }

    // Transient failure: HTTP non-200 -> null, DO NOT cache.
    if (!res || res.status !== 200) {
      consecutiveFailures++; // FIX-2: non-200 counts as a transport failure
      return null;
    }
    consecutiveFailures = 0; // FIX-2: a successful fetch re-closes the breaker

    let json;
    try {
      json = await res.json();
    } catch {
      return null; // JSON parse error -> transient, DO NOT cache
    }

    const media = json?.data?.Page?.media;
    if (!Array.isArray(media)) return null; // malformed shape -> transient, DO NOT cache

    const candidates = media.slice(0, 5);
    if (candidates.length === 0) {
      map[q] = { negative: true, ts: Date.now() };
      saveTitleMap();
      return null;
    }

    for (const candidate of candidates) {
      if (passesTrustGuard(tokenize(q), candidate)) {
        const romaji = candidate?.title?.romaji || null;
        const english = candidate?.title?.english || null;
        const entryOut = {
          id: candidate?.id ?? null,
          romaji,
          english,
          synonyms: Array.isArray(candidate?.synonyms) ? candidate.synonyms.slice() : [],
          negative: false,
          ts: Date.now(),
        };
        // Episode-numbering enrichment: persist ONLY what the API actually
        // returned (absent field => old-shaped entry => { romaji, english }).
        if (candidate?.episodes !== undefined) entryOut.episodes = candidate.episodes; // number|null as returned
        const edges = Array.isArray(candidate?.relations?.edges) ? candidate.relations.edges : null;
        // Cap stored edges (F9) to bound cache growth; the SEQUEL derived
        // below still scans the full response before capping.
        if (edges) entryOut.relations = edges.slice(0, 20);
        const sequelEdge = edges ? edges.find(e => e && e.relationType === 'SEQUEL' && e.node && e.node.id != null) : null;
        if (sequelEdge) {
          entryOut.sequel = {
            id: sequelEdge.node.id,
            episodes: Number.isInteger(sequelEdge.node.episodes) ? sequelEdge.node.episodes : null,
            romaji: sequelEdge.node.title?.romaji ?? null,
            english: sequelEdge.node.title?.english ?? null,
          };
        }
        map[q] = entryOut;
        saveTitleMap();
        // Same conditional shape as the cache-hit path (single builder).
        return buildCanonicalResult(entryOut);
      }
    }

    // Successful fetch but no candidate passed the guard -> genuine negative.
    map[q] = { negative: true, ts: Date.now() };
    saveTitleMap();
    return null;
  } catch {
    return null; // never throws
  }
}

// --------------------------------------------------------------------
// getCachedCanonical — synchronous, cache-only (used inside sync loops).
// --------------------------------------------------------------------
export function getCachedCanonical(rawTitle) {
  try {
    const q = normalizeQuery(rawTitle);
    if (q.length < 2) return null;
    const entry = loadTitleMap()[q];
    if (!entry || entry.negative) return null;
    // Same enriched conditional shape as resolveCanonicalTitle — this feeds
    // the sync pre-pass in telegram-client (getCachedCanonical call sites).
    return buildCanonicalResult(entry);
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------
// resolveCanonicalTitlesBatch — prefetch helper for the sync pre-pass:
// dedupes input (by normalized query), bounded concurrency 3, respects
// budget. Returns void, never throws.
// --------------------------------------------------------------------
export async function resolveCanonicalTitlesBatch(titles) {
  try {
    const unique = [];
    const seen = new Set();
    for (const t of Array.isArray(titles) ? titles : []) {
      if (typeof t !== 'string') continue;
      const q = normalizeQuery(t);
      if (q.length < 2 || seen.has(q)) continue;
      seen.add(q);
      unique.push(t);
    }
    let i = 0;
    const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, unique.length) }, async () => {
      while (i < unique.length) {
        const idx = i++;
        await resolveCanonicalTitle(unique[idx]);
      }
    });
    await Promise.all(workers);
  } catch {
    // never throws
  }
}

// --------------------------------------------------------------------
// buildSyntheticTitle — rebuild the original title with the anime-name
// region replaced by a dictionary title string, preserving the leading
// platform bracket, the episode token (text/spacing verbatim) and any
// trailing tags. Used by the synthetic re-run families in
// telegram-client.mjs. Exported for tests (fidelity assertions).
// Returns null when no safe split point is found (caller skips).
// --------------------------------------------------------------------
export function buildSyntheticTitle(originalTitle, replacementName) {
  try {
    const title = String(originalTitle ?? '');
    const name = String(replacementName ?? '').trim();
    if (!title || !name) return null;

    const platformMatch = title.match(/^\[[^\]]*\]\s*/);
    const platform = platformMatch ? platformMatch[0] : '';
    const rest = title.slice(platform.length);

    // Skip batch ranges entirely: with two numbers the "episode token" split
    // is ambiguous, and a wrong synthetic key could wrongly suppress a
    // legitimate release (bias: reject over-guessing).
    if (/\d{1,4}\s*[-~]\s*\d{1,4}/.test(rest.replace(/\[[^\]]*\]/g, ' '))) return null;

    // Locate the episode token. The leading-whitespace requirement for the
    // dash form prevents matching internal hyphens ("Spy x Family").
    const EP_PATTERNS = [
      /\s+-\s*\d{1,4}(?:\s*v\d+)?(?=\s|$|\[|\()/,
      /\s+ep(?:isode)?\.?\s*\d{1,4}(?:\s*v\d+)?(?=\s|$|\[|\()/i,
      /\s+e\.?\s*\d{1,4}(?:\s*v\d+)?(?=\s|$|\[|\()/i,
      /#\s*\d{1,4}(?:\s*v\d+)?(?=\s|$|\[|\()/,
      /\s+S\d{1,2}E\d{1,3}(?:\s*v\d+)?(?=\s|$|\[|\()/i,
    ];
    let epIdx = -1;
    let epMatch = null;
    for (const re of EP_PATTERNS) {
      const m = rest.match(re);
      if (m && (epIdx === -1 || m.index < epIdx)) {
        epIdx = m.index;
        epMatch = m;
      }
    }

    if (epIdx > 0 && epMatch) {
      const nameRegion = rest.slice(0, epIdx).trim();
      if (!nameRegion) return null;
      const suffix = rest.slice(epIdx); // episode token + trailing tags, verbatim
      return `${platform}${name}${suffix}`;
    }

    // No episode token: replace the name region but keep trailing [tags] verbatim.
    const tagMatch = rest.match(/((?:\s*\[[^\]]*\]\s*)+)$/);
    const trailingTags = tagMatch ? tagMatch[1] : '';
    const nameRegion = rest.slice(0, rest.length - trailingTags.length).trim();
    if (!nameRegion) return null;
    return `${platform}${name}${trailingTags}`;
  } catch {
    return null;
  }
}
