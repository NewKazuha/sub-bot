import * as cheerio from 'cheerio';

async function testRSSContent(name, feedUrl) {
  console.log(`\n=== Testing RSS for: ${name} ===`);
  const r = await fetch(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) { console.log('Feed failed:', r.status); return; }
  const xml = await r.text();
  const $ = cheerio.load(xml, { xmlMode: true });
  
  const items = $('item').toArray().slice(0, 2);
  for (const item of items) {
    const title = $(item).find('title').text();
    const link = $(item).find('link').text();
    const content = $(item).find('content\\:encoded').text();
    const desc = $(item).find('description').text();
    
    console.log(`\n--- TITLE: ${title}`);
    console.log(`--- LINK: ${link}`);
    console.log(`--- content:encoded length: ${content.length}`);
    console.log(`--- description length: ${desc.length}`);
    
    // Parse content:encoded HTML for links
    if (content) {
      const inner = cheerio.load(content);
      const links = inner('a[href]').toArray();
      console.log(`--- Links found in content:encoded: ${links.length}`);
      for (const a of links) {
        const href = inner(a).attr('href');
        const text = inner(a).text().trim();
        console.log(`  LINK: [${text}] -> ${href}`);
      }
      // Check poster image
      const poster = inner('img').first().attr('src');
      if (poster) console.log(`  POSTER: ${poster}`);
    }
    
    // Also parse description
    if (desc) {
      const innerDesc = cheerio.load(desc);
      const dLinks = innerDesc('a[href]').toArray();
      console.log(`--- Links found in description: ${dLinks.length}`);
      for (const a of dLinks) {
        console.log(`  DESC LINK: [${innerDesc(a).text().trim()}] -> ${innerDesc(a).attr('href')}`);
      }
    }
  }
}

async function main() {
  await testRSSContent('Celestial Dragons', 'https://www.celestial-dragons.com/feed/');
  await testRSSContent('LazySano', 'https://lazysano.com/feed/');
  await testRSSContent('Anime-San', 'https://www.anime-san.com/feed/');
  await testRSSContent('Rhythm-Sub', 'https://rhythm-sub.com/feed/');
  await testRSSContent('Revive', 'https://revivesubs.com/feed/');
}

main();
