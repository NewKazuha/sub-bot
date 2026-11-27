import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolation: temp cwd BEFORE importing src modules so nothing touches data/**.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-redirect-guard-'));
process.chdir(tempDir);
const { downloadFileToDisk, shouldDownloadViaBrowser } = await import('../src/telegram-client.mjs');

after(() => {
  try { process.chdir(os.tmpdir()); } catch { }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { }
});

const dest = name => path.join(tempDir, name);

// Minimal Response stub exposing exactly what downloadFileToDisk consumes.
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

// Fails loudly if any test accidentally needs real DNS.
const noDns = async () => { throw new Error('DNS must not be consulted in these offline tests'); };

test('V3-a: an internal initial URL is refused before any fetch', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return mkRes(); });
  await assert.rejects(
    downloadFileToDisk('http://169.254.169.254/file', dest('a.bin'), {}, { lookup: noDns }),
    /unsafe initial URL/,
  );
  assert.equal(calls, 0, 'no request may be issued for an internal initial URL');
  assert.equal(fs.existsSync(dest('a.bin')), false, 'no file may be created');
});

test('V3-b: a 302 into cloud metadata is refused after exactly one fetch', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return mkRes({
      status: 302,
      url: 'https://public.example.test/sub.ass',
      headers: { location: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' },
    });
  });
  await assert.rejects(
    downloadFileToDisk('https://public.example.test/sub.ass', dest('b.bin'), {}, { lookup: noDns }),
    /unsafe redirect target/,
  );
  assert.equal(calls, 1, 'the metadata Location must never be fetched');
  assert.equal(fs.existsSync(dest('b.bin')), false);
});

test('V3-c: validateUrl override permits a test-local URL (escape hatch)', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return mkRes({
      url: 'http://127.0.0.1/file.ass',
      headers: { 'content-type': 'application/octet-stream' },
      chunks: ['subtitle-bytes'],
    });
  });
  const target = dest('c.bin');
  await downloadFileToDisk('http://127.0.0.1/file.ass', target, {},
    { validateUrl: () => true, lookup: noDns });
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'subtitle-bytes');
});

test('V3-d: recovery 3xx throws typed RECOVERY_REDIRECT before any follow', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return mkRes({
      status: 302,
      url: 'https://public.example.test/x',
      headers: { location: 'https://public.example.test/y' },
    });
  });
  await assert.rejects(
    downloadFileToDisk('https://public.example.test/x', dest('d.bin'), {},
      { recovery: true, lookup: noDns }),
    err => err && err.name === 'RecoveryRedirectError' && err.code === 'RECOVERY_REDIRECT',
  );
  assert.equal(calls, 1, 'recovery aborts on the first 3xx');
  assert.equal(fs.existsSync(dest('d.bin')), false);
});

test('V3-e: a public-looking host resolving to a private IP is refused', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return mkRes({
      status: 302,
      url: 'https://public.example.test/x',
      headers: { location: 'http://metadata.attacker.test/latest/meta-data/' },
    });
  });
  const lookup = async (host, opts) => {
    assert.equal(host, 'metadata.attacker.test');
    assert.equal(opts?.all, true, 'all DNS answers must be checked');
    return [{ address: '169.254.169.254', family: 4 }];
  };
  await assert.rejects(
    downloadFileToDisk('https://public.example.test/x', dest('e.bin'), {}, { lookup }),
    /unsafe redirect target/,
  );
  assert.equal(calls, 1, 'the private DNS answer must stop the second request');
});

test('V3-f: fetch is forced to redirect:manual even if a caller asks to follow', async t => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    seen.push(opts);
    return mkRes({
      status: 302,
      url: 'https://public.example.test/x',
      headers: { location: 'http://169.254.169.254/' },
    });
  });
  await assert.rejects(
    downloadFileToDisk('https://public.example.test/x', dest('f.bin'), {},
      { redirect: 'follow', lookup: noDns }),
    /unsafe redirect target/,
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].redirect, 'manual', 'fetch must never follow redirects implicitly');
});

test('V3-g: an async validateUrl returning false is awaited (no fail-open)', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return mkRes(); });
  await assert.rejects(
    downloadFileToDisk('http://127.0.0.1/file', dest('g.bin'), {},
      { validateUrl: async () => false, lookup: noDns }),
    /unsafe initial URL/,
  );
  assert.equal(calls, 0, 'a resolved Promise must not be treated as a truthy validation result');
  assert.equal(fs.existsSync(dest('g.bin')), false);
});

test('V3-h: browser downloads are restricted to exact provider hosts', () => {
  assert.equal(shouldDownloadViaBrowser('https://ddl.rocks-team.net/file.ass'), true);
  assert.equal(shouldDownloadViaBrowser('https://subs.celestial-dragons.com/download.aspx?file=x&mac=y'), true);
  assert.equal(shouldDownloadViaBrowser('https://subs.celestial-dragons.com.evil.example/file.ass'), false);
  assert.equal(shouldDownloadViaBrowser('https://ddl.rocks-team.net.evil.example/file.ass'), false);
  assert.equal(shouldDownloadViaBrowser('https://example.workers.dev/file.ass'), false);
  assert.equal(shouldDownloadViaBrowser('not a URL'), false);
});
