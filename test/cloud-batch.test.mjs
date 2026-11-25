import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolation: run in a temp working directory BEFORE importing any src module
// so no persistent cache (data/posted.json, data/title-map.json) ever touches
// the repo. node --test runs each test file in its own process.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-batch-test-'));
process.chdir(tempDir);

// Namespace imports (NOT named): a missing export must fail per-test at call
// time (TypeError) instead of failing the whole file at link time.
const cf = await import('../src/cloud-folders.mjs');
const tc = await import('../src/telegram-client.mjs');
const ss = await import('../src/site-scrapers.mjs');
const ps = await import('../src/path-safety.mjs');
const { CONFIG } = await import('../src/config.mjs');
const AdmZip = (await import('adm-zip')).default;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A fetch stub that never touches the network.
function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve()
    .then(fn)
    .finally(() => { globalThis.fetch = original; });
}

function htmlResponse(body = '<html><body>nothing</body></html>') {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
}

function binaryResponse(bytes, headers = {}) {
  return new Response(Buffer.alloc(bytes, 0x41), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', ...headers }
  });
}

// The refusal of a cloud cap: the error is a CloudCapError with a code.
async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.name, 'CloudCapError', `expected a CloudCapError, got ${e && e.name}: ${e && e.message}`);
    assert.equal(e.code, code);
    return true;
  });
}

function entriesOf(dir) {
  return fs.readdirSync(dir);
}

// ---------------------------------------------------------------------------
// M6 — the batch caps (T1-T4)
// ---------------------------------------------------------------------------

test('T1 — a 21-file cloud selection is refused BEFORE the first download', async () => {
  const dest = tmpDir('cloud-t1-');
  const files = Array.from({ length: 21 }, (_, i) => ({
    name: `Show - ${String(i + 1).padStart(2, '0')}.ass`,
    size: 1024,
    directUrl: `https://example.test/${i}.ass`
  }));

  let downloaderCalls = 0;
  await rejectsWithCode(
    tc.downloadCloudSubtitleSelection({ type: 'subtitles', files }, dest, 'https://ref.test', {
      downloadFile: async () => { downloaderCalls += 1; }
    }),
    'TOO_MANY_FILES'
  );

  assert.equal(downloaderCalls, 0, 'the downloader must never be called');
  assert.deepEqual(entriesOf(dest), [], 'no cloud_unpack_* directory may survive the refusal');
});

test('T2 — downloadFileToDisk refuses a body over the per-file cap and removes the partial file', async () => {
  const dest = tmpDir('cloud-t2-');
  const target = path.join(dest, 'file.ass');

  await withFetch(async () => binaryResponse(20), async () => {
    await rejectsWithCode(
      tc.downloadFileToDisk('https://example.test/file.ass', target, {}, { maxBytes: 10 }),
      'FILE_TOO_LARGE'
    );
  });

  assert.equal(fs.existsSync(target), false, 'the partial file must be removed');
});

test('T3 — a batch whose known sizes exceed the total cap is refused before the first download', async () => {
  const dest = tmpDir('cloud-t3-');
  // 10 files of 60 MiB: every file is under the per-file cap (64 MiB), the
  // batch total (600 MiB) is over the total cap (512 MiB).
  const files = Array.from({ length: 10 }, (_, i) => ({
    name: `Show - ${String(i + 1).padStart(2, '0')}.ass`,
    size: 60 * 1024 * 1024,
    directUrl: `https://example.test/${i}.ass`
  }));

  let downloaderCalls = 0;
  await rejectsWithCode(
    tc.downloadCloudSubtitleSelection({ type: 'subtitles', files }, dest, 'https://ref.test', {
      downloadFile: async () => { downloaderCalls += 1; }
    }),
    'BATCH_TOO_LARGE'
  );

  assert.equal(downloaderCalls, 0, 'the downloader must never be called');
  assert.deepEqual(entriesOf(dest), []);
});

test('T4 — every cap refusal is counted exactly once', async () => {
  const dest = tmpDir('cloud-t4-');
  cf.__resetCloudCapStats();

  const before = cf.__getCloudCapStats();
  assert.equal(before.refusals, 0);

  const files = Array.from({ length: 21 }, (_, i) => ({
    name: `Show - ${i + 1}.ass`,
    size: 1024,
    directUrl: `https://example.test/${i}.ass`
  }));
  await rejectsWithCode(
    tc.downloadCloudSubtitleSelection({ type: 'subtitles', files }, dest, 'https://ref.test', {
      downloadFile: async () => {}
    }),
    'TOO_MANY_FILES'
  );

  const after = cf.__getCloudCapStats();
  assert.equal(after.refusals, before.refusals + 1, 'exactly one refusal is counted');
  assert.equal(after.byCode.TOO_MANY_FILES, 1, 'the refusal is counted under its code');
});

// ---------------------------------------------------------------------------
// M1 / m11 / m12 — the cloud sources of a post (T5-T7)
// ---------------------------------------------------------------------------

test('T5 — every candidate is listed ONCE and carries its own listing', async () => {
  const listings = {
    mediafire: [{ name: 'mf.ass', size: 10 }],
    mega: [{ name: 'mega.ass', size: 10 }],
    drive: [{ name: 'drive.ass', size: 10 }]
  };
  const calls = [];

  const sources = await tc.buildPostCloudSources({
    mediafire: 'https://www.mediafire.com/folder/mfkey',
    mega: 'https://mega.nz/folder/megakey',
    drive: 'https://drive.google.com/drive/folders/drivefolderid1234567890'
  }, {
    listFolder: async (kind, url) => {
      calls.push([kind, url]);
      return listings[kind];
    }
  });

  assert.equal(calls.length, 3, 'the lister is called once per candidate');
  assert.equal(sources.length, 3);
  for (const s of sources) {
    assert.deepEqual(s.listing, listings[s.kind], `the listing of ${s.kind} is carried by the source`);
    assert.equal(s.listingError, undefined);
    assert.equal(s.offersSubtitles, true);
  }
});

test('T6 — a directSub source is never listed', async () => {
  let listCalls = 0;
  const sources = await tc.buildPostCloudSources({
    directSub: 'https://mega.nz/folder/directsubkey'
  }, {
    listFolder: async () => { listCalls += 1; return []; }
  });

  assert.equal(listCalls, 0, 'directSub is a subtitle source by construction — it is not listed');
  assert.equal(sources.length, 1);
  assert.equal(sources[0].kind, 'mega');
  assert.equal(sources[0].offersSubtitles, true);
  assert.equal(sources[0].listing, undefined);
});

test('T7 — a post without any cloud link yields no source and no listing', async () => {
  let listCalls = 0;
  const sources = await tc.buildPostCloudSources({}, {
    listFolder: async () => { listCalls += 1; return []; }
  });

  assert.deepEqual(sources, []);
  assert.equal(listCalls, 0);
});

// ---------------------------------------------------------------------------
// M1 / M6 / C3 — the production entry points with an injected listing (T8, T10)
// ---------------------------------------------------------------------------

test('T8 — downloadMegaFolderRelease uses the injected listing and the injected downloader', async () => {
  const dest = tmpDir('cloud-t8-');
  const listed = Array.from({ length: 3 }, (_, i) => ({
    name: `Show - ${String(i + 1).padStart(2, '0')}.ass`,
    size: 2048,
    node: { id: i }
  }));

  const downloaded = [];
  const release = await cf.downloadMegaFolderRelease('https://mega.nz/folder/megakey', dest, null, {
    listedFiles: listed,
    downloadNode: async (node, destPath) => {
      downloaded.push(node.id);
      fs.writeFileSync(destPath, 'fake');
      return destPath;
    }
  });

  assert.deepEqual(downloaded, [0, 1, 2], 'the injected downloader is used for every listed file');
  assert.ok(release && release.filePath, 'the release is produced from the injected listing');
  assert.ok(release.filePath.endsWith('.zip'));
  assert.equal(
    entriesOf(dest).filter(n => n.startsWith('mega_unpack')).length,
    0,
    'the unpack directory never survives the call'
  );
});

test('T10 — downloadDriveFolderRelease packs the injected listing into a zip of 5 .ass', async () => {
  const dest = tmpDir('cloud-t10-');
  const listed = Array.from({ length: 5 }, (_, i) => ({
    name: `Show - ${String(i + 1).padStart(2, '0')}.ass`,
    id: `driveid${i}`,
    isFolder: false
  }));

  const downloaded = [];
  const release = await cf.downloadDriveFolderRelease(
    'https://drive.google.com/drive/folders/drivefolderid1234567890',
    dest,
    null,
    null,
    '',
    {
      listedFiles: listed,
      downloadFile: async (fileId, destPath) => {
        downloaded.push(fileId);
        fs.writeFileSync(destPath, 'fake');
        return true;
      }
    }
  );

  assert.equal(downloaded.length, 5, 'the injected downloader is used for every listed file');
  assert.ok(release && release.filePath.endsWith('.zip'));
  const zip = new AdmZip(release.filePath);
  const assEntries = zip.getEntries().filter(e => !e.isDirectory && e.entryName.toLowerCase().endsWith('.ass'));
  assert.equal(assEntries.length, 5, 'the zip holds the 5 subtitle files');
  assert.deepEqual(
    assEntries.map(e => e.entryName).sort(),
    listed.map(f => f.name).sort()
  );
  assert.equal(
    entriesOf(dest).filter(n => n.startsWith('drive_unpack')).length,
    0,
    'the unpack directory never survives the call'
  );
});

// ---------------------------------------------------------------------------
// M3 (minimal) — an archive is not a subtitle file (T11, T12)
// ---------------------------------------------------------------------------

test('T11 — a folder of five archives is not a subtitle batch', async () => {
  const listing = Array.from({ length: 5 }, (_, i) => ({
    name: `Show - ${String(i + 1).padStart(2, '0')}.zip`,
    size: 4096,
    node: { id: i }
  }));

  assert.equal(cf.listingOffersSubtitles(listing), false, 'a zip listing offers no subtitles');

  const best = await cf.findBestFileInMegaFolder('https://mega.nz/folder/megakey', null, [], listing);
  assert.notEqual(best && best.type, 'subtitles', 'archives must not become a subtitle batch');
});

test('T12 — a folder of 5 subtitles and 1 archive is a batch of exactly 5 files', async () => {
  const listing = [
    ...Array.from({ length: 5 }, (_, i) => ({
      name: `Show - ${String(i + 1).padStart(2, '0')}.ass`,
      size: 4096,
      node: { id: i }
    })),
    { name: 'Show - Extras.zip', size: 4096, node: { id: 99 } }
  ];

  const best = await cf.findBestFileInMegaFolder('https://mega.nz/folder/megakey', null, [], listing);
  assert.equal(best.type, 'subtitles');
  assert.equal(best.files.length, 5, 'the archive is not part of the subtitle batch');
  assert.ok(best.files.every(f => f.name.toLowerCase().endsWith('.ass')));
});

// ---------------------------------------------------------------------------
// M6 / M7 — the refusal of a hostile folder (T17, T18)
// ---------------------------------------------------------------------------

test('T17 — a 21-subtitle Mega release is refused and nothing is downloaded', async () => {
  const dest = tmpDir('cloud-t17-');
  const listed = Array.from({ length: 21 }, (_, i) => ({
    name: `Show - ${String(i + 1).padStart(2, '0')}.ass`,
    size: 4096,
    node: { id: i }
  }));

  let downloaderCalls = 0;
  await rejectsWithCode(
    cf.downloadMegaFolderRelease('https://mega.nz/folder/megakey', dest, null, {
      listedFiles: listed,
      downloadNode: async () => { downloaderCalls += 1; }
    }),
    'TOO_MANY_FILES'
  );

  assert.equal(downloaderCalls, 0, 'the downloader must never be called');
  assert.deepEqual(entriesOf(dest), []);
});

test('T18 — a download that fails on the second file removes the unpack directory', async () => {
  // (a) the cloud selection of the telegram-client
  const dest = tmpDir('cloud-t18a-');
  const files = Array.from({ length: 3 }, (_, i) => ({
    name: `Show - ${String(i + 1).padStart(2, '0')}.ass`,
    size: 2048,
    directUrl: `https://example.test/${i}.ass`
  }));

  let calls = 0;
  await assert.rejects(() => tc.downloadCloudSubtitleSelection({ type: 'subtitles', files }, dest, 'https://ref.test', {
    downloadFile: async (_url, destPath) => {
      calls += 1;
      if (calls === 2) throw new Error('boom');
      fs.writeFileSync(destPath, 'fake');
    }
  }), /boom/);

  assert.ok(calls >= 2, 'the failure happened on the second file');
  assert.ok(calls <= cf.CLOUD_CAP_LIMITS.CONCURRENCY, 'the batch stops at the concurrency bound');
  assert.deepEqual(entriesOf(dest), [], 'no cloud_unpack_* directory survives the failure');

  // (b) the Mega release
  const dest2 = tmpDir('cloud-t18b-');
  const listed = Array.from({ length: 3 }, (_, i) => ({
    name: `Show - ${String(i + 1).padStart(2, '0')}.ass`,
    size: 2048,
    node: { id: i }
  }));

  let megaCalls = 0;
  await assert.rejects(() => cf.downloadMegaFolderRelease('https://mega.nz/folder/megakey', dest2, null, {
    listedFiles: listed,
    downloadNode: async (_node, destPath) => {
      megaCalls += 1;
      if (megaCalls === 2) throw new Error('boom');
      fs.writeFileSync(destPath, 'fake');
    }
  }), /boom/);

  assert.ok(megaCalls >= 2, 'the failure happened on the second file');
  assert.ok(megaCalls <= cf.CLOUD_CAP_LIMITS.CONCURRENCY, 'the batch stops at the concurrency bound');
  assert.deepEqual(entriesOf(dest2), [], 'no mega_unpack_* directory survives the failure');
});

// ---------------------------------------------------------------------------
// m1 / m2 / m3 / m4 / m5 — the small helpers (T19-T22)
// ---------------------------------------------------------------------------

test('T19 — uniqueFileName disambiguates and nextTempTag never repeats', async () => {
  const used = new Set();
  assert.equal(cf.uniqueFileName('a.ass', used), 'a.ass');
  assert.equal(cf.uniqueFileName('a.ass', used), 'a (2).ass');
  assert.equal(cf.uniqueFileName('a.ass', used), 'a (3).ass');

  const first = cf.nextTempTag('cloud_unpack');
  const second = cf.nextTempTag('cloud_unpack');
  assert.notEqual(first, second, 'two temp tags in the same millisecond differ');
});

test('T20 — packFolderToZip sanitizes the entry names', async () => {
  const dir = tmpDir('cloud-t20-');
  fs.writeFileSync(path.join(dir, 'normal.ass'), 'x');
  fs.writeFileSync(path.join(dir, 'second one.ass'), 'x');
  const zipPath = path.join(dir, 'out.zip');

  tc.packFolderToZip(dir, zipPath);

  const entries = new AdmZip(zipPath).getEntries().filter(e => !e.isDirectory).map(e => e.entryName);
  assert.deepEqual(entries.sort(), ['normal.ass', 'second one.ass']);
  for (const name of entries) {
    assert.equal(name, ps.safeRemoteBaseName(name), 'every entry name is the sanitized base name');
  }
  assert.equal(ps.safeRemoteBaseName('../../../evil.ass'), 'evil.ass');
});

test('T21 — logSafe strips the control characters of a scraped name', async () => {
  assert.equal(cf.logSafe('a\r\nb\tc'), 'a b c');
  assert.equal(cf.logSafe('forged\nline: OK'), 'forged line: OK');
});

test('T22 — cloudKindOfUrl decides by hostname, never by a substring', async () => {
  assert.equal(cf.cloudKindOfUrl('https://evil.test/?x=mega.nz'), null);
  assert.equal(cf.cloudKindOfUrl('https://evil.test/mega.nz/file'), null);
  assert.equal(cf.cloudKindOfUrl('https://mega.nz/folder/abc'), 'mega');
  assert.equal(cf.cloudKindOfUrl('https://www.mediafire.com/folder/abc'), 'mediafire');
  assert.equal(cf.cloudKindOfUrl('https://drive.google.com/drive/folders/abcdefghijklmnopqrstuv'), 'drive');
  assert.equal(cf.cloudKindOfUrl('https://drive.google.com/file/d/abcdefghijklmnopqrstuv'), null);
});

// ---------------------------------------------------------------------------
// M8 — the caption escaping (T27)
// ---------------------------------------------------------------------------

test('T27 — publishDocument escapes the caption exactly once per transport', async () => {
  const dir = tmpDir('cloud-t27-');
  const filePath = path.join(dir, 'doc.ass');
  fs.writeFileSync(filePath, 'x');
  const caption = 'A & <B>';
  const escapedOnce = 'A &amp; &lt;B&gt;';

  const realToken = CONFIG.TELEGRAM.BOT_TOKEN;
  CONFIG.TELEGRAM.BOT_TOKEN = 'test-token';

  // The Bot API answer is switchable: the Bot API transport is tested alone
  // (the answer is OK) and then the Bot API failure FALLS THROUGH to MTProto.
  let botAnswer = { ok: true, result: { message_id: 1 } };
  let botCaption = null;

  try {
    await withFetch(async (url, init) => {
      if (!String(url).includes('sendDocument')) throw new Error(`unexpected fetch: ${url}`);
      if (init && init.body && typeof init.body.get === 'function') {
        botCaption = init.body.get('caption');
      }
      return new Response(JSON.stringify(botAnswer), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }, async () => {
      // 1. the Bot API transport
      const res = await tc.publishDocument(null, filePath, caption, { retries: 1 });
      assert.equal(res.ok, true, 'the Bot API transport publishes the document');
      assert.equal(botCaption, escapedOnce, 'the Bot API caption is escaped exactly once');

      // 2. the MTProto transport — the Bot API answer is a failure, so
      //    publishDocument FALLS THROUGH to MTProto.
      botAnswer = { ok: false, description: 'boom' };
      botCaption = null;
      let mtCaption = null;
      const client = {
        connected: true,
        getEntity: async () => ({}),
        sendFile: async (_channel, options) => { mtCaption = options.caption; return { id: 7 }; }
      };
      const mtRes = await tc.publishDocument(client, filePath, caption, { retries: 1 });
      assert.equal(mtRes.ok, true, 'the MTProto transport publishes the document');
      assert.equal(mtCaption, escapedOnce, 'the fall-through caption is escaped exactly once (not twice)');
    });
  } finally {
    CONFIG.TELEGRAM.BOT_TOKEN = realToken;
  }
});

// ---------------------------------------------------------------------------
// m4 / C8 — the redaction of a url (T29)
// ---------------------------------------------------------------------------

test('T29 — redactUrl strips the Mega key and the token parameters', async () => {
  const mega = cf.redactUrl('https://mega.nz/file/ID#SECRETKEY');
  assert.ok(!mega.includes('SECRET'), `the Mega key must not survive: ${mega}`);
  assert.ok(mega.includes('mega.nz'));

  const mediafire = cf.redactUrl('https://www.mediafire.com/file/x?token=SECRETTOKEN&keep=1');
  assert.ok(!mediafire.includes('SECRETTOKEN'), `the token must not survive: ${mediafire}`);
  assert.ok(mediafire.includes('keep=1'), 'the harmless parameters survive');
});

// ---------------------------------------------------------------------------
// C9 — the streamed caps of the download sinks (T30, T31)
// ---------------------------------------------------------------------------

test('T30 — the Mega sink aborts a download over the cap and removes the file', async () => {
  const dir = tmpDir('cloud-t30-');
  const dest = path.join(dir, 'file.ass');
  const fakeNode = {
    download: () => ({
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(8, 0x41);
        yield Buffer.alloc(8, 0x41);
      }
    })
  };

  await rejectsWithCode(
    cf.downloadMegaNode(fakeNode, dest, dir, { maxBytes: 10 }),
    'FILE_TOO_LARGE'
  );

  assert.equal(fs.existsSync(dest), false, 'the partial file must be removed');
});

test('T31 — the Drive sink aborts a download over the cap and removes the file', async () => {
  const dir = tmpDir('cloud-t31-');
  const dest = path.join(dir, 'file.ass');

  await withFetch(async () => binaryResponse(2048), async () => {
    await rejectsWithCode(
      cf.downloadGoogleDriveFileToDisk('drivefileid1234567890abcd', dest, 'file.ass', { maxBytes: 100 }),
      'FILE_TOO_LARGE'
    );
  });

  assert.equal(fs.existsSync(dest), false, 'the partial file must be removed');
});

// ---------------------------------------------------------------------------
// C7b / C10 — the per-file cap of the single-file paths (T32)
// ---------------------------------------------------------------------------

test('T32 — the single-file path of the cloud selection refuses a file over the cap', async () => {
  const dest = tmpDir('cloud-t32-');
  const selection = {
    type: 'subtitles',
    files: [{ name: 'big.ass', size: 100 * 1024 * 1024, directUrl: 'https://example.test/big.ass' }]
  };

  let downloaderCalls = 0;
  await rejectsWithCode(
    tc.downloadCloudSubtitleSelection(selection, dest, 'https://ref.test', {
      downloadFile: async () => { downloaderCalls += 1; }
    }),
    'FILE_TOO_LARGE'
  );

  assert.equal(downloaderCalls, 0, 'the downloader must never be called');
  assert.deepEqual(entriesOf(dest), []);
});

// ---------------------------------------------------------------------------
// M1 / T33 — the production entry uses the cached listing
// ---------------------------------------------------------------------------

test('T33 — the Mediafire production entry uses the cached listing (the folder is listed once)', async () => {
  const listing = [
    { name: 'Show - 01.ass', size: 1024, quickkey: 'q1', directUrl: 'https://www.mediafire.com/file/q1/Show%20-%2001.ass/file' },
    { name: 'Show - 02.ass', size: 1024, quickkey: 'q2', directUrl: 'https://www.mediafire.com/file/q2/Show%20-%2002.ass/file' }
  ];

  let listCalls = 0;
  const sources = await tc.buildPostCloudSources({
    mediafire: 'https://www.mediafire.com/folder/mfkey'
  }, {
    listFolder: async () => { listCalls += 1; return listing; }
  });

  assert.equal(listCalls, 1, 'the folder is listed exactly once');
  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0].listing, listing);

  // The production entry works on the CACHED listing: the network stub would
  // return a page without any file, so a second listing would find nothing.
  await withFetch(async () => htmlResponse(), async () => {
    const best = await cf.findBestFileInMediafire(sources[0].url, null, [], sources[0].listing);
    assert.equal(best.type, 'subtitles');
    assert.equal(best.files.length, 2);
    assert.deepEqual(best.subNames.sort(), ['Show - 01.ass', 'Show - 02.ass']);
  });
});

// ---------------------------------------------------------------------------
// C7c — the post-download total check (the Drive listing carries no sizes)
// ---------------------------------------------------------------------------

test('T34 — a Drive batch whose real size exceeds the total cap is refused after the download', async () => {
  const dest = tmpDir('cloud-t34-');
  const listed = Array.from({ length: 5 }, (_, i) => ({
    name: `Show - ${String(i + 1).padStart(2, '0')}.ass`,
    id: `driveid${i}`,
    isFolder: false
  }));

  const saved = cf.CLOUD_CAP_LIMITS.BATCH_MAX_TOTAL_BYTES;
  cf.CLOUD_CAP_LIMITS.BATCH_MAX_TOTAL_BYTES = 1000; // 5 x 400 bytes = 2000
  try {
    await rejectsWithCode(
      cf.downloadDriveFolderRelease(
        'https://drive.google.com/drive/folders/drivefolderid1234567890',
        dest,
        null,
        null,
        '',
        {
          listedFiles: listed,
          downloadFile: async (_fileId, destPath) => {
            fs.writeFileSync(destPath, Buffer.alloc(400, 0x41));
            return true;
          }
        }
      ),
      'BATCH_TOO_LARGE'
    );
  } finally {
    cf.CLOUD_CAP_LIMITS.BATCH_MAX_TOTAL_BYTES = saved;
  }

  assert.equal(
    entriesOf(dest).filter(n => n.startsWith('drive_unpack')).length,
    0,
    'the unpack directory is removed when the batch is refused'
  );
});

// ---------------------------------------------------------------------------
// C7a / C7b — the fonts count towards the cap, the single paths carry the cap
// ---------------------------------------------------------------------------

test('T35 — the font files count towards the batch cap', async () => {
  const dest = tmpDir('cloud-t35-');
  const listed = [
    ...Array.from({ length: 20 }, (_, i) => ({
      name: `Show - ${String(i + 1).padStart(2, '0')}.ass`,
      id: `driveid${i}`,
      isFolder: false
    })),
    { name: 'Font.ttf', id: 'fontid', isFolder: false }
  ];

  let downloaderCalls = 0;
  await rejectsWithCode(
    cf.downloadDriveFolderRelease(
      'https://drive.google.com/drive/folders/drivefolderid1234567890',
      dest,
      null,
      null,
      '',
      {
        listedFiles: listed,
        downloadFile: async () => { downloaderCalls += 1; }
      }
    ),
    'TOO_MANY_FILES'
  );

  assert.equal(downloaderCalls, 0, 'the downloader must never be called');
  assert.deepEqual(entriesOf(dest), []);
});

test('T36 — the single-file paths of Mega and Mediafire refuse a listed file over the cap', async () => {
  // the Mega single subtitle
  const dest = tmpDir('cloud-t36-');
  let megaCalls = 0;
  await rejectsWithCode(
    cf.downloadMegaFolderRelease('https://mega.nz/folder/megakey', dest, null, {
      listedFiles: [{ name: 'Show - 01.ass', size: 100 * 1024 * 1024, node: { id: 1 } }],
      downloadNode: async () => { megaCalls += 1; }
    }),
    'FILE_TOO_LARGE'
  );
  assert.equal(megaCalls, 0);
  assert.deepEqual(entriesOf(dest), []);

  // the Mediafire single subtitle
  const mfListing = [{
    name: 'Show - 01.ass',
    size: 100 * 1024 * 1024,
    quickkey: 'q1',
    directUrl: 'https://www.mediafire.com/file/q1/Show%20-%2001.ass/file'
  }];
  await rejectsWithCode(
    cf.findBestFileInMediafire('https://www.mediafire.com/folder/mfkey', null, [], mfListing),
    'FILE_TOO_LARGE'
  );
});

test('T37 — the single Drive download carries the per-file cap', async () => {
  const dest = tmpDir('cloud-t37-');
  let options = null;
  const release = await cf.downloadDriveFolderRelease(
    'https://drive.google.com/drive/folders/drivefolderid1234567890',
    dest,
    null,
    null,
    '',
    {
      listedFiles: [{ name: 'Show - 01.ass', id: 'driveid1', isFolder: false }],
      downloadFile: async (_fileId, destPath, _fileName, opts) => {
        options = opts;
        fs.writeFileSync(destPath, 'fake');
        return true;
      }
    }
  );

  assert.ok(release && release.filePath, 'the single subtitle is downloaded');
  assert.ok(options, 'the download options are passed to the sink');
  assert.equal(options.maxBytes, cf.CLOUD_CAP_LIMITS.SUB_MAX_FILE_BYTES);
});

// ---------------------------------------------------------------------------
// M2 + C5 — the Drive subtitle-subfolder descent (T9)
// ---------------------------------------------------------------------------

// A Drive "embeddedfolderview" page: every entry is a .flip-entry with an
// "entry-<id>" id and a .flip-entry-title.
function driveEntryHtml(id, name, isFolder) {
  const href = isFolder
    ? `https://drive.google.com/drive/folders/${id}`
    : `https://drive.google.com/file/d/${id}`;
  return `<div class="flip-entry" id="entry-${id}">
    <div class="flip-entry-title">${name}</div>
    <a href="${href}">${name}</a>
  </div>`;
}

test('T9 — the Drive listing descends into the ONE subtitle subfolder (C5: the top wins on an empty subfolder)', async () => {
  const topId = 'TOPFOLDERID1234567890abcd';
  const subId = 'SUBFOLDERID1234567890abcd';
  const topHtml = `<html><body>
    ${driveEntryHtml(subId, 'Subtitles', true)}
    ${driveEntryHtml('VIDEOFILEID1234567890abcd', 'Aikatsu! - 001.mkv', false)}
  </body></html>`;
  const subHtml = `<html><body>
    ${Array.from({ length: 5 }, (_, i) => driveEntryHtml(`SUBFILEID000000000000${i}1`, `Aikatsu! - 00${i + 1}.ass`, false)).join('\n')}
  </body></html>`;

  const pageFor = (id) => (id === topId ? topHtml : (id === subId ? subHtml : ''));
  const stub = async (url) => {
    const id = String(url).match(/[?&]id=([^&#]+)/)?.[1] || '';
    return new Response(pageFor(id), { status: 200, headers: { 'content-type': 'text/html' } });
  };

  await withFetch(stub, async () => {
    const listing = await cf.listDriveFolderWithSubtitles(`https://drive.google.com/drive/folders/${topId}`);
    assert.equal(listing.length, 5, 'the subtitle subfolder is listed');
    assert.equal(cf.listingOffersSubtitles(listing), true);
    assert.ok(listing.every(f => f.name.toLowerCase().endsWith('.ass')));
  });

  // C5: an EMPTY subtitle subfolder falls back to the TOP listing.
  const emptyStub = async (url) => {
    const id = String(url).match(/[?&]id=([^&#]+)/)?.[1] || '';
    const body = id === topId ? topHtml : '';
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  await withFetch(emptyStub, async () => {
    const listing = await cf.listDriveFolderWithSubtitles(`https://drive.google.com/drive/folders/${topId}`);
    assert.equal(listing.length, 2, 'the top listing is used when the subfolder is empty');
    assert.equal(cf.listingOffersSubtitles(listing), false);
  });

  // C5: a FAILED subtitle subfolder listing falls back to the TOP listing.
  const failingStub = async (url) => {
    const id = String(url).match(/[?&]id=([^&#]+)/)?.[1] || '';
    if (id !== topId) throw new Error('subfolder listing failed');
    return new Response(topHtml, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  await withFetch(failingStub, async () => {
    const listing = await cf.listDriveFolderWithSubtitles(`https://drive.google.com/drive/folders/${topId}`);
    assert.equal(listing.length, 2, 'the top listing is used when the subfolder listing fails');
  });
});

// ---------------------------------------------------------------------------
// M4 + m8 + m9 — the explicit range is the only narrowing rule (T13, T14)
// ---------------------------------------------------------------------------

test('T13 — a multi-episode folder is NEVER narrowed by a single requested episode', async () => {
  // (a) the Drive production entry
  const dest = tmpDir('cloud-t13-');
  const listed = Array.from({ length: 5 }, (_, i) => ({
    name: `Aikatsu! - ${String(i + 1).padStart(3, '0')}.ass`,
    id: `driveid${i}`,
    isFolder: false
  }));
  const release = await cf.downloadDriveFolderRelease(
    'https://drive.google.com/drive/folders/drivefolderid1234567890',
    dest,
    '001',
    null,
    'Aikatsu! - 001',
    {
      listedFiles: listed,
      downloadFile: async (_fileId, destPath) => { fs.writeFileSync(destPath, 'fake'); return true; }
    }
  );
  assert.ok(release && release.filePath.endsWith('.zip'));
  const driveAss = new AdmZip(release.filePath).getEntries().filter(e => !e.isDirectory && e.entryName.toLowerCase().endsWith('.ass'));
  assert.equal(driveAss.length, 5, 'the whole folder is downloaded (m9)');

  // (b) the Mega production entry — the same rule (m8)
  const dest2 = tmpDir('cloud-t13b-');
  const megaListed = Array.from({ length: 5 }, (_, i) => ({
    name: `Aikatsu! - ${String(i + 1).padStart(3, '0')}.ass`,
    size: 2048,
    node: { id: i }
  }));
  const megaRelease = await cf.downloadMegaFolderRelease('https://mega.nz/folder/megakey', dest2, '001', {
    rawTitle: 'Aikatsu! - 001',
    listedFiles: megaListed,
    downloadNode: async (_node, destPath) => { fs.writeFileSync(destPath, 'fake'); return destPath; }
  });
  assert.ok(megaRelease && megaRelease.filePath.endsWith('.zip'));
  const megaAss = new AdmZip(megaRelease.filePath).getEntries().filter(e => !e.isDirectory && e.entryName.toLowerCase().endsWith('.ass'));
  assert.equal(megaAss.length, 5, 'Mega and Drive behave the same (m8)');
});

test('T14 — extractExplicitEpisodeRange only accepts a real episode range', () => {
  assert.deepEqual(cf.extractExplicitEpisodeRange('[01~03]'), ['1', '2', '3']);
  assert.deepEqual(cf.extractExplicitEpisodeRange('S01 - 02'), [], 'a season + an episode is not a range');
  assert.deepEqual(cf.extractExplicitEpisodeRange('- 01'), [], 'a single number is not a range');
  assert.deepEqual(cf.extractExplicitEpisodeRange('Episodes 01-05'), ['1', '2', '3', '4', '5']);
  assert.deepEqual(cf.extractExplicitEpisodeRange(''), []);
  assert.deepEqual(cf.extractExplicitEpisodeRange('Aikatsu! - 001'), [], 'a single episode number is not a range');
  assert.deepEqual(cf.extractExplicitEpisodeRange('1080p - 1081p'), [], 'a resolution is not a range');
  assert.deepEqual(cf.extractExplicitEpisodeRange('03 - 01'), [], 'the range must grow');
});

// ---------------------------------------------------------------------------
// M5 — the collection word and its ordinal (T15, T16)
// ---------------------------------------------------------------------------

test('T15 — an ordinal is blanked only when it is glued to a collection word', () => {
  assert.equal(tc.extractEpisodeNumber('الدفعة الأولى: الحلقة الأولى'), '01');
  assert.equal(tc.extractEpisodeNumber('الجزء الثاني: الحلقة الثالثة'), '03');
  assert.equal(tc.extractEpisodeNumber('الدفعة الأولى - 004'), '4');
  assert.equal(tc.extractEpisodeNumber('الدفعة الأولى من سلسلة'), '');
});

test('T16 — a separator breaks the adjacency, a long gap does not suppress the ordinal', () => {
  const stripped = tc.stripCollectionAdjacentOrdinals('الدفعة الأولى: الحلقة الأولى');
  assert.ok(!stripped.includes('الدفعة الأولى'), 'the ordinal glued to the collection word is blanked');
  assert.ok(stripped.includes('الحلقة الأولى'), 'the ordinal behind the separator survives');

  assert.equal(tc.extractEpisodeNumber('الدفعة الأولى: الحلقة الثانية'), '02');

  const near = tc.stripCollectionAdjacentOrdinals(`الدفعة${' '.repeat(25)}الأولى`);
  assert.ok(!near.includes('الأولى'), 'a gap of 25 characters still suppresses the ordinal');

  const far = tc.stripCollectionAdjacentOrdinals(`الدفعة${' '.repeat(26)}الأولى`);
  assert.ok(far.includes('الأولى'), 'a gap of 26 characters does not suppress the ordinal');
});

// ---------------------------------------------------------------------------
// m6 — the official/Subdl title derivation (T23)
// ---------------------------------------------------------------------------

test('T23 — the release name comes from the .ass chain, not from the video (m6)', async () => {
  const dir = tmpDir('cloud-t23-');
  const assPath = path.join(dir, 'subtitle.ass');
  fs.writeFileSync(
    assPath,
    '[Script Info]\nTitle: [Aurora Team] Aikatsu! - 001\n\n[Events]\nFormat: Layer, Start, End, Style\n'
  );
  const videoName = 'Aikatsu! - 002 [1080p].mkv';

  // The pre-patch name candidates (the .ass first, the archive name) with the
  // episode numbers taken from the whole package.
  const resolved = tc.resolveEnglishTitleIfArabic(
    '[Aurora Team] الدفعة الأولى',
    ['subtitle.ass', 'الدفعة الأولى.zip'],
    [assPath],
    { episodeNames: [videoName] }
  );

  assert.ok(resolved.includes('Aikatsu!'), `the title comes from the .ass chain: ${resolved}`);
  assert.ok(resolved.includes('001'), `the .ass title is used: ${resolved}`);
  assert.ok(!resolved.includes('002'), `the video must not derive the title: ${resolved}`);
});

// ---------------------------------------------------------------------------
// m10 — the resolution guard (T24)
// ---------------------------------------------------------------------------

test('T24 — a resolution is not an episode, unless it is in an episode-token position', () => {
  const arabic = '[Aurora Team] الدفعة الأولى';

  const resolutions = tc.resolveEnglishTitleIfArabic(
    arabic,
    ['Show 720p.mkv', 'Show 1080p.mkv', 'Show 480.mkv', 'Show 540.mkv'],
    []
  );
  assert.ok(!/\[\d+\s*~\s*\]/i.test(resolutions), `the resolutions are not episodes: ${resolutions}`);
  assert.ok(!/\[\d+\s*~\s*\d+\]/.test(resolutions), `no range is derived from the resolutions: ${resolutions}`);

  const episodes = tc.resolveEnglishTitleIfArabic(
    arabic,
    ['Show - 1080.mkv', 'Show - 1081.mkv'],
    []
  );
  assert.ok(episodes.includes('[1080~1081]'), `the episode range survives: ${episodes}`);
});

// ---------------------------------------------------------------------------
// m11 — a failed listing (T25)
// ---------------------------------------------------------------------------

test('T25 — a failed cloud listing warns exactly once and marks the source', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
  try {
    await withFetch(async () => { throw new Error('network down'); }, async () => {
      const sources = await tc.buildPostCloudSources({
        drive: 'https://drive.google.com/drive/folders/drivefolderid1234567890'
      });
      assert.equal(sources.length, 1);
      assert.equal(sources[0].listingError, true, 'the failed listing is marked');
      assert.deepEqual(sources[0].listing, []);
    });
  } finally {
    console.warn = originalWarn;
  }

  const listingWarnings = warnings.filter(w => w.includes('Cloud folder listing failed'));
  assert.equal(listingWarnings.length, 1, `exactly one warning: ${warnings.join(' | ')}`);
});

// ---------------------------------------------------------------------------
// m7 — the DDL batch directory (T26)
// ---------------------------------------------------------------------------

test('T26 — a batch DDL directory prefers the archive without an episode token', async () => {
  const batchHtml = `<html><body>
    <a href="https://example.test/files/Aikatsu%20Batch%2001-05.zip">Aikatsu Batch 01-05.zip</a>
    <a href="https://example.test/files/Aikatsu%20Batch.zip">Aikatsu Batch.zip</a>
  </body></html>`;

  await withFetch(async () => new Response(batchHtml, { status: 200, headers: { 'content-type': 'text/html' } }), async () => {
    const chosen = await ss.resolveSubtitleFromDirectory('https://example.test/subtitles/', null, { batch: true });
    assert.ok(chosen && chosen.includes('Aikatsu%20Batch.zip'), `the whole-batch archive wins: ${chosen}`);
  });

  // Only per-episode archives: the limitation is logged and the first is used.
  const perEpisodeHtml = `<html><body>
    <a href="https://example.test/files/ep01.zip">ep01.zip</a>
    <a href="https://example.test/files/ep02.zip">ep02.zip</a>
  </body></html>`;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
  try {
    await withFetch(async () => new Response(perEpisodeHtml, { status: 200, headers: { 'content-type': 'text/html' } }), async () => {
      const chosen = await ss.resolveSubtitleFromDirectory('https://example.test/subtitles/', null, { batch: true });
      assert.ok(chosen && chosen.includes('ep01.zip'), `the first archive is used: ${chosen}`);
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    warnings.some(w => w.includes('batch directory has only per-episode archives')),
    `the limitation is logged: ${warnings.join(' | ')}`
  );
});

// ---------------------------------------------------------------------------
// the caption of a batch release (T28)
// ---------------------------------------------------------------------------

test('T28 — the caption of a batch carries the range and the fonts marker', () => {
  const resolved = '[Aurora Team] Aikatsu! [01~04]';
  const fileName = tc.getSafeTelegramFileName(resolved, '.ass');
  const caption = tc.formatCleanCaption(fileName.replace(/\.ass$/, ''), true, false, true);
  assert.ok(caption.includes('[01~04]'), `the range is in the caption: ${caption}`);
  assert.ok(caption.includes('[+Fonts]'), `the fonts marker is in the caption: ${caption}`);
});

// ---------------------------------------------------------------------------
// the call sites carry the new options (m6, m7)
// ---------------------------------------------------------------------------

test('T38 — the call sites pass the new options (m6, m7)', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const client = fs.readFileSync(path.join(repoRoot, 'src', 'telegram-client.mjs'), 'utf8');
  const scrapers = fs.readFileSync(path.join(repoRoot, 'src', 'site-scrapers.mjs'), 'utf8');

  assert.ok(client.includes('{ episodeNames: allExtracted }'), 'the Subdl package call site passes the episode names');
  assert.ok(client.includes('{ episodeNames: allExtractedFiles }'), 'the archive package call site passes the episode names');
  assert.ok(client.includes('{ batch: isCollectionTitle(titleLine) }'), 'the post scrape passes the batch option');
  assert.ok(
    client.includes('{ rawTitle: titleLine, listedFiles: listing, batch: isCollectionTitle(titleLine) }'),
    'the Mega cloud call site passes the batch option'
  );
  assert.ok(scrapers.includes('{ batch: Boolean(options.batch) }'), 'scrapePostPage forwards the batch option');
  assert.ok(client.includes('extractExplicitEpisodeRange(titleLine || \'\')'), 'the cloud title range uses the explicit range');
  // X7: BOTH call sites of the DDL directory resolution pass the batch option.
  assert.ok(
    client.includes('scrapePostPage(postPageUrl, null, extractEpisodeNumber(titleLine) || null, titleLine, { batch: isCollectionTitle(titleLine) })'),
    'the LazySano scrape passes the batch option'
  );
  assert.ok(
    client.includes('resolveSubtitleFromDirectory(directUrl, targetEp, { batch: isCollectionTitle(titleLine) })'),
    'the fansub DDL directory resolution passes the batch option'
  );
});

// ---------------------------------------------------------------------------
// X1 — the sink error / drain handling
// ---------------------------------------------------------------------------

test('T39 — a source stream that errors mid-download rejects and removes the partial file (X1)', async () => {
  const dir = tmpDir('cloud-t39-');
  const dest = path.join(dir, 'file.ass');
  const { Readable } = await import('node:stream');

  // A chunk bigger than the high-water mark: the sink suspends at the drain
  // wait while the error arrives.
  const failing = new Readable({
    read() {
      if (this._sent) return;
      this._sent = true;
      this.push(Buffer.alloc(128 * 1024, 0x41));
      setImmediate(() => this.destroy(new Error('stream exploded')));
    }
  });

  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(
      () => cf.downloadMegaNode({ download: () => failing }, dest, dir, {}),
      /stream exploded/
    );
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.equal(fs.existsSync(dest), false, 'the partial file is removed');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(unhandled, [], 'no unhandled rejection');
});

test('T40 — the Drive sink: an erroring body leaves no partial file and no unhandled rejection (X1)', async () => {
  const dir = tmpDir('cloud-t40-');
  const dest = path.join(dir, 'file.ass');

  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(2048));
      controller.error(new Error('body exploded'));
    }
  });

  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await withFetch(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } }), async () => {
      // The existing contract of the Drive sink: a soft failure returns
      // false (the cap refusal is the only one that rejects).
      const ok = await cf.downloadGoogleDriveFileToDisk('drivefileid1234567890abcd', dest, 'file.ass', { maxBytes: 1024 * 1024 });
      assert.equal(ok, false);
    });
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.equal(fs.existsSync(dest), false, 'the partial file is removed');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(unhandled, [], 'no unhandled rejection');
});

// ---------------------------------------------------------------------------
// X2 — the listing-cap cooldown
// ---------------------------------------------------------------------------

test('T41 — a listing refusal marks the 6 h cooldown and the folder is not fetched again (X2)', async () => {
  cf.__resetCloudCapCooldowns();
  const url = 'https://www.mediafire.com/folder/mfkey';
  let fetchCalls = 0;

  try {
    await withFetch(async () => {
      fetchCalls += 1;
      // A listing response over the 2 MiB cap.
      return new Response('x'.repeat(3 * 1024 * 1024), { status: 200, headers: { 'content-type': 'application/json' } });
    }, async () => {
      const first = await cf.listCloudFolderFiles('mediafire', url);
      assert.equal(first, null, 'the failed listing is reported as null');
      assert.equal(cf.isCloudCapCooldownActive('mediafire', url), true, 'the cooldown is active');
      assert.equal(cf.cloudCapCooldownKey('mediafire', url), `mediafire|${cf.redactUrl(url)}`, 'the key carries the redacted url');

      const second = await cf.listCloudFolderFiles('mediafire', url);
      assert.equal(second, null);
      assert.equal(fetchCalls, 1, 'the folder is not fetched again while the cooldown is active');
    });
  } finally {
    cf.__resetCloudCapCooldowns();
  }
});

// ---------------------------------------------------------------------------
// X3 — the provider classification (SSRF)
// ---------------------------------------------------------------------------

test('T42 — a provider field is classified by its hostname (X3)', async () => {
  const evil = 'https://evil.test/x?mediafire.com';
  const sources = await tc.buildPostCloudSources({
    mediafire: evil,
    mega: 'https://mega.nz/folder/megakey',
    drive: 'https://drive.google.com/drive/folders/drivefolderid1234567890'
  }, { listFolder: async () => [] });

  assert.equal(sources.length, 2, 'the hostile mediafire link is dropped');
  assert.ok(!sources.some(s => s.kind === 'mediafire'), 'no mediafire source is built from a foreign host');
  assert.ok(sources.some(s => s.kind === 'mega'), 'a real mega link still classifies');
  assert.ok(sources.some(s => s.kind === 'drive'), 'a real drive link still classifies');

  const ok = await tc.buildPostCloudSources({
    mediafire: 'https://www.mediafire.com/folder/mfkey'
  }, { listFolder: async () => [] });
  assert.equal(ok.length, 1);
  assert.equal(ok[0].kind, 'mediafire');
});

// ---------------------------------------------------------------------------
// X4 / X5 — the caps of the non-subtitle sinks
// ---------------------------------------------------------------------------

test('T43 — the non-subtitle sinks carry the 4 GiB ceiling (X4)', async () => {
  // the Mega archive sink
  const dest = tmpDir('cloud-t43-');
  let options = null;
  await cf.downloadMegaFolderRelease('https://mega.nz/folder/megakey', dest, null, {
    listedFiles: [{ name: 'Aikatsu! Batch.zip', size: 200 * 1024 * 1024, node: { id: 1 } }],
    downloadNode: async (_node, destPath, _dir, opts) => { options = opts; fs.writeFileSync(destPath, 'fake'); return destPath; }
  });
  assert.equal(options.maxBytes, cf.CLOUD_CAP_LIMITS.CLOUD_FILE_MAX_BYTES);
  assert.ok(options.maxBytes > 200 * 1024 * 1024, 'a 200 MiB video passes the ceiling');

  // the Mega MKV sink
  let mkvOptions = null;
  await cf.downloadMegaFolderRelease('https://mega.nz/folder/megakey', dest, null, {
    listedFiles: [{ name: 'Aikatsu! - 001.mkv', size: 200 * 1024 * 1024, node: { id: 2 } }],
    downloadNode: async (_node, destPath, _dir, opts) => { mkvOptions = opts; fs.writeFileSync(destPath, 'fake'); return destPath; }
  });
  assert.equal(mkvOptions.maxBytes, cf.CLOUD_CAP_LIMITS.CLOUD_FILE_MAX_BYTES);

  // the Drive archive sink
  const dest2 = tmpDir('cloud-t43b-');
  let driveOptions = null;
  await cf.downloadDriveFolderRelease(
    'https://drive.google.com/drive/folders/drivefolderid1234567890',
    dest2, null, null, '',
    {
      listedFiles: [{ name: 'Aikatsu! Batch.zip', id: 'driveid1', isFolder: false }],
      downloadFile: async (_id, destPath, _name, opts) => { driveOptions = opts; fs.writeFileSync(destPath, 'fake'); return true; }
    }
  );
  assert.equal(driveOptions.maxBytes, cf.CLOUD_CAP_LIMITS.CLOUD_FILE_MAX_BYTES);
});

test('T44 — the single-file cap follows the type: a video gets the 4 GiB ceiling (X5)', async () => {
  const dest = tmpDir('cloud-t44-');

  let videoOptions = null;
  await tc.downloadCloudSubtitleSelection(
    { type: 'mkv', name: 'Aikatsu! - 001.mkv', directUrl: 'https://example.test/a.mkv', size: 200 * 1024 * 1024 },
    dest, 'https://ref.test',
    {
      downloadFile: async (_url, destPath, _headers, opts) => { videoOptions = opts; fs.writeFileSync(destPath, 'fake'); return destPath; }
    }
  );
  assert.equal(videoOptions.maxBytes, cf.CLOUD_CAP_LIMITS.CLOUD_FILE_MAX_BYTES, 'a video is not bounded by the subtitle cap');

  let subOptions = null;
  await tc.downloadCloudSubtitleSelection(
    { type: 'subtitle', name: 'Aikatsu! - 001.ass', directUrl: 'https://example.test/a.ass', size: 1024 },
    dest, 'https://ref.test',
    {
      downloadFile: async (_url, destPath, _headers, opts) => { subOptions = opts; fs.writeFileSync(destPath, 'fake'); return destPath; }
    }
  );
  assert.equal(subOptions.maxBytes, cf.CLOUD_CAP_LIMITS.SUB_MAX_FILE_BYTES, 'a subtitle keeps the 64 MiB cap');
});

// ---------------------------------------------------------------------------
// X6 — the log injection in the m7 warning
// ---------------------------------------------------------------------------

test('T45 — the batch warning cannot forge a log line (X6)', async () => {
  const html = '<html><body><a href="https://example.test/files/ep%0a01.zip">x</a></body></html>';
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
  try {
    await withFetch(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }), async () => {
      await ss.resolveSubtitleFromDirectory('https://example.test/subtitles/', null, { batch: true });
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.length > 0, 'the warning is logged');
  for (const w of warnings) {
    assert.ok(!w.includes('\n'), `no newline in the warning: ${JSON.stringify(w)}`);
  }
});

// ---------------------------------------------------------------------------
// M4 — the scraper host classification
// ---------------------------------------------------------------------------

test('T46 — a provider host is decided by the hostname, never by a substring (M4)', () => {
  // the scraper helper
  assert.equal(ss.isHostOf('https://www.mediafire.com/folder/x', 'mediafire.com'), true);
  assert.equal(ss.isHostOf('https://evil-mediafire.com/folder/x', 'mediafire.com'), false);
  assert.equal(ss.isHostOf('https://mediafire.com.evil.test/folder/x', 'mediafire.com'), false);
  assert.equal(ss.isHostOf('https://evil.test/?x=mediafire.com', 'mediafire.com'), false);
  assert.equal(ss.isHostOf('not a url', 'mediafire.com'), false, 'a malformed href is never a provider');

  // the cloud helper (the same rule)
  assert.equal(cf.isProviderHostUrl('https://www.mediafire.com/folder/x', 'mediafire'), true);
  assert.equal(cf.isProviderHostUrl('https://evil-mediafire.com/folder/x', 'mediafire'), false);
  assert.equal(cf.isProviderHostUrl('https://mediafire.com.evil.test/folder/x', 'mediafire'), false);
  assert.equal(cf.isProviderHostUrl('https://evil.test/?x=mediafire.com', 'mediafire'), false);
});

// ---------------------------------------------------------------------------
// X8 — the listing cap binds while the body is read
// ---------------------------------------------------------------------------

test('T47 — a chunked listing body over the cap is refused while it is read (X8)', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('x'.repeat(1024 * 1024)));
      controller.enqueue(encoder.encode('x'.repeat(1024 * 1024)));
      controller.enqueue(encoder.encode('x'.repeat(1024 * 1024)));
      controller.close();
    }
  });
  const res = new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  assert.equal(res.headers.get('content-length'), null, 'the body is chunked (no content-length)');

  await rejectsWithCode(
    () => cf.readResponseTextCapped(res, 2 * 1024 * 1024),
    'LISTING_TOO_LARGE'
  );
});

// ---------------------------------------------------------------------------
// X9 — the control characters in a remote name
// ---------------------------------------------------------------------------

test('T48 — safeRemoteBaseName strips the control characters (X9)', () => {
  const name = ps.safeRemoteBaseName('evil\n[+Fonts].ass');
  assert.ok(!/[\u0000-\u001f\u007f]/.test(name), `no control characters: ${JSON.stringify(name)}`);
  assert.equal(name, 'evil[+Fonts].ass');
});

// ---------------------------------------------------------------------------
// X10 — the episode word breaks the collection adjacency
// ---------------------------------------------------------------------------

test('T49 — an episode word breaks the collection adjacency (X10)', () => {
  assert.equal(tc.extractEpisodeNumber('الجزء الثاني الحلقة الثالثة'), '03', 'the episode ordinal survives');
  // the four required cases still hold
  assert.equal(tc.extractEpisodeNumber('الدفعة الأولى: الحلقة الأولى'), '01');
  assert.equal(tc.extractEpisodeNumber('الجزء الثاني: الحلقة الثالثة'), '03');
  assert.equal(tc.extractEpisodeNumber('الدفعة الأولى - 004'), '4');
  assert.equal(tc.extractEpisodeNumber('الدفعة الأولى من سلسلة'), '');
});

// ---------------------------------------------------------------------------
// X11 — no partial zip when the pack fails
// ---------------------------------------------------------------------------

test('T50 — a failed pack leaves no partial zip behind (X11)', async () => {
  const dest = tmpDir('cloud-t50-');
  const files = [
    { name: 'Show - 01.ass', size: 1024, directUrl: 'https://example.test/1.ass' },
    { name: 'Show - 02.ass', size: 1024, directUrl: 'https://example.test/2.ass' }
  ];

  await assert.rejects(() => tc.downloadCloudSubtitleSelection({ type: 'subtitles', files }, dest, 'https://ref.test', {
    downloadFile: async (_url, destPath) => { fs.writeFileSync(destPath, 'fake'); },
    packFolder: (_dir, zipPath) => { fs.writeFileSync(zipPath, 'partial'); throw new Error('pack failed'); }
  }), /pack failed/);

  assert.deepEqual(fs.readdirSync(dest).filter(n => n.endsWith('.zip')), [], 'no partial zip survives');
  assert.deepEqual(fs.readdirSync(dest).filter(n => n.startsWith('cloud_unpack')), [], 'no unpack directory survives');
});

// ---------------------------------------------------------------------------
// S1 — the Buzzheavier host validation
// ---------------------------------------------------------------------------

test('T51 — a Buzzheavier download is only accepted from a known https host (S1)', () => {
  assert.equal(ss.isBuzzheavierHost('https://buzzheavier.com/abc123'), true);
  assert.equal(ss.isBuzzheavierHost('https://www.buzzheavier.com/abc123'), true);
  assert.equal(ss.isBuzzheavierHost('http://buzzheavier.com/abc123'), false, 'http is refused');
  assert.equal(ss.isBuzzheavierHost('https://evil.test/buzzheavier.com/abc123'), false);
  assert.equal(ss.isBuzzheavierHost('https://buzzheavier.com.evil.test/abc123'), false);
  assert.equal(ss.isBuzzheavierHost('not a url'), false);
});

// ---------------------------------------------------------------------------
// S2 — the archive extraction cap
// ---------------------------------------------------------------------------

test('T52 — an archive over the uncompressed-size cap is refused before the extraction (S2)', async () => {
  const dir = tmpDir('cloud-t52-');
  const zipPath = path.join(dir, 'small.zip');
  const zip = new AdmZip();
  zip.addFile('a.ass', Buffer.alloc(4096, 0x41));
  zip.writeZip(zipPath);

  const total = tc.assertArchiveUncompressedCapped(zipPath, 1024 * 1024);
  assert.ok(total >= 4096, `the uncompressed size is reported: ${total}`);

  await rejectsWithCode(
    async () => tc.assertArchiveUncompressedCapped(zipPath, 1024),
    'ARCHIVE_TOO_LARGE'
  );
});

// ---------------------------------------------------------------------------
// P1 / P2 — the bounded parallelism of the batch downloads
// ---------------------------------------------------------------------------

test('T53 — the batch downloads run in parallel, bounded by the concurrency limit (P1, P2)', async () => {
  // (a) the cloud selection
  const dest = tmpDir('cloud-t53-');
  let inFlight = 0;
  let maxInFlight = 0;
  const files = Array.from({ length: 6 }, (_, i) => ({
    name: `Show - ${String(i + 1).padStart(2, '0')}.ass`,
    size: 1024,
    directUrl: `https://example.test/${i}.ass`
  }));
  await tc.downloadCloudSubtitleSelection({ type: 'subtitles', files }, dest, 'https://ref.test', {
    downloadFile: async (_url, destPath) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 25));
      fs.writeFileSync(destPath, 'fake');
      inFlight -= 1;
    }
  });
  assert.ok(maxInFlight > 1, `the cloud selection downloads in parallel (max ${maxInFlight})`);
  assert.ok(maxInFlight <= cf.CLOUD_CAP_LIMITS.CONCURRENCY, `the parallelism is bounded (max ${maxInFlight})`);

  // (b) the Mega release
  const dest2 = tmpDir('cloud-t53b-');
  let megaInFlight = 0;
  let megaMax = 0;
  const listed = Array.from({ length: 6 }, (_, i) => ({
    name: `Show - ${String(i + 1).padStart(2, '0')}.ass`,
    size: 1024,
    node: { id: i }
  }));
  await cf.downloadMegaFolderRelease('https://mega.nz/folder/megakey', dest2, null, {
    listedFiles: listed,
    downloadNode: async (_node, destPath) => {
      megaInFlight += 1;
      megaMax = Math.max(megaMax, megaInFlight);
      await new Promise(r => setTimeout(r, 25));
      fs.writeFileSync(destPath, 'fake');
      megaInFlight -= 1;
    }
  });
  assert.ok(megaMax > 1, `the Mega batch downloads in parallel (max ${megaMax})`);
  assert.ok(megaMax <= cf.CLOUD_CAP_LIMITS.CONCURRENCY, `the parallelism is bounded (max ${megaMax})`);
});

// ---------------------------------------------------------------------------
// M1 — the cooldown map is bounded
// ---------------------------------------------------------------------------

test('T54 — the cooldown map is bounded and prunes the expired entries (M1)', () => {
  cf.__resetCloudCapCooldowns();
  const now = Date.now();
  for (let i = 0; i < 600; i++) {
    cf.markCloudCapCooldown('mega', `https://mega.nz/folder/key${i}`, now);
  }
  const entries = cf.__getCloudCapCooldowns();
  assert.ok(
    entries.length <= cf.CLOUD_CAP_LIMITS.MAX_COOLDOWN_ENTRIES,
    `the map is bounded: ${entries.length} entries`
  );

  // an expired entry is pruned on the next insert
  cf.markCloudCapCooldown('mega', 'https://mega.nz/folder/old', now);
  cf.markCloudCapCooldown('mega', 'https://mega.nz/folder/new', now + 7 * 60 * 60 * 1000);
  const after = cf.__getCloudCapCooldowns();
  assert.ok(!after.some(([key]) => key.includes('/old')), 'the expired entry is pruned');
  assert.ok(after.length <= cf.CLOUD_CAP_LIMITS.MAX_COOLDOWN_ENTRIES, 'the map stays bounded');
  cf.__resetCloudCapCooldowns();
});

// ---------------------------------------------------------------------------
// M2 — the published document name
// ---------------------------------------------------------------------------

test('T55 — a published document name carries no control character (M2)', () => {
  const name = tc.getSafeTelegramFileName('evil\u0000\u001b[31m[+Fonts].ass', '.ass');
  assert.ok(!/[\u0000-\u001f\u007f]/.test(name), `no control character: ${JSON.stringify(name)}`);
  assert.ok(!name.includes('\u0000'));
  assert.ok(!name.includes('\u001b'));
});

// ---------------------------------------------------------------------------
// M3 — the residual log interpolations
// ---------------------------------------------------------------------------

test('T56 — the residual log interpolations are redacted / log-safe (M3)', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const client = fs.readFileSync(path.join(repoRoot, 'src', 'telegram-client.mjs'), 'utf8');

  assert.ok(!client.includes('Direct download: ${directUrl}'), 'the direct url is redacted');
  assert.ok(!client.includes('Fansub torrent found: ${pageData.videoLinks.torrent}'), 'the torrent url is redacted');
  assert.ok(!client.includes('"${titleLine}"'), 'the title is log-safe');
  assert.ok(!client.includes('"${caption}"'), 'the caption is log-safe');
  assert.ok(!client.includes('"${originalName}"'), 'the original file name is log-safe');
});

// ---------------------------------------------------------------------------
// Horemajo — a SINGLE-episode post in a series-wide Mega subtitle folder
// (the batch:false narrowing, its cap refusal and its log hygiene)
// ---------------------------------------------------------------------------

// A folder that actually holds episodes 01..07 (the reported case).
function seriesSubs(count = 7) {
  return Array.from({ length: count }, (_, i) => ({
    name: `Horemajo - ${String(i + 1).padStart(2, '0')}.ass`,
    size: 2048,
    node: { id: i }
  }));
}

test('T57 — batch:false narrows a 7-sub series folder to exactly the requested episode', () => {
  const sel = cf.selectFolderTargets(seriesSubs(7), { targetEpisode: '7', batch: false });
  assert.equal(sel.length, 1, 'only episode 07 is selected');
  assert.equal(sel[0].name, 'Horemajo - 07.ass');
});

test('T58 — the m9 invariant: batch:true (and omitted) still selects all 7 episodes', () => {
  const files = seriesSubs(7);
  assert.equal(cf.selectFolderTargets(files, { targetEpisode: '7', batch: true }).length, 7);
  assert.equal(cf.selectFolderTargets(files, { targetEpisode: '7' }).length, 7, 'the default is batch:true');
  assert.equal(cf.selectFolderSubtitleBatch(files, { targetEpisode: '7' }).length, 7, 'the listing path keeps the default');
});

test('T59 — a parseable folder missing the requested episode defers (EPISODE_ABSENT), never downloads', async () => {
  const dest = tmpDir('cloud-t59-');
  // Episodes 10..30: nothing matches target "7". Substituting another
  // episode (or the whole folder) is wrong — the source has not uploaded
  // ep 7 yet, so the release defers and is retried on a later cycle.
  const listed = Array.from({ length: 21 }, (_, i) => ({
    name: `Horemajo - ${String(i + 10).padStart(2, '0')}.ass`,
    size: 2048,
    node: { id: i }
  }));

  let calls = 0;
  // EPISODE_ABSENT is deliberately NOT a CloudCapError: no 6h cooldown —
  // the release is retried on the next cycle (the source uploads it soon).
  await assert.rejects(
    cf.downloadMegaFolderRelease('https://mega.nz/folder/megakey', dest, '7', {
      listedFiles: listed,
      batch: false,
      downloadNode: async () => { calls += 1; }
    }),
    (e) => e.code === 'EPISODE_ABSENT'
  );
  assert.equal(calls, 0, 'nothing is downloaded');
  assert.deepEqual(entriesOf(dest), []);
});

test('T59b — a NON-parsable oversized folder still falls through to the generic cap', async () => {
  const dest = tmpDir('cloud-t59b-');
  const listed = 'abcdefghijklmnopqrstu'.split('').map((c, i) => ({
    name: `subtitle_${c}.ass`,
    size: 2048,
    node: { id: i }
  }));

  let calls = 0;
  await rejectsWithCode(
    cf.downloadMegaFolderRelease('https://mega.nz/folder/megakey', dest, '7', {
      listedFiles: listed,
      batch: false,
      downloadNode: async () => { calls += 1; }
    }),
    'TOO_MANY_FILES'
  );
  assert.equal(calls, 0, 'nothing is downloaded');
});

test('T60 — a narrowed 1-sub + 20-fonts series folder throws SERIES_FOLDER_BATCH', async () => {
  const dest = tmpDir('cloud-t60-');
  const listed = [
    ...seriesSubs(7),
    ...Array.from({ length: 20 }, (_, i) => ({ name: `Font${i + 1}.ttf`, size: 2048, node: { id: 100 + i } }))
  ];

  let calls = 0;
  await rejectsWithCode(
    cf.downloadMegaFolderRelease('https://mega.nz/folder/megakey', dest, '7', {
      listedFiles: listed,
      batch: false,
      downloadNode: async () => { calls += 1; }
    }),
    'SERIES_FOLDER_BATCH'
  );
  assert.equal(calls, 0);
  assert.deepEqual(entriesOf(dest), []);
});

test('T60b — a narrowed Drive series folder over the font cap uses the fallback code', async () => {
  const dest = tmpDir('cloud-t60b-');
  const listed = [
    ...seriesSubs(7).map((f, i) => ({ name: f.name, id: `driveid${i}`, isFolder: false })),
    ...Array.from({ length: 20 }, (_, i) => ({ name: `Font${i + 1}.ttf`, id: `fontid${i}`, isFolder: false }))
  ];
  const downloaded = [];
  const downloadFile = async (_id, destPath, name) => {
    downloaded.push(name);
    fs.writeFileSync(destPath, 'fake');
    return true;
  };

  await rejectsWithCode(
    cf.downloadDriveFolderRelease(
      'https://drive.google.com/drive/folders/drivefolderid1234567890',
      dest,
      '7',
      null,
      'Horemajo - 07',
      { listedFiles: listed, batch: false, downloadFile }
    ),
    'SERIES_FOLDER_BATCH'
  );
  assert.deepEqual(downloaded, [], 'the cap refusal happens before the first download');
  assert.deepEqual(entriesOf(dest), []);

  const release = await cf.downloadDriveFolderRelease(
    'https://drive.google.com/drive/folders/drivefolderid1234567890',
    dest,
    '7',
    null,
    'Horemajo - 07',
    { listedFiles: listed, batch: false, skipFonts: true, downloadFile }
  );
  assert.equal(release.type, 'subtitle');
  assert.deepEqual(downloaded, ['Horemajo - 07.ass'], 'the fallback downloads only the requested subtitle');
  assert.equal(fs.existsSync(release.filePath), true);
});

test('T60c — a narrowed Drive folder with too many matching subtitles uses the fallback code', async () => {
  const dest = tmpDir('cloud-t60c-');
  const listed = [
    ...Array.from({ length: 21 }, (_, i) => ({
      name: `Horemajo - 07 [${i + 1}].ass`,
      id: `driveid${i}`,
      isFolder: false
    })),
    { name: 'Horemajo - 08.ass', id: 'driveid08', isFolder: false }
  ];
  let downloaderCalls = 0;

  await rejectsWithCode(
    cf.downloadDriveFolderRelease(
      'https://drive.google.com/drive/folders/drivefolderid1234567890',
      dest,
      '7',
      null,
      'Horemajo - 07',
      {
        listedFiles: listed,
        batch: false,
        downloadFile: async () => { downloaderCalls += 1; }
      }
    ),
    'SERIES_FOLDER_BATCH'
  );
  assert.equal(downloaderCalls, 0);
  assert.deepEqual(entriesOf(dest), []);
});

test('T61 — the narrowed release still packs its fonts under Fonts/', async () => {
  const dest = tmpDir('cloud-t61-');
  const fonts = [
    { name: 'Base.ttf', size: 2048, node: { id: 100 } },
    { name: 'Bold.otf', size: 2048, node: { id: 101 } }
  ];
  const listed = [...seriesSubs(7), ...fonts];

  const release = await cf.downloadMegaFolderRelease('https://mega.nz/folder/megakey', dest, '7', {
    rawTitle: 'Horemajo - 07',
    listedFiles: listed,
    batch: false,
    downloadNode: async (_node, destPath) => { fs.writeFileSync(destPath, 'fake'); return destPath; }
  });
  assert.ok(release && release.filePath.endsWith('.zip'));
  assert.equal(release.hasFonts, true);

  const names = new AdmZip(release.filePath).getEntries()
    .filter(e => !e.isDirectory)
    .map(e => e.entryName);
  assert.deepEqual(names.filter(n => /\.ass$/i.test(n)), ['Horemajo - 07.ass'], 'only ep 07 travels');
  assert.deepEqual(
    names.filter(n => n.startsWith('Fonts/')).sort(),
    ['Fonts/Base.ttf', 'Fonts/Bold.otf'],
    'fonts are still packed under Fonts/'
  );
});

test('T62 — a narrowed cap refusal logs its reason only, with no cooldown and no state key', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const client = fs.readFileSync(path.join(repoRoot, 'src', 'telegram-client.mjs'), 'utf8');
  const before = cf.__getCloudCapStats().byCode.SERIES_FOLDER_BATCH || 0;

  cf.__resetCloudCapCooldowns();
  const logs = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { logs.push(args.map(String).join(' ')); };
  try {
    tc.handleCloudCapRefusal(
      cf.cloudCapError('SERIES_FOLDER_BATCH', '1 sub(s) + 20 font(s) > 20'),
      { kind: 'mega', url: 'https://mega.nz/folder/SECRETKEY#FRAGMENTKEY', label: 'Mega' }
    );
  } finally {
    console.warn = originalWarn;
  }

  const line = logs.join('\n');
  assert.match(
    line,
    /⚠️ Mega single-episode refused \(SERIES_FOLDER_BATCH\): 1 sub\(s\) \+ 20 font\(s\) > 20 — not a batch title/,
    'the dedicated reason is logged'
  );
  assert.ok(!/SECRETKEY|FRAGMENTKEY|mega\.nz/.test(line), 'no url / Mega key is printed');
  assert.equal(
    (cf.__getCloudCapStats().byCode.SERIES_FOLDER_BATCH || 0), before + 1,
    'the refusal is counted once under its code'
  );
  assert.equal(cf.__getCloudCapCooldowns().length, 0, 'SERIES_FOLDER_BATCH does NOT set a cooldown');
  assert.ok(
    client.includes('if (!classified(msgKey)) countSkipped(msgKey);'),
    'with no downloaded file the message ends skipped (no state key written)'
  );

  // Every OTHER cap code keeps the existing 6 h cooldown.
  tc.handleCloudCapRefusal(
    cf.cloudCapError('TOO_MANY_FILES', 'cloud batch refused: 21 files > 20'),
    { kind: 'mega', url: 'https://mega.nz/folder/OTHERKEY', label: 'Mega' }
  );
  assert.equal(cf.__getCloudCapCooldowns().length, 1, 'other cap codes still get a cooldown');
  cf.__resetCloudCapCooldowns();
});

test('T63 — 1 sub + 20 fonts is SERIES_FOLDER_BATCH and is counted in byCode', async () => {
  const dest = tmpDir('cloud-t63-');
  const listed = [
    { name: 'Horemajo - 07.ass', size: 2048, node: { id: 1 } },
    ...Array.from({ length: 20 }, (_, i) => ({ name: `Font${i + 1}.ttf`, size: 2048, node: { id: 100 + i } }))
  ];
  const before = cf.__getCloudCapStats().byCode.SERIES_FOLDER_BATCH || 0;
  let calls = 0;

  await rejectsWithCode(
    cf.downloadMegaFolderRelease('https://mega.nz/folder/megakey', dest, '7', {
      listedFiles: listed,
      batch: false,
      downloadNode: async () => { calls += 1; }
    }),
    'SERIES_FOLDER_BATCH'
  );
  assert.equal(calls, 0);
  assert.deepEqual(entriesOf(dest), []);
  assert.equal(cf.__getCloudCapStats().byCode.SERIES_FOLDER_BATCH, before + 1);
});

test('T64 — a non-parsable filename never makes a narrowed release vanish', () => {
  const files = [
    { name: 'Horemajo.ass', node: { id: 1 } },
    { name: 'Horemajo Extra.ass', node: { id: 2 } }
  ];
  const sel = cf.selectFolderTargets(files, { targetEpisode: '7', batch: false });
  assert.ok(sel.length > 0, 'never returns []');
  assert.deepEqual(sel, files, 'falls through to the whole folder');
});

test('T65 — matchesEpisode normalizes leading zeros in both directions', () => {
  assert.equal(cf.matchesEpisode('Horemajo - 07.ass', '7'), true);
  assert.equal(cf.matchesEpisode('Horemajo - 7.ass', '07'), true);
});

test('T66 — a fonts-only (0-subtitle) Mega folder keeps the existing path', async () => {
  const dest = tmpDir('cloud-t66-');
  let calls = 0;
  const release = await cf.downloadMegaFolderRelease('https://mega.nz/folder/megakey', dest, '7', {
    listedFiles: [
      { name: 'Font1.ttf', size: 2048, node: { id: 1 } },
      { name: 'Font2.ttf', size: 2048, node: { id: 2 } }
    ],
    batch: false,
    downloadNode: async () => { calls += 1; }
  });
  assert.equal(release, null, 'no subtitle / archive / mkv means no release');
  assert.equal(calls, 0);
  assert.deepEqual(entriesOf(dest), []);
});

test('T67 — downloadMegaFolderRelease with skipFonts: true downloads single sub even when folder has 20+ fonts', async () => {
  const dest = tmpDir('cloud-t67-');
  const listed = [
    { name: 'Horemajo - 07.ass', size: 2048, node: { id: 1 } },
    ...Array.from({ length: 22 }, (_, i) => ({ name: `Font${i + 1}.ttf`, size: 2048, node: { id: 100 + i } }))
  ];
  let calls = 0;
  const release = await cf.downloadMegaFolderRelease('https://mega.nz/folder/megakey', dest, '7', {
    listedFiles: listed,
    batch: false,
    skipFonts: true,
    downloadNode: async (_node, destPath) => { calls += 1; fs.writeFileSync(destPath, '[Script Info]\n'); return destPath; }
  });
  assert.ok(release && release.filePath);
  assert.equal(release.isArchive, false);
  assert.equal(release.hasFonts, false);
  assert.equal(calls, 1, 'downloaded exactly 1 sub file');
  assert.ok(fs.existsSync(release.filePath));
});

test('T68 — extractAssFontNames and findMatchingFontFiles match styles correctly', () => {
  const sampleAss = `[Script Info]
Title: Sample
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour
Style: Default,adobe arabic,78,&H00FFFFFF
Style: Signs,29LT Riwaya,65,&H00F7F7F7
Style: Other,Noto Kufi Arabic,60,&H00E6E4E4
`;
  const fonts = cf.extractAssFontNames(sampleAss);
  assert.deepEqual(fonts.sort(), ['29LT Riwaya', 'Noto Kufi Arabic', 'adobe arabic'].sort());

  const availableFiles = [
    { name: 'arial-1.ttf' },
    { name: 'adobe-arabic-bold.otf' },
    { name: '29LTRiwaya-Regular.ttf' },
    { name: 'خط-بدر-اليدوي.ttf' },
    { name: 'NotoKufiArabic-Bold-1.ttf' },
  ];
  const matched = cf.findMatchingFontFiles(fonts, availableFiles);
  assert.deepEqual(matched.map(f => f.name).sort(), [
    '29LTRiwaya-Regular.ttf',
    'NotoKufiArabic-Bold-1.ttf',
    'adobe-arabic-bold.otf'
  ].sort());
});

test('T69 — tryBundleMatchingFonts bundles matched fonts into zip', async () => {
  const dest = tmpDir('cloud-t69-');
  const subFile = path.join(dest, 'sample.ass');
  fs.writeFileSync(subFile, `[Script Info]\n[V4+ Styles]\nStyle: Default,adobe arabic,78,&H00FFFFFF\n`);

  const availableFiles = [
    { name: 'adobe-arabic-bold.otf', id: 1 },
    { name: 'unrelated.ttf', id: 2 }
  ];

  let fontCalls = 0;
  const bundled = await cf.tryBundleMatchingFonts(subFile, availableFiles, dest, async (font, fontDest) => {
    fontCalls++;
    fs.writeFileSync(fontDest, 'dummyfont');
  });

  assert.ok(bundled && bundled.endsWith('.zip'), 'returns zip when fonts matched');
  assert.equal(fontCalls, 1, 'downloaded only the 1 matched font');
  assert.ok(fs.existsSync(bundled));

  const zipEntries = new AdmZip(bundled).getEntries().map(e => e.entryName);
  assert.ok(zipEntries.includes('sample.ass'));
  assert.ok(zipEntries.some(e => e.startsWith('Fonts/')));
});
