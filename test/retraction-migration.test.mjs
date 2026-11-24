import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the module-level POSTED_FILE path: chdir BEFORE importing the src
// module so no test ever touches the repository's data/posted.json.
// node --test runs each test file in its own process.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retraction-migration-'));
process.chdir(tempDir);
fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });

const { loadPostedIds, isReleaseAlreadyPosted } = await import('../src/telegram-client.mjs');
const { RETRACTED_KEYS, RETRACTION_MARKER, RETRACTION_VERSION } = await import('../src/retracted-keys.mjs');
const { mergePostedIds, postedKeyProblem } = await import('../scripts/merge-posted-state.mjs');

const RETRACTED_SAMPLE = 'tg_-1002084152036_11490';
const RETRACTED_TITLE = 'black_clover_2nd_season_08';
const LEGIT_A = 'legit_release_key_a';
const LEGIT_B = 'legit_release_key_b';

function writePosted(arr) {
  fs.writeFileSync(path.join(tempDir, 'data', 'posted.json'), JSON.stringify(arr));
}

test('marker constants are stable and retracted keys are intact', () => {
  assert.equal(RETRACTION_VERSION, 1);
  assert.equal(RETRACTION_MARKER, '__retraction_v1_applied__');
  assert.equal(RETRACTED_KEYS.size, 477);
  assert.ok(RETRACTED_KEYS.has(RETRACTED_SAMPLE));
  assert.ok(RETRACTED_KEYS.has(RETRACTED_TITLE));
  // The marker must survive posted.json validation.
  assert.equal(postedKeyProblem(RETRACTION_MARKER), null);
});

test('(a) absent marker: load filters retracted keys once and adds the marker', () => {
  writePosted([RETRACTED_SAMPLE, RETRACTED_TITLE, LEGIT_A]);
  const loaded = loadPostedIds();
  assert.equal(loaded.has(RETRACTED_SAMPLE), false);
  assert.equal(loaded.has(RETRACTED_TITLE), false);
  assert.equal(loaded.has(LEGIT_A), true);
  assert.equal(loaded.has(RETRACTION_MARKER), true);
  assert.equal(loaded.size, 2);
});

test('(b) present marker: load preserves a formerly-retracted key and keeps the marker', () => {
  writePosted([RETRACTED_SAMPLE, RETRACTED_TITLE, LEGIT_A, RETRACTION_MARKER]);
  const loaded = loadPostedIds();
  assert.equal(loaded.has(RETRACTED_SAMPLE), true);
  assert.equal(loaded.has(RETRACTED_TITLE), true);
  assert.equal(loaded.has(LEGIT_A), true);
  assert.equal(loaded.has(RETRACTION_MARKER), true);
  assert.equal(loaded.size, 4);
});

test('(c) merge with the marker on EITHER side preserves retracted keys and emits exactly one marker', () => {
  // Marker on the local side.
  const localMarked = mergePostedIds(
    [RETRACTED_SAMPLE, LEGIT_A, RETRACTION_MARKER],
    [LEGIT_B],
  );
  assert.equal(localMarked.merged.filter(k => k === RETRACTION_MARKER).length, 1);
  assert.ok(localMarked.merged.includes(RETRACTED_SAMPLE));
  assert.ok(localMarked.merged.includes(LEGIT_A));
  assert.ok(localMarked.merged.includes(LEGIT_B));

  // Marker on the remote side.
  const remoteMarked = mergePostedIds(
    [LEGIT_A],
    [RETRACTED_TITLE, LEGIT_B, RETRACTION_MARKER],
  );
  assert.equal(remoteMarked.merged.filter(k => k === RETRACTION_MARKER).length, 1);
  assert.ok(remoteMarked.merged.includes(RETRACTED_TITLE));

  // Marker on BOTH sides still emits exactly one.
  const bothMarked = mergePostedIds(
    [RETRACTED_SAMPLE, RETRACTION_MARKER],
    [RETRACTED_SAMPLE, RETRACTION_MARKER],
  );
  assert.equal(bothMarked.merged.filter(k => k === RETRACTION_MARKER).length, 1);
  assert.ok(bothMarked.merged.includes(RETRACTED_SAMPLE));

  // Marker on the local side with an ABSENT remote side.
  const remoteAbsent = mergePostedIds(
    [RETRACTED_SAMPLE, RETRACTION_MARKER],
    [],
    { remoteAbsent: true },
  );
  assert.equal(remoteAbsent.merged.filter(k => k === RETRACTION_MARKER).length, 1);
  assert.ok(remoteAbsent.merged.includes(RETRACTED_SAMPLE));
});

test('merge with NO marker on either side filters once and adds the marker', () => {
  const merged = mergePostedIds(
    [RETRACTED_SAMPLE, LEGIT_A],
    [RETRACTED_SAMPLE, LEGIT_B],
  );
  assert.equal(merged.merged.includes(RETRACTED_SAMPLE), false);
  assert.equal(merged.merged.filter(k => k === RETRACTION_MARKER).length, 1);
  assert.ok(merged.merged.includes(LEGIT_A));
  assert.ok(merged.merged.includes(LEGIT_B));
});

test('(d) the marker is a persisted set member but never matches a generated release key', () => {
  writePosted([LEGIT_A, RETRACTION_MARKER]);
  const loaded = loadPostedIds();
  assert.equal(loaded.has(RETRACTION_MARKER), true);
  assert.deepEqual([...loaded], [LEGIT_A, RETRACTION_MARKER]);
  // The marker can never suppress a real release (no generator emits it).
  assert.equal(isReleaseAlreadyPosted(new Set([RETRACTION_MARKER]), ['any_real_key']), false);

  // The merge still emits exactly one marker when both sides carry it.
  const merged = mergePostedIds([LEGIT_A, RETRACTION_MARKER], [LEGIT_B, RETRACTION_MARKER]);
  assert.equal(merged.merged.filter(k => k === RETRACTION_MARKER).length, 1);
  assert.equal(merged.merged.includes(LEGIT_A), true);
  assert.equal(merged.merged.includes(LEGIT_B), true);
});

test('fresh install (missing file) records the migration marker', () => {
  fs.rmSync(path.join(tempDir, 'data', 'posted.json'), { force: true });
  const loaded = loadPostedIds();
  assert.deepEqual([...loaded], [RETRACTION_MARKER]);
});
