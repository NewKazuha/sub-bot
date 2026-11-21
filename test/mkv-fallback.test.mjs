// MKV fallback: when the requested episode has no subtitle/archive in the
// cloud folder yet, the softsub MKV of THAT episode is used (Arabic subs +
// fonts are extracted downstream). Never a different episode's MKV.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadMegaFolderRelease } from '../src/cloud-folders.mjs';

const sub = (n) => ({ name: `[GRP] Show - 0${n}.ass`, node: { id: n }, size: 1000, isFolder: false });
const arc = (n) => ({ name: `[GRP] Show - 0${n}.rar`, node: { id: n }, size: 1000, isFolder: false });
const mkv = (n) => ({ name: `[GRP] Show - 0${n} [1080p].mkv`, node: { id: 100 + n }, size: 5_000_000, isFolder: false });
const range = (f, a, b) => Array.from({ length: b - a + 1 }, (_, i) => f(a + i));

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mkvfb-')); }
function stubSink(log) {
  return async (node, dest) => { log.push(dest); fs.writeFileSync(dest, 'x'); };
}

test('M1: subs 01~07 + MKV 08, target 8 → the MKV 08 is downloaded', async () => {
  const dir = tmpDir(); const log = [];
  const res = await downloadMegaFolderRelease('https://mega.nz/folder/T#k', dir, '8', {
    batch: false, listedFiles: [...range(sub, 1, 7), mkv(8)], downloadNode: stubSink(log),
  });
  assert.equal(res.type, 'mkv');
  assert.deepEqual(res.subNames, ['[GRP] Show - 08 [1080p].mkv']);
  assert.equal(log.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('M2 (santen shape): archives 01~07 + MKV 08, target 8 → MKV 08', async () => {
  const dir = tmpDir(); const log = [];
  const res = await downloadMegaFolderRelease('https://mega.nz/folder/T#k', dir, '8', {
    batch: false, listedFiles: [...range(arc, 1, 7), mkv(8)], downloadNode: stubSink(log),
  });
  assert.equal(res.type, 'mkv');
  assert.deepEqual(res.subNames, ['[GRP] Show - 08 [1080p].mkv']);
  assert.equal(log.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('M3: subs 01~07 + MKVs 01~07, target 8 → EPISODE_ABSENT, nothing downloaded', async () => {
  const dir = tmpDir(); const log = [];
  await assert.rejects(
    downloadMegaFolderRelease('https://mega.nz/folder/T#k', dir, '8', {
      batch: false, listedFiles: [...range(sub, 1, 7), ...range(mkv, 1, 7)], downloadNode: stubSink(log),
    }),
    (e) => e.code === 'EPISODE_ABSENT'
  );
  assert.equal(log.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('M4: MKVs 01~07 only, target 8 → EPISODE_ABSENT (no MKV substitution)', async () => {
  const dir = tmpDir(); const log = [];
  await assert.rejects(
    downloadMegaFolderRelease('https://mega.nz/folder/T#k', dir, '8', {
      batch: false, listedFiles: range(mkv, 1, 7), downloadNode: stubSink(log),
    }),
    (e) => e.code === 'EPISODE_ABSENT'
  );
  assert.equal(log.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('M5: MKV 08 only, target 8 → downloaded (pre-existing path unchanged)', async () => {
  const dir = tmpDir(); const log = [];
  const res = await downloadMegaFolderRelease('https://mega.nz/folder/T#k', dir, '8', {
    batch: false, listedFiles: [mkv(8)], downloadNode: stubSink(log),
  });
  assert.equal(res.type, 'mkv');
  assert.equal(log.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('M6: subs 01~07 + MKV 08, target 7 → the SUBTITLE 07 wins (no video needed)', async () => {
  const dir = tmpDir(); const log = [];
  const res = await downloadMegaFolderRelease('https://mega.nz/folder/T#k', dir, '7', {
    batch: false, listedFiles: [...range(sub, 1, 7), mkv(8)], downloadNode: stubSink(log),
  });
  assert.equal(res.type, 'subtitle');
  assert.deepEqual(res.subNames, ['[GRP] Show - 07.ass']);
  fs.rmSync(dir, { recursive: true, force: true });
});