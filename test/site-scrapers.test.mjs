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
