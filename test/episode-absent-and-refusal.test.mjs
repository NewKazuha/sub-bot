// Regression tests for the two production defects observed on 2026-11-20:
//  A) "[REVIVE] ... Santen Sensou-hen - 08" published ep 07: the Mega folder
//     held 01~07 only and the last-archive fallback substituted ep 07.
//  B) The refused extraction (symlinks in 07.rar) did NOT stop publication —
//     the raw archive was published under the ep-08 title.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {
  chooseArchiveForEpisode,
  selectFolderTargets,
  selectFolderSubtitleBatch,
  downloadMegaFolderRelease,
} from '../src/cloud-folders.mjs';
import { extractArchive, extractSubtitleAndFontsFromAnyFile } from '../src/telegram-client.mjs';

const arc = (name) => ({ name, node: {}, size: 1000, isFolder: false });
const sub = (name) => ({ name, node: {}, size: 1000, isFolder: false });
const arcs01to07 = [1, 2, 3, 4, 5, 6, 7].map(n => arc(`[GRP] Show - 0${n}.rar`));
const subs01to07 = [1, 2, 3, 4, 5, 6, 7].map(n => sub(`[GRP] Show - 0${n}.ass`));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'epabs-'));
}

// --- A1: archive choice -----------------------------------------------------
test('A1: matching archive wins over the last fallback', () => {
  const chosen = chooseArchiveForEpisode(arcs01to07, '7');
  assert.equal(chosen.name, '[GRP] Show - 07.rar');
});

test('A2: absent episode among parseable names throws EPISODE_ABSENT', () => {
  assert.throws(() => chooseArchiveForEpisode(arcs01to07, '8'), (e) => e.code === 'EPISODE_ABSENT');
});

test('A3: non-parsable names keep the legacy last-archive fallback', () => {
  const files = [arc('subs.rar'), arc('fonts.rar')];
  const chosen = chooseArchiveForEpisode(files, '8');
  assert.equal(chosen.name, 'fonts.rar');
});

test('A4: no target episode keeps the legacy last-archive choice', () => {
  assert.equal(chooseArchiveForEpisode(arcs01to07, null).name, '[GRP] Show - 07.rar');
});

// --- A5: subtitle-folder narrowing ------------------------------------------
test('A5: single-episode title narrows to the requested episode', () => {
  const sel = selectFolderTargets(subs01to07, { targetEpisode: '3', batch: false });
  assert.deepEqual(sel.map(f => f.name), ['[GRP] Show - 03.ass']);
});

test('A6: absent episode in a parseable folder throws EPISODE_ABSENT', () => {
  assert.throws(() => selectFolderTargets(subs01to07, { targetEpisode: '8', batch: false }),
    (e) => e.code === 'EPISODE_ABSENT');
});

test('A7: batch title still takes the whole folder', () => {
  const sel = selectFolderTargets(subs01to07, { targetEpisode: '8', batch: true });
  assert.equal(sel.length, 7);
});

test('A8: non-parsable names fall through whole (legacy behavior)', () => {
  const files = [sub('alpha.ass'), sub('beta.ass'), sub('gamma.ass')];
  const sel = selectFolderTargets(files, { targetEpisode: '8', batch: false });
  assert.equal(sel.length, 3);
});

test('A9: explicit episode range absent from parseable folder throws', () => {
  assert.throws(() => selectFolderTargets(subs01to07, { extractedEps: ['9', '10'], batch: true }),
    (e) => e.code === 'EPISODE_ABSENT');
});

test('A10: selectFolderSubtitleBatch forwards batch:false narrowing', () => {
  assert.throws(() => selectFolderSubtitleBatch(subs01to07, { targetEpisode: '8', batch: false }),
    (e) => e.code === 'EPISODE_ABSENT');
  const sel = selectFolderSubtitleBatch(subs01to07, { targetEpisode: '3', batch: false });
  assert.deepEqual(sel.map(f => f.name), ['[GRP] Show - 03.ass']);
});

// --- A11: offline end-to-end Mega folder release -----------------------------
test('A11: Mega folder missing the requested episode defers WITHOUT downloading', async () => {
  const dir = tmpDir();
  let downloads = 0;
  await assert.rejects(
    downloadMegaFolderRelease('https://mega.nz/folder/TEST#key', dir, '8', {
      batch: false,
      listedFiles: arcs01to07,
      downloadNode: async () => { downloads++; throw new Error('must not download'); },
    }),
    (e) => e.code === 'EPISODE_ABSENT'
  );
  assert.equal(downloads, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('A12: Mega folder WITH the requested episode downloads exactly it', async () => {
  const dir = tmpDir();
  const got = [];
  const res = await downloadMegaFolderRelease('https://mega.nz/folder/TEST#key', dir, '7', {
    batch: false,
    listedFiles: arcs01to07,
    downloadNode: async (node, dest) => { got.push(dest); fs.writeFileSync(dest, 'x'); },
  });
  assert.ok(res && res.filePath);
  assert.deepEqual(res.subNames, ['[GRP] Show - 07.rar']);
  assert.equal(got.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- B: refused extraction must never publish --------------------------------
function makeZip(entries) {
  const zip = new AdmZip();
  for (const e of entries) zip.addFile(e.name, Buffer.from(e.content || 'x'));
  const buf = zip.toBuffer();
  // AdmZip normalizes external attrs on write; force the unix mode directly
  // in the central directory (external attrs at offset 38) for symlinks.
  for (const e of entries) {
    if (!e.symlink) continue;
    for (let i = 0; i + 46 <= buf.length; i++) {
      if (buf.readUInt32LE(i) !== 0x02014b50) continue;
      const nameLen = buf.readUInt16LE(i + 28);
      if (buf.toString('utf8', i + 46, i + 46 + nameLen) === e.name) {
        buf.writeUInt32LE(0xA1FF0000, i + 38);
        break;
      }
    }
  }
  return buf;
}

test('B1: extractArchive refuses a zip containing a symlink entry', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'evil.zip');
  // unix mode S_IFLNK (0xA000) in the upper 16 bits of the external attrs
  fs.writeFileSync(p, makeZip([{ name: 'link', symlink: true }, { name: 'sub.ass', content: '[Script Info]\n' }]));
  const out = path.join(dir, 'out');
  assert.equal(extractArchive(p, out), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('B2: extractArchive accepts a clean zip', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'clean.zip');
  fs.writeFileSync(p, makeZip([{ name: 'sub.ass', content: '[Script Info]\nTitle: x\n' }]));
  const out = path.join(dir, 'out');
  assert.equal(extractArchive(p, out), true);
  assert.ok(fs.existsSync(path.join(out, 'sub.ass')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('B3: extractSubtitleAndFontsFromAnyFile returns NULL on a refused archive (never the raw file)', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'evil.zip');
  fs.writeFileSync(p, makeZip([{ name: 'link', symlink: true }, { name: 'sub.ass', content: '[Script Info]\n' }]));
  const res = extractSubtitleAndFontsFromAnyFile(p, dir, false, false, '[GRP] Show - 08');
  assert.equal(res, null);
  fs.rmSync(dir, { recursive: true, force: true });
});