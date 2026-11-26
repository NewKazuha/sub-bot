// Regression tests for the path-traversal write (audit finding #1) and the
// stale downloadedFilePath (finding #9) fixed in src/telegram-client.mjs.
// The helper under test is pure: the only filesystem activity below is the
// mkdtempSync sandbox created in before() and removed in after().
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { resolveSafeSubtitleDestination, safeMoveFile, packFolderToZip } from '../src/telegram-client.mjs';

let workDir;
let nestedWorkDir;

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pathfix-'));
  nestedWorkDir = path.join(workDir, 'nested');
  fs.mkdirSync(nestedWorkDir, { recursive: true });
});

after(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

const inside = (target, base) => path.resolve(target).startsWith(path.resolve(base) + path.sep);

test('plain subtitle name resolves inside the work dir with its original basename', () => {
  const result = resolveSafeSubtitleDestination('https://example.com/subs/Episode.01.ass', workDir, '.ass');
  assert.ok(result);
  assert.ok(inside(result, workDir), `expected inside work dir, got ${result}`);
  assert.equal(path.basename(result), 'Episode.01.ass');
});

test('signed DDL URL uses the resolver-provided subtitle name instead of download.aspx', () => {
  const originalName = '[Celestial Dragons] Steel Ball Run - JoJo no Kimyou na Bouken - 01.ass';
  const result = resolveSafeSubtitleDestination(
    'https://subs.celestial-dragons.com/download.aspx?file=episode.ass&expiry=1&mac=SECRET',
    workDir,
    '.ass',
    originalName,
  );
  assert.ok(result);
  assert.ok(inside(result, workDir));
  assert.equal(path.basename(result), originalName);
});

test('signed DDL fallback keeps a subtitle extension when no original name is available', () => {
  const result = resolveSafeSubtitleDestination(
    'https://subs.celestial-dragons.com/download.aspx?file=episode.ass&expiry=1&mac=SECRET',
    workDir,
    '.ass',
  );
  assert.ok(result);
  assert.ok(inside(result, workDir));
  assert.equal(path.basename(result), 'download.aspx.ass');
});

test('resolver-provided names are reduced to one component and receive the detected extension', () => {
  const result = resolveSafeSubtitleDestination(
    'https://subs.celestial-dragons.com/download.aspx?file=episode&expiry=1&mac=SECRET',
    workDir,
    '.ass',
    '../../outside',
  );
  assert.ok(result);
  assert.ok(inside(result, workDir));
  assert.equal(path.basename(result), 'outside.ass');
});

test('signed subtitle and fonts package contains both the ASS file and font files', () => {
  const packageDir = path.join(workDir, 'signed-package');
  fs.mkdirSync(packageDir, { recursive: true });
  try {
    const originalName = '[Celestial Dragons] Steel Ball Run - JoJo no Kimyou na Bouken - 01.ass';
    const signedUrl = 'https://subs.celestial-dragons.com/download.aspx?file=episode.ass&expiry=1&mac=SECRET';
    const tempSubtitle = path.join(packageDir, 'direct_123');
    fs.writeFileSync(tempSubtitle, '[Script Info]\nDialogue: signed subtitle fixture with enough content\n');

    const properSubtitle = resolveSafeSubtitleDestination(signedUrl, packageDir, '.ass', originalName);
    assert.ok(properSubtitle);
    assert.strictEqual(safeMoveFile(tempSubtitle, properSubtitle), true);

    const fontsDir = path.join(packageDir, 'Fonts');
    fs.mkdirSync(fontsDir);
    fs.writeFileSync(path.join(fontsDir, 'font.ttf'), 'font fixture');

    const zipPath = path.join(packageDir, 'release.zip');
    packFolderToZip(packageDir, zipPath);
    const entries = new AdmZip(zipPath).getEntries().map(entry => entry.entryName);
    assert.ok(entries.includes(originalName), `subtitle missing from ZIP: ${entries.join(', ')}`);
    assert.ok(entries.includes('Fonts/font.ttf'), `font missing from ZIP: ${entries.join(', ')}`);
    assert.ok(!entries.some(entry => entry === 'download.aspx'), 'signed endpoint name must not replace the subtitle');
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

test('query string and fragment are stripped from the URL basename', () => {
  const result = resolveSafeSubtitleDestination(
    'https://example.com/subs/Episode.01.ass?token=abc#fragment', workDir, '.ass'
  );
  assert.ok(result);
  assert.ok(inside(result, workDir));
  assert.equal(path.basename(result), 'Episode.01.ass');
});

test('Unicode names (raw and percent-encoded) resolve inside the work dir', () => {
  const raw = resolveSafeSubtitleDestination('https://example.com/subs/ترجمة_الحلقة.ass', workDir, '.ass');
  assert.ok(raw);
  assert.ok(inside(raw, workDir));
  assert.equal(path.basename(raw), 'ترجمة_الحلقة.ass');

  const encoded = resolveSafeSubtitleDestination(
    'https://example.com/subs/%E5%8B%95%E7%94%BB%20Part%202.srt', workDir, '.srt'
  );
  assert.ok(encoded);
  assert.ok(inside(encoded, workDir));
  assert.equal(path.basename(encoded), '動画 Part 2.srt');
});

test('%20 spaces decode to a single safe filename component', () => {
  const result = resolveSafeSubtitleDestination(
    'https://example.com/subs/My%20Subtitle%20-%2001.ass', workDir, '.ass'
  );
  assert.ok(result);
  assert.ok(inside(result, workDir));
  assert.equal(path.basename(result), 'My Subtitle - 01.ass');
});

test('percent-encoded ../ payload resolves to null or stays inside the work dir', () => {
  const payload = '%2e%2e%2f%2e%2e%2fdata%2fposted.json';
  const result = resolveSafeSubtitleDestination(`https://evil.example/subs/${payload}`, workDir, '.ass');
  if (result !== null) {
    assert.ok(inside(result, workDir), `traversal escaped work dir: ${result}`);
    assert.notEqual(
      path.resolve(result),
      path.resolve(path.join(workDir, '..', 'data', 'posted.json'))
    );
  }
});

test('literal ../ segments in the URL path never leave the work dir', () => {
  const result = resolveSafeSubtitleDestination(
    'https://evil.example/subs/../../data/posted.json', workDir, '.ass'
  );
  if (result !== null) assert.ok(inside(result, workDir), `traversal escaped work dir: ${result}`);
});

test('malformed percent-encoding does not throw and stays inside the work dir', () => {
  const result = resolveSafeSubtitleDestination(
    'https://example.com/subs/100%25%ZZ%GG.ass', workDir, '.ass'
  );
  assert.ok(result);
  assert.ok(inside(result, workDir));
});

test('dot-only basenames fall back to subtitle<ext>', () => {
  for (const url of [
    'https://example.com/subs/%2e%2e',
    'https://example.com/subs/.'
  ]) {
    const result = resolveSafeSubtitleDestination(url, workDir, '.ass');
    assert.ok(result);
    assert.ok(inside(result, workDir));
    assert.equal(path.basename(result), 'subtitle.ass');
  }
});

test('a host-only URL still resolves to a single safe component inside the work dir', () => {
  const result = resolveSafeSubtitleDestination('https://example.com/', workDir, '.ass');
  assert.ok(result);
  assert.ok(inside(result, workDir));
  assert.equal(path.basename(result), path.basename(result).split(/[\\/]/).pop());
});

test('containment is enforced relative to the supplied work dir', () => {
  const result = resolveSafeSubtitleDestination(
    'https://example.com/subs/Episode.01.ass', nestedWorkDir, '.ass'
  );
  assert.ok(result);
  assert.ok(inside(result, nestedWorkDir));
  assert.ok(inside(result, workDir));
});

// The fonts-bundling fix in checkTelegramChannels() now gates packaging on
// `fontsReady = safeMoveFile(...) === true`. That strict comparison depends on
// safeMoveFile returning a literal boolean, so guard the contract here: a
// failed move (missing source) must be exactly false, and a successful move
// exactly true. The surrounding inline branch itself is not unit-testable in
// isolation because it lives inside the network-driven checkTelegramChannels.
test('safeMoveFile returns literal booleans required by the fonts-ready strict check', () => {
  const moveDir = path.join(workDir, 'moves');
  const destDir = path.join(moveDir, 'Fonts');
  fs.mkdirSync(destDir, { recursive: true });

  const missing = path.join(moveDir, 'missing-font.ttf');
  const dest = path.join(destDir, 'font.ttf');
  assert.strictEqual(safeMoveFile(missing, dest), false);
  assert.ok(!fs.existsSync(dest));

  const src = path.join(moveDir, 'font.ttf');
  fs.writeFileSync(src, 'font-bytes');
  assert.strictEqual(safeMoveFile(src, dest), true);
  assert.ok(fs.existsSync(dest));
  assert.ok(!fs.existsSync(src));
});
