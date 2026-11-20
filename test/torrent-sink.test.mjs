import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolation: temp cwd BEFORE importing src modules so data/** is never touched.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torrent-sink-test-'));
process.chdir(tempDir);

const tc = await import('../src/telegram-client.mjs');
const rec = await import('../src/recovery.mjs');
const { downloadFileToDisk, downloadAndExtractSubtitleFromTorrent } = tc;

// A minimal fetch Response stub exposing exactly what downloadFileToDisk uses.
function mkRes({ status = 200, url = '', headers = {}, chunks = [] } = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 200 ? 'OK' : 'Status',
    url,
    headers: { get: k => (h[String(k).toLowerCase()] ?? null) },
    body: new ReadableStream({
      start(c) {
        for (const x of chunks) c.enqueue(typeof x === 'string' ? Buffer.from(x) : x);
        c.close();
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// F13 — downloadFileToDisk sink guarantees (offline, stubbed fetch).
// ---------------------------------------------------------------------------

test('F13: expectedHost mismatch throws and leaves no file', async t => {
  const dest = path.join(tempDir, 'host-mismatch.bin');
  t.mock.method(globalThis, 'fetch', async () =>
    mkRes({ url: 'https://evil.attacker.tld/x', headers: { 'content-type': 'application/octet-stream' }, chunks: ['x'] }));
  await assert.rejects(
    downloadFileToDisk('https://example.com/x.torrent', dest, {}, { expectedHost: 'example.com' }),
    /unexpected host/,
  );
  assert.equal(fs.existsSync(dest), false, 'no file may remain after a host mismatch');
});

test('F13: declared maxBytes exceeded throws and leaves no file', async t => {
  const dest = path.join(tempDir, 'declared-too-large.bin');
  t.mock.method(globalThis, 'fetch', async () =>
    mkRes({ url: 'https://example.com/x', headers: { 'content-type': 'application/octet-stream', 'content-length': '9999' }, chunks: ['x'] }));
  await assert.rejects(
    downloadFileToDisk('https://example.com/x', dest, {}, { expectedHost: 'example.com', maxBytes: 10 }),
    err => err && err.code === 'FILE_TOO_LARGE',
  );
  assert.equal(fs.existsSync(dest), false, 'no file may remain after a declared-size refusal');
});

test('F13: in-stream overflow removes the partial file', async t => {
  const dest = path.join(tempDir, 'stream-overflow.bin');
  // No content-length (or a lying small one) -> the byte counter must catch it.
  t.mock.method(globalThis, 'fetch', async () =>
    mkRes({ url: 'https://example.com/x', headers: { 'content-type': 'application/octet-stream', 'content-length': '2' }, chunks: ['1234567890AAAA'] }));
  await assert.rejects(
    downloadFileToDisk('https://example.com/x', dest, {}, { expectedHost: 'example.com', maxBytes: 5 }),
    err => err && err.code === 'FILE_TOO_LARGE',
  );
  assert.equal(fs.existsSync(dest), false, 'partial file must be removed on in-stream overflow');
});

test('F11: zero-byte torrent removes the empty file and throws', async t => {
  const work = fs.mkdtempSync(path.join(tempDir, 'empty-torrent-'));
  t.mock.method(globalThis, 'fetch', async () =>
    mkRes({ url: 'https://example.com/x.torrent', headers: { 'content-type': 'application/x-bittorrent' }, chunks: [] }));
  await assert.rejects(
    downloadAndExtractSubtitleFromTorrent('https://example.com/x.torrent', work),
    /empty file/i,
  );
  assert.equal(fs.existsSync(path.join(work, 'release.torrent')), false, 'empty torrent file must be removed');
});

// ---------------------------------------------------------------------------
// F4 — bounded, re-validated redirect loop (non-recovery manual mode).
// ---------------------------------------------------------------------------

test('F4: 302 to a private host throws before a second request', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return mkRes({ status: 302, url: 'https://example.com/x.torrent', headers: { location: 'https://127.0.0.1/x.torrent' } });
  });
  await assert.rejects(
    downloadFileToDisk('https://example.com/x.torrent', path.join(tempDir, 'ssrf.bin'), {},
      { expectedHost: 'example.com', redirect: 'manual', recovery: false }),
  );
  assert.equal(calls, 1, 'no second request may be issued for an SSRF redirect');
});

test('F4: 302 to the same host is followed up to the cap', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls <= 3) return mkRes({ status: 302, url: 'https://example.com/x.torrent', headers: { location: `https://example.com/step${calls}.torrent` } });
    return mkRes({ url: 'https://example.com/final.torrent', headers: { 'content-type': 'application/x-bittorrent' }, chunks: ['OK'] });
  });
  const dest = path.join(tempDir, 'redirect-ok.bin');
  const result = await downloadFileToDisk('https://example.com/x.torrent', dest, {},
    { expectedHost: 'example.com', redirect: 'manual', recovery: false });
  assert.equal(result, dest);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'OK');
  assert.equal(calls, 4, 'initial request + 3 followed redirects');
});

test('F4: redirect cap is enforced', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return mkRes({ status: 302, url: 'https://example.com/x.torrent', headers: { location: `https://example.com/step${calls}.torrent` } });
  });
  await assert.rejects(
    downloadFileToDisk('https://example.com/x.torrent', path.join(tempDir, 'redirect-cap.bin'), {},
      { expectedHost: 'example.com', redirect: 'manual', recovery: false }),
    /Too many redirects/,
  );
  assert.equal(calls, 4, 'initial + 3 redirects, then refused');
});

test('F4/F13: recovery 302 throws the typed RECOVERY_REDIRECT', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return mkRes({ status: 302, url: 'https://example.com/x.torrent', headers: { location: 'https://example.com/step.torrent' } });
  });
  await assert.rejects(
    downloadFileToDisk('https://example.com/x.torrent', path.join(tempDir, 'recovery-302.bin'), {},
      { expectedHost: 'example.com', redirect: 'manual', recovery: true }),
    err => err && err.code === 'RECOVERY_REDIRECT',
  );
  assert.equal(calls, 1, 'recovery aborts on the first 3xx');
});

// ---------------------------------------------------------------------------
// F2 — negative synthetic pending ids never abort the channel.
// ---------------------------------------------------------------------------

test('F2: negative pending ids and throwing fetchByIds are skipped, recovery continues', async () => {
  const posted = new Set();
  assert.equal(rec.recordPendingAttempt(posted, 'tg_-100123_-42'), true); // synthetic negative id
  assert.equal(rec.recordPendingAttempt(posted, 'tg_-100123_42'), true);  // real id (will throw)

  for (const builder of [rec.pendingRetryKeys, rec.cappedPendingRetryKeys]) {
    const keys = builder(posted, '-100123', []);
    assert.equal(keys.includes('tg_-100123_-42'), false, 'negative synthetic id must be skipped');
    assert.equal(keys.includes('tg_-100123_42'), true, 'real id must still be queued');
  }

  const result = await rec.withRecoveryMessages({
    chat: { id: '-100123' },
    windowMsgs: [],
    posted,
    tasks: [{ kind: 'synthetic', chatId: '-100123', title: 'Show - 01', postUrl: 'https://erai-raws.blogspot.com/x.torrent' }],
    fetchByIds: async () => { throw new Error('MESSAGE_IDS_INVALID'); },
    log() {},
  });
  assert.equal(result.fatal, undefined, 'a throwing pending fetch must never be fatal');
  assert.ok(result.msgs.length >= 1, 'the synthetic recovery message must still be present');
});

// ---------------------------------------------------------------------------
// F6 — control characters in a raw recovery postUrl.
// ---------------------------------------------------------------------------

test('F6: validateRecoveryUrl rejects raw control characters', () => {
  for (const raw of [
    'https://erai-raws.blogspot.com/a\u0000b',
    'https://erai-raws.blogspot.com/a\nb',
    'https://erai-raws.blogspot.com/a\tb',
    'https://erai-raws.blogspot.com/a\u007Fb',
  ]) {
    assert.throws(() => rec.validateRecoveryUrl(raw), undefined, `must reject control chars in ${JSON.stringify(raw)}`);
  }
  assert.equal(rec.validateRecoveryUrl('https://erai-raws.blogspot.com/ok'), 'erai-raws.blogspot.com');
});
