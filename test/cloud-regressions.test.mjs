// Regressions for the cloud-folder audit (batch wiring, season-range parsing,
// MKV fallthrough). Everything is injected/offline: no network, no data/ writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cf from '../src/cloud-folders.mjs';

const DRIVE_FOLDER = 'https://drive.google.com/drive/folders/drivefolderid1234567890';
const MF_FOLDER = 'https://www.mediafire.com/folder/folderkey123';

// A fetch stub that turns any accidental network access into a hard failure.
function withNoNetwork(fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network is disabled in this test'); };
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = original; });
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Fix A — the Drive download path must forward `batch` to selectFolderTargets.
// ---------------------------------------------------------------------------

test('R1 — Drive batch:false narrows a multi-episode folder to the requested episode', async () => {
  const dir = tmpDir('cloud-reg-drive-batch-');
  const listed = Array.from({ length: 5 }, (_, i) => ({
    name: `Show - ${String(i + 1).padStart(2, '0')}.ass`,
    id: `drive-sub-${i + 1}`,
    isFolder: false,
  }));
  const downloaded = [];

  try {
    const release = await cf.downloadDriveFolderRelease(
      DRIVE_FOLDER,
      dir,
      '3',
      null,
      'Show - 03',
      {
        listedFiles: listed,
        batch: false,
        downloadFile: async (id, destPath) => {
          downloaded.push(id);
          fs.writeFileSync(destPath, 'fake subtitle');
          return true;
        },
      }
    );

    assert.ok(release, 'a release is produced from the injected listing');
    assert.equal(release.type, 'subtitle', 'one episode must not be packed as a whole-folder batch');
    assert.deepEqual(release.subNames, ['Show - 03.ass']);
    assert.deepEqual(downloaded, ['drive-sub-3'], 'only the requested episode is downloaded');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fix B — "S2 - 05" is a season plus episode 5, not the range 2..5.
// ---------------------------------------------------------------------------

test('R2 — the season head of "S2 - 05" is not expanded into a range', () => {
  assert.deepEqual(cf.extractEpisodesFromText('S2 - 05.mkv'), ['5'], 'the single number survives');
  assert.equal(cf.matchesEpisode('S2 - 05.mkv', '3'), false, 'episode 3 is NOT in this filename');
  assert.equal(cf.matchesEpisode('S2 - 05.mkv', '5'), true, 'episode 5 IS in this filename');
});

test('R2b — spelled-out season numbers are not ranges, in either parser', () => {
  for (const name of ['Season 2 - 05.mkv', 'Season2 - 05.mkv']) {
    assert.deepEqual(cf.extractEpisodesFromText(name), ['5'], `${name}: only the episode survives`);
    assert.equal(cf.matchesEpisode(name, '3'), false, `${name}: episode 3 is absent`);
    assert.equal(cf.matchesEpisode(name, '5'), true, `${name}: episode 5 is present`);
  }
  // The batch-title parser must agree with the filename parser.
  assert.deepEqual(cf.extractExplicitEpisodeRange('Season 2 - 05'), [], 'spelled-out season is not a batch range');
  assert.deepEqual(cf.extractExplicitEpisodeRange('Season2 - 05'), [], 'compact spelled-out season is not a batch range');

  // Legitimate ranges are untouched by the season guard.
  const oneToTwelve = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
  assert.deepEqual(cf.extractEpisodesFromText('01-12.ass'), oneToTwelve);
  assert.deepEqual(cf.extractExplicitEpisodeRange('01-12'), oneToTwelve);
  assert.deepEqual(cf.extractEpisodesFromText('E01 - E12.ass'), ['1', '12'], 'E01 - E12 stays as two endpoints');
});

// ---------------------------------------------------------------------------
// Fix C — an EPISODE_ABSENT subtitle branch must fall through to the MKV
// branch of findBestFileInMediafire / findBestFileInDrive.
// ---------------------------------------------------------------------------

test('R3 — Mediafire: a matching MKV wins over a different-episode subtitle', async () => {
  const listed = [
    { name: 'Show - 03.ass', size: 1024, quickkey: 'sub3', directUrl: 'https://www.mediafire.com/file/sub3/Show%20-%2003.ass/file' },
    { name: 'Show - 05 [1080p].mkv', size: 5_000_000, quickkey: 'mkv5', directUrl: 'https://www.mediafire.com/file/mkv5/Show%20-%2005.mkv/file' },
  ];

  await withNoNetwork(async () => {
    const best = await cf.findBestFileInMediafire(MF_FOLDER, '5', [], listed);
    assert.ok(best, 'a release is returned instead of throwing EPISODE_ABSENT');
    assert.equal(best.type, 'mkv');
    assert.equal(best.name, 'Show - 05 [1080p].mkv');
  });
});

test('R4 — Drive: a matching MKV wins over a different-episode subtitle', async () => {
  const listed = [
    { name: 'Show - 03.ass', id: 'sub3', isFolder: false },
    { name: 'Show - 05 [1080p].mkv', id: 'mkv5', isFolder: false },
  ];

  await withNoNetwork(async () => {
    const best = await cf.findBestFileInDrive(DRIVE_FOLDER, '5', [], listed);
    assert.ok(best, 'a release is returned instead of throwing EPISODE_ABSENT');
    assert.equal(best.type, 'mkv');
    assert.equal(best.name, 'Show - 05 [1080p].mkv');
    assert.ok(best.directUrl.includes('mkv5'), 'the direct URL belongs to the MKV');
  });
});

// ---------------------------------------------------------------------------
// Fix C — the defer invariant: when BOTH branches lack the requested episode
// (in a parseable folder), EPISODE_ABSENT is still re-thrown — no substitute.
// ---------------------------------------------------------------------------

test('R5 — both providers defer when neither the subtitle nor the MKV matches', async () => {
  const mfListed = [
    { name: 'Show - 03.ass', size: 1024, quickkey: 'sub3', directUrl: 'https://www.mediafire.com/file/sub3/x.ass/file' },
    { name: 'Show - 07 [1080p].mkv', size: 5_000_000, quickkey: 'mkv7', directUrl: 'https://www.mediafire.com/file/mkv7/x.mkv/file' },
  ];
  const driveListed = [
    { name: 'Show - 03.ass', id: 'sub3', isFolder: false },
    { name: 'Show - 07 [1080p].mkv', id: 'mkv7', isFolder: false },
  ];

  await withNoNetwork(async () => {
    await assert.rejects(
      cf.findBestFileInMediafire(MF_FOLDER, '5', [], mfListed),
      (e) => e.code === 'EPISODE_ABSENT',
      'Mediafire defers instead of substituting episode 7'
    );
    await assert.rejects(
      cf.findBestFileInDrive(DRIVE_FOLDER, '5', [], driveListed),
      (e) => e.code === 'EPISODE_ABSENT',
      'Drive defers instead of substituting episode 7'
    );
  });
});

// ---------------------------------------------------------------------------
// Fix C — downloadDriveFolderRelease now has its own MKV branch, using the
// injected sink and the 4 GiB non-subtitle byte ceiling.
// ---------------------------------------------------------------------------

test('R6 — Drive download falls through to the matching MKV with the video cap', async () => {
  const dir = tmpDir('cloud-reg-drive-mkv-');
  const listed = [
    { name: 'Show - 03.ass', id: 'sub3', isFolder: false },
    { name: 'Show - 05 [1080p].mkv', id: 'mkv5', isFolder: false },
  ];
  const downloaded = [];
  let maxBytes = null;

  try {
    const release = await cf.downloadDriveFolderRelease(
      DRIVE_FOLDER,
      dir,
      '5',
      null,
      'Show - 05',
      {
        listedFiles: listed,
        batch: false,
        downloadFile: async (id, destPath, fileName, opts) => {
          downloaded.push(id);
          maxBytes = opts && opts.maxBytes;
          fs.writeFileSync(destPath, 'fake video');
          return true;
        },
      }
    );

    assert.ok(release, 'the MKV branch produces a release');
    assert.equal(release.type, 'mkv');
    assert.deepEqual(release.subNames, ['Show - 05 [1080p].mkv']);
    assert.deepEqual(downloaded, ['mkv5'], 'only the matching MKV is downloaded');
    assert.equal(maxBytes, cf.CLOUD_CAP_LIMITS.CLOUD_FILE_MAX_BYTES, 'the video carries the 4 GiB ceiling');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
