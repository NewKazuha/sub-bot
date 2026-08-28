import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

class SessionJar {
  constructor() {
    this.cookies = new Map();
  }
  absorb(res) {
    const setCookies = res.headers.getSetCookie?.() ?? [];
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

async function ensureSiteSession(siteConfig) {
  if (!siteConfig || !siteConfig.user || !siteConfig.pass) return null;
  let jar = siteSessions.get(siteConfig.id);
  if (!jar) {
    jar = new SessionJar();
    siteSessions.set(siteConfig.id, jar);
  }

  try {
    await fetch(`${siteConfig.base}/wp-login.php`, { headers: { 'User-Agent': UA } }).then(r => jar.absorb(r));

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
    console.warn(`Login to ${siteConfig.name} failed:`, e.message);
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
  'google.com/url'
];

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
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (href && /^https?:\/\//i.test(href)) {
      const isIgnored = IGNORED_DOMAINS.some(d => href.includes(d));
      if (!isIgnored) {
        allLinks.push({ href, text });
      }
    }
  });

  const directSub = allLinks.find(l => 
    /\.(ass|srt|zip|rar|7z)$/i.test(l.href) || 
    /^(ملف الترجمة|الترجمة|softsub|fonts|الخطوط)$/i.test(l.text)
  );

  const top4top = allLinks.find(l => l.href.includes('top4top.io'))?.href || null;
  const mediafire = allLinks.find(l => l.href.includes('mediafire.com'))?.href || null;
  const mega = allLinks.find(l => l.href.includes('mega.nz'))?.href || null;
  const drive = allLinks.find(l => l.href.includes('drive.google.com'))?.href || null;
  const torrent = allLinks.find(l => l.href.includes('.torrent') || l.href.includes('nyaa.si'))?.href || null;

  const bestDownloadUrl = directSub ? directSub.href : (top4top || mediafire || mega || drive || torrent || null);

  return {
    title,
    pageUrl,
    bestDownloadUrl,
    videoLinks: {
      directSub: directSub ? directSub.href : null,
      top4top,
      mediafire,
      mega,
      drive,
      torrent
    }
  };
}
