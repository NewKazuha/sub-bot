import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolation: temp cwd BEFORE importing src modules so data/posted.json and
// data/title-map.json in the repo are never touched by tests.
// node --test runs each test file in its own process.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-test-'));
process.chdir(tempDir);

const ti = await import('../src/title-identity.mjs');
const {
  resolveCanonicalTitle,
  resolveCanonicalTitlesBatch,
  getCachedCanonical,
  resetCycleBudget,
  buildSyntheticTitle,
  __setFetchImpl,
  __setTitleMapFile,
  __resetTitleIdentityState,
} = ti;
const { getReleaseKeys, getFansubReleaseKeys, isReleaseAlreadyPosted } = await import('../src/telegram-client.mjs');

const MAP_FILE = path.join(tempDir, 'data', 'title-map.json');

// ---------------------------------------------------------------------------
// Fixtures — AniList-shaped payloads for three cross-language pairs (أ)
// ---------------------------------------------------------------------------
const PAIRS = [
  {
    media: {
      id: 212888,
      title: { romaji: 'Overgeared', english: 'Overgeared' },
      synonyms: ['Tempal: Item no Chikara'],
    },
    a: '[Crunchyroll] Overgeared - 04',
    b: '[Crunchyroll] Tempal: Item no Chikara - 04',
  },
  {
    media: {
      id: 205896,
      title: {
        romaji: 'Shinja Zero no Megami-sama to Hajimeru Isekai Kouryaku',
        english: 'Full Clearing Another World Under a Goddess with Zero Believers',
      },
      synonyms: [
        'Shinja Zero no Megami-sama to Hajimeru Isekai Kouryaku',
        'Full Clearing Another World Under a Goddess with Zero Believers',
      ],
    },
    a: '[Crunchyroll] Shinja Zero no Megami-sama to Hajimeru Isekai Kouryaku - 02',
    b: '[Crunchyroll] Full Clearing Another World Under a Goddess with Zero Believers - 02',
  },
  {
    media: {
      id: 195571,
      title: { romaji: 'Shuiro no Kamen', english: 'The Vermilion Mask' },
      synonyms: ['Shuiro no Kamen', 'The Vermilion Mask'],
    },
    a: '[Crunchyroll] Shuiro no Kamen - 02',
    b: '[Crunchyroll] The Vermilion Mask - 02',
  },
];

// Stub AniList fetch: routes a normalized query to the fixture whose fields
// share tokens with the query. Never touches the network.
function makeFetchStub() {
  const state = { calls: 0, searches: [] };
  const impl = async (url, options) => {
    state.calls++;
    const body = JSON.parse(options.body);
    const search = String(body?.variables?.search || '');
    state.searches.push(search);
    const q = search.toLowerCase();
    const toks = new Set(q.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    const media = PAIRS.filter(p =>
      [p.media.title.romaji, p.media.title.english, ...p.media.synonyms].some(field =>
        String(field).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).some(t => toks.has(t))
      )
    ).map(p => p.media);
    return { status: 200, ok: true, json: async () => ({ data: { Page: { media } } }) };
  };
  return { impl, state };
}

// Production call-site shape: resolve once, then generate keys with the result.
async function keysWithResolution(title, isOfficial = true) {
  const resolved = await resolveCanonicalTitle(title);
  return isOfficial ? getReleaseKeys(title, isOfficial, resolved) : getFansubReleaseKeys(title, resolved);
}

beforeEach(() => {
  fs.rmSync(MAP_FILE, { force: true });
  __setTitleMapFile(MAP_FILE);
  __resetTitleIdentityState();
  resetCycleBudget();
});

// ---------------------------------------------------------------------------
// أ — 3 cross-language pairs intersect in BOTH directions
// ---------------------------------------------------------------------------
test('أ: cross-language pair 1 (Overgeared <-> Tempal) blocked in both directions', async () => {
  const { impl } = makeFetchStub();
  __setFetchImpl(impl);
  const [A, B] = [PAIRS[0].a, PAIRS[0].b];

  let posted = new Set(await keysWithResolution(A));
  assert.equal(isReleaseAlreadyPosted(posted, await keysWithResolution(B)), true, 'B should be blocked by A');

  posted = new Set(await keysWithResolution(B));
  assert.equal(isReleaseAlreadyPosted(posted, await keysWithResolution(A)), true, 'A should be blocked by B');
});

test('أ: cross-language pair 2 (Shinja Zero <-> Full Clearing) blocked in both directions', async () => {
  const { impl } = makeFetchStub();
  __setFetchImpl(impl);
  const [A, B] = [PAIRS[1].a, PAIRS[1].b];

  let posted = new Set(await keysWithResolution(A));
  assert.equal(isReleaseAlreadyPosted(posted, await keysWithResolution(B)), true, 'B should be blocked by A');

  posted = new Set(await keysWithResolution(B));
  assert.equal(isReleaseAlreadyPosted(posted, await keysWithResolution(A)), true, 'A should be blocked by B');
});

test('أ: cross-language pair 3 (Shuiro no Kamen <-> The Vermilion Mask) blocked in both directions', async () => {
  const { impl } = makeFetchStub();
  __setFetchImpl(impl);
  const [A, B] = [PAIRS[2].a, PAIRS[2].b];

  let posted = new Set(await keysWithResolution(A));
  assert.equal(isReleaseAlreadyPosted(posted, await keysWithResolution(B)), true, 'B should be blocked by A');

  posted = new Set(await keysWithResolution(B));
  assert.equal(isReleaseAlreadyPosted(posted, await keysWithResolution(A)), true, 'A should be blocked by B');
});

// ---------------------------------------------------------------------------
// ب — 4 team-name pairs intersect (raw <-> alias / year-suffixed)
// ---------------------------------------------------------------------------
test('ب: fansub team pairs (bam/bam25, celectial/celestial, zaraxsub/zaraxsubs, netfli/netflix) intersect', () => {
  const pairs = [
    ['[bam] Show X - 01', '[bam25] Show X - 01'],
    ['[celectial] Show X - 01', '[celestial] Show X - 01'],
    ['[zaraxsub] Show X - 01', '[zaraxsubs] Show X - 01'],
    ['[netfli] Show X - 01', '[netflix] Show X - 01'],
  ];
  for (const [t1, t2] of pairs) {
    const k1 = getFansubReleaseKeys(t1);
    const k2 = getFansubReleaseKeys(t2);
    const inter = k1.filter(k => k2.includes(k));
    assert.ok(inter.length > 0, `expected non-empty intersection for ${t1} vs ${t2}; got ${JSON.stringify({ k1, k2 })}`);
  }
});

// ---------------------------------------------------------------------------
// ج — total AniList failure: publishing path continues with text keys, no throw
// ---------------------------------------------------------------------------
test('ج: AniList fully down -> resolver returns null, keys equal base keys, zero throws', async () => {
  __setFetchImpl(async () => {
    throw new Error('AniList is down');
  });
  const title = '[Crunchyroll] Overgeared - 04';
  // Exercise the exact candidate flow the bot uses.
  const resolved = await resolveCanonicalTitle(title);
  assert.equal(resolved, null);
  const official = getReleaseKeys(title, true, resolved);
  assert.deepEqual(official, getReleaseKeys(title, true, null));
  const fansub = getFansubReleaseKeys(title, resolved);
  assert.deepEqual(fansub, getFansubReleaseKeys(title, null));
});

// ---------------------------------------------------------------------------
// د — integration: resolved once, then cache (fetch counter === 1)
// ---------------------------------------------------------------------------
test('د: same candidate title twice through resolve+keys flow -> exactly 1 fetch', async () => {
  const { impl, state } = makeFetchStub();
  __setFetchImpl(impl);
  const title = '[Crunchyroll] Tempal: Item no Chikara - 04';
  await keysWithResolution(title);
  await keysWithResolution(title);
  assert.equal(state.calls, 1);
});

// ---------------------------------------------------------------------------
// هـ — superset: new keys ⊇ old keys for same input (additive only)
// ---------------------------------------------------------------------------
test('هـ: getReleaseKeys(T, true, resolved) is a superset of getReleaseKeys(T, true)', async () => {
  const { impl } = makeFetchStub();
  __setFetchImpl(impl);
  for (const p of PAIRS) {
    const resolved = await resolveCanonicalTitle(p.a);
    const oldKeys = getReleaseKeys(p.a, true);
    const newKeys = getReleaseKeys(p.a, true, resolved);
    for (const k of oldKeys) {
      assert.ok(newKeys.includes(k), `old official key missing from new set: ${k}`);
    }
  }
});

test('هـ: getFansubReleaseKeys(T, resolved) is a superset of getFansubReleaseKeys(T)', async () => {
  const { impl } = makeFetchStub();
  __setFetchImpl(impl);
  const t = '[bam] Tempal: Item no Chikara - 01';
  const resolved = await resolveCanonicalTitle(t);
  const oldKeys = getFansubReleaseKeys(t);
  const newKeys = getFansubReleaseKeys(t, resolved);
  for (const k of oldKeys) {
    assert.ok(newKeys.includes(k), `old fansub key missing from new set: ${k}`);
  }
});

// ---------------------------------------------------------------------------
// و — explicit canonical family + synthetic re-run families are present
// ---------------------------------------------------------------------------
test('و: resolved keys include explicit canonical family + synthetic re-runs of the other variant', async () => {
  const { impl } = makeFetchStub();
  __setFetchImpl(impl);
  const A = PAIRS[0].a; // "[Crunchyroll] Overgeared - 04"
  const B = PAIRS[0].b; // "[Crunchyroll] Tempal: Item no Chikara - 04"

  const keysA = await keysWithResolution(A);
  // Explicit canonical family: <canonSlug>_ep_<ev>_<source>
  assert.ok(keysA.includes('overgeared_ep_04_crunchyroll'), `missing canonical key; keys=${JSON.stringify(keysA)}`);
  assert.ok(keysA.includes('overgeared_ep_4_crunchyroll'));

  // Synthetic re-runs: processing the Synonym-side title with resolution must
  // emit base keys derived from the OTHER variant's text ("Overgeared").
  const keysB = await keysWithResolution(B);
  assert.ok(keysB.includes('crunchyroll_overgeared_04'), `missing synthetic base key of other variant; keys=${JSON.stringify(keysB)}`);
  // ...and the canonical family is also emitted on the synonym side.
  assert.ok(keysB.includes('overgeared_ep_04_crunchyroll'));
});

// ---------------------------------------------------------------------------
// ز2 forward — old text-key post + other-language arrival WITH resolution -> blocked
// ---------------------------------------------------------------------------
test('ز2 forward: old 2-arg post of variant A blocks variant B when B is resolved', async () => {
  const { impl } = makeFetchStub();
  __setFetchImpl(impl);
  // Pre-fix equivalent: stored keys were generated with the 2-arg call (no canonical).
  const posted = new Set(getReleaseKeys(PAIRS[0].a, true));
  const candidateKeys = await keysWithResolution(PAIRS[0].b);
  assert.equal(isReleaseAlreadyPosted(posted, candidateKeys), true);
});

// ---------------------------------------------------------------------------
// ز2 reverse — sync-simulated: pre-fix post whose stored text equals only a
// Synonym gets canonical keys added by the 300-message sync, then the
// other-language arrival WITH resolution is blocked.
// (In production, pre-fix posts whose stored text equals only a Synonym are
// closed by the 300-message sync window.)
// ---------------------------------------------------------------------------
test('ز2 reverse: sync ingestion of synonym-side post blocks romaji-side arrival', async () => {
  const { impl } = makeFetchStub();
  __setFetchImpl(impl);
  const B = PAIRS[0].b; // "[Crunchyroll] Tempal: Item no Chikara - 04"

  // Pre-fix posted keys for B (text-only, no canonical family):
  const posted = new Set(getReleaseKeys(B, true));
  // What the fixed 300-message sync does in production for each synced message:
  const syncedResolved = await resolveCanonicalTitle(B);
  getReleaseKeys(B, true, syncedResolved).forEach(k => posted.add(k));

  // The romaji-side arrival, processed WITH resolution, must now be blocked.
  const candidateKeys = await keysWithResolution(PAIRS[0].a);
  assert.equal(isReleaseAlreadyPosted(posted, candidateKeys), true);
});

// ---------------------------------------------------------------------------
// Reconstruction fidelity (C1) — implemented via the same function the
// synthetic re-run uses (buildSyntheticTitle, exported for tests).
// ---------------------------------------------------------------------------
test('reconstruction fidelity: buildSyntheticTitle preserves platform bracket, episode token and tags', () => {
  assert.equal(
    buildSyntheticTitle('[Crunchyroll] Tempal: Item no Chikara - 04', 'Overgeared'),
    '[Crunchyroll] Overgeared - 04'
  );
  assert.equal(
    buildSyntheticTitle('[Bam] Y - 01 [1080p]', 'X'),
    '[Bam] X - 01 [1080p]'
  );
});

// ---------------------------------------------------------------------------
// Batch/sync-equivalence (و) — duplicates in, one fetch per unique title out
// ---------------------------------------------------------------------------
test('batch: duplicates resolve with one fetch per unique title; getCachedCanonical populated', async () => {
  const { impl, state } = makeFetchStub();
  __setFetchImpl(impl);
  await resolveCanonicalTitlesBatch([
    PAIRS[0].b,
    PAIRS[0].b, // exact duplicate
    PAIRS[0].a, // different title, same media
  ]);
  assert.equal(state.calls, 2);
  assert.deepEqual(getCachedCanonical(PAIRS[0].b), { romaji: 'Overgeared', english: 'Overgeared' });
  assert.deepEqual(getCachedCanonical(PAIRS[0].a), { romaji: 'Overgeared', english: 'Overgeared' });
});
