import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve('temp_extracted');

export async function fetchLatestSubdlArabic() {
  const releases = [];
  try {
    const res = await fetch('https://subdl.com/subtitle/browse?language=ar&type=anime', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!res.ok) return releases;
    const html = await res.text();
    const $ = cheerio.load(html);

    $('.sub-row, .subtitle-row, tr').each((_, el) => {
      const title = $(el).find('a.sub-title, .title, a').first().text().trim();
      const href = $(el).find('a[href*="/subtitle/"]').attr('href');
      if (title && href) {
        releases.push({
          title,
          url: href.startsWith('http') ? href : `https://subdl.com${href}`
        });
      }
    });
  } catch (e) {
    console.warn('SUBDL fetch warning:', e.message);
  }
  return releases.slice(0, 5);
}