import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

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
      const getRes = await fetch(`${siteConfig.base}/login`, {
        headers: { 'User-Agent': UA }
      });
      jar.absorb(getRes);
      const html = await getRes.text();
      const $ = cheerio.load(html);
      const token = $('meta[name="csrf-token"]').attr('content') || $('input[name="_token"]').val();

      const params = new URLSearchParams();
      if (token) params.append('_token', token);
      params.append('email', siteConfig.user);
      params.append('password', siteConfig.pass);
      params.append('remember', 'on');

      const postRes = await fetch(`${siteConfig.base}/login`, {
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
    const wpInit = await fetch(`${siteConfig.base}/wp-login.php`, {
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

    const res = await fetch(`${siteConfig.base}/wp-login.php`, {
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
      const res = await fetch(curr, {
        method: 'HEAD',
        redirect: 'manual',
        headers: { 'User-Agent': UA }
      });
      const loc = res.headers.get('location');
      if (loc && (res.status >= 300 && res.status < 400)) {
        curr = new URL(loc, curr).toString();
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return curr;
}

export async function scrapePostPage(pageUrl, siteConfig = null) {
  let cookieHeader = '';
  if (siteConfig && siteConfig.user) {
    const jar = await ensureSiteSession(siteConfig);
    if (jar) cookieHeader = jar.header();
  }

  let html = '';
  try {
    const res = await fetch(pageUrl, {
      headers: { 'User-Agent': UA, 'Cookie': cookieHeader }
    });
    html = await res.text();
  } catch (e) {
    console.error(`Failed to fetch page: ${pageUrl}`, e.message);
    return null;
  }

  const $ = cheerio.load(html);

  const title = $('h1.entry-title').text().trim() || 
                $('h1.post-title').text().trim() || 
                $('title').text().replace(/[-–|].*$/, '').trim() || 
                'Anime Release';

  const allLinks = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')?.trim();
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (href && /^https?:\/\//i.test(href)) {
      const isIgnored = IGNORED_DOMAINS.some(d => href.includes(d));
      if (!isIgnored) {
        // Check parent/surrounding context text
        const parentContext = $(el).closest('div, section, article, p, table, tr, td, li').text().trim().replace(/\s+/g, ' ');
        allLinks.push({ href, text, parentContext });
      }
    }
  });

  // 1. Check for dedicated Subtitle / Font links
  // Patterns: "ملف الترجمة والخطوط", "الترجمة والخطوط", "ملف الترجمة", "الخطوط", "softsub", "fonts", "sub", "subs"
  const subKeywordsRegex = /(?:ملف(?:ات)?\s*الترجمة|الترجمة\s*و?الخطوط|ملف\s*الخطوط|soft\s*sub|subtitles?|fonts?)/i;
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

  // If directSubLink is an internal redirector (e.g. urls.mugi-subs.com/...), resolve it
  if (directSubLink && /urls\.|redirect|go\.|link\./i.test(directSubLink)) {
    directSubLink = await followRedirectUrl(directSubLink);
  }

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
