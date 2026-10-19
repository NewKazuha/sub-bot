import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolation: run in a temp working directory BEFORE importing any src module so
// the persistent title-map cache (data/title-map.json) never touches the repo.
// node --test runs each test file in its own process.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'episode-numbering-test-'));
process.chdir(tempDir);

// Namespace imports (NOT named): a missing export must fail per-test at call
// time (TypeError) instead of failing the whole file at link time.
const ti = await import('../src/title-identity.mjs');
const tc = await import('../src/telegram-client.mjs');

const {
  normalizeQuery,
  resolveCanonicalTitle,
  getCachedCanonical,
  resetCycleBudget,
  __setFetchImpl,
  __setTitleMapFile,
  __resetTitleIdentityState,
} = ti;

const MAP_FILE = path.join(tempDir, 'data', 'title-map.json');

// ---------------------------------------------------------------------------
// The live defect pair (A = sequel part title, B = cumulative episode title)
// ---------------------------------------------------------------------------
const A = '[Disney+] Yozakura-san Chi no Daisakusen 2nd Season Part 2 - 01';
const B = '[Disney+] Yozakura-san Chi no Daisakusen 2nd Season - 13 [P2 - 01]';
// normalizeQuery(A) === normalizeQuery(B) (verified): one stub entry answers both.
const EXPECTED_Q = 'Yozakura san Chi no Daisakusen 2nd';

// AniList-shaped fixture: 182578 "2nd Season" episodes=12 with SEQUEL -> 213657.
const YOZAKURA_MEDIA = {
  id: 182578,
  title: {
    romaji: 'Yozakura-san Chi no Daisakusen 2nd Season',
    english: 'Mission: Yozakura Family Season 2',
  },
  synonyms: [],
  episodes: 12,
  relations: {
    edges: [{
      relationType: 'SEQUEL',
      node: {
        id: 213657,
        episodes: null,
        title: {
          romaji: 'Yozakura-san Chi no Daisakusen 2nd Season Part 2',
          english: 'Mission: Yozakura Family Season 2 Part 2',
        },
      },
    }],
  },
};

// Stub AniList fetch routed on the NORMALIZED search string (never the network).
function makeYozakuraFetch(media = YOZAKURA_MEDIA) {
  const state = { calls: 0, searches: [] };
  const impl = async (url, options) => {
    state.calls++;
    const body = JSON.parse(options.body);
    const search = String(body?.variables?.search || '');
    state.searches.push(search);
    const page = search === EXPECTED_Q ? [media] : [];
    return { status: 200, ok: true, json: async () => ({ data: { Page: { media: page } } }) };
  };
  return { impl, state };
}

const RESOLVED_SHAPE = {
  romaji: 'Yozakura-san Chi no Daisakusen 2nd Season',
  english: 'Mission: Yozakura Family Season 2',
};
// A's base fullNorm key — the fingerprint the sequel synthesis must reproduce.
const A_FULL_NORM = 'disney_yozakura_san_chi_no_daisakusen_2nd_season_part_2_01';
const A_CORE_KEY = 'yozakura_san_chi_no_daisakusen_2nd_season_part_2_01';
// B's fast-path alt title AFTER F1: secondary bracket stripped — the
// bracket-less per-part release title (" - 01" primary, no "[P2 - 01]").
const B_PER_PART = '[Disney+] Yozakura-san Chi no Daisakusen 2nd Season - 01';
const B_PER_PART_FULL_NORM = 'disney_yozakura_san_chi_no_daisakusen_2nd_season_01';
// The STALE un-stripped form (kept only to prove its keys do NOT leak).
const B_ALT = '[Disney+] Yozakura-san Chi no Daisakusen 2nd Season - 01 [P2 - 01]';
const B_ALT_FULL_NORM = 'disney_yozakura_san_chi_no_daisakusen_2nd_season_01_p2_01';

beforeEach(() => {
  // Fresh state + fresh cache file per test: no cross-test cache bleed.
  fs.rmSync(MAP_FILE, { force: true });
  __setTitleMapFile(MAP_FILE);
  __resetTitleIdentityState();
  resetCycleBudget();
});

// ---------------------------------------------------------------------------
// 1 — extractBatchRange must not read "Part 2 - 01" as range [2, 1]
// ---------------------------------------------------------------------------
test("extractBatchRange: ignores 'Part 2 - 01' and false ranges (returns null)", () => {
  assert.equal(tc.extractBatchRange(A), null, "defect A '… Part 2 - 01' must not read as a range");
  assert.equal(tc.extractBatchRange(B), null, "defect B must not read as a range");
  assert.equal(tc.extractBatchRange('[Subs] Some Show Part 2 - 01'), null);
  assert.equal(tc.extractBatchRange('[Subs] Some Show Season 3 - 05'), null);
  assert.equal(tc.extractBatchRange('[Subs] Some Show Cour 2 - 03'), null);
  // Regression: a genuinely trailing ascending range is still found.
  assert.deepEqual(tc.extractBatchRange('[Subs] Some Show 01-13'), [1, 13]);
});

// ---------------------------------------------------------------------------
// 2 — valid batch ranges survive; descending ranges (rules 1-2 were ungated)
// ---------------------------------------------------------------------------
test("extractBatchRange: preserves valid batch ranges ('01-13' and '[01 - 13 END]')", () => {
  assert.deepEqual(tc.extractBatchRange('[Subs] Some Show 01-13'), [1, 13], 'trailing 01-13 must stay [1,13]');
  assert.deepEqual(tc.extractBatchRange('[Subs] Some Show [01 - 13 END]'), [1, 13], '[01 - 13 END] must stay [1,13]');
  assert.deepEqual(tc.extractBatchRange('[Subs] Some Show 001~005'), [1, 5], 'tilde range must survive');
  assert.equal(tc.extractBatchRange('[Subs] Some Show 13-01'), null, 'descending trailing range must be rejected');
  assert.equal(tc.extractBatchRange('[Subs] Some Show [13 - 01]'), null, 'descending bracketed range must be rejected');
  assert.equal(tc.extractBatchRange('[Subs] Some Show 05~05'), null, 'start == end is not a batch');
});

// ---------------------------------------------------------------------------
// 3 — fast-path secondary-episode extraction from bracketed markers
// ---------------------------------------------------------------------------
test("fast-path: extracts secondary episode from bracketed '[P2 - 01]' or '[Part 2 - 01]'", () => {
  assert.equal(tc.extractSecondaryEpisodeNumber(B), '1');
  assert.equal(tc.extractSecondaryEpisodeNumber('[Subs] Some Show - 05 [Part 2 - 01]'), '1');
  assert.equal(tc.extractSecondaryEpisodeNumber('[Subs] Some Show - 05 [Cour 2 - 03]'), '3');
  assert.equal(tc.extractSecondaryEpisodeNumber('[Subs] Some Show - 05 [P2 - 10]'), '10');
  assert.equal(tc.extractSecondaryEpisodeNumber(A), '', 'A has no secondary bracket');

  // Emission (behavior, not an implementation title): with a non-null resolved
  // object, B's keys must be a SUPERSET of the bracket-less per-part release's
  // own keys — fast-path resolves B to the same family the per-part post
  // itself would produce.
  const resolved = { ...RESOLVED_SHAPE, episodes: 12 };
  const withFastPath = tc.getReleaseKeys(B, true, resolved);
  const perPartKeys = tc.getReleaseKeys(B_PER_PART, true, null);
  assert.ok(perPartKeys.length > 0, 'per-part title must produce keys');
  for (const k of perPartKeys) {
    assert.ok(withFastPath.includes(k), `fast-path key missing from B's keys: ${k}`);
  }
  // F1: the stale secondary-bracket suffix (_p2_01) must NOT survive into the
  // fast-path keys — no key unique to the un-stripped form may be emitted.
  assert.ok(!withFastPath.includes(B_ALT_FULL_NORM), 'stale _p2_01 fullNorm leaked into fast-path keys');
  const staleKeys = tc.getReleaseKeys(B_ALT, true, null).filter(k => !perPartKeys.includes(k));
  assert.ok(staleKeys.length > 0, 'un-stripped alt must produce distinguishable keys');
  for (const k of staleKeys) {
    assert.ok(!withFastPath.includes(k), `stale secondary-bracket key leaked into fast-path: ${k}`);
  }
});

// ---------------------------------------------------------------------------
// 4 — standalone part/season brackets carry NO secondary episode
// ---------------------------------------------------------------------------
test("fast-path guard: ignores standalone '[Part 2]' or '[Season 2]' without secondary episode", () => {
  assert.equal(tc.extractSecondaryEpisodeNumber('[Subs] Some Show [Part 2]'), '');
  assert.equal(tc.extractSecondaryEpisodeNumber('[Subs] Some Show [Season 2]'), '');
  assert.equal(tc.extractSecondaryEpisodeNumber('[Subs] Some Show [P2]'), '');
  assert.equal(tc.extractSecondaryEpisodeNumber('[Subs] Some Show [Cour 2]'), '');
  assert.equal(tc.extractSecondaryEpisodeNumber(''), '');
  assert.equal(tc.extractSecondaryEpisodeNumber(null), '');

  // Without a secondary bracket no fast-path keys can be added at all.
  const resolved = { ...RESOLVED_SHAPE, episodes: 12 };
  const withResolved = tc.getReleaseKeys(A, true, resolved);
  const plain = tc.getReleaseKeys(A, true, { romaji: RESOLVED_SHAPE.romaji, english: RESOLVED_SHAPE.english });
  assert.deepEqual(withResolved, plain, 'no fast-path deltas on a bracket-less title');
});

// ---------------------------------------------------------------------------
// 5 — sequel overflow gate + 1-indexed difference (13 - 12 = 1)
// ---------------------------------------------------------------------------
test('sequel overflow: epNum > episodes calculates sequel difference (13 - 12 = 1) and emits sequel keys', async () => {
  const { impl } = makeYozakuraFetch();
  __setFetchImpl(impl);

  const resolvedB = await resolveCanonicalTitle(B);
  assert.ok(resolvedB && typeof resolvedB === 'object', 'resolve must return an object');
  assert.equal(resolvedB.episodes, 12, 'resolver must expose episodes=12');
  assert.ok(resolvedB.sequel && resolvedB.sequel.id === 213657, 'resolver must expose the SEQUEL edge');
  assert.equal(resolvedB.sequel.episodes, null, 'sequel node episodes:null is surfaced as null');
  assert.equal(resolvedB.sequel.romaji, 'Yozakura-san Chi no Daisakusen 2nd Season Part 2');
  // diff = 13 - 12 = 1 (1-indexed, no off-by-one): the synthesized sequel
  // title equals A exactly, so A's key family must be unioned into B's keys.
  assert.equal(Number(tc.extractEpisodeNumber(B)) - resolvedB.episodes, 1);

  const keysB = tc.getReleaseKeys(B, true, resolvedB);
  const keysA = tc.getReleaseKeys(A, true, null);
  const hits = keysA.filter(k => keysB.includes(k));
  assert.ok(hits.length > 0, `expected sequel keys (diff 1) intersecting A; got 0 of ${keysA.length}`);
  assert.ok(keysB.includes(A_FULL_NORM), `sequel fullNorm key missing; keys=${JSON.stringify(keysB)}`);

  // Fansub path emits the same sequel family. Team token comes from the
  // title's platform bracket "[Disney+]" -> non-alnum collapsed/trimmed ->
  // "disney"; the sequel core key is prefixed ("fansub_disney_..."), so the
  // assertion must include it (an unprefixed core key can never match).
  const fansubB = tc.getFansubReleaseKeys(B, resolvedB);
  const fansubA = tc.getFansubReleaseKeys(A, null);
  assert.ok(fansubA.filter(k => fansubB.includes(k)).length > 0, 'fansub sequel keys missing');
  assert.ok(
    fansubB.includes('fansub_disney_' + A_CORE_KEY),
    `exact fansub sequel core key missing; keys=${JSON.stringify(fansubB)}`
  );
});

// ---------------------------------------------------------------------------
// 6 — bidirectional dedup: A blocks B AND B blocks A
// ---------------------------------------------------------------------------
test('sequel overflow: bidirectional deduplication (A blocks B, and B blocks A)', async () => {
  const { impl } = makeYozakuraFetch();
  __setFetchImpl(impl);

  const resolvedA = await resolveCanonicalTitle(A);
  const resolvedB = await resolveCanonicalTitle(B); // cache hit: same normalized query

  let posted = new Set(tc.getReleaseKeys(A, true, resolvedA));
  assert.equal(
    tc.isReleaseAlreadyPosted(posted, tc.getReleaseKeys(B, true, resolvedB)),
    true,
    'B must be blocked by A'
  );

  posted = new Set(tc.getReleaseKeys(B, true, resolvedB));
  assert.equal(
    tc.isReleaseAlreadyPosted(posted, tc.getReleaseKeys(A, true, resolvedA)),
    true,
    'A must be blocked by B'
  );

  // Both sides resolve to the same enriched identity (same normalized query).
  assert.deepEqual(resolvedA, resolvedB, 'A and B resolve to the same identity');
  assert.equal(resolvedA.episodes, 12);
  assert.ok(resolvedA.sequel);
});

// ---------------------------------------------------------------------------
// 7 — fail-open: episodes:null -> unknown; AniList down -> null -> base keys
// ---------------------------------------------------------------------------
test('sequel overflow: fail-open when episodes is null or AniList is down', async () => {
  // (a) episodes:null is unknown: enriched resolve WITHOUT episodes, no sequel keys, no throw
  const { impl } = makeYozakuraFetch({ ...YOZAKURA_MEDIA, episodes: null });
  __setFetchImpl(impl);
  const r = await resolveCanonicalTitle(B);
  assert.ok(r && typeof r === 'object', 'resolve must return an object');
  assert.ok(!('episodes' in r), 'episodes:null must be omitted (treated as unknown)');
  assert.ok(Array.isArray(r.relations), 'enriched resolve must expose relations when present');
  assert.ok(r.sequel && r.sequel.id === 213657, 'enriched resolve must expose sequel when a SEQUEL edge exists');

  const withEps = tc.getReleaseKeys(B, true, r);
  const plain = tc.getReleaseKeys(B, true, { romaji: r.romaji, english: r.english });
  assert.deepEqual(withEps, plain, 'no sequel keys may fire while episodes is unknown');
  assert.ok(!withEps.includes(A_FULL_NORM), 'sequel fullNorm must be absent while episodes unknown');

  // (b) AniList down -> resolved === null -> base keys, zero throws
  fs.rmSync(MAP_FILE, { force: true });
  __setTitleMapFile(MAP_FILE);
  __resetTitleIdentityState();
  resetCycleBudget();
  __setFetchImpl(async () => { throw new Error('AniList is down'); });
  const resolvedDown = await resolveCanonicalTitle(B);
  assert.equal(resolvedDown, null);
  assert.deepEqual(tc.getReleaseKeys(B, true, resolvedDown), tc.getReleaseKeys(B, true));
  assert.deepEqual(tc.getFansubReleaseKeys(B, resolvedDown), tc.getFansubReleaseKeys(B));
  assert.deepEqual(tc.getReleaseKeys(B, true, resolvedDown), tc.getReleaseKeys(B, true, null));
});

// ---------------------------------------------------------------------------
// Extra (i) — old cache entries (no episodes/relations/sequel) stay EXACTLY
// {romaji, english} and can never emit sequel keys.
// ---------------------------------------------------------------------------
test('old cache entry without episodes/relations/sequel returns exactly {romaji, english} and emits no sequel keys', async () => {
  const q = normalizeQuery(A);
  fs.mkdirSync(path.dirname(MAP_FILE), { recursive: true });
  fs.writeFileSync(MAP_FILE, JSON.stringify({
    [q]: {
      id: 182578,
      romaji: RESOLVED_SHAPE.romaji,
      english: RESOLVED_SHAPE.english,
      synonyms: [],
      negative: false,
      ts: Date.now(),
    },
  }));
  __setTitleMapFile(MAP_FILE);
  __resetTitleIdentityState();
  __setFetchImpl(async () => { throw new Error('must not fetch — cache hit expected'); });

  const fromCache = getCachedCanonical(A);
  assert.deepEqual(fromCache, RESOLVED_SHAPE, 'old-shaped cache entries must stay EXACTLY {romaji, english}');
  const resolved = await resolveCanonicalTitle(B);
  assert.deepEqual(resolved, RESOLVED_SHAPE, 'old-shaped resolve must stay EXACTLY {romaji, english}');
  assert.ok(!('episodes' in resolved) && !('relations' in resolved) && !('sequel' in resolved));

  const keys = tc.getReleaseKeys(B, true, resolved);
  assert.ok(!keys.includes(A_FULL_NORM), 'old-shaped entry must not emit sequel keys');
  assert.ok(!keys.includes(A_CORE_KEY), 'old-shaped entry must not emit sequel core keys');
  // Base key family is untouched (additive layer only when data is known).
  for (const k of tc.getReleaseKeys(B, true, null)) {
    assert.ok(keys.includes(k), `base key missing under old-shaped resolve: ${k}`);
  }
});

// ---------------------------------------------------------------------------
// Extra (ii) — episodes: 0 is unknown (omitted), so no overflow fires; the
// SAME shape with a known episodes DOES overflow (contrast).
// ---------------------------------------------------------------------------
test('episodes: 0 is treated as unknown (resolver omits it; no sequel overflow)', async () => {
  const { impl } = makeYozakuraFetch({ ...YOZAKURA_MEDIA, episodes: 0 });
  __setFetchImpl(impl);
  const r = await resolveCanonicalTitle(B);
  assert.ok(r && typeof r === 'object', 'resolve must return an object');
  assert.ok(!('episodes' in r), 'episodes:0 must be omitted (treated as unknown)');
  assert.ok(Array.isArray(r.relations), 'relations stay exposed when present');
  assert.ok(r.sequel && r.sequel.id === 213657, 'sequel stays exposed when a SEQUEL edge exists');

  const keys = tc.getReleaseKeys(B, true, r);
  assert.ok(!keys.includes(A_FULL_NORM), 'no sequel overflow while episodes is 0/unknown');

  // Contrast: identical resolved shape with episodes known -> overflow fires.
  const withKnown = tc.getReleaseKeys(B, true, { ...r, episodes: 12 });
  assert.ok(withKnown.includes(A_FULL_NORM), 'sequel overflow must fire once episodes is known');

  // F5 fail-CLOSED guard: sequel total KNOWN (2) and diff (13 - 10 = 3)
  // exceeds it -> this release cannot be that sequel -> NO sequel keys
  // (bias: wrong suppression is worse than a duplicate). The branch above
  // (sequel.episodes null) still allows, proving unknown total = fail-open.
  const overSequel = tc.getReleaseKeys(B, true, {
    ...r,
    episodes: 10,
    sequel: { ...r.sequel, episodes: 2 },
  });
  assert.ok(!overSequel.includes(A_FULL_NORM), 'fail-closed: diff 3 > sequel total 2 must not emit sequel keys');
});

// ---------------------------------------------------------------------------
// Extra (iii) — acceptance و: resolved=null on defect B = pre-fix-shaped base
// keys (no fast-path, no sequel additions on the null path).
// ---------------------------------------------------------------------------
test('resolved=null on defect title B yields the pre-fix-shaped base keys (no fast-path/sequel additions)', () => {
  const nullKeys = tc.getReleaseKeys(B, true, null);
  assert.deepEqual(nullKeys, tc.getReleaseKeys(B, true), 'explicit-null and default call must match');
  // Pre-fix base key families of B (unchanged: B never had a batch range).
  assert.ok(nullKeys.includes('disney_yozakura_san_chi_no_daisakusen_2nd_season_13_p2_01'), 'fullNorm base key missing');
  assert.ok(nullKeys.includes('yozakura_san_chi_no_daisakusen_2nd_season_13_p2_01'), 'coreKey base key missing');
  // No enrichment families on the null path:
  assert.ok(!nullKeys.includes(A_FULL_NORM), 'no sequel keys on resolved=null');
  assert.ok(!nullKeys.includes(B_ALT_FULL_NORM), 'no fast-path keys on resolved=null');
  assert.ok(!nullKeys.includes(B_PER_PART_FULL_NORM), 'no stripped fast-path keys on resolved=null');
  assert.deepEqual(tc.getFansubReleaseKeys(B, null), tc.getFansubReleaseKeys(B));
});
