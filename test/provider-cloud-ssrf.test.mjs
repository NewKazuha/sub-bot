import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolation: switch to a temp cwd BEFORE loading the src modules so no
// persistent cache file can be touched. node --test runs each file in its own
// process, so stubbing globalThis.fetch/console.warn is file-local.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-cloud-ssrf-'));
process.chdir(tempDir);

const cf = await import('../src/cloud-folders.mjs');
const ss = await import('../src/site-scrapers.mjs');

const ROOT = path.resolve(import.meta.dirname, '..');
const readSource = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Install a fetch stub and restore it in `finally`. The stub records every
// (url, init) pair so tests can assert ZERO fetches or exactly one safe hop.
async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// (a) A metadata URL that merely MENTIONS mediafire.com must issue ZERO fetches.
// ---------------------------------------------------------------------------

test('P1: resolveMediafireDirectDownload refuses a query-only mediafire lookalike with zero fetches', async () => {
  const calls = [];
  const evil = 'http://169.254.169.254/?x=mediafire.com/file/abc/file';
  await withFetch(async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response('', { status: 200 });
  }, async () => {
    const result = await cf.resolveMediafireDirectDownload(evil);
    assert.equal(result, null, 'a non-mediafire hostname is never resolved');
  });
  assert.deepEqual(calls, [], 'NO fetch may reach the metadata address');
});

// ---------------------------------------------------------------------------
// (b) A public -> metadata 302 from a mediafire-looking host is NOT followed.
// ---------------------------------------------------------------------------

test('P2: a 302 into metadata is refused before a second fetch', async () => {
  const calls = [];
  const page = 'https://www.mediafire.com/file/abc123/Show.ass/file';
  const metadata = 'http://169.254.169.254/latest/meta-data/iam/security-credentials/';
  await withFetch(async (url, init) => {
    calls.push({ url: String(url), init });
    assert.equal(String(url), page, 'only the validated first URL is fetched');
    return new Response('', {
      status: 302,
      headers: { location: metadata },
    });
  }, async () => {
    const result = await cf.resolveMediafireDirectDownload(page);
    assert.equal(result, null, 'a refused redirect yields no direct link');
  });
  assert.equal(calls.length, 1, 'the metadata Location is NEVER fetched');
  assert.equal(calls[0].init?.redirect, 'manual', 'fetchSafe disables automatic redirect following');
});

// ---------------------------------------------------------------------------
// (c) A legitimate mediafire URL still works with a stubbed response.
// ---------------------------------------------------------------------------

test('P3: a legitimate https mediafire file resolves its download button', async () => {
  const calls = [];
  const page = 'https://www.mediafire.com/file/abc123/Show.ass/file';
  const direct = 'https://download.mediafire.com/abc123/Show.ass';
  const html = `<html><body><a id="downloadButton" href="${direct}">Download</a></body></html>`;
  await withFetch(async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  }, async () => {
    const result = await cf.resolveMediafireDirectDownload(page);
    assert.equal(result, direct, 'the cheerio parse and return shape are unchanged');
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, page);
});

// ---------------------------------------------------------------------------
// (d) The Buzzheavier resolver refuses a lookalike host BEFORE spawning curl.
// ---------------------------------------------------------------------------

test('P4: a buzzheavier lookalike host is refused before any curl is spawned', async () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const lookalikes = [
      'https://buzzheavier.com.evil.test/abc123XYZ',
      'https://evil.test/?x=buzzheavier.com/file',
    ];
    for (const url of lookalikes) {
      const result = await ss.resolveBuzzheavierDownloadUrl(url);
      assert.equal(result, null, `lookalike refused: ${url}`);
    }
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    warnings.some(w => /not hosted by buzzheavier\.com/.test(w)),
    'the hostname guard fired'
  );
  assert.ok(
    !warnings.some(w => /Curl fetch error|Curl header error/.test(w)),
    'curl was never spawned for a lookalike host'
  );

  // Deterministic static proof that the guard precedes curl and that the
  // page fetch no longer follows redirects (`-L`).
  const source = readSource('src/site-scrapers.mjs');
  const fnAt = source.indexOf('export async function resolveBuzzheavierDownloadUrl');
  assert.ok(fnAt >= 0, 'the resolver is present');
  const fnBody = source.slice(fnAt, fnAt + 5000);
  const guardAt = fnBody.indexOf('is not hosted by buzzheavier.com');
  const curlAt = fnBody.indexOf("'-s',");
  assert.ok(guardAt >= 0 && curlAt >= 0 && guardAt < curlAt, 'host guard precedes curl');
  assert.doesNotMatch(fnBody.substring(0, curlAt + 200), /['"]-L['"]/, 'no redirect-following curl flag');
});
