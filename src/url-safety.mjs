// Shared URL-safety boundary for every scraped-URL fetch path.
//
// This is a leaf module: it imports nothing from other src files, so callers
// can import/re-export it without creating a cycle. The DNS lookup and the
// fetch implementation are injectable, which keeps every decision testable
// offline. Behaviour of the helpers below is identical to the originals in
// site-scrapers.mjs — they were moved here verbatim so the guards cannot drift.

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
export const HTTP_TIMEOUT_MS = 60_000;
export const META_REFRESH_MAX_HOPS = 3;

// DNS-name forms that must never be followed. IP literals are handled by
// isPrivateAddress instead (which also covers 169.254.169.254 / 169.254.170.2).
export const META_REFRESH_FORBIDDEN_HOSTS = new Set([
  'metadata', 'metadata.google.internal', 'metadata.goog', 'metadata.azure.com',
  'instance-data', 'instance-data.ec2.internal', 'kubernetes.default',
  'metadata.local',
]);

export function normaliseHostname(host) {
  let h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1); // IPv6 URL literal
  return h;
}

export function isForbiddenHostname(host) {
  const h = normaliseHostname(host);
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true;
  if (h.endsWith('.internal')) return true;
  return META_REFRESH_FORBIDDEN_HOSTS.has(h);
}

/** Expand a validated IPv6 address to eight numeric hextets. */
export function expandIpv6(ip) {
  const parts = ip.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts[1] ? parts[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const hextets = [...left, ...Array(missing).fill('0'), ...right]
    .map(h => parseInt(h || '0', 16));
  return hextets.length === 8 && hextets.every(Number.isFinite) ? hextets : null;
}

/** True for private/loopback/link-local/unique-local (or malformed) addresses. */
export function isPrivateAddress(address) {
  let ip = String(address || '').trim().toLowerCase().replace(/%.*$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) ip = mapped[1]; // IPv4-mapped IPv6

  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;          // unspecified / private / loopback
    if (a === 169 && b === 254) return true;                    // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;           // private
    if (a === 192 && b === 168) return true;                    // private
    if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
    if (a === 192 && b === 0 && c === 2) return true;           // documentation
    if (a === 198 && (b === 18 || b === 19)) return true;       // benchmarking
    if (a === 198 && b === 51 && c === 100) return true;        // documentation
    if (a === 203 && b === 0 && c === 113) return true;         // documentation
    if (a >= 224) return true;                                  // multicast / reserved
    return false;
  }

  if (isIP(ip) === 6) {
    const h = expandIpv6(ip);
    if (!h) return true; // malformed — refuse
    if (h.every(x => x === 0)) return true;                    // :: unspecified
    // WHATWG URL canonicalises IPv4-mapped/compatible forms to hex
    // (e.g. [::ffff:127.0.0.1] -> ::ffff:7f00:1), so extract the embedded v4.
    if (h.slice(0, 5).every(x => x === 0) && (h[5] === 0xffff || h[5] === 0)) {
      const a = h[6] >> 8, b = h[6] & 0xff, c = h[7] >> 8, d = h[7] & 0xff;
      return isPrivateAddress(`${a}.${b}.${c}.${d}`);
    }
    if ((h[0] & 0xffc0) === 0xfe80) return true;               // link-local fe80::/10
    if ((h[0] & 0xfe00) === 0xfc00) return true;               // unique-local fc00::/7
    return false;
  }

  return true; // malformed address — refuse
}

/**
 * May a meta-refresh target be fetched? Resolves `target` against `sourceUrl`;
 * allows only http(s), no credentials, no local/metadata hostnames, and (for
 * DNS names) EVERY resolved answer must be public. A mixed public/private
 * answer set is refused because the actual connection may land on the private
 * answer. DNS failure or malformed answers refuse — fail closed.
 */
export async function isAllowedMetaRefreshTarget(target, sourceUrl, lookup = dnsLookup) {
  let url;
  try {
    url = new URL(String(target), sourceUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;

  const host = normaliseHostname(url.hostname);
  if (!host || isForbiddenHostname(host)) return false;

  if (isIP(host)) return !isPrivateAddress(host);

  try {
    const answers = await lookup(host, { all: true });
    if (!Array.isArray(answers) || answers.length === 0) return false;
    // Fail closed: EVERY answer must be public. `some` let a mixed
    // public/private answer set through, but the socket may still open to the
    // private address. A null/malformed answer also fails here.
    return answers.every(a => a && !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

/**
 * The site Cookie may only travel back to the SAME scheme AND host that issued
 * the meta refresh. An https -> http downgrade is refused (it would leak the
 * cookie in cleartext); the port is irrelevant to cookie semantics. Returns an
 * empty object otherwise (so the caller sends only the User-Agent), and never
 * forwards an empty cookie.
 */
export function cookieHeaderForRedirect(cookieHeader, targetUrl, sourceUrl) {
  if (!cookieHeader) return {};
  try {
    const target = new URL(String(targetUrl));
    const source = new URL(String(sourceUrl));
    const targetHost = normaliseHostname(target.hostname);
    const sourceHost = normaliseHostname(source.hostname);
    if (targetHost && target.protocol === source.protocol && targetHost === sourceHost) {
      return { Cookie: cookieHeader };
    }
  } catch { }
  return {};
}

/** Extract the `url=` target of a <meta http-equiv=refresh> tag (any attribute order). */
export function extractMetaRefreshTarget(html) {
  const tag = String(html || '').match(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?refresh["']?[^>]*>/i);
  if (!tag) return null;
  const content = tag[0].match(/\bcontent\s*=\s*["']?([^"'>]*)/i);
  if (!content) return null;
  const url = content[1].match(/\burl\s*=\s*["']?([^"'\s]+)/i);
  if (!url) return null;
  return url[1].trim().replace(/^['"]|['"]$/g, '') || null;
}

/**
 * Synchronous, DNS-free initial-fetch guard.
 *
 * Used for fetch paths whose host may be an unresolvable test name
 * (`example.test`, `evil.tld`) that must NOT trigger DNS. WHATWG URL parsing
 * canonicalises decimal/octal/hex IPv4 literals and IPv4-mapped IPv6 literals
 * into forms that isIP() recognises, so those cannot slip past the check.
 * DNS names that are not forbidden are accepted without resolution; that is
 * the explicitly accepted rebinding risk for `staticOnly` callers.
 */
export function isStaticSafeUrl(target, sourceUrl) {
  let url;
  try {
    url = new URL(String(target), sourceUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;

  const host = normaliseHostname(url.hostname);
  if (!host || isForbiddenHostname(host)) return false;

  // `new URL()` canonicalises 2130706433 / 0177.0.0.1 / 0x7f.0.0.1 to
  // 127.0.0.1 and [::ffff:127.0.0.1] to [::ffff:7f00:1], so an IP literal
  // here always reaches isPrivateAddress in a comparable form.
  if (isIP(host)) return !isPrivateAddress(host);

  return true;
}

/** Typed error thrown in `recovery` mode when any 3xx response is seen. */
export class RecoveryRedirectError extends Error {
  constructor(message = 'Redirect refused during recovery') {
    super(message);
    this.name = 'RecoveryRedirectError';
    this.code = 'RECOVERY_REDIRECT';
  }
}

/**
 * Generalised, fully validated fetch for scraped URLs.
 *
 * Every hop (including the initial URL) is validated before it is fetched:
 * with `staticOnly` false via isAllowedMetaRefreshTarget (injected lookup),
 * otherwise via the DNS-free isStaticSafeUrl. A caller may supply
 * `initialValidator(target, sourceUrl)` to validate ONLY the first URL with a
 * different (e.g. DNS-free) policy while redirect hops stay DNS-checked;
 * a throwing validator fails closed. Responses are always fetched with
 * `redirect: 'manual'` so a Location can never be followed unchecked. Callers
 * may pass `method` and `body` (for POST directories); a 301/302/303 downgrades
 * a POST to a body-less GET on the next hop, while 307/308 preserve both.
 * The Cookie is re-scoped against the ORIGINAL `sourceUrl` on every hop.
 * In `recovery` mode any 3xx throws a RecoveryRedirectError (code
 * 'RECOVERY_REDIRECT') BEFORE the redirect target is fetched, and a transport
 * error is rethrown so the caller can classify it as a fatal.
 *
 * Returns { response, url } from a fully validated 2xx (or any non-3xx status
 * when `allowNonOk` is set, so a caller can inspect a 403/503 challenge) — the
 * response body is left untouched for the caller. Returns null on any
 * blocked/invalid hop, missing Location, hop-cap or (non-recovery) fetch error.
 */
export async function fetchSafe(url, {
  sourceUrl = url,
  cookieHeader = '',
  lookup = dnsLookup,
  fetchImpl = (...a) => globalThis.fetch(...a),
  maxRedirects = META_REFRESH_MAX_HOPS,
  staticOnly = false,
  headers = {},
  timeoutMs = HTTP_TIMEOUT_MS,
  recovery = false,
  initialValidator = null,
  allowNonOk = false,
  method = 'GET',
  body = undefined,
} = {}) {
  let currentUrl = url;
  let currentMethod = method;
  let currentBody = body;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    // Validate BEFORE fetching: a public host must not be able to 302 us into
    // a private address (or receive the site Cookie on a different host).
    let allowed = false;
    try {
      if (hop === 0 && initialValidator) {
        allowed = await initialValidator(currentUrl, sourceUrl);
      } else if (staticOnly) {
        allowed = isStaticSafeUrl(currentUrl, sourceUrl);
      } else {
        allowed = await isAllowedMetaRefreshTarget(currentUrl, sourceUrl, lookup);
      }
    } catch {
      return null;
    }
    if (!allowed) return null;

    // Build fresh headers per hop. Never let caller headers override the
    // forced User-Agent or re-introduce a Cookie that cookie scoping removed.
    const requestHeaders = { ...headers, 'User-Agent': UA };
    for (const key of Object.keys(requestHeaders)) {
      if (key.toLowerCase() === 'cookie') delete requestHeaders[key];
    }
    Object.assign(requestHeaders, cookieHeaderForRedirect(cookieHeader, currentUrl, sourceUrl));

    // Keep the historical option shape for plain GETs (no method/body keys),
    // and retain the recovery marker that older no-redirect callers pass to
    // fetch. The method/body are added only for non-default POST requests.
    const init = {
      headers: requestHeaders,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (recovery) init.recovery = true;
    if (currentMethod !== 'GET') init.method = currentMethod;
    if (currentBody !== undefined) init.body = currentBody;

    let res;
    try {
      res = await fetchImpl(currentUrl, init);
    } catch (e) {
      // Recovery callers must see the transport failure so it can be
      // classified as fatal instead of silently becoming "no page".
      if (recovery) throw e;
      return null;
    }

    if (res.status >= 300 && res.status < 400) {
      // Recovery mode must not follow a redirect at all — surface a typed
      // error so the caller can classify it as a recovery failure.
      if (recovery) {
        try { await res.body?.cancel(); } catch { }
        const loc = res.headers?.get?.('location') || '';
        throw new RecoveryRedirectError(`Refusing redirect during recovery${loc ? `: ${loc}` : ''}`);
      }

      const loc = res.headers?.get?.('location');
      let nextUrl = null;
      try {
        if (loc) nextUrl = new URL(loc, currentUrl).toString();
      } catch { nextUrl = null; }
      try { await res.body?.cancel(); } catch { }
      if (!nextUrl || hop >= maxRedirects || nextUrl === currentUrl) return null;

      // 301/302/303 convert a POST into a body-less GET (standard HTTP
      // semantics) so the POST body is never replayed to a different host.
      // 307/308 keep the original method and body. The next loop iteration
      // re-validates currentUrl before fetching it.
      if (res.status === 301 || res.status === 302 || res.status === 303) {
        currentMethod = 'GET';
        currentBody = undefined;
      }
      currentUrl = nextUrl;
      continue;
    }

    if (!res.ok) {
      // A 403/503 can carry a Cloudflare challenge the caller still needs to
      // inspect (and refuse on the recovery path). It is NOT a redirect, so
      // handing the body back does not bypass any hop validation.
      if (allowNonOk) return { response: res, url: currentUrl };
      try { await res.body?.cancel(); } catch { }
      return null;
    }

    // Preserve the stream for the caller — do NOT consume res.text() here.
    return { response: res, url: currentUrl };
  }

  return null;
}
