import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate module-load side effects (config.mjs reads .env / session from cwd).
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-ssrf-'));
process.chdir(tempDir);

const {
  isUrlHostOf,
  findProviderUrlInText,
  pickFontProviderUrl,
  resolveSubdlDownloadData,
  resolveTop4topDownloadUrl,
  resolveMediafireDownloadUrl,
} = await import('../src/telegram-client.mjs');

after(() => {
  try { process.chdir(os.tmpdir()); } catch { }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { }
});

const noDns = async () => { throw new Error('DNS must not be consulted in these offline tests'); };

function mkHtmlResponse(html, { status = 200 } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 200 ? 'OK' : 'Status',
    url: 'https://public.example/page',
    headers: { get: () => null },
    text: async () => html,
    body: { cancel: async () => { } },
  };
}

// t.mock.method auto-restores globalThis.fetch at the end of each test.
function trackFetch(t, handler) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  });
  return calls;
}

const isMetadataUrl = (url) => /169\.254\.169\.254|169\.254\.170\.2|metadata\.google\.internal|localhost|127\.0\.0\.1/i.test(url);

// A realistic Subdl poster message: strict subdl.com info link plus the
// "fonts:" line the old code fed to /mediafire\.com/i.test(fontUrl).
const SUBDL_MSG_METADATA = `[Sub1984] Spy x Family - 12 [1080p][+fonts] 📍
https://www.subdl.com/s/info/Ab12Cd34
Fonts & Subs: http://169.254.169.254/?x=mediafire.com/file
📌 Arabic / English subtitle pack
`;

test('P1-a: Subdl message with a metadata "fonts:" URL dispatches no resolver and issues zero metadata requests', async t => {
  // Provider detection is hostname-based, so the lookalike selects nothing.
  assert.equal(pickFontProviderUrl(SUBDL_MSG_METADATA), null);
  assert.equal(findProviderUrlInText(SUBDL_MSG_METADATA, ['mediafire.com', 'top4top.io']), null);

  const calls = trackFetch(t, async () => mkHtmlResponse('provider page'));
  // Defensive belt: even if the raw candidate reaches a resolver by another
  // path, the fetchSafe initial validator refuses it before any fetch.
  assert.equal(await resolveSubdlDownloadData('http://169.254.169.254/?x=mediafire.com/file', { lookup: noDns }), null);
  assert.equal(await resolveMediafireDownloadUrl('http://169.254.169.254/?x=mediafire.com/file', { lookup: noDns }), null);
  assert.equal(await resolveTop4topDownloadUrl('http://169.254.169.254/?x=mediafire.com/file', { lookup: noDns }), null);
  assert.equal(calls.length, 0, 'no request may be issued for a metadata URL');
  assert.ok(calls.every(c => !isMetadataUrl(c.url)));
});

test('P1-b: "top4top.io" in the query of a foreign host is never treated as Top4Top', async t => {
  const text = `[Sub1984] Spy x Family - 13 [1080p] 📍
https://www.subdl.com/s/info/Zz99Yy88
fonts: https://evil.example/?x=top4top.io/file
`;
  assert.equal(pickFontProviderUrl(text), null, 'no provider is dispatched');
  assert.equal(findProviderUrlInText(text, 'top4top.io'), null, 'the note-file fallback ignores it too');
  assert.equal(isUrlHostOf('https://evil.example/?x=top4top.io/file', 'top4top.io'), false);

  const calls = trackFetch(t, async () => mkHtmlResponse('provider page'));
  // The exported resolvers enforce their own provider host: no lookalike URL
  // may be fetched at all, not even the public evil.example host.
  assert.equal(await resolveTop4topDownloadUrl('https://evil.example/?x=top4top.io/file', { lookup: noDns }), null);
  assert.equal(await resolveMediafireDownloadUrl('https://evil.example/?x=mediafire.com/file', { lookup: noDns }), null);
  assert.equal(calls.length, 0, 'ZERO fetches for provider-name-in-query lookalikes');
  assert.ok(calls.every(c => !isMetadataUrl(c.url)));
});

test('P1-c: a legitimate www.mediafire.com fonts link still dispatches to the Mediafire resolver', async t => {
  const mfUrl = 'https://www.mediafire.com/file/abc123/subtitles+fonts.zip/file';
  const text = `[Sub1984] Spy x Family - 14 [1080p][+fonts] 📍
https://www.subdl.com/s/info/Qq11Ww22
fonts: ${mfUrl}
`;
  assert.deepEqual(pickFontProviderUrl(text), { kind: 'mediafire', url: mfUrl });

  const calls = trackFetch(t, async () => mkHtmlResponse(
    '<a id="downloadButton" href="https://download.mediafire.com/x/subtitles.zip">Download</a>'
  ));
  const direct = await resolveMediafireDownloadUrl(mfUrl, { lookup: noDns });
  assert.equal(direct, 'https://download.mediafire.com/x/subtitles.zip');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, mfUrl, 'the real provider URL is fetched exactly once');
  assert.equal(calls[0].init.redirect, 'manual', 'fetchSafe forces manual redirects');
});

test('P1-c2: same-provider subdomains are accepted by both exported resolvers', async t => {
  const top4topUrl = 'https://www.top4top.io/f_123';
  const calls = trackFetch(t, async () => mkHtmlResponse(
    '<input value="https://dl.top4top.io/f_123/subtitles.zip">'
  ));
  assert.equal(await resolveTop4topDownloadUrl(top4topUrl, { lookup: noDns }),
    'https://dl.top4top.io/f_123/subtitles.zip');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, top4topUrl, 'a genuine provider subdomain is still fetched');
});

test('P1-d: isUrlHostOf accepts exact/subdomain hosts and rejects lookalikes and malformed URLs', () => {
  // Accepted: exact host and subdomains.
  assert.equal(isUrlHostOf('https://mediafire.com/file/x', 'mediafire.com'), true);
  assert.equal(isUrlHostOf('https://www.mediafire.com/file/x', 'mediafire.com'), true);
  assert.equal(isUrlHostOf('http://top4top.io/f_123', 'top4top.io'), true);
  assert.equal(isUrlHostOf('https://www.top4top.io/f_123', 'top4top.io'), true);
  assert.equal(isUrlHostOf('https://www.mediafire.com./file/x', 'mediafire.com'), true, 'trailing dot is normalised');

  // Rejected: provider name only in query/path/userinfo, suffix tricks, IP.
  assert.equal(isUrlHostOf('http://169.254.169.254/?x=mediafire.com/file', 'mediafire.com'), false);
  assert.equal(isUrlHostOf('https://evil.example/?x=top4top.io/file', 'top4top.io'), false);
  assert.equal(isUrlHostOf('https://mediafire.com.evil.example/x', 'mediafire.com'), false);
  assert.equal(isUrlHostOf('https://evil-mediafire.com/x', 'mediafire.com'), false);
  assert.equal(isUrlHostOf('https://mediafire.com@evil.example/x', 'mediafire.com'), false);
  assert.equal(isUrlHostOf('https://notmediafire.com/x', 'mediafire.com'), false);
  assert.equal(isUrlHostOf('http://127.0.0.1/?x=mega.nz', 'mega.nz'), false);

  // Rejected: malformed / non-http URLs and empty input.
  assert.equal(isUrlHostOf('not a url', 'mediafire.com'), false);
  assert.equal(isUrlHostOf('', 'mediafire.com'), false);
  assert.equal(isUrlHostOf(undefined, 'mediafire.com'), false);
  assert.equal(isUrlHostOf('ftp://mediafire.com/file', 'mediafire.com'), false);
  assert.equal(isUrlHostOf('https://mediafire.com/file', ''), false);
});

test('P2-a: resolvers refuse a 302 into cloud metadata (one fetch, no second hop)', async t => {
  const calls = trackFetch(t, async () => ({
    status: 302,
    ok: false,
    headers: { get: n => String(n).toLowerCase() === 'location' ? 'http://169.254.169.254/latest/meta-data/' : null },
    body: { cancel: async () => { } },
  }));
  const lookup = async () => [{ address: '169.254.169.254', family: 4 }];
  assert.equal(await resolveMediafireDownloadUrl('https://www.mediafire.com/file/x', { lookup }), null);
  assert.equal(await resolveTop4topDownloadUrl('https://top4top.io/f_123', { lookup }), null);
  assert.equal(calls.length, 2, 'one initial fetch per resolver, never the redirect target');
  assert.ok(calls.every(c => !isMetadataUrl(c.url)));
});

test('P2-b: resolveSubdlDownloadData refuses a non-subdl initial URL (zero curl/Jina/fetch requests)', async t => {
  const calls = trackFetch(t, async () => mkHtmlResponse('<a href="https://dl.subdl.com/subtitle/1-2/x.zip">x</a>'));
  const result = await resolveSubdlDownloadData('http://169.254.169.254/?x=subdl.com/s/info/Ab12', { lookup: noDns });
  assert.equal(result, null);
  assert.equal(calls.length, 0, 'the unvalidated curl/Jina sinks are never reached');
});

test('P2-c: a legitimate Subdl info URL still yields its download links through fetchSafe', async t => {
  const infoUrl = 'https://www.subdl.com/s/info/Ab12Cd34';
  const html = '<a href="https://dl.subdl.com/subtitle/120-125/pack.zip">Complete</a>' +
    '<a href="https://evil.example/?x=dl.subdl.com/subtitle/999-999/x.zip">Lookalike</a>';
  const calls = trackFetch(t, async () => mkHtmlResponse(html));
  const data = await resolveSubdlDownloadData(infoUrl, { lookup: noDns });
  assert.ok(data);
  assert.deepEqual(data.allLinks, ['https://dl.subdl.com/subtitle/120-125/pack.zip'],
    'a lookalike host carrying dl.subdl.com in its query is ignored');
  assert.equal(data.batchZipLink, 'https://dl.subdl.com/subtitle/120-125/pack.zip');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, infoUrl);
  assert.equal(calls[0].init.redirect, 'manual');
});
