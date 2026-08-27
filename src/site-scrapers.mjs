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
  if (!siteConfig.user || !siteConfig.pass) return null;
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

  const title = $('h1.entry-title').text().trim() || $('title').text().replace(/[-–|].*$/, '').trim() || 'Anime Release';
  let posterUrl = $('img.wp-post-image').attr('src') || $('img.entry-image').attr('src') || $('article img').first().attr('src') || null;
  if (posterUrl && posterUrl.startsWith('//')) posterUrl = 'https:' + posterUrl;

  const allLinks = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (href && /^https?:\/\//i.test(href)) {
      allLinks.push({ href, text });
    }
  });

  const directSub = allLinks.find(l => 
    /\.(ass|srt|zip)$/i.test(l.href) || 
    /ترجمة|ملف الترجمة|softsub|sub/i.test(l.text)
  );

  const videoLinks = {
    directSub: directSub ? directSub.href : null,
    mega: allLinks.find(l => l.href.includes('mega.nz'))?.href || null,
    drive: allLinks.find(l => l.href.includes('drive.google.com'))?.href || null,
    mediafire: allLinks.find(l => l.href.includes('mediafire.com'))?.href || null,
    torrent: allLinks.find(l => l.href.includes('.torrent') || l.href.includes('nyaa.si') || l.href.includes('/rr-torrent/'))?.href || null
  };

  const bestDownloadUrl = videoLinks.directSub || videoLinks.mega || videoLinks.drive || videoLinks.mediafire || videoLinks.torrent;

  return {
    title,
    posterUrl,
    pageUrl,
    bestDownloadUrl,
    videoLinks
  };
}
