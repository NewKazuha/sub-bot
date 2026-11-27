import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

import {
  CLOUD_CAP_LIMITS,
  __resetCloudCapCooldowns,
  __resetCloudCapStats,
  isCloudCapCooldownActive,
  assertCloudBatchCaps,
  extractPcloudPublinkCode,
  isPcloudPublinkUrl,
  cloudKindOfUrl,
  isProviderHostUrl,
  chooseVideoCandidate,
  listPcloudFolderStrict,
  downloadPcloudEntryToDisk,
  findBestFileInPcloud,
  downloadPcloudFolderRelease,
  downloadMegaFolderRelease,
  findBestFileInMegaFolder,
  findBestFileInDrive,
  downloadDriveFolderRelease,
  tryBundleMatchingFonts,
} from '../src/cloud-folders.mjs';
import {
  buildPostCloudSources,
  downloadCloudSubtitleSelection,
  handleCloudCapRefusal,
  resolveEraiArabicFallbackFromNyaa,
  isEraiNonArabicCooldownActive,
  markEraiNonArabicCooldown,
  __resetEraiNonArabicCooldowns,
  getSafeTelegramFileName,
} from '../src/telegram-client.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFakeAss(fontName = 'MainFont', line = 'مرحبا') {
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${fontName},48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    `Dialogue: 0,0:00:01.00,0:00:05.00,Default,,0,0,0,,${line}`,
  ].join('\n');
}

function makeResponse(body, status = 200, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  return new Response(buf, { status, headers });
}

// ---------------------------------------------------------------------------
// Bug 2 — pCloud public link support (Date A Live II subs)
// ---------------------------------------------------------------------------

test('pCloud URL parser and SSRF hostname checks reject non-pCloud traps', () => {
  const validU = 'https://u.pcloud.link/publink/show?code=kZYVfWJZYjA6r4fLYHpXNV1L5VhaEH3xywLy';
  const validE = 'https://e.pcloud.link/publink/show?code=XZabc12345';
  const validMy = 'https://my.pcloud.com/publink/show?code=XZ999';

  assert.equal(extractPcloudPublinkCode(validU), 'kZYVfWJZYjA6r4fLYHpXNV1L5VhaEH3xywLy');
  assert.equal(isPcloudPublinkUrl(validU), true);
  assert.equal(isPcloudPublinkUrl(validE), true);
  assert.equal(isPcloudPublinkUrl(validMy), true);
  assert.equal(cloudKindOfUrl(validU), 'pcloud');
  assert.equal(isProviderHostUrl(validU, 'pcloud'), true);

  for (const trap of [
    'http://169.254.169.254/publink/show?code=abc123&x=u.pcloud.link',
    'https://evil.tld/?next=https://u.pcloud.link/publink/show&code=abc123',
    'https://u.pcloud.link/publink/show?code=../secret',
    'ftp://u.pcloud.link/publink/show?code=abc123',
    'https://pcloud.link.attacker.example/publink/show?code=abc123',
  ]) {
    assert.equal(extractPcloudPublinkCode(trap), null, trap);
    assert.equal(isPcloudPublinkUrl(trap), false, trap);
    assert.equal(cloudKindOfUrl(trap), null, trap);
    if (!trap.startsWith('https://u.pcloud.link/')) {
      assert.equal(isProviderHostUrl(trap, 'pcloud'), false, trap);
    }
  }
});

test('listPcloudFolderStrict handles US->EU fallback, nested folders, and refuses unsafe hosts/paths', async () => {
  const calls = [];
  const files = await listPcloudFolderStrict(
    'https://u.pcloud.link/publink/show?code=XZeuCode123',
    {
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.startsWith('https://api.pcloud.com/')) {
          return makeResponse(JSON.stringify({ result: 7002, error: 'Wrong datacenter' }));
        }
        return makeResponse(JSON.stringify({
          result: 0,
          metadata: {
            name: 'Date A Live II (10)',
            isfolder: true,
            contents: [
              { name: '[Anime-Genesis] Date A Live II - 01.ass', isfolder: false, size: 120000, fileid: 101 },
              {
                name: 'Fonts',
                isfolder: true,
                contents: [{ name: 'AraFont.ttf', isfolder: false, size: 50000, fileid: 201 }],
              },
            ],
          },
        }));
      },
    }
  );

  assert.equal(calls.length, 2);
  assert.ok(calls[0].startsWith('https://api.pcloud.com/showpublink?code=XZeuCode123'));
  assert.ok(calls[1].startsWith('https://eapi.pcloud.com/showpublink?code=XZeuCode123'));
  assert.equal(files.length, 2);
  assert.equal(files[0].apiHost, 'eapi.pcloud.com');
  assert.equal(files[1].name, 'AraFont.ttf');

  await assert.rejects(
    () => listPcloudFolderStrict('http://127.0.0.1/publink/show?code=abc'),
    /unsafe host/i
  );

  const dir = makeTempDir('pcloud_ssrf_');
  try {
    const dest = path.join(dir, 'sub.ass');
    const okBadHost = await downloadPcloudEntryToDisk(
      { name: '01.ass', code: 'XZ1', fileid: 1, apiHost: 'api.pcloud.com', isSingleFile: false },
      dest,
      {
        fetchImpl: async () => makeResponse(JSON.stringify({
          result: 0,
          path: '/d1/01.ass',
          hosts: ['127.0.0.1', '169.254.169.254'],
        })),
      }
    );
    assert.equal(okBadHost, false);
    assert.equal(fs.existsSync(dest), false);

    const okProtoRel = await downloadPcloudEntryToDisk(
      { name: '01.ass', code: 'XZ1', fileid: 1, apiHost: 'api.pcloud.com', isSingleFile: false },
      dest,
      {
        fetchImpl: async () => makeResponse(JSON.stringify({
          result: 0,
          path: '//attacker.example/payload',
          hosts: ['p-lux3.pcloud.com'],
        })),
      }
    );
    assert.equal(okProtoRel, false);
    assert.equal(fs.existsSync(dest), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadPcloudFolderRelease packs 10 Date A Live II .ass files into one batch zip', async () => {
  const dir = makeTempDir('pcloud_dal_');
  try {
    const folderUrl = 'https://u.pcloud.link/publink/show?code=kZYVfWJZYjA6r4fLYHpXNV1L5VhaEH3xywLy';
    const contents = Array.from({ length: 10 }, (_, idx) => {
      const ep = String(idx + 1).padStart(2, '0');
      return {
        name: `[Anime-Genesis] Date A Live II - ${ep}.ass`,
        isfolder: false,
        size: 160_000,
        fileid: 900 + idx,
      };
    });

    const fetched = [];
    const rel = await downloadPcloudFolderRelease(folderUrl, dir, null, {
      batch: false, // Even non-collection title ("Date A Live II subs") must keep all 10 episodes when targetEpisode is ''
      fetchImpl: async (url) => {
        fetched.push(url);
        if (url.includes('/showpublink?')) {
          return makeResponse(JSON.stringify({
            result: 0,
            metadata: { name: 'Date A Live II (10)', isfolder: true, contents },
          }));
        }
        if (url.includes('/getpublinkdownload?')) {
          const u = new URL(url);
          const fid = Number(u.searchParams.get('fileid'));
          return makeResponse(JSON.stringify({
            result: 0,
            path: `/dl/${fid}.ass`,
            hosts: ['p-lux3.pcloud.com'],
          }));
        }
        if (url.startsWith('https://p-lux3.pcloud.com/dl/')) {
          return makeResponse(makeFakeAss('AraFont', `حلقة ${url}`));
        }
        return makeResponse('not found', 404);
      },
    });

    assert.ok(rel && rel.isArchive && fs.existsSync(rel.filePath));
    assert.equal(rel.subNames.length, 10);
    const zipEntries = new AdmZip(rel.filePath).getEntries().map(e => e.entryName);
    assert.equal(zipEntries.length, 10);
    assert.ok(fetched.some(u => u.startsWith('https://api.pcloud.com/showpublink')));
    assert.ok(fetched.some(u => u.startsWith('https://p-lux3.pcloud.com/dl/')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildPostCloudSources prioritizes pCloud subtitle folder and downloadCloudSubtitleSelection supports pCloud entries', async () => {
  const dir = makeTempDir('pcloud_sources_');
  try {
    const pcloudUrl = 'https://u.pcloud.link/publink/show?code=kZYVfW';
    const megaUrl = 'https://mega.nz/folder/vidOnly#key123';
    const listedKinds = [];
    const sources = await buildPostCloudSources(
      { pcloud: pcloudUrl, mega: megaUrl },
      {
        listFolder: async (kind) => {
          listedKinds.push(kind);
          if (kind === 'pcloud') {
            return [
              { name: 'Date A Live II - 01.ass', size: 1000, fileid: 1, code: 'kZYVfW', apiHost: 'api.pcloud.com' },
              { name: 'Date A Live II - 02.ass', size: 1000, fileid: 2, code: 'kZYVfW', apiHost: 'api.pcloud.com' },
            ];
          }
          return [{ name: 'Date A Live II - 01.mkv', size: 100_000_000, node: {} }];
        },
      }
    );

    assert.deepEqual([...listedKinds].sort(), ['mega', 'pcloud']);
    assert.equal(sources[0].kind, 'pcloud');
    assert.equal(sources[0].offersSubtitles, true);
    assert.equal(sources[1].kind, 'mega');
    assert.equal(sources[1].offersSubtitles, false);

    const best = await findBestFileInPcloud(pcloudUrl, '', [], sources[0].listing, true);
    assert.equal(best.type, 'subtitles');
    assert.equal(best.files.length, 2);

    const pcloudCalls = [];
    const out = await downloadCloudSubtitleSelection(
      best,
      dir,
      'http://animegenesis.weebly.com/anime-subs/date-a-live-ii-subs',
      {
        downloadPcloud: async (entry, dest) => {
          pcloudCalls.push(entry.fileid);
          fs.writeFileSync(dest, makeFakeAss('AraFont', `ep:${entry.name}`));
          return true;
        },
      }
    );
    assert.deepEqual(pcloudCalls, [1, 2]);
    assert.ok(out && out.endsWith('.zip') && fs.existsSync(out));
    assert.equal(new AdmZip(out).getEntries().length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Bug 3 — Aurora Team Aikatsu (fontOverflow, zip fonts, .mkv preference)
// ---------------------------------------------------------------------------

test('assertCloudBatchCaps marks fontOverflow only when subtitles fit <= MAX_FILES and fonts overflow', () => {
  __resetCloudCapStats();
  const subs10 = Array.from({ length: 10 }, (_, i) => ({ name: `ep_${i + 1}.ass`, size: 1024 }));
  const fonts54 = Array.from({ length: 54 }, (_, i) => ({ name: `font_${i + 1}.ttf`, size: 1024 }));

  let fontOverflowErr = null;
  assert.throws(
    () => assertCloudBatchCaps(subs10, fonts54),
    (e) => { fontOverflowErr = e; return e.code === 'TOO_MANY_FILES'; }
  );
  assert.equal(fontOverflowErr.fontOverflow, true);

  const subs21 = Array.from({ length: 21 }, (_, i) => ({ name: `ep_${i + 1}.ass`, size: 1024 }));
  let subOverflowErr = null;
  assert.throws(
    () => assertCloudBatchCaps(subs21, []),
    (e) => { subOverflowErr = e; return e.code === 'TOO_MANY_FILES'; }
  );
  assert.notEqual(subOverflowErr.fontOverflow, true);

  // Drive batch keeps throwing TOO_MANY_FILES with fontOverflow=true when 10 subs + 54 fonts exceed 20
  let driveErr = null;
  return assert.rejects(
    () => downloadDriveFolderRelease('https://drive.google.com/drive/folders/1AoXMEy', os.tmpdir(), null, null, '[01~10]', {
      listedFiles: [...subs10.map((s, i) => ({ ...s, id: `s${i}` })), ...fonts54.map((f, i) => ({ ...f, id: `f${i}` }))],
    }),
    (e) => { driveErr = e; return e.code === 'TOO_MANY_FILES' && e.fontOverflow === true; }
  ).then(() => {
    assert.ok(driveErr);
  });
});

test('tryBundleMatchingFonts extracts font names from .zip .ass entries and packs ONLY matched fonts', async () => {
  const dir = makeTempDir('zip_fonts_');
  try {
    const rawZipPath = path.join(dir, 'aikatsu_01_10.zip');
    const zip = new AdmZip();
    for (let i = 1; i <= 10; i++) {
      const ep = String(i).padStart(2, '0');
      const fontForEp = i <= 6 ? 'UsedFontA' : (i <= 8 ? 'UsedFontB' : 'UsedFontC');
      let content = makeFakeAss(fontForEp, `الحلقة ${ep}`);
      if (i === 10) {
        // UTF-16LE with BOM on episode 10 introducing UsedFontD
        const u16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(makeFakeAss('UsedFontD', 'أيكاتسو'), 'utf16le')]);
        zip.addFile(`Aikatsu! - 0${ep}.ass`, u16);
      } else {
        zip.addFile(`Aikatsu! - 0${ep}.ass`, Buffer.from(content, 'utf8'));
      }
    }
    zip.writeZip(rawZipPath);

    const fontCatalog = [
      { id: 'f1', name: 'UsedFontA-Regular.ttf' },
      { id: 'f2', name: 'UsedFontB.otf' },
      { id: 'f3', name: 'UsedFontC_Bold.ttf' },
      { id: 'f4', name: 'UsedFontD.ttf' },
      ...Array.from({ length: 50 }, (_, i) => ({ id: `unused_${i}`, name: `UnusedFont_${i}.ttf` })),
    ];

    const downloadedFontNames = [];
    const bundledPath = await tryBundleMatchingFonts(
      rawZipPath,
      fontCatalog,
      dir,
      async (font, dest) => {
        downloadedFontNames.push(font.name);
        fs.writeFileSync(dest, Buffer.from(`font:${font.name}`));
      }
    );

    assert.notEqual(bundledPath, rawZipPath);
    assert.equal(fs.existsSync(rawZipPath), false, 'old unbundled zip should be cleaned up');
    assert.deepEqual(
      downloadedFontNames.sort(),
      ['UsedFontA-Regular.ttf', 'UsedFontB.otf', 'UsedFontC_Bold.ttf', 'UsedFontD.ttf']
    );

    const entries = new AdmZip(bundledPath).getEntries().map(e => e.entryName);
    const assCount = entries.filter(n => n.endsWith('.ass')).length;
    const fontEntries = entries.filter(n => n.startsWith('Fonts/')).sort();
    assert.equal(assCount, 10);
    assert.deepEqual(fontEntries, [
      'Fonts/UsedFontA-Regular.ttf',
      'Fonts/UsedFontB.otf',
      'Fonts/UsedFontC_Bold.ttf',
      'Fonts/UsedFontD.ttf',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chooseVideoCandidate prefers .mkv over .mp4/.m4v even when .mp4 appears last', async () => {
  const dir = makeTempDir('mkv_pref_');
  try {
    const listing = [
      { name: '[Aurora] Aikatsu - 005.mkv', size: 400_000_000, node: { id: 'mkv5' }, id: 'drive_mkv5' },
      { name: '[Aurora] Aikatsu - 005.mp4', size: 365_000_000, node: { id: 'mp4_5' }, id: 'drive_mp4_5' },
    ];

    const picked = chooseVideoCandidate(listing, null);
    assert.equal(picked.name, '[Aurora] Aikatsu - 005.mkv');

    const pickedEp5 = chooseVideoCandidate(listing, '5');
    assert.equal(pickedEp5.name, '[Aurora] Aikatsu - 005.mkv');

    const megaBest = await findBestFileInMegaFolder('https://mega.nz/folder/gul0AZpR#key', null, [], listing);
    assert.equal(megaBest.name, '[Aurora] Aikatsu - 005.mkv');

    const driveBest = await findBestFileInDrive('https://drive.google.com/drive/folders/123', null, [], listing);
    assert.equal(driveBest.name, '[Aurora] Aikatsu - 005.mkv');

    const downloaded = [];
    const megaRel = await downloadMegaFolderRelease('https://mega.nz/folder/gul0AZpR#key', dir, null, {
      listedFiles: listing,
      downloadNode: async (node, dest) => {
        downloaded.push(node.id);
        fs.writeFileSync(dest, Buffer.from('mkv-bytes'));
      },
    });
    assert.deepEqual(downloaded, ['mkv5']);
    assert.equal(megaRel.type, 'mkv');
    assert.deepEqual(megaRel.subNames, ['[Aurora] Aikatsu - 005.mkv']);

    // Falls back to .mp4 only when no .mkv exists for that episode
    const mp4Only = [{ name: '[Aurora] Aikatsu - 006.mp4', size: 300_000_000 }];
    assert.equal(chooseVideoCandidate(mp4Only, '6').name, '[Aurora] Aikatsu - 006.mp4');

    // SERIES_FOLDER_BATCH cap still produces 0 cooldown while other caps apply 6h cooldown
    __resetCloudCapCooldowns();
    handleCloudCapRefusal(
      { name: 'CloudCapError', code: 'SERIES_FOLDER_BATCH', message: '1 sub + 30 fonts > 20' },
      { kind: 'drive', url: 'https://drive.google.com/drive/folders/abc', label: 'Google Drive' }
    );
    assert.equal(isCloudCapCooldownActive('drive', 'https://drive.google.com/drive/folders/abc'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Bug 1 — Erai-Raws delayed Arabic fallback via Nyaa RSS
// ---------------------------------------------------------------------------

test('resolveEraiArabicFallbackFromNyaa detects HEVC Arabic re-upload and enforces strict matching + SSRF guards', async () => {
  const avcViewUrl = 'https://nyaa.si/view/2190919';
  const hevcViewUrl = 'https://nyaa.si/view/2191067';
  const ep8ViewUrl = 'https://nyaa.si/view/2180000';
  const batchViewUrl = 'https://nyaa.si/view/2199999';

  const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:nyaa="https://nyaa.si/xmlns/nyaa">
  <channel>
    <item>
      <title>[Erai-raws] Tougen Anki: Nikko Kegon no Taki-hen - 08 [1080p][HEVC][Multiple Subtitle]</title>
      <link>https://nyaa.si/download/2180000.torrent</link>
      <guid isPermaLink="true">${ep8ViewUrl}</guid>
    </item>
    <item>
      <title>[Erai-raws] Tougen Anki: Nikko Kegon no Taki-hen - 01 ~ 09 [1080p][HEVC][Multiple Subtitle]</title>
      <link>https://nyaa.si/download/2199999.torrent</link>
      <guid isPermaLink="true">${batchViewUrl}</guid>
    </item>
    <item>
      <title>[OtherGroup] Tougen Anki: Nikko Kegon no Taki-hen - 09 [1080p][HEVC]</title>
      <link>https://nyaa.si/download/2195555.torrent</link>
      <guid isPermaLink="true">https://nyaa.si/view/2195555</guid>
    </item>
    <item>
      <title>[Erai-raws] Tougen Anki: Nikko Kegon no Taki-hen - 09 [1080p][CR][Multiple Subtitle]</title>
      <link>https://evil.example/download/bad.torrent</link>
      <guid isPermaLink="true">${hevcViewUrl}</guid>
    </item>
    <item>
      <title>[Erai-raws] Tougen Anki: Nikko Kegon no Taki-hen - 09 [1080p][CR][AVC][Multiple Subtitle]</title>
      <link>https://nyaa.si/download/2190919.torrent</link>
      <guid isPermaLink="true">${avcViewUrl}</guid>
    </item>
    <item>
      <title>[Erai-raws] Tougen Anki: Nikko Kegon no Taki-hen - 09 [1080p][CR][HEVC][Multiple Subtitle]</title>
      <link>https://nyaa.si/download/2191067.torrent</link>
      <guid isPermaLink="true">${hevcViewUrl}</guid>
    </item>
  </channel>
</rss>`;

  const fetchedUrls = [];
  const res = await resolveEraiArabicFallbackFromNyaa(
    {
      title: 'Tougen Anki: Nikko Kegon no Taki-hen - 09',
      hasArabic: false,
      torrentUrl: 'https://nyaa.si/download/2190919.torrent',
      nyaaUrl: avcViewUrl,
    },
    {
      fetchFn: async (url) => {
        fetchedUrls.push(url);
        if (url.includes('?page=rss')) {
          return makeResponse(rssXml, 200, { 'content-type': 'application/xml' });
        }
        if (url === hevcViewUrl) {
          return makeResponse('<div id="torrent-description">Subtitles: English, CR_Arabic, Spanish</div>');
        }
        if (url === avcViewUrl) {
          return makeResponse('<div id="torrent-description">Subtitles: English, Spanish</div>');
        }
        return makeResponse('not found', 404);
      },
    }
  );

  assert.ok(res);
  assert.equal(res.torrentUrl, 'https://nyaa.si/download/2191067.torrent');
  assert.equal(res.nyaaUrl, hevcViewUrl);
  // Alternate release checked BEFORE re-checking original view URL; ep08, batch, OtherGroup, and evil.example skipped
  assert.equal(fetchedUrls[1], hevcViewUrl);
  assert.equal(fetchedUrls.includes(ep8ViewUrl), false);
  assert.equal(fetchedUrls.includes(batchViewUrl), false);
});

test('Erai non-Arabic cooldown bounds entries without .clear()', () => {
  __resetEraiNonArabicCooldowns();
  const baseNow = 1_700_000_000_000;
  markEraiNonArabicCooldown('tg_-1002084152036_11541', baseNow);
  assert.equal(isEraiNonArabicCooldownActive('tg_-1002084152036_11541', baseNow + 60_000), true);
  assert.equal(isEraiNonArabicCooldownActive('tg_-1002084152036_11541', baseNow + 16 * 60_000), false);
  __resetEraiNonArabicCooldowns();
  assert.equal(isEraiNonArabicCooldownActive('tg_-1002084152036_11541', baseNow + 60_000), false);
});

test('getSafeTelegramFileName preserves Tougen Anki arc title and never leaves trailing hyphen on truncation', () => {
  const full = getSafeTelegramFileName('[Crunchyroll] Tougen Anki: Nikko Kegon no Taki-hen - 09', '.ass');
  assert.equal(full, '[Crunchyroll] Tougen Anki Nikko Kegon no Taki-hen - 09.ass');

  const ultraLong = getSafeTelegramFileName('[Crunchyroll] Very Long Anime Title With An Extremely Extended Arc-hen - 09', '.ass');
  assert.ok(ultraLong.length <= 72, ultraLong);
  assert.equal(ultraLong.includes('- -'), false, `double hyphen must not appear: ${ultraLong}`);
  assert.ok(ultraLong.endsWith(' - 09.ass'), ultraLong);

  const exactHyphenCut = getSafeTelegramFileName(`[Crunchyroll] ${'A'.repeat(48)}-hen - 09`, '.ass');
  assert.equal(exactHyphenCut, `[Crunchyroll] ${'A'.repeat(48)} - 09.ass`);
});
