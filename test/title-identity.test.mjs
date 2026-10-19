import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolation: run in a temp working directory BEFORE importing any src module so
// the persistent title-map cache (data/title-map.json) never touches the repo.
// node --test runs each test file in its own process.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'title-identity-test-'));
process.chdir(tempDir);

const ti = await import('../src/title-identity.mjs');
const {
  normalizeQuery,
  normalizeTeamName,
  resolveCanonicalTitle,
  resolveCanonicalTitlesBatch,
  getCachedCanonical,
  resetCycleBudget,
  QUERY_BUDGET,
  CYCLE_BUDGET_MS,
  MAX_CONSECUTIVE_FAILURES,
  NEGATIVE_TTL_MS,
  __setFetchImpl,
  __setTitleMapFile,
  __resetTitleIdentityState,
} = ti;

const MAP_FILE = path.join(tempDir, 'data', 'title-map.json');

function okResponse(media) {
  return {
    status: 200,
    ok: true,
    json: async () => ({ data: { Page: { media } } }),
  };
}

const OVERGEARED_MEDIA = {
  id: 212888,
  title: { romaji: 'Overgeared', english: 'Overgeared' },
  synonyms: ['Tempal: Item no Chikara'],
};

beforeEach(() => {
  // Fresh state + fresh cache file per test: no cross-test cache bleed.
  fs.rmSync(MAP_FILE, { force: true });
  __setTitleMapFile(MAP_FILE);
  __resetTitleIdentityState();
  resetCycleBudget();
});

// ---------------------------------------------------------------------------
// normalizeQuery — binding contract examples
// ---------------------------------------------------------------------------
test('normalizeQuery contract examples', () => {
  assert.equal(normalizeQuery('[Crunchyroll] Tempal: Item no Chikara - 04'), 'Tempal Item no Chikara');
  assert.equal(normalizeQuery('[Crunchyroll] Overgeared - 04'), 'Overgeared');
  assert.equal(
    normalizeQuery('[Crunchyroll] Shinja Zero no Megami-sama to Hajimeru Isekai Kouryaku - 02'),
    'Shinja Zero no Megami sama to Hajimeru Isekai Kouryaku'
  );
  assert.equal(
    normalizeQuery('[Crunchyroll] Full Clearing Another World Under a Goddess with Zero Believers - 02'),
    'Full Clearing Another World Under a Goddess with Zero Believers'
  );
  assert.equal(normalizeQuery('[Crunchyroll] Shuiro no Kamen - 02'), 'Shuiro no Kamen');
  assert.equal(normalizeQuery('[Crunchyroll] The Vermilion Mask - 02'), 'The Vermilion Mask');
});

// ---------------------------------------------------------------------------
// normalizeTeamName — aliases + year-suffix strip (year strip BEFORE alias)
// ---------------------------------------------------------------------------
test('normalizeTeamName aliases and year-suffix stripping', () => {
  assert.equal(normalizeTeamName('bam'), 'bam25');
  assert.equal(normalizeTeamName('bam25'), 'bam25');
  assert.equal(normalizeTeamName('celectial'), 'celestial');
  assert.equal(normalizeTeamName('zaraxsubs'), 'zaraxsub');
  assert.equal(normalizeTeamName('netfli'), 'netflix');
  // Year strip (no separator required) happens BEFORE alias lookup:
  assert.equal(normalizeTeamName('bam_2025'), 'bam25');
  assert.equal(normalizeTeamName('bam (2025)'), 'bam25');
  assert.equal(normalizeTeamName('[bam (2025)]'), 'bam25');
  assert.equal(normalizeTeamName('subsplease2024'), 'subsplease');
});

// ---------------------------------------------------------------------------
// Trust guard — single-token queries require exact token-set equality
// ---------------------------------------------------------------------------
test('trust guard: single-token query accepts ONLY exact token-set equality', async () => {
  __setFetchImpl(async () => okResponse([OVERGEARED_MEDIA]));
  const r = await resolveCanonicalTitle('[Crunchyroll] Overgeared - 04');
  assert.deepEqual(r, { romaji: 'Overgeared', english: 'Overgeared' });
});

test('trust guard: single-token query REJECTS a multi-token field containing it', async () => {
  let calls = 0;
  __setFetchImpl(async () => {
    calls++;
    return okResponse([{
      id: 1,
      title: { romaji: 'Overgeared Zero Chronicles', english: null },
      synonyms: [],
    }]);
  });
  // "Overgeared" (1 token) must NOT match "Overgeared Zero Chronicles" (3 tokens)
  // even though the field contains the token.
  const r = await resolveCanonicalTitle('[Crunchyroll] Overgeared - 04');
  assert.equal(r, null);
  assert.equal(calls, 1);
});

test('trust guard: multi-token query accepts via synonym (Jaccard/exact)', async () => {
  __setFetchImpl(async () => okResponse([OVERGEARED_MEDIA]));
  const r = await resolveCanonicalTitle('[Crunchyroll] Tempal: Item no Chikara - 04');
  assert.deepEqual(r, { romaji: 'Overgeared', english: 'Overgeared' });
});

test('trust guard: low-similarity candidates are rejected (bias: reject)', async () => {
  let calls = 0;
  __setFetchImpl(async () => {
    calls++;
    return okResponse([{
      id: 42,
      title: { romaji: 'Sousou no Frieren', english: 'Frieren: Beyond Journey\'s End' },
      synonyms: [],
    }]);
  });
  const r = await resolveCanonicalTitle('[Crunchyroll] Overgeared - 04');
  assert.equal(r, null);
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// Cache behavior (fetch counter = ج/د)
// ---------------------------------------------------------------------------
test('resolveCanonicalTitle fetches exactly once per unique title (cache hit on 2nd)', async () => {
  let calls = 0;
  __setFetchImpl(async () => {
    calls++;
    return okResponse([OVERGEARED_MEDIA]);
  });
  const a = await resolveCanonicalTitle('[Crunchyroll] Overgeared - 04');
  const b = await resolveCanonicalTitle('[Crunchyroll] Overgeared - 04');
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  // sync cache-only accessor also sees it
  assert.deepEqual(getCachedCanonical('[Crunchyroll] Overgeared - 04'), { romaji: 'Overgeared', english: 'Overgeared' });
});

test('transient fetch failure -> null, never throws, NOT cached (second call re-fetches)', async () => {
  let calls = 0;
  __setFetchImpl(async () => {
    calls++;
    throw new Error('network down');
  });
  const r1 = await resolveCanonicalTitle('[Crunchyroll] Overgeared - 04');
  assert.equal(r1, null);
  const r2 = await resolveCanonicalTitle('[Crunchyroll] Overgeared - 04');
  assert.equal(r2, null);
  // Transient failure must not be cached: the second call attempts again.
  assert.equal(calls, 2);
});

test('HTTP non-200 -> null, no cache write (second call re-fetches)', async () => {
  let calls = 0;
  __setFetchImpl(async () => {
    calls++;
    return { status: 500, ok: false, json: async () => ({}) };
  });
  const r1 = await resolveCanonicalTitle('[Crunchyroll] Overgeared - 04');
  assert.equal(r1, null);
  const r2 = await resolveCanonicalTitle('[Crunchyroll] Overgeared - 04');
  assert.equal(r2, null);
  assert.equal(calls, 2);
  assert.equal(getCachedCanonical('[Crunchyroll] Overgeared - 04'), null);
});

test('genuine negative (successful fetch, no match) IS cached for 24h', async () => {
  let calls = 0;
  __setFetchImpl(async () => {
    calls++;
    return okResponse([]); // successful fetch, zero candidates
  });
  const r1 = await resolveCanonicalTitle('[Crunchyroll] Overgeared - 04');
  assert.equal(r1, null);
  const r2 = await resolveCanonicalTitle('[Crunchyroll] Overgeared - 04');
  assert.equal(r2, null);
  assert.equal(calls, 1); // second call served from negative cache
});

test('cache persistence: entry written to disk survives state reset (no new fetch)', async () => {
  let calls = 0;
  __setFetchImpl(async () => {
    calls++;
    return okResponse([OVERGEARED_MEDIA]);
  });
  const a = await resolveCanonicalTitle('[Crunchyroll] Overgeared - 04');
  assert.deepEqual(a, { romaji: 'Overgeared', english: 'Overgeared' });
  assert.ok(fs.existsSync(MAP_FILE), 'title-map.json must be written');

  // Simulate a fresh process: drop in-memory state, keep the file on disk.
  __resetTitleIdentityState();
  __setFetchImpl(async () => {
    throw new Error('must not fetch — cache should be loaded from disk');
  });
  const b = await resolveCanonicalTitle('[Crunchyroll] Overgeared - 04');
  assert.deepEqual(b, a);
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------
test('budget exhaustion -> null without fetching or caching', async () => {
  let calls = 0;
  __setFetchImpl(async () => {
    calls++;
    return okResponse([]); // negative-cache every one, consume budget
  });
  for (let i = 0; i < QUERY_BUDGET; i++) {
    const r = await resolveCanonicalTitle(`Budget Probe Show ${i}`);
    assert.equal(r, null);
  }
  assert.equal(calls, QUERY_BUDGET);
  // Budget now exhausted: no fetch attempted for a brand-new title.
  const r = await resolveCanonicalTitle('[Crunchyroll] Overgeared - 04');
  assert.equal(r, null);
  assert.equal(calls, QUERY_BUDGET);
});

// ---------------------------------------------------------------------------
// Batch + sync-equivalence (و)
// ---------------------------------------------------------------------------
test('resolveCanonicalTitlesBatch dedupes input; getCachedCanonical works afterwards', async () => {
  let calls = 0;
  __setFetchImpl(async () => {
    calls++;
    return okResponse([OVERGEARED_MEDIA]);
  });
  await resolveCanonicalTitlesBatch([
    '[Crunchyroll] Overgeared - 04',
    '[Crunchyroll] Overgeared - 04',          // exact duplicate
    '[Bam] Overgeared - 04 [1080p]',          // same normalized query
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(
    getCachedCanonical('[Crunchyroll] Overgeared - 04'),
    { romaji: 'Overgeared', english: 'Overgeared' }
  );
});

// ---------------------------------------------------------------------------
// Fix-pass hardening: cycle deadline / circuit-breaker / URL strip /
// future-ts clamp / atomic save
// ---------------------------------------------------------------------------
test('circuit-breaker: 3 consecutive transport failures stop fetching for the rest of the cycle', async () => {
  let calls = 0;
  __setFetchImpl(async () => {
    calls++;
    throw new Error('anilist down');
  });
  // Three distinct titles, each consumes budget, each fails -> counter = 3.
  const r1 = await resolveCanonicalTitle('[Crunchyroll] Alpha Circuit Show - 01');
  const r2 = await resolveCanonicalTitle('[Crunchyroll] Beta Circuit Show - 02');
  const r3 = await resolveCanonicalTitle('[Crunchyroll] Gamma Circuit Show - 03');
  assert.equal(r1, null);
  assert.equal(r2, null);
  assert.equal(r3, null);
  assert.equal(calls, MAX_CONSECUTIVE_FAILURES);

  // Breaker open: a 4th distinct title must NOT trigger a fetch attempt.
  const r4 = await resolveCanonicalTitle('[Crunchyroll] Delta Circuit Show - 04');
  assert.equal(r4, null);
  assert.equal(calls, MAX_CONSECUTIVE_FAILURES); // STAYS 3 — no 4th attempt

  // A new cycle closes the breaker -> fetching resumes.
  resetCycleBudget();
  const r5 = await resolveCanonicalTitle('[Crunchyroll] Epsilon Circuit Show - 05');
  assert.equal(r5, null);
  assert.equal(calls, MAX_CONSECUTIVE_FAILURES + 1); // fetch attempted again (4)
});

test('cycle deadline: past CYCLE_BUDGET_MS the cycle fails open with zero fetches', async () => {
  let calls = 0;
  __setFetchImpl(async () => {
    calls++;
    return okResponse([OVERGEARED_MEDIA]);
  });
  // Stub is installed AFTER resetCycleBudget so cycleStart records real time.
  resetCycleBudget();
  const realNow = Date.now;
  try {
    globalThis.Date.now = () => realNow() + CYCLE_BUDGET_MS + 5_000; // +25s
    const r = await resolveCanonicalTitle('[Crunchyroll] Deadline Probe Show - 07');
    assert.equal(r, null);
    assert.equal(calls, 0); // deadline fails open BEFORE any fetch
  } finally {
    globalThis.Date.now = realNow;
  }
});

test('normalizeQuery strips URLs so URL fragments never become cache keys', async () => {
  assert.equal(normalizeQuery('https://subdl.com/s/info/AbC123'), '');
  const q = normalizeQuery('[Subs] https://x.com/a Show Name - 01');
  assert.ok(!q.includes('http'));
  assert.equal(q, 'Show Name');
  // URL-only input -> empty query -> resolve returns null without fetching.
  let calls = 0;
  __setFetchImpl(async () => {
    calls++;
    return okResponse([OVERGEARED_MEDIA]);
  });
  const r = await resolveCanonicalTitle('https://subdl.com/s/info/AbC123');
  assert.equal(r, null);
  assert.equal(calls, 0);
});

test('future-dated negative ts is clamped: fetch IS attempted and the entry is refreshed', async () => {
  fs.mkdirSync(path.dirname(MAP_FILE), { recursive: true });
  const q = normalizeQuery('[Crunchyroll] Overgeared - 04');
  fs.writeFileSync(MAP_FILE, JSON.stringify({ [q]: { negative: true, ts: Date.now() + 1e12 } }));
  __resetTitleIdentityState();
  __setTitleMapFile(MAP_FILE);
  let calls = 0;
  __setFetchImpl(async () => {
    calls++;
    return okResponse([OVERGEARED_MEDIA]);
  });
  const r = await resolveCanonicalTitle('[Crunchyroll] Overgeared - 04');
  assert.equal(calls, 1, 'future-dated negative must NOT suppress the title');
  assert.deepEqual(r, { romaji: 'Overgeared', english: 'Overgeared' });
  const disk = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
  assert.equal(disk[q].negative, false, 'entry refreshed to a positive');
  assert.ok(Date.now() - Number(disk[q].ts) < 60_000, 'refreshed ts is fresh');
});

test('saveTitleMap: atomic write (tmp+rename) and prunes expired negatives', async () => {
  fs.mkdirSync(path.dirname(MAP_FILE), { recursive: true });
  const expiredKey = normalizeQuery('[Crunchyroll] Expired Probe Show - 09');
  fs.writeFileSync(MAP_FILE, JSON.stringify({
    [expiredKey]: { negative: true, ts: Date.now() - NEGATIVE_TTL_MS * 3 },
  }));
  __resetTitleIdentityState();
  __setTitleMapFile(MAP_FILE);
  let calls = 0;
  __setFetchImpl(async () => {
    calls++;
    return okResponse([OVERGEARED_MEDIA]);
  });
  const r = await resolveCanonicalTitle('[Crunchyroll] Overgeared - 04');
  assert.deepEqual(r, { romaji: 'Overgeared', english: 'Overgeared' });
  assert.equal(calls, 1);
  // Reload from disk: must parse as valid JSON, expired negative gone,
  // new positive entry present, no leftover .tmp file.
  const disk = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
  assert.ok(!(expiredKey in disk), 'expired negative must be pruned from disk');
  assert.equal(disk[normalizeQuery('[Crunchyroll] Overgeared - 04')].negative, false);
  assert.ok(!fs.existsSync(`${MAP_FILE}.tmp`), 'tmp file must not survive the rename');
});
