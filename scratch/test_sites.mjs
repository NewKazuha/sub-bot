import * as cheerio from 'cheerio';

async function testSite(name, url, cookies = '') {
  console.log(`\n========================================`);
  console.log(`Testing: ${name} (${url})`);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Cookie': cookies
      }
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    console.log(`Status: ${res.status}`);
    console.log(`Title: ${$('title').text().trim()}`);
    
    // Find all links
    const foundLinks = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      if (href && (href.includes('mega') || href.includes('drive') || href.includes('mediafire') || href.includes('torrent') || href.includes('nyaa') || href.includes('.ass') || href.includes('.zip') || href.includes('download') || href.includes('stream') || href.includes('file'))) {
        foundLinks.push({ text, href });
      }
    });
    console.log(`Download/Media Links Found (${foundLinks.length}):`);
    foundLinks.slice(0, 15).forEach(l => console.log(`  - [${l.text}] -> ${l.href}`));

    // If no direct links, print any buttons, iframes, or scripts
    if (foundLinks.length === 0) {
      console.log('No direct download links found. Checking iframes and buttons:');
      $('iframe[src]').each((_, el) => console.log(`  - IFRAME: ${$(el).attr('src')}`));
      $('button, .btn, .download, [data-url]').each((_, el) => {
        console.log(`  - BUTTON/DIV: text="${$(el).text().trim()}" attrs=${JSON.stringify($(el).attr())}`);
      });
      // Check article text
      console.log('Article text snippet:', $('article, main, .content').text().replace(/\s+/g, ' ').slice(0, 300));
    }
  } catch (e) {
    console.error(`Error on ${name}:`, e.message);
  }
}

async function main() {
  await testSite('LazySano Episode', 'https://lazysano.com/episode/qdbcqbtuhwa/');
  await testSite('Anime-San Post', 'https://www.anime-san.com/morita-san-wa-mukuchi-2-01-13-special-dvd/');
  await testSite('Celestial Dragons Post', 'https://www.celestial-dragons.com/katainaka-no-ossan-kensei-ni-naru-s2-06-07/');
}

main();
