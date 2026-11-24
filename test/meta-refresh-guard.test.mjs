import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractMetaRefreshTarget,
  isAllowedMetaRefreshTarget,
  cookieHeaderForRedirect,
  fetchValidatedMetaRefreshChain,
  resolveFontFromDirectory,
  scrapePostPage,
  followRedirectUrl,
} from '../src/site-scrapers.mjs';
import {
  RECOVERY_CODES, RECOVERY_REDIRECT_MODE, recoveryFatalCodeFor
} from '../src/recovery.mjs';

const SOURCE = 'https://example.com/start';
const PUBLIC_IP = '93.184.216.34';

/** Deterministic DNS stub — never touches the network. */
function lookupWith(addresses) {
  const calls = [];
  const lookup = async (host, options) => {
    calls.push({ host, options });
    assert.deepEqual(options, { all: true }, 'lookup must request all answers');
    if (addresses === null) {
      const err = new Error(`ENOTFOUND ${host}`);
      err.code = 'ENOTFOUND';
      throw err;
    }
    return addresses.map(address => ({
      address,
      family: String(address).includes(':') ? 6 : 4,
    }));
  };
  return { lookup, calls };
}

// ---------------------------------------------------------------------------
// meta tag extraction — attribute order must not matter
// ---------------------------------------------------------------------------

test('extractMetaRefreshTarget handles both attribute orders', () => {
  assert.equal(
    extractMetaRefreshTarget('<meta http-equiv="refresh" content="0;url=https://example.com/target">'),
    'https://example.com/target'
  );
  assert.equal(
    extractMetaRefreshTarget("<meta content='0; url=https://example.com/target' http-equiv='refresh'>"),
    'https://example.com/target'
  );
  assert.equal(
    extractMetaRefreshTarget('<meta name="x" content="0;url=/relative" http-equiv=refresh>'),
    '/relative'
  );
});

test('extractMetaRefreshTarget returns null for non-refresh or malformed tags', () => {
  assert.equal(extractMetaRefreshTarget('<meta charset="utf-8">'), null);
  assert.equal(extractMetaRefreshTarget('<meta http-equiv="refresh" content="0">'), null);
  assert.equal(extractMetaRefreshTarget(''), null);
});

// ---------------------------------------------------------------------------
// target allow-list
// ---------------------------------------------------------------------------

test('refuses localhost, .local, .internal and metadata hostnames', async () => {
  // The stub would return a PUBLIC answer for every name: the rejection must
  // therefore come from the hostname check, before DNS is consulted.
  const { lookup, calls } = lookupWith([PUBLIC_IP]);
  for (const target of [
    'https://localhost/admin',
    'http://foo.localhost/',
    'https://api.local/',
    'https://vault.internal/',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://metadata.goog/',
    'https://instance-data.ec2.internal/',
    'https://metadata/',
  ]) {
    assert.equal(await isAllowedMetaRefreshTarget(target, SOURCE, lookup), false, target);
  }
  assert.equal(calls.length, 0, 'forbidden hostnames must not be resolved');
});

test('refuses private, loopback, link-local and unique-local IP literals', async () => {
  const { lookup, calls } = lookupWith([PUBLIC_IP]);
  for (const target of [
    'http://127.0.0.1/admin',
    'https://10.0.0.5/',
    'http://172.16.0.1/',
    'https://192.168.1.1/',
    'https://169.254.169.254/latest/meta-data/',
    'http://169.254.170.2/v2/credentials/',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[::]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
  ]) {
    assert.equal(await isAllowedMetaRefreshTarget(target, SOURCE, lookup), false, target);
  }
  assert.equal(calls.length, 0, 'IP literals must be decided without DNS');
});

test('refuses non-http(s) schemes', async () => {
  const { lookup, calls } = lookupWith([PUBLIC_IP]);
  for (const target of [
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'file:///etc/passwd',
    'ftp://example.com/x',
  ]) {
    assert.equal(await isAllowedMetaRefreshTarget(target, SOURCE, lookup), false, target);
  }
  assert.equal(calls.length, 0, 'non-http schemes must not be resolved');
});

test('refuses URLs carrying credentials', async () => {
  const { lookup, calls } = lookupWith([PUBLIC_IP]);
  for (const target of [
    'https://user:pass@example.com/target',
    'https://user@example.com/target',
    'https://:pass@example.com/target',
  ]) {
    assert.equal(await isAllowedMetaRefreshTarget(target, SOURCE, lookup), false, target);
  }
  assert.equal(calls.length, 0, 'credentialed URLs must not be resolved');
});

test('allows a public https host with a public DNS answer', async () => {
  const { lookup, calls } = lookupWith([PUBLIC_IP]);
  assert.equal(await isAllowedMetaRefreshTarget('https://example.org/page', SOURCE, lookup), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, 'example.org');
});

test('refuses a mixed public/private answer set (every answer must be public)', async () => {
  // The connection may still land on the private answer, so a single public
  // answer must NOT make the host allow-listed (fail closed).
  const { lookup } = lookupWith(['10.0.0.9', PUBLIC_IP]);
  assert.equal(await isAllowedMetaRefreshTarget('https://example.org/page', SOURCE, lookup), false);
});

test('refuses when any resolved address is private or malformed', async () => {
  for (const answers of [
    ['127.0.0.1', '192.168.0.4'],
    [PUBLIC_IP, '169.254.169.254'],
    [PUBLIC_IP, null],
    [PUBLIC_IP, { address: undefined }],
  ]) {
    const { lookup } = lookupWith(answers);
    assert.equal(await isAllowedMetaRefreshTarget('https://example.org/page', SOURCE, lookup), false);
  }
});

test('allows a host only when every resolved address is public', async () => {
  const { lookup, calls } = lookupWith([PUBLIC_IP, '93.184.216.35']);
  assert.equal(await isAllowedMetaRefreshTarget('https://example.org/page', SOURCE, lookup), true);
  assert.equal(calls.length, 1);
});

test('refuses on DNS failure or empty answers (fail closed)', async () => {
  const failed = lookupWith(null);
  assert.equal(await isAllowedMetaRefreshTarget('https://example.org/page', SOURCE, failed.lookup), false);

  const empty = lookupWith([]);
  assert.equal(await isAllowedMetaRefreshTarget('https://example.org/page', SOURCE, empty.lookup), false);
});

test('refuses a malformed target', async () => {
  const { lookup } = lookupWith([PUBLIC_IP]);
  assert.equal(await isAllowedMetaRefreshTarget('http://[', SOURCE, lookup), false);
});

// ---------------------------------------------------------------------------
// cookie scoping
// ---------------------------------------------------------------------------

test('cookie is forwarded only to the same scheme and host', () => {
  const cookie = 'session=abc123';
  assert.deepEqual(
    cookieHeaderForRedirect(cookie, 'https://example.com/target', 'https://example.com/start'),
    { Cookie: cookie }
  );
  // Host comparison is case-insensitive and ignores the port.
  assert.deepEqual(
    cookieHeaderForRedirect(cookie, 'https://EXAMPLE.com:8443/target', SOURCE),
    { Cookie: cookie }
  );
});

test('cookie is withheld on an https -> http scheme downgrade', () => {
  const cookie = 'session=abc123';
  // Same host + port, but the scheme changed to plaintext: must not forward.
  assert.deepEqual(
    cookieHeaderForRedirect(cookie, 'http://EXAMPLE.com:8443/target', SOURCE),
    {}
  );
  assert.deepEqual(
    cookieHeaderForRedirect(cookie, 'http://example.com/target', 'https://example.com/start'),
    {}
  );
});

test('cookie is withheld from a different host, subdomain or empty jar', () => {
  const cookie = 'session=abc123';
  assert.deepEqual(
    cookieHeaderForRedirect(cookie, 'https://evil.example/target', SOURCE),
    {}
  );
  assert.deepEqual(
    cookieHeaderForRedirect(cookie, 'https://sub.example.com/target', SOURCE),
    {}
  );
  assert.deepEqual(
    cookieHeaderForRedirect('', 'https://example.com/target', SOURCE),
    {}
  );
  assert.deepEqual(
    cookieHeaderForRedirect(cookie, 'not a url', SOURCE),
    {}
  );
});

// ---------------------------------------------------------------------------
// validated meta-refresh redirect chain (every hop re-checked, never auto-followed)
// ---------------------------------------------------------------------------

function redirectResponse(location) {
  return {
    ok: false,
    status: 302,
    headers: { get: (name) => String(name).toLowerCase() === 'location' ? location : null },
    body: { cancel: async () => { } },
  };
}

function okResponse(html) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: { cancel: async () => { } },
    text: async () => html,
  };
}

test('meta-refresh chain refuses a public -> private 302 hop', async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options);
    return redirectResponse('http://127.0.0.1/latest/meta-data/');
  };
  const { lookup } = lookupWith([PUBLIC_IP]);
  const result = await fetchValidatedMetaRefreshChain(
    'https://public.example/page', SOURCE, 'session=abc', { fetchImpl, lookup }
  );
  assert.equal(result, null);
  assert.equal(calls.length, 1, 'the private Location must never be fetched');
  assert.equal(calls[0].redirect, 'manual', 'redirects are never auto-followed');
});

test('meta-refresh chain refuses a redirect host with a private DNS answer', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return redirectResponse('http://internal.example/admin');
  };
  const { lookup } = lookupWith([PUBLIC_IP, '10.0.0.5']);
  const result = await fetchValidatedMetaRefreshChain(
    'https://public.example/page', SOURCE, '', { fetchImpl, lookup }
  );
  assert.equal(result, null);
  assert.equal(calls.length, 1, 'a mixed public/private answer set makes the hop invalid');
});

test('meta-refresh chain refuses a 3xx with no Location header', async () => {
  let fetches = 0;
  const fetchImpl = async () => {
    fetches++;
    return redirectResponse(null);
  };
  const result = await fetchValidatedMetaRefreshChain(
    'https://public.example/page', SOURCE, '', { fetchImpl, lookup: lookupWith([PUBLIC_IP]).lookup }
  );
  assert.equal(result, null);
  assert.equal(fetches, 1);
});

test('meta-refresh chain bounds the redirect hop count', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return redirectResponse(`/next${calls.length}`);
  };
  const result = await fetchValidatedMetaRefreshChain(
    'https://public.example/page', SOURCE, '',
    { fetchImpl, lookup: lookupWith([PUBLIC_IP]).lookup, maxHops: 3 }
  );
  assert.equal(result, null);
  assert.equal(calls.length, 4, 'initial fetch plus 3 redirects, then stop');
});

test('meta-refresh chain re-scopes the Cookie per hop and returns only a validated final response', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, cookie: options.headers.Cookie ?? null, redirect: options.redirect });
    if (url === 'https://example.com/a') return redirectResponse('https://evil.example/step');
    if (url === 'https://evil.example/step') return redirectResponse('https://example.com/final');
    return okResponse('<h1>done</h1>');
  };
  const result = await fetchValidatedMetaRefreshChain(
    'https://example.com/a', SOURCE, 'session=abc',
    { fetchImpl, lookup: lookupWith([PUBLIC_IP]).lookup }
  );
  assert.deepEqual(result, { html: '<h1>done</h1>', url: 'https://example.com/final' });
  // Cookie goes to the original site, is withheld from the cross-host hop, and
  // returns to the original host; every fetch uses redirect:'manual'.
  assert.deepEqual(calls.map(c => c.cookie), ['session=abc', null, 'session=abc']);
  assert.ok(calls.every(c => c.redirect === 'manual'));
});

// ---------------------------------------------------------------------------
// recovery no-redirect path through resolveFontFromDirectory
// ---------------------------------------------------------------------------

test('resolveFontFromDirectory threads the no-redirect recovery mode into every fetch', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, options) => {
    seen.push(options);
    return { ok: false, status: 200, text: async () => '' };
  };
  try {
    const dir = 'https://ddl.example.workers.dev/0:/Uma/';
    await resolveFontFromDirectory(dir, { redirect: RECOVERY_REDIRECT_MODE });
    assert.equal(seen.length, 3, 'json, form and html attempts all ran');
    for (const options of seen) {
      assert.equal(options.redirect, RECOVERY_REDIRECT_MODE, 'manual redirect mode is set');
      assert.equal(options.recovery, true, 'recovery marker makes 3xx a typed refusal');
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('resolveFontFromDirectory gives normal callers manual redirects without a recovery marker', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, options) => {
    seen.push(options);
    return { ok: false, status: 200, text: async () => '' };
  };
  try {
    await resolveFontFromDirectory('https://ddl.example.workers.dev/0:/Uma/');
    assert.equal(seen.length, 3);
    for (const options of seen) {
      assert.equal(options.redirect, 'manual');
      assert.equal('recovery' in options, false);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a 3xx on the recovery path throws a fatal instead of yielding a font link', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, options) => {
    seen.push(options);
    return {
      ok: false,
      status: 302,
      text: async () => JSON.stringify({ data: { files: [{ name: 'Fonts.zip' }] } }),
    };
  };
  try {
    await assert.rejects(
      resolveFontFromDirectory(
        'https://ddl.example.workers.dev/0:/Uma/',
        { redirect: RECOVERY_REDIRECT_MODE }
      ),
      (err) => {
        assert.equal(recoveryFatalCodeFor(err), RECOVERY_CODES.REDIRECT);
        return true;
      }
    );
    // The first (JSON) attempt throws the typed refusal; it must not be
    // swallowed by the form/HTML fallback attempts.
    assert.equal(seen.length, 1, 'fatal refusal stops at the first attempt');
    assert.equal(seen[0].recovery, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// V1 / V2: validate the fetch target BEFORE the first request and on every hop
// ---------------------------------------------------------------------------

test('V1: scrapePostPage refuses a private first-page URL without any fetch', async () => {
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const warnings = [];
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return okResponse('');
  };
  console.warn = (message) => warnings.push(String(message));
  try {
    const result = await scrapePostPage(
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      null, null, 'V1 Test'
    );
    assert.equal(result, null, 'a refused page must yield the normal failure result');
    assert.equal(calls, 0, 'no network request may be made for a refused page URL');
    assert.ok(warnings.some(w => /unsafe post page URL/.test(w)), 'the refusal is logged');
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
});

test('V2: followRedirectUrl never fetches a Location pointing at a private address', async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options);
    return redirectResponse('http://169.254.169.254/latest/meta-data/');
  };
  const { lookup } = lookupWith([PUBLIC_IP]);
  const original = 'https://bit.ly.example/x';
  const result = await followRedirectUrl(original, { fetchImpl, lookup });
  assert.equal(calls.length, 1, 'the private Location must never be fetched');
  assert.equal(result, original, 'the safe URL is returned unchanged on refusal');
  assert.equal(calls[0].redirect, 'manual', 'redirects are never auto-followed');
});

test('V1: a scraped page 302 into cloud metadata is refused before the second fetch', async () => {
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const warnings = [];
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return redirectResponse('http://169.254.169.254/latest/meta-data/iam/security-credentials/');
  };
  console.warn = (message) => warnings.push(String(message));
  try {
    const { lookup } = lookupWith([PUBLIC_IP]);
    const result = await scrapePostPage(
      'https://public-attacker.example/post', null, null, 'V1 Redirect', { lookup }
    );
    assert.equal(result, null, 'a refused redirect yields the normal failure result');
    assert.equal(calls.length, 1, 'the private Location must never be fetched');
    assert.equal(calls[0].options.redirect, 'manual', 'undici must not auto-follow the first hop');
    assert.ok(warnings.some(w => /unsafe redirect/.test(w)), 'the refusal is logged');
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
});

test('V1: a normal public 2xx page still scrapes with a manual first fetch', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return okResponse('<html><body><a href="https://example.com/file.ass">ملف الترجمة والخطوط</a></body></html>');
  };
  try {
    const data = await scrapePostPage('https://public-attacker.example/ok-post', null, null, 'V1 OK');
    assert.equal(data.bestDownloadUrl, 'https://example.com/file.ass');
    assert.equal(calls.length, 1, 'no extra request for a plain 2xx page');
    assert.equal(calls[0].options.redirect, 'manual');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('V1: a validated public 302 is followed through the re-validated chain', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://public-attacker.example/chain') {
      return redirectResponse('https://public-target.example/final');
    }
    return okResponse('<html><body><a href="https://example.com/file.ass">ملف الترجمة والخطوط</a></body></html>');
  };
  try {
    const { lookup } = lookupWith([PUBLIC_IP]);
    const data = await scrapePostPage(
      'https://public-attacker.example/chain', null, null, 'V1 Chain', { lookup }
    );
    assert.deepEqual(calls.map(c => c.url), [
      'https://public-attacker.example/chain', 'https://public-target.example/final',
    ]);
    assert.ok(calls.every(c => c.options.redirect === 'manual'));
    assert.equal(data.pageUrl, 'https://public-target.example/final');
    assert.equal(data.bestDownloadUrl, 'https://example.com/file.ass');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a meta refresh on a validated 302 target is followed with every hop manual and validated', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://public-attacker.example/chain-meta') {
      return redirectResponse('https://public-target.example/mid');
    }
    if (url === 'https://public-target.example/mid') {
      return okResponse('<html><head><meta http-equiv="refresh" content="0;url=https://meta-target.example/final"></head><body>redirect</body></html>');
    }
    return okResponse('<html><body><a href="https://example.com/file.ass">ملف الترجمة والخطوط</a></body></html>');
  };
  try {
    const { lookup } = lookupWith([PUBLIC_IP]);
    const data = await scrapePostPage(
      'https://public-attacker.example/chain-meta', null, null, 'V1 Chain Meta', { lookup }
    );
    assert.deepEqual(calls.map(c => c.url), [
      'https://public-attacker.example/chain-meta',
      'https://public-target.example/mid',
      'https://meta-target.example/final',
    ]);
    assert.ok(calls.every(c => c.options.redirect === 'manual'), 'no hop is auto-followed');
    assert.equal(data.pageUrl, 'https://meta-target.example/final');
    assert.equal(data.bestDownloadUrl, 'https://example.com/file.ass');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a private meta refresh on a validated 302 target is refused without a request', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://public-attacker.example/chain-meta-private') {
      return redirectResponse('https://public-target.example/mid-private');
    }
    return okResponse('<html><head><meta http-equiv="refresh" content="0;url=http://169.254.169.254/latest/meta-data/"></head><body>x</body></html>');
  };
  try {
    const { lookup } = lookupWith([PUBLIC_IP]);
    await scrapePostPage(
      'https://public-attacker.example/chain-meta-private', null, null, 'V1 Chain Meta Private', { lookup }
    );
    assert.deepEqual(calls.map(c => c.url), [
      'https://public-attacker.example/chain-meta-private',
      'https://public-target.example/mid-private',
    ]);
    assert.equal(calls.some(c => c.url.includes('169.254.169.254')), false, 'the metadata URL is never fetched');
    assert.ok(calls.every(c => c.options.redirect === 'manual'));
  } finally {
    globalThis.fetch = realFetch;
  }
});
