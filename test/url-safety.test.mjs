import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchSafe,
  isPrivateAddress,
  isStaticSafeUrl,
  RecoveryRedirectError,
} from '../src/url-safety.mjs';

const SOURCE = 'https://example.com/start';
const PUBLIC_IP = '93.184.216.34';

/** Deterministic DNS stub — never touches the network. */
function lookupWith(addresses, byHost = {}) {
  const calls = [];
  const lookup = async (host, options) => {
    calls.push({ host, options });
    assert.deepEqual(options, { all: true }, 'lookup must request all answers');
    const answer = Object.hasOwn(byHost, host) ? byHost[host] : addresses;
    if (answer === null) {
      throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    }
    return answer.map(address => ({
      address,
      family: String(address).includes(':') ? 6 : 4,
    }));
  };
  return { lookup, calls };
}

/** fetch stub that records every call and delegates the response to a handler. */
function fetchStub(handler) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options, calls.length - 1);
  };
  return { fetchImpl, calls };
}

function okResponse() {
  // A marker body proves fetchSafe did not consume the stream.
  return { status: 200, ok: true, headers: new Headers(), body: null, marker: 'untouched' };
}

function redirectResponse(location, status = 302) {
  const headers = new Headers();
  if (location !== null && location !== undefined) headers.set('location', location);
  return {
    status,
    ok: false,
    headers,
    body: { cancel: async () => { } },
  };
}

// ---------------------------------------------------------------------------
// isStaticSafeUrl — synchronous, DNS-free, URL-canonicalised
// ---------------------------------------------------------------------------

test('static guard blocks private, loopback, link-local and metadata IP literals', () => {
  for (const target of [
    'http://169.254.169.254/latest/meta-data/',
    'http://169.254.170.2/v2/credentials',
    'http://127.0.0.1/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://[::1]/',
    'http://[::]/',
  ]) {
    assert.equal(isStaticSafeUrl(target, SOURCE), false, target);
  }
});

test('static guard blocks non-http schemes and credentials', () => {
  for (const target of [
    'file:///etc/passwd',
    'ftp://example.com/x',
    'javascript:alert(1)',
    'http://user@example.com/',
    'http://user:pass@example.com/',
  ]) {
    assert.equal(isStaticSafeUrl(target, SOURCE), false, target);
  }
});

test('static guard blocks localhost, .local and .internal before DNS', () => {
  for (const target of [
    'http://localhost/x',
    'http://router.local/x',
    'http://vault.internal/x',
    'http://metadata.google.internal/',
    'http://kubernetes.default/',
  ]) {
    assert.equal(isStaticSafeUrl(target, SOURCE), false, target);
  }
});

test('static guard catches canonicalised decimal, octal and hex IPv4', () => {
  // All four forms canonicalise (via new URL) to 169.254.169.254.
  for (const target of [
    'http://2852039166/latest/meta-data/',
    'http://0251.0376.0251.0376/',
    'http://0xa9.0xfe.0xa9.0xfe/',
    'http://0xA9FEA9FE/',
  ]) {
    assert.equal(new URL(String(target), SOURCE).hostname, '169.254.169.254', target);
    assert.equal(isStaticSafeUrl(target, SOURCE), false, target);
  }
  // 127.0.0.1 in alternate forms.
  for (const target of [
    'http://2130706433/',
    'http://0177.0.0.1/',
    'http://0x7f.0.0.1/',
  ]) {
    assert.equal(isStaticSafeUrl(target, SOURCE), false, target);
  }
});

test('static guard catches IPv4-mapped IPv6 literals', () => {
  for (const target of [
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::ffff:7f00:1]/',
  ]) {
    assert.equal(isStaticSafeUrl(target, SOURCE), false, target);
  }
});

test('static guard accepts public hosts and unresolvable test names', () => {
  assert.equal(isStaticSafeUrl('https://example.test/', SOURCE), true);
  assert.equal(isStaticSafeUrl('http://evil.tld/path?q=1', SOURCE), true);
  assert.equal(isStaticSafeUrl('https://93.184.216.34/', SOURCE), true);
  assert.equal(isStaticSafeUrl('https://example.test/modern', 'https://example.test/start'), true);
  // A relative string resolves against the base; a genuinely malformed URL does not.
  assert.equal(isStaticSafeUrl('http://', SOURCE), false);
  assert.equal(isStaticSafeUrl('http://[invalid', SOURCE), false);
});

test('isPrivateAddress keeps the original IPv6 and malformed-address semantics', () => {
  assert.equal(isPrivateAddress('93.184.216.34'), false);
  assert.equal(isPrivateAddress('::ffff:93.184.216.34'), false);
  assert.equal(isPrivateAddress('fe80::1'), true);
  assert.equal(isPrivateAddress('fc00::1'), true);
  assert.equal(isPrivateAddress('garbage'), true);
});

// ---------------------------------------------------------------------------
// fetchSafe — every hop validated, body preserved
// ---------------------------------------------------------------------------

test('fetchSafe returns { response, url } from a validated 2xx with body untouched', async () => {
  const { fetchImpl, calls } = fetchStub(() => okResponse());
  const { lookup } = lookupWith([PUBLIC_IP]);
  const result = await fetchSafe('https://example.com/file', {
    sourceUrl: SOURCE,
    lookup,
    fetchImpl,
  });
  assert.equal(result.url, 'https://example.com/file');
  assert.equal(result.response.marker, 'untouched');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.ok(calls[0].options.headers['User-Agent']);
});

test('fetchSafe refuses a public -> private 302 without ever fetching the private URL', async () => {
  const privateUrl = 'http://169.254.169.254/latest/meta-data/iam/security-credentials/';
  const { fetchImpl, calls } = fetchStub(() => redirectResponse(privateUrl));
  const { lookup } = lookupWith([PUBLIC_IP]);
  const result = await fetchSafe('https://example.com/page', {
    sourceUrl: SOURCE,
    lookup,
    fetchImpl,
  });
  assert.equal(result, null);
  assert.equal(calls.length, 1, 'the private redirect target must not be fetched');
  assert.equal(calls[0].url, 'https://example.com/page');
});

test('fetchSafe refuses a DNS name that resolves to a private address', async () => {
  const { fetchImpl, calls } = fetchStub(() => redirectResponse('http://attacker.test/'));
  const { lookup } = lookupWith([PUBLIC_IP], {
    'attacker.test': ['127.0.0.1', PUBLIC_IP], // mixed set must fail closed
  });
  const result = await fetchSafe('https://example.com/page', {
    sourceUrl: SOURCE,
    lookup,
    fetchImpl,
  });
  assert.equal(result, null);
  assert.equal(calls.length, 1);
});

test('fetchSafe refuses a 3xx with no Location', async () => {
  const { fetchImpl, calls } = fetchStub(() => redirectResponse(null));
  const { lookup } = lookupWith([PUBLIC_IP]);
  assert.equal(await fetchSafe('https://example.com/page', { sourceUrl: SOURCE, lookup, fetchImpl }), null);
  assert.equal(calls.length, 1);
});

test('fetchSafe caps redirect hops', async () => {
  const { fetchImpl, calls } = fetchStub((url, options, i) =>
    redirectResponse(`https://public-${i + 1}.test/next`)
  );
  const { lookup } = lookupWith([PUBLIC_IP]);
  const result = await fetchSafe('https://public-0.test/start', {
    sourceUrl: SOURCE,
    lookup,
    fetchImpl,
    maxRedirects: 2,
  });
  assert.equal(result, null);
  assert.equal(calls.length, 3, 'initial fetch plus at most maxRedirects follows');
});

test('fetchSafe re-scopes the Cookie against the original source on every hop', async () => {
  const { fetchImpl, calls } = fetchStub((url, options, i) =>
    i === 0 ? redirectResponse('https://other.example/file') : okResponse()
  );
  const { lookup } = lookupWith([PUBLIC_IP]);
  const result = await fetchSafe('https://example.com/file', {
    sourceUrl: SOURCE,
    cookieHeader: 'session=abc',
    lookup,
    fetchImpl,
  });
  assert.equal(result.url, 'https://other.example/file');
  assert.equal(calls[0].options.headers.Cookie, 'session=abc');
  assert.equal(calls[1].options.headers.Cookie, undefined);
  // Caller-supplied Cookie must not re-introduce the site cookie on a new host.
  assert.equal(calls[1].options.headers['X-Test'], undefined);
});

test('fetchSafe drops a caller Cookie header when scoping forbids it', async () => {
  const { fetchImpl, calls } = fetchStub(() => okResponse());
  const { lookup } = lookupWith([PUBLIC_IP]);
  await fetchSafe('https://different.test/file', {
    sourceUrl: SOURCE,
    headers: { Cookie: 'leak=1', 'X-Trace': 'keep' },
    lookup,
    fetchImpl,
  });
  assert.equal(calls[0].options.headers.Cookie, undefined);
  assert.equal(calls[0].options.headers['X-Trace'], 'keep');
});

test('fetchSafe refuses an https -> http downgrade of the same host', async () => {
  const { fetchImpl, calls } = fetchStub((url, options, i) =>
    i === 0 ? redirectResponse('http://example.com/downgraded') : okResponse()
  );
  const { lookup } = lookupWith([PUBLIC_IP]);
  await fetchSafe('https://example.com/file', {
    sourceUrl: SOURCE,
    cookieHeader: 'session=abc',
    lookup,
    fetchImpl,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.Cookie, undefined);
});

test('fetchSafe in recovery mode throws a typed RECOVERY_REDIRECT before following', async () => {
  const { fetchImpl, calls } = fetchStub(() => redirectResponse('https://example.com/next'));
  const { lookup } = lookupWith([PUBLIC_IP]);
  await assert.rejects(
    fetchSafe('https://example.com/page', { sourceUrl: SOURCE, lookup, fetchImpl, recovery: true }),
    err => err instanceof RecoveryRedirectError && err.code === 'RECOVERY_REDIRECT'
  );
  assert.equal(calls.length, 1, 'recovery mode must not fetch the redirect target');
});

test('fetchSafe with staticOnly never consults DNS', async () => {
  const { fetchImpl, calls } = fetchStub(() => okResponse());
  const { lookup, calls: dnsCalls } = lookupWith([PUBLIC_IP]);
  const result = await fetchSafe('https://example.test/file', {
    sourceUrl: 'https://example.test/start',
    lookup,
    fetchImpl,
    staticOnly: true,
  });
  assert.equal(result.url, 'https://example.test/file');
  assert.equal(calls.length, 1);
  assert.equal(dnsCalls.length, 0, 'staticOnly must not trigger DNS for unresolvable test hosts');
});

test('fetchSafe returns null on fetch errors and DNS failures', async () => {
  const badFetch = fetchStub(() => { throw new Error('network down'); });
  const { lookup } = lookupWith([PUBLIC_IP]);
  assert.equal(await fetchSafe('https://example.com/x', {
    sourceUrl: SOURCE, lookup, fetchImpl: badFetch.fetchImpl,
  }), null);

  const okFetch = fetchStub(() => okResponse());
  const { lookup: failingLookup } = lookupWith(null);
  assert.equal(await fetchSafe('https://unresolvable.test/x', {
    sourceUrl: SOURCE, lookup: failingLookup, fetchImpl: okFetch.fetchImpl,
  }), null);
  assert.equal(okFetch.calls.length, 0);
});

// ---------------------------------------------------------------------------
// initialValidator / allowNonOk / recovery transport errors
// ---------------------------------------------------------------------------

test('fetchSafe initialValidator overrides ONLY the first hop', async () => {
  const { fetchImpl, calls } = fetchStub((url, options, i) =>
    i === 0 ? redirectResponse('https://redirect.test/next') : okResponse()
  );
  const { lookup, calls: dnsCalls } = lookupWith([PUBLIC_IP]);
  const result = await fetchSafe('https://initial.test/start', {
    lookup,
    fetchImpl,
    initialValidator: (target) => target === 'https://initial.test/start',
  });
  assert.equal(result.url, 'https://redirect.test/next');
  assert.equal(calls.length, 2);
  assert.deepEqual(dnsCalls.map(c => c.host), ['redirect.test'], 'redirect hop is still DNS-checked');
});

test('fetchSafe initialValidator that throws fails closed without a fetch', async () => {
  const { fetchImpl, calls } = fetchStub(() => okResponse());
  assert.equal(await fetchSafe('https://initial.test/start', {
    fetchImpl,
    initialValidator: () => { throw new Error('validator down'); },
  }), null);
  assert.equal(calls.length, 0);
});

test('fetchSafe allowNonOk hands a 403 body back for challenge handling', async () => {
  const challenge = { status: 403, ok: false, headers: new Headers(), body: null, text: async () => 'Just a moment...' };
  const { fetchImpl } = fetchStub(() => challenge);
  const { lookup } = lookupWith([PUBLIC_IP]);
  const result = await fetchSafe('https://example.com/challenge', {
    sourceUrl: SOURCE, lookup, fetchImpl, allowNonOk: true,
  });
  assert.equal(result.response, challenge);
  assert.equal(result.url, 'https://example.com/challenge');
});

test('fetchSafe recovery mode rethrows a transport error instead of returning null', async () => {
  const boom = new Error('fetch failed');
  boom.cause = new Error('unexpected redirect');
  const { fetchImpl } = fetchStub(() => { throw boom; });
  const { lookup } = lookupWith([PUBLIC_IP]);
  await assert.rejects(
    fetchSafe('https://example.com/page', { sourceUrl: SOURCE, lookup, fetchImpl, recovery: true }),
    err => err === boom
  );
});
