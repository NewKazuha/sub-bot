import * as cheerio from 'cheerio';
import { execFileSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const HTTP_TIMEOUT_MS = 60_000;

function fetchWithTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  return fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(timeoutMs) });
}

function isCertificateValidationError(error) {
  const detail = `${error?.code || ''} ${error?.cause?.code || ''} ${error?.message || ''} ${error?.cause?.message || ''}`;
  return /(?:CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|UNTRUSTED)/i.test(detail);
}

function fetchHtmlWithCurl(url, cookieHeader = '') {
  // curl uses the runner's maintained system CA bundle. This is a secure
  // fallback for Rhythm only when Node's bundled CA store rejects its chain.
  const command = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const args = [
    '--fail', '--silent', '--show-error', '--max-time', '60',
    '--user-agent', UA
  ];
  if (cookieHeader) args.push('--cookie', cookieHeader);
  args.push(url);
  return execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 65_000,
    maxBuffer: 10 * 1024 * 1024
  });
}

class SessionJar {
  constructor() {
    this.cookies = new Map();
  }
  absorb(res) {
    let setCookies = [];
    if (typeof res.headers.getSetCookie === 'function') {
      setCookies = res.headers.getSetCookie() || [];
    } else if (res.headers.get('set-cookie')) {
      setCookies = [res.headers.get('set-cookie')];
    }
    for (const line of setCookies) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

const siteSessions = new Map();
const SESSION_TTL = 2 * 60 * 60 * 1000; // Refresh session cookie every 2 hours

async function ensureSiteSession(siteConfig) {
  if (!siteConfig || !siteConfig.user || !siteConfig.pass) return null;
  const now = Date.now();
  const cached = siteSessions.get(siteConfig.id);
  if (cached && (now - cached.created < SESSION_TTL)) {
    return cached.jar;
  }
  const jar = new SessionJar();
  siteSessions.set(siteConfig.id, { jar, created: now });

  // 1. Check if site is Laravel / Custom Auth (e.g. Revive Subs)
  if (siteConfig.id === 'revive' || (siteConfig.base && siteConfig.base.includes('revivesubs'))) {
    try {
      const getRes = await fetchWithTimeout(`${siteConfig.base}/login`, {
        headers: { 'User-Agent': UA }
      });
      jar.absorb(getRes);
      const html = await getRes.text();
      const $ = cheerio.load(html);
      const token = $('meta[name="csrf-token"]').attr('content') || $('input[name="_token"]').val();

      // Revive protects its login with Cloudflare Turnstile.  A GitHub Actions
      // runner cannot legitimately complete an interactive challenge, so a
      // password-only POST is guaranteed to be rejected even when the
      // credentials are valid.  Keep the anonymous session (public posts may
      // still be readable) and let the caller try the next URL in a joint post.
      if ($('input[name="cf-turnstile-response"]').length) {
        console.warn(`Login to ${siteConfig.name} requires Cloudflare Turnstile; skipping automated login and using public pages only.`);
        return jar;
      }

      const params = new URLSearchParams();
      if (token) params.append('_token', token);
      params.append('email', siteConfig.user);
      params.append('password', siteConfig.pass);
      params.append('remember', 'on');

      const postRes = await fetchWithTimeout(`${siteConfig.base}/login`, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': jar.header(),
          'Referer': `${siteConfig.base}/login`
        },
        body: params.toString(),
        redirect: 'manual'
      });
      jar.absorb(postRes);
      return jar;
    } catch (e) {
      console.warn(`Login to Laravel site ${siteConfig.name} failed:`, e.message);
      return jar;
    }
  }

  // 2. Standard WordPress Authentication (Rhythm, LazySano, Anime-San, Celestial)
  try {
    const wpInit = await fetchWithTimeout(`${siteConfig.base}/wp-login.php`, {
      headers: { 'User-Agent': UA }
    });
    jar.absorb(wpInit);

    const params = new URLSearchParams({
      log: siteConfig.user,
      pwd: siteConfig.pass,
      rememberme: 'forever',
      'wp-submit': 'Log In',
      testcookie: '1',
      redirect_to: `${siteConfig.base}/`
    });

    const res = await fetchWithTimeout(`${siteConfig.base}/wp-login.php`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': jar.header(),
        'Referer': `${siteConfig.base}/wp-login.php`
      },
      body: params.toString(),
      redirect: 'manual'
    });
    jar.absorb(res);
    const loggedIn = [...jar.cookies.keys()].some(name => /^wordpress_(?:sec_|logged_in_)/i.test(name));
    if (!loggedIn) {
      console.warn(`Login to WordPress site ${siteConfig.name} was not accepted; protected posts cannot be read.`);
    }
  } catch (e) {
    console.warn(`Login to WordPress site ${siteConfig.name} failed:`, e.message);
  }
  return jar;
}

const IGNORED_DOMAINS = [
  'maz-software.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'instagram.com',
  'discord.gg',
  'discord.com',
  't.me',
  'telegram.me',
  'wordpress.org',
  'blogger.com',
  'google.com/url',
  'support.google.com',
  'policies.google.com'
];

export async function followRedirectUrl(url, maxHops = 3) {
  if (!url || !url.startsWith('http')) return url;
  let curr = url;
  for (let i = 0; i < maxHops; i++) {
    try {
      // Many link shorteners (including Blogger redirect pages) reject HEAD.
      // Try HEAD first, then use a redirect-only GET without downloading the body.
      let res = await fetchWithTimeout(curr, {
        method: 'HEAD',
        redirect: 'manual',
        headers: { 'User-Agent': UA }
      });
      if (![301, 302, 303, 307, 308].includes(res.status)) {
        try { await res.body?.cancel(); } catch {}
        res = await fetchWithTimeout(curr, {
          method: 'GET',
          redirect: 'manual',
          headers: { 'User-Agent': UA, 'Range': 'bytes=0-0' }
        });
      }
      const loc = res.headers.get('location');
      if (loc && (res.status >= 300 && res.status < 400)) {
        curr = new URL(loc, curr).toString();
      } else {
        break;
      }
      try { await res.body?.cancel(); } catch {}
    } catch {
      break;
    }
  }
  return curr;
}

function normaliseLinkUrl(rawUrl, pageUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl.trim(), pageUrl);
    return /^https?:$/i.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function getLinkTarget($, el, pageUrl) {
  // Some Arabic fansub themes place the target in a data attribute or an
  // onclick handler instead of href. Support both forms used by their buttons.
  const raw = $(el).attr('href') || $(el).attr('data-href') ||
    $(el).attr('data-url') || $(el).attr('data-link');
  const normal = normaliseLinkUrl(raw, pageUrl);
  if (normal) return normal;

  const onclick = $(el).attr('onclick') || '';
  const match = onclick.match(/(?:window\.location(?:\.href)?|location\.href)\s*=\s*['"]([^'"]+)['"]/i);
  return normaliseLinkUrl(match?.[1], pageUrl);
}

async function resolveSubtitleFromDirectory(directoryUrl) {
  try {
    const res = await fetchWithTimeout(directoryUrl, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!/html|text\//i.test(contentType)) return null;

    const $ = cheerio.load(await res.text());
    const candidates = [];
    $('a[href]').each((_, el) => {
      const href = normaliseLinkUrl($(el).attr('href'), directoryUrl);
      const label = $(el).text().trim();
      if (href && (/\.(?:ass|srt|zip|rar|7z)(?:$|[?#])/i.test(href) || /\.(?:ass|srt|zip|rar|7z)\b/i.test(label))) {
        candidates.push(href);
      }
    });

    // Prefer an archive because fansub releases commonly bundle fonts with it.
    return candidates.find(url => /\.(?:zip|rar|7z)(?:$|[?#])/i.test(url)) || candidates[0] || null;
  } catch (e) {
    console.warn(`Could not inspect subtitle directory ${directoryUrl}:`, e.message);
    return null;
  }
}

export async function scrapePostPage(pageUrl, siteConfig = null) {
  let cookieHeader = '';
  if (siteConfig && siteConfig.user) {
    const jar = await ensureSiteSession(siteConfig);
    if (jar) cookieHeader = jar.header();
  }

  let html = '';
  try {
    const res = await fetchWithTimeout(pageUrl, {
      headers: { 'User-Agent': UA, 'Cookie': cookieHeader }
    });
    html = await res.text();
  } catch (e) {
    if (siteConfig && isCertificateValidationError(e)) {
      try {
        console.warn(`Node TLS validation failed for ${siteConfig.name}; using the system CA bundle.`);
        html = fetchHtmlWithCurl(pageUrl, cookieHeader);
      } catch (curlError) {
        console.error(`Failed to fetch ${siteConfig.name} page with system CA bundle: ${pageUrl}`, curlError.message);
        return null;
      }
    } else {
    console.error(`Failed to fetch page: ${pageUrl}`, e.message);
    return null;
    }
  }

  const $ = cheerio.load(html);

  const title = $('h1.entry-title').text().trim() || 
                $('h1.post-title').text().trim() || 
                $('title').text().replace(/[-–|].*$/, '').trim() || 
                'Anime Release';

  const allLinks = [];
  $('a, [data-href], [data-url], [data-link], [onclick]').each((_, el) => {
    const href = getLinkTarget($, el, pageUrl);
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (href) {
      const isIgnored = IGNORED_DOMAINS.some(d => href.includes(d));
      if (!isIgnored) {
        // Check parent/surrounding context text
        const parentContext = $(el).closest('div, section, article, p, table, tr, td, li').text().trim().replace(/\s+/g, ' ');
        allLinks.push({ href, text, parentContext });
      }
    }
  });

  // 1. Check for dedicated Subtitle / Font links
  // Patterns used by the fansub sites: "ملف الترجمة والخطوط", "ملف الترجمة",
  // "Softsub", and buttons labelled "هنا" under these headings.
  const subKeywordsRegex = /(?:ملف(?:ات)?\s*(?:الترجمة|الترجمات)(?:\s*و\s*الخطوط)?|(?:الترجمة|الترجمات)\s*و?\s*الخطوط|ملف\s*الخطوط|soft\s*sub|subtitles?|fonts?)/i;
  const actionButtonRegex = /^(?:هنا|اضغط\s*هنا|إضغط\s*هنا|اضغط|إضغط|التحميل|تحميل|تنزيل|download|direct|ddl)$/i;

  let directSubLink = null;

  // A. Link text explicitly indicates subtitle file
  for (const l of allLinks) {
    if (subKeywordsRegex.test(l.text) || /\.(ass|srt|zip|rar|7z)$/i.test(l.href)) {
      directSubLink = l.href;
      break;
    }
  }

  // B. Contextual match: link inside a container/heading about subtitle
  if (!directSubLink) {
    for (const l of allLinks) {
      if (subKeywordsRegex.test(l.parentContext) && (actionButtonRegex.test(l.text) || subKeywordsRegex.test(l.text) || l.href.includes('top4top.io') || l.href.includes('mediafire.com'))) {
        directSubLink = l.href;
        break;
      }
    }
  }

  // C. Find specific cloud & direct download providers (HEVC, H264, Softsub)
  let top4top = null;
  let mediafire = null;
  let mega = null;
  let drive = null;
  let proton = null;
  let pixeldrain = null;
  let torrent = null;
  let hevcLink = null;
  let h264Link = null;

  for (const l of allLinks) {
    const hrefLower = l.href.toLowerCase();
    const textLower = l.text.toLowerCase();
    const ctxLower = l.parentContext.toLowerCase();

    const isSoft = textLower.includes('soft') || ctxLower.includes('soft') || !ctxLower.includes('hard');

    if (hrefLower.includes('top4top.io') && !top4top) top4top = l.href;
    if (hrefLower.includes('mediafire.com') && isSoft && !mediafire) mediafire = l.href;
    if (hrefLower.includes('mega.nz') && isSoft && !mega) mega = l.href;
    if ((hrefLower.includes('drive.google.com') || hrefLower.includes('docs.google.com')) && isSoft && !drive) drive = l.href;
    if (hrefLower.includes('proton.me') && isSoft && !proton) proton = l.href;
    if (hrefLower.includes('pixeldrain.com') && isSoft && !pixeldrain) pixeldrain = l.href;
    if ((hrefLower.includes('.torrent') || hrefLower.includes('nyaa.si')) && !torrent) torrent = l.href;

    if ((textLower.includes('hevc') || textLower.includes('x265')) && isSoft && !hevcLink) hevcLink = l.href;
    if ((textLower.includes('h264') || textLower.includes('h.264') || textLower.includes('x264')) && isSoft && !h264Link) h264Link = l.href;
  }

  // Resolve shorteners before choosing a download method. This covers the
  // buttons used by Mugi, Mejaow and Blogger sites (TinyURL/URLs/go links).
  if (directSubLink && /(?:urls\.|redirect|go\.|link\.|tinyurl\.com|bit\.ly|t\.co|ouo\.|shrink)/i.test(directSubLink)) {
    directSubLink = await followRedirectUrl(directSubLink);
  }

  // Rocks-Team style DDL links lead to a directory named "ملفات الترجمة"
  // rather than a file. Pick the actual subtitle/archive from that listing.
  if (directSubLink && /(?:ddl\.[^/]+\/0:|(?:subtitle|subtitles|ملفات(?:%20|\s)*الترجمة))/i.test(directSubLink) &&
      !/\.(?:ass|srt|zip|rar|7z)(?:$|[?#])/i.test(directSubLink)) {
    const resolvedFile = await resolveSubtitleFromDirectory(directSubLink);
    if (resolvedFile) directSubLink = resolvedFile;
  }

  // A subtitle button can itself be a short link. Once expanded, expose the
  // underlying provider as well so the caller can use its folder/file resolver
  // after a plain HTTP download is unsuitable (notably Drive and MediaFire).
  const resolvedLower = (directSubLink || '').toLowerCase();
  if (resolvedLower.includes('top4top.io') && !top4top) top4top = directSubLink;
  if (resolvedLower.includes('mediafire.com') && !mediafire) mediafire = directSubLink;
  if ((resolvedLower.includes('drive.google.com') || resolvedLower.includes('docs.google.com')) && !drive) drive = directSubLink;
  if (resolvedLower.includes('mega.nz') && !mega) mega = directSubLink;
  if (resolvedLower.includes('proton.me') && !proton) proton = directSubLink;
  if (resolvedLower.includes('pixeldrain.com') && !pixeldrain) pixeldrain = directSubLink;
  if ((resolvedLower.includes('.torrent') || resolvedLower.includes('nyaa.si')) && !torrent) torrent = directSubLink;

  const bestDownloadUrl = directSubLink || (top4top || mediafire || hevcLink || h264Link || mega || drive || proton || pixeldrain || torrent || null);

  return {
    title,
    pageUrl,
    bestDownloadUrl,
    videoLinks: {
      directSub: directSubLink,
      top4top,
      mediafire,
      mega,
      drive,
      proton,
      pixeldrain,
      torrent,
      hevc: hevcLink,
      h264: h264Link
    }
  };
}
