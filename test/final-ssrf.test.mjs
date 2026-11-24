import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  followRedirectUrl,
  resolveGoIndexSubtitle,
  resolveFontFromDirectory,
  resolveSubtitleFromDirectory,
  fetchHtmlWithImpersonation,
} from '../src/site-scrapers.mjs';
import { fetchSafe } from '../src/url-safety.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const readSource = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// Finding 1 — curl_cffi must not auto-follow a redirect.
// ---------------------------------------------------------------------------

test('N1: cf_fetch.py disables redirect following and refuses 3xx bodies', () => {
  const source = readSource('scripts/cf_fetch.py');
  assert.match(source, /allow_redirects\s*=\s*False/, 'auto-follow is disabled');
  assert.doesNotMatch(source, /allow_redirects\s*=\s*True/, 'no allow_redirects=True remains');
  assert.match(source, /300\s*<=\s*res\.status_code\s*<\s*400/, 'the 3xx branch is present');
  assert.match(source, /redirect refused/, 'a clear refusal line is emitted');
  // The body write is AFTER (not inside) the 3xx guard.
  assert.ok(
    source.indexOf('redirect refused') < source.indexOf('sys.stdout.buffer.write(res.content)'),
    'the 3xx refusal must precede the body write'
  );
});

test('N1: a non-zero impersonation fetch is treated as no-html by the caller', async () => {
  // Offline stand-in for curl_cffi: the stub exits 1 with the same refusal
  // line the real script now emits on a 3xx. execFileSync throws, and the
  // caller must fail closed (null) instead of using any body.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'final-ssrf-cf-'));
  const scriptDir = path.join(temp, 'scripts');
  fs.mkdirSync(scriptDir);
  fs.writeFileSync(
    path.join(scriptDir, 'cf_fetch.py'),
    'import sys\nsys.stderr.write("cf_fetch error: redirect refused\\n")\nsys.exit(1)\n'
  );
  const originalCwd = process.cwd();
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(String(m));
  try {
    process.chdir(temp);
    const html = fetchHtmlWithImpersonation('https://public.example/page', '');
    assert.equal(html, null, 'a refused fetch yields no html');
    assert.ok(warnings.some(w => /impersonation failed/.test(w)), 'the failure is surfaced as a warning');
  } finally {
    process.chdir(originalCwd);
    console.warn = originalWarn;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Finding 2 — shortener INITIAL URL was fetched before any validation.
// ---------------------------------------------------------------------------

test('N2: followRedirectUrl never fetches a metadata initial URL', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { status: 200, headers: { get: () => null }, body: { cancel: async () => {} } };
  };
  const unsafe = 'http://169.254.169.254/redirect';
  const result = await followRedirectUrl(unsafe, { fetchImpl });
  assert.equal(result, unsafe, 'the URL is returned unchanged on refusal');
  assert.equal(calls.length, 0, 'zero fetch calls for an unsafe initial URL');
});

test('N2: followRedirectUrl honours an injected validateUrl and still follows safe hops', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === 'https://safe.example/final') {
      return { status: 200, headers: { get: () => null }, body: { cancel: async () => {} } };
    }
    return {
      status: 302,
      headers: { get: (n) => String(n).toLowerCase() === 'location' ? 'https://safe.example/final' : null },
      body: { cancel: async () => {} },
    };
  };
  const result = await followRedirectUrl('https://short.test/go', {
    fetchImpl,
    validateUrl: () => true,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  // HEAD is rejected on the final hop, so the redirect-only GET runs too.
  assert.deepEqual(calls, [
    'https://short.test/go',
    'https://safe.example/final',
    'https://safe.example/final',
  ]);
  assert.equal(result, 'https://safe.example/final');
});

// ---------------------------------------------------------------------------
// Finding 3 — GoIndex / font directory URLs were POSTed/fetched unchecked.
// ---------------------------------------------------------------------------

test('N3: resolveGoIndexSubtitle refuses a metadata directory URL with zero fetches', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 200 }; };
  try {
    const result = await resolveGoIndexSubtitle('http://169.254.169.254/0:/subs', null);
    assert.equal(result, null);
    assert.equal(calls, 0, 'no POST may reach the metadata address');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('N3: resolveFontFromDirectory refuses a metadata directory URL with zero fetches', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 200 }; };
  try {
    const result = await resolveFontFromDirectory('http://169.254.169.254/0:/fonts');
    assert.equal(result, null);
    assert.equal(calls, 0, 'none of the three font fetches may run');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('N3: the injected validateUrl keeps existing callers and test-local URLs working', async () => {
  const realFetch = globalThis.fetch;
  const payload = { data: { files: [{ name: 'Show - 01.ass' }] } };
  globalThis.fetch = async () => ({
    ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload),
  });
  try {
    const result = await resolveGoIndexSubtitle('http://127.0.0.1:9/0:/subs', null, {
      validateUrl: () => true,
    });
    assert.equal(result, 'http://127.0.0.1:9/0:/subs/Show%20-%2001.ass');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// Finding 4 — fetchSafe is now a production dependency of scrapePostPage.
// ---------------------------------------------------------------------------

test('N4: a production src/ file imports and calls fetchSafe (SECURITY.md claim)', () => {
  const source = readSource('src/site-scrapers.mjs');
  assert.match(source, /fetchSafe\s*,?\s*}?\s*from\s*'\.\/url-safety\.mjs'/, 'fetchSafe is imported');
  assert.match(source, /await\s+fetchSafe\(pageUrl\s*,/, 'scrapePostPage calls fetchSafe on the first fetch');
});

test('N4: fetchSafe refuses a private redirect hop before the second request', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      status: 302, ok: false,
      headers: { get: (n) => String(n).toLowerCase() === 'location' ? 'http://169.254.169.254/latest/meta-data/' : null },
      body: { cancel: async () => {} },
    };
  };
  const result = await fetchSafe('https://public.example/page', {
    fetchImpl,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  assert.equal(result, null);
  assert.deepEqual(calls, ['https://public.example/page'], 'metadata URL is never fetched');
});

// ---------------------------------------------------------------------------
// Finding 5 — Revive site matching must compare hosts, not substrings.
// ---------------------------------------------------------------------------

test('N5: Revive site detection uses host equality (source-level guard)', () => {
  const source = readSource('src/telegram-client.mjs');
  assert.doesNotMatch(source, /url\.includes\(new URL\(s\.base\)\.hostname\)/, 'substring match is gone');
  assert.match(source, /new URL\(url\)\.hostname\.toLowerCase\(\)\s*===\s*new URL\(s\.base\)\.hostname\.toLowerCase\(\)/);
});

// Mirrors the production expression above; the source-level assertion keeps
// this behavioural check in sync with src/telegram-client.mjs.
function findSiteByHost(url, sites) {
  return sites.find(s => {
    try {
      return new URL(url).hostname.toLowerCase() === new URL(s.base).hostname.toLowerCase();
    } catch { return false; }
  });
}

test('N5: an evil URL mentioning revivesubs.com cannot inherit the Revive config', () => {
  const sites = [
    { id: 'rhythm', base: 'https://rhythm-sub.com' },
    { id: 'revive', base: 'https://revivesubs.com' },
  ];
  assert.equal(findSiteByHost('https://revivesubs.com/post-1', sites)?.id, 'revive');
  assert.equal(findSiteByHost('https://REVIVESUBS.COM:443/post-1', sites)?.id, 'revive');
  assert.equal(findSiteByHost('https://evil.tld/?x=revivesubs.com', sites), undefined);
  assert.equal(findSiteByHost('https://revivesubs.com.evil.tld/post', sites), undefined);
  assert.equal(findSiteByHost('not a url', sites), undefined);
});

// ---------------------------------------------------------------------------
// Finding 6 — the plain HTML directory fallback was the last scraped-URL GET
// still using raw fetchWithTimeout (undici auto-follows its 302).
// ---------------------------------------------------------------------------

test('N6: HTML directory fallback refuses a 302 into metadata (zero private fetches)', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://public.example/dir') {
      return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    }
    return new Response('private secret', { status: 200, headers: { 'content-type': 'text/plain' } });
  };
  try {
    const result = await resolveSubtitleFromDirectory('https://public.example/dir', null);
    assert.equal(result, null, 'a blocked hop yields no subtitle link');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls.map(c => c.url), ['https://public.example/dir'], 'metadata URL is never fetched');
  assert.equal(calls[0].options.redirect, 'manual', 'the GET carries a manual redirect policy');
});

test('N6: HTML directory fallback follows a validated public 302 and parses the listing', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  const listing = '<html><body><a href="https://cdn.example/files/Show - 01.ass">Show - 01.ass</a></body></html>';
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://public.example/dir') {
      return new Response('', { status: 302, headers: { location: 'https://cdn.example/files/' } });
    }
    return new Response(listing, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  try {
    const result = await resolveSubtitleFromDirectory('https://public.example/dir', null, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    assert.equal(result, 'https://cdn.example/files/Show%20-%2001.ass', 'the final listing is parsed');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls.map(c => c.url), ['https://public.example/dir', 'https://cdn.example/files/']);
  assert.ok(calls.every(c => c.options.redirect === 'manual'), 'every hop stays manual');
});
