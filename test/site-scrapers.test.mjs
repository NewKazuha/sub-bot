import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolation: run in a temp working directory BEFORE importing any src module so
// no persistent cache (data/posted.json, data/title-map.json) ever touches the
// repo. node --test runs each test file in its own process.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-scrapers-test-'));
process.chdir(tempDir);

// Namespace import (NOT named): a missing export must fail per-test at call time
// (TypeError) instead of failing the whole file at link time.
const ss = await import('../src/site-scrapers.mjs');

const {
  resolveMugiSubtitleFromWorker,
  scrapePostPage,
  mugiNormalizeTokens,
  isMugiHost,
  __setFetchImpl,
  __resetMugiWorkerState,
  __resetNegativeCache,
  __getNegativeCacheStats,
  __setNowImpl,
  resolveScrapeNegativeTtlMinutes,
} = ss;

// ---------------------------------------------------------------------------
// Worker stub routing (offline; never a real network call)
// ---------------------------------------------------------------------------

const TARGET_FOLDER = 'Bleach - Sennen Kessen-hen S4';
const TARGET_FILE = '[ESPADAS-3ASQ] Bleach Sennen Kessen-hen - 49.ass';
const TARGET_URL = 'https://subs.mugisubs.workers.dev/0:/Bleach%20-%20Sennen%20Kessen-hen%20S4/%5BESPADAS-3ASQ%5D%20Bleach%20Sennen%20Kessen-hen%20-%2049.ass';

function jsonResponse(obj, { contentLength = null } = {}) {
  const text = JSON.stringify(obj);
  return {
    ok: true,
    status: 200,
    url: 'https://subs.mugisubs.workers.dev/0:/',
    headers: {
      get: name => (String(name).toLowerCase() === 'content-length'
        ? (contentLength == null ? String(text.length) : String(contentLength))
        : null),
    },
    text: async () => text,
  };
}

function rootListing() {
  return {
    nextPageToken: null,
    curPageIndex: 0,
    data: {
      files: [
        { name: 'Bleach - Sennen Kessen-hen S1', mimeType: 'application/vnd.google-apps.folder' },
        { name: 'Bleach - Sennen Kessen-hen S4', mimeType: 'application/vnd.google-apps.folder' },
      ],
    },
  };
}

function s1Listing() {
  const files = [];
  for (let i = 1; i <= 12; i++) {
    files.push({
      name: `[ESPADAS-3ASQ] Bleach Sennen Kessen-hen - ${String(i).padStart(2, '0')}.ass`,
      fileExtension: 'ass',
      size: '100000',
      link: '/download.aspx?x=1',
    });
  }
  return { nextPageToken: null, curPageIndex: 0, data: { files } };
}

function s4Listing(episodes = [41, 42, 43, 44, 45, 46, 47, 48, 49]) {
  const files = [{ name: 'Fonts', mimeType: 'application/vnd.google-apps.folder' }];
  for (const i of episodes) {
    files.push({
      name: `[ESPADAS-3ASQ] Bleach Sennen Kessen-hen - ${i}.ass`,
      fileExtension: 'ass',
      size: '42683619',
      link: '/download.aspx?x=2',
    });
  }
  return { nextPageToken: null, curPageIndex: 0, data: { files } };
}

function installStub({ root = rootListing, s4 = s4Listing, calls = [], options = [] } = {}) {
  const folders = {
    'Bleach - Sennen Kessen-hen S1': s1Listing,
    [TARGET_FOLDER]: s4,
  };
  const impl = async (url, opts) => {
    calls.push(url);
    options.push(opts);
    if (/mugi-subs\.com/i.test(url)) {
      throw new Error('unexpected mugi-subs page fetch');
    }
    const pathname = new URL(url).pathname;
    if (pathname === '/0:/') return jsonResponse(root());
    const m = pathname.match(/^\/0:\/(.+)\/$/);
    if (m) {
      const folderName = decodeURIComponent(m[1]);
      const factory = folders[folderName];
      if (factory) return jsonResponse(factory());
    }
    throw new Error(`unexpected URL in stub: ${url}`);
  };
  __setFetchImpl(impl);
  return { calls, options };
}

beforeEach(() => {
  __resetMugiWorkerState();
  __resetNegativeCache();
});

// ---------------------------------------------------------------------------
// 1. Tokenizer
// ---------------------------------------------------------------------------

test('mugiNormalizeTokens drops bracket contents and episode tokens', () => {
  assert.deepEqual(
    mugiNormalizeTokens('[Mugi-Subs] Bleach: Sennen Kessen-hen – 49', '49'),
    ['bleach', 'sennen', 'kessen', 'hen'],
  );
});

test('mugiNormalizeTokens keeps s<N> season tokens and words', () => {
  assert.deepEqual(
    mugiNormalizeTokens('Bleach - Sennen Kessen-hen S4', '49'),
    ['bleach', 'sennen', 'kessen', 'hen', 's4'],
  );
});

test('mugiNormalizeTokens keeps 2-digit numeric titles', () => {
  assert.deepEqual(
    mugiNormalizeTokens('86 - Eighty Six', '12'),
    ['86', 'eighty', 'six'],
  );
});

// ---------------------------------------------------------------------------
// 2. Basic resolver
// ---------------------------------------------------------------------------

test('resolveMugiSubtitleFromWorker resolves the exact direct URL', async () => {
  installStub();
  const result = await resolveMugiSubtitleFromWorker('[Mugi-Subs] Bleach: Sennen Kessen-hen – 49', '49');
  assert.ok(result, 'expected a resolution');
  assert.equal(result.url, TARGET_URL);
  assert.equal(result.fileName, TARGET_FILE);
  assert.equal(result.folderName, TARGET_FOLDER);
});

// ---------------------------------------------------------------------------
// 3. Multi-season: S1 listing is tried before S4, but 49 only exists in S4
// ---------------------------------------------------------------------------

test('multi-season scan requests S1 then S4 and returns from S4', async () => {
  const { calls } = installStub();
  const result = await resolveMugiSubtitleFromWorker('[Mugi-Subs] Bleach: Sennen Kessen-hen – 49', '49');
  assert.ok(result);
  assert.equal(result.folderName, TARGET_FOLDER);
  const s1Called = calls.some(u => /Sennen%20Kessen-hen%20S1\//.test(u));
  const s4Called = calls.some(u => /Sennen%20Kessen-hen%20S4\//.test(u));
  assert.ok(s1Called, `expected S1 folder listing, got ${JSON.stringify(calls)}`);
  assert.ok(s4Called, `expected S4 folder listing, got ${JSON.stringify(calls)}`);
});

// ---------------------------------------------------------------------------
// 4. scrapePostPage routes Mugi via the worker (never the blocked page)
// ---------------------------------------------------------------------------

test('scrapePostPage resolves Mugi releases through the worker API', async () => {
  const { calls } = installStub();
  const pageData = await scrapePostPage(
    'https://www.mugi-subs.com/bleach-sennen-kessen-hen-49/',
    null,
    '49',
    '[Mugi-Subs] Bleach: Sennen Kessen-hen – 49',
  );
  assert.ok(pageData, 'expected pageData');
  assert.equal(pageData.bestDownloadUrl, TARGET_URL);
  assert.equal(pageData.videoLinks.directSub, TARGET_URL);
  assert.ok(!calls.some(u => /mugi-subs\.com/i.test(u)), 'must not fetch the blocked mugi-subs page');
});

// ---------------------------------------------------------------------------
// 5. No-match: missing episode yields null with no throw and no page fetch
// ---------------------------------------------------------------------------

test('scrapePostPage returns null when the worker has no matching episode', async () => {
  const { calls } = installStub({ s4: () => s4Listing([41, 42, 43, 44, 45, 46, 47, 48]) });
  const pageData = await scrapePostPage(
    'https://www.mugi-subs.com/bleach-sennen-kessen-hen-49/',
    null,
    '49',
    '[Mugi-Subs] Bleach: Sennen Kessen-hen – 49',
  );
  assert.equal(pageData, null);
  assert.ok(!calls.some(u => /mugi-subs\.com/i.test(u)), 'must not fetch the blocked mugi-subs page');
});

// ---------------------------------------------------------------------------
// 6. Empty target episode with multiple candidate files is ambiguous -> null
// ---------------------------------------------------------------------------

test('empty target episode with multiple files returns null (ambiguous)', async () => {
  installStub();
  const result = await resolveMugiSubtitleFromWorker('[Mugi-Subs] Bleach: Sennen Kessen-hen', '');
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// 7. isMugiHost: exact host + subdomains only (S-7)
// ---------------------------------------------------------------------------

test('isMugiHost accepts mugi-subs.com and its subdomains only', () => {
  assert.equal(isMugiHost('https://www.mugi-subs.com/x'), true);
  assert.equal(isMugiHost('https://sub.mugi-subs.com/x'), true);
  assert.equal(isMugiHost('https://mugi-subs.com/x'), true);
  assert.equal(isMugiHost('https://notmugi-subs.com/x'), false);
  assert.equal(isMugiHost('https://mugi-subs.com.evil.com/x'), false);
  assert.equal(isMugiHost('not a url'), false);
});

// ---------------------------------------------------------------------------
// 8. Oversize worker response is rejected (S-3)
// ---------------------------------------------------------------------------

test('oversize worker response returns null without throwing', async () => {
  __setFetchImpl(async (url, opts) => {
    if (/mugi-subs\.com/i.test(url)) throw new Error('unexpected mugi-subs page fetch');
    return jsonResponse(rootListing(), { contentLength: 3_000_000 });
  });
  const result = await resolveMugiSubtitleFromWorker('Bleach: Sennen Kessen-hen – 49', '49');
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// 9. Worker POST must never follow redirects (S-1)
// ---------------------------------------------------------------------------

test('worker POST requests use redirect: error', async () => {
  const { options } = installStub();
  await resolveMugiSubtitleFromWorker('[Mugi-Subs] Bleach: Sennen Kessen-hen – 49', '49');
  assert.ok(options.length > 0, 'expected at least one worker request');
  assert.ok(options.every(o => o && o.redirect === 'error'), `expected redirect:error on every POST, got ${JSON.stringify(options)}`);
});

// ---------------------------------------------------------------------------
// 10. targetEp null derives the episode from the page URL (F10)
// ---------------------------------------------------------------------------

test('scrapePostPage with null targetEp derives episode from the page URL', async () => {
  const { calls } = installStub();
  const pageData = await scrapePostPage(
    'https://www.mugi-subs.com/bleach-sennen-kessen-hen-49/',
    null,
    null,
    '[Mugi-Subs] Bleach: Sennen Kessen-hen – 49',
  );
  assert.ok(pageData, 'expected pageData');
  assert.equal(pageData.bestDownloadUrl, TARGET_URL);
  assert.ok(!calls.some(u => /mugi-subs\.com/i.test(u)), 'must not fetch the blocked mugi-subs page');
});

// ---------------------------------------------------------------------------
// 11. Duplicate root folder entries are de-duplicated (F6)
// ---------------------------------------------------------------------------

test('duplicate root folder entries are requested exactly once', async () => {
  const dupRoot = () => ({
    nextPageToken: null,
    curPageIndex: 0,
    data: {
      files: [
        { name: 'Bleach - Sennen Kessen-hen S1', mimeType: 'application/vnd.google-apps.folder' },
        { name: 'Bleach - Sennen Kessen-hen S4', mimeType: 'application/vnd.google-apps.folder' },
        { name: 'Bleach - Sennen Kessen-hen S4', mimeType: 'application/vnd.google-apps.folder' },
      ],
    },
  });
  const { calls } = installStub({ root: dupRoot });
  const result = await resolveMugiSubtitleFromWorker('[Mugi-Subs] Bleach: Sennen Kessen-hen – 49', '49');
  assert.ok(result, 'expected a resolution');
  assert.equal(result.url, TARGET_URL);
  const s4Requests = calls.filter(u => /Sennen%20Kessen-hen%20S4\//.test(u));
  assert.equal(s4Requests.length, 1, `expected S4 requested once, got ${JSON.stringify(calls)}`);
});

// ---------------------------------------------------------------------------
// 12. Over-long folder names are skipped (S-6)
// ---------------------------------------------------------------------------

test('over-long folder names are skipped and never requested', async () => {
  const longName = 'A'.repeat(2000);
  const longRoot = () => ({
    nextPageToken: null,
    curPageIndex: 0,
    data: { files: [{ name: longName, mimeType: 'application/vnd.google-apps.folder' }] },
  });
  const { calls } = installStub({ root: longRoot });
  const result = await resolveMugiSubtitleFromWorker(`[Mugi-Subs] ${longName}`, '49');
  assert.equal(result, null);
  assert.ok(!calls.some(u => u.includes(encodeURIComponent(longName))), 'must not request the over-long folder');
});

// ---------------------------------------------------------------------------
// 13. P1-1b: the negative cache for "no download links"
// ---------------------------------------------------------------------------

const NO_LINK_HTML = '<html><head><title>Release</title></head><body><p>No links here</p></body></html>';

function htmlResponse(html, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: name => (String(name).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null),
    },
    text: async () => html,
  };
}

/** Stub the PAGE fetch (the non-Mugi path goes through globalThis.fetch). */
function installPageFetch(html = NO_LINK_HTML) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return htmlResponse(html);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('P1-1b: a link-less page is fetched ONCE and then served from the negative cache', async () => {
  let clock = 1_700_000_000_000;
  __setNowImpl(() => clock);
  const { calls, restore } = installPageFetch();
  try {
    const url = 'https://lazysano.test/post-1';

    const first = await scrapePostPage(url, null, null, 'Release 01');
    assert.equal(calls.length, 1, 'the first scrape must fetch the page exactly once');
    assert.equal(first.bestDownloadUrl, null, 'the page has no download link');
    assert.equal(first.videoLinks.directSub, null, 'the page has no direct sub');
    assert.notEqual(first.negativeCached, true, 'the first scrape is not a cache hit');

    const second = await scrapePostPage(url, null, null, 'Release 01');
    assert.equal(calls.length, 1, 'the second scrape must NOT make a network request');
    assert.equal(second.negativeCached, true, 'the second scrape is answered from the cache');
    assert.equal(second.bestDownloadUrl, null);
    assert.equal(second.videoLinks, null);

    const stats = __getNegativeCacheStats();
    assert.equal(stats.hits, 1, 'the cached URL must be counted as a hit');
    assert.equal(stats.misses, 1, 'the first URL must be counted as a miss');
    assert.equal(stats.size, 1);

    // The TTL expires -> the page is fetched again.
    clock += 15 * 60_000 + 1;
    const third = await scrapePostPage(url, null, null, 'Release 01');
    assert.equal(calls.length, 2, 'an expired entry must trigger a new fetch');
    assert.notEqual(third.negativeCached, true);
  } finally {
    restore();
    __resetNegativeCache();
  }
});

test('P1-1b: SCRAPE_NEGATIVE_TTL_MINUTES is validated exactly like MAX_CONSECUTIVE_CYCLE_FAILURES', () => {
  const warnings = [];
  const warn = (m) => warnings.push(String(m));

  for (const bad of ['0', 'abc', '-1']) {
    assert.equal(resolveScrapeNegativeTtlMinutes({ value: bad, env: {}, warn }), 15,
      `an invalid TTL (${bad}) must fall back to 15`);
  }
  assert.equal(warnings.length, 3, 'every invalid value must warn');
  assert.ok(warnings.every(w => /SCRAPE_NEGATIVE_TTL_MINUTES/.test(w)), `unexpected warnings: ${JSON.stringify(warnings)}`);

  assert.equal(resolveScrapeNegativeTtlMinutes({ value: '60', env: {}, warn }), 60, '60 must be honoured');
  assert.equal(warnings.length, 3, 'a valid value must not warn');

  // An unset / empty env falls back to 15 WITHOUT a warning.
  assert.equal(resolveScrapeNegativeTtlMinutes({ env: {}, warn }), 15);
  assert.equal(resolveScrapeNegativeTtlMinutes({ env: { SCRAPE_NEGATIVE_TTL_MINUTES: '' }, warn }), 15);
  assert.equal(warnings.length, 3, 'an unset TTL must not warn');
});

test('P1-1b: the runtime TTL honours SCRAPE_NEGATIVE_TTL_MINUTES=60 and an invalid value falls back to 15', async () => {
  const previous = process.env.SCRAPE_NEGATIVE_TTL_MINUTES;
  let clock = 1_700_000_000_000;
  __setNowImpl(() => clock);
  const { calls, restore } = installPageFetch();
  try {
    process.env.SCRAPE_NEGATIVE_TTL_MINUTES = '60';
    const url = 'https://lazysano.test/post-ttl';
    await scrapePostPage(url, null, null, 'Release 02');
    assert.equal(calls.length, 1);

    // 30 minutes later the entry is still live (60-minute TTL).
    clock += 30 * 60_000;
    await scrapePostPage(url, null, null, 'Release 02');
    assert.equal(calls.length, 1, 'a 60-minute TTL must still be live after 30 minutes');

    // Past the 60-minute TTL the page is fetched again.
    clock += 31 * 60_000;
    await scrapePostPage(url, null, null, 'Release 02');
    assert.equal(calls.length, 2, 'an expired entry must trigger a new fetch');

    // An invalid TTL falls back to 15 minutes (and warns).
    __resetNegativeCache();
    const realWarn = console.warn;
    const warnings = [];
    console.warn = (m) => { warnings.push(String(m)); realWarn(m); };
    try {
      process.env.SCRAPE_NEGATIVE_TTL_MINUTES = 'abc';
      const badUrl = 'https://lazysano.test/post-bad-ttl';
      const before = calls.length;
      await scrapePostPage(badUrl, null, null, 'Release 03');
      clock += 14 * 60_000;
      await scrapePostPage(badUrl, null, null, 'Release 03');
      assert.equal(calls.length, before + 1, 'the fallback TTL (15 min) must still be live after 14 minutes');
      assert.ok(warnings.some(w => /invalid SCRAPE_NEGATIVE_TTL_MINUTES/.test(w)),
        `the invalid TTL must warn: ${JSON.stringify(warnings)}`);
    } finally {
      console.warn = realWarn;
    }
  } finally {
    if (previous === undefined) delete process.env.SCRAPE_NEGATIVE_TTL_MINUTES;
    else process.env.SCRAPE_NEGATIVE_TTL_MINUTES = previous;
    restore();
    __resetNegativeCache();
  }
});

test('P1-1b: the negative cache is bounded — it never exceeds its cap and evicts the oldest', async () => {
  const { calls, restore } = installPageFetch();
  try {
    const cap = __getNegativeCacheStats().maxEntries;
    assert.ok(cap >= 1, 'the cache must have a cap');
    for (let i = 0; i < cap + 5; i++) {
      await scrapePostPage(`https://lazysano.test/post-${i}`, null, null, `Release ${i}`);
    }
    assert.equal(calls.length, cap + 5, 'every distinct URL must be fetched once');
    const stats = __getNegativeCacheStats();
    assert.equal(stats.size, cap, 'the map must never grow beyond its cap');
    assert.equal(stats.maxEntries, cap);

    // The oldest entries were evicted -> they are fetched again.
    const before = calls.length;
    await scrapePostPage('https://lazysano.test/post-0', null, null, 'Release 0');
    assert.equal(calls.length, before + 1, 'the evicted (oldest) entry must be fetched again');
    // The newest entry is still cached.
    await scrapePostPage(`https://lazysano.test/post-${cap + 4}`, null, null, 'Release newest');
    assert.equal(calls.length, before + 1, 'the newest entry must still be cached');
  } finally {
    restore();
    __resetNegativeCache();
  }
});
