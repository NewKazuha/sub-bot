// Broken-emoji remnants must never reach captions, file names, or dedup keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeBrokenChars, formatCleanTitle, formatCleanCaption,
  getSafeTelegramFileName, extractTeamAndFormatTitle,
} from '../src/telegram-client.mjs';

const BROKEN = '\uFFFD\u200D\u{1F525}'; //  + ZWJ + 🔥 (the santen-08 incident)

test('S1: replacement char + orphaned ZWJ are stripped, fire emoji kept', () => {
  assert.equal(sanitizeBrokenChars(`${BROKEN} - Tokyo Revengers - 08`), '🔥 - Tokyo Revengers - 08');
});

test('S2: valid ZWJ emoji sequences are preserved', () => {
  assert.equal(sanitizeBrokenChars('❤️‍🔥 release'), '❤️‍🔥 release');
  assert.equal(sanitizeBrokenChars('👨‍👩‍👧 family'), '👨‍👩‍👧 family');
});

test('S3: plain Arabic/English titles unchanged', () => {
  assert.equal(sanitizeBrokenChars('[ReDEJA] Horemajo - 07 [1080p]'), '[ReDEJA] Horemajo - 07 [1080p]');
  assert.equal(sanitizeBrokenChars('ترجمة الحلقة السابعة'), 'ترجمة الحلقة السابعة');
});

test('S4: multiple replacement chars and edge selectors removed', () => {
  assert.equal(sanitizeBrokenChars('\uFFFD\uFFFDhello\uFE0F'), 'hello');
  assert.equal(sanitizeBrokenChars('abc\u200Ddef'), 'abcdef');
});

test('S5: formatCleanTitle sanitizes (dedup keys + logs path)', () => {
  assert.equal(formatCleanTitle(`📍 ${BROKEN} - Show - 08`), '🔥 - Show - 08');
});

test('S6: formatCleanCaption sanitizes (publish path)', () => {
  const cap = formatCleanCaption(`[REVIVE] ${BROKEN} - Tokyo Revengers - Santen Sensou-hen - 08 [1080p]`, true, false);
  assert.ok(!cap.includes('\uFFFD'), 'no replacement char in caption');
  assert.ok(!cap.includes('\u200D'), 'no orphaned ZWJ in caption');
  assert.ok(cap.includes('🔥'));
  assert.ok(cap.includes('[+Fonts]'));
});

test('S7: getSafeTelegramFileName sanitizes (document name path)', () => {
  const fn = getSafeTelegramFileName(`[REVIVE] ${BROKEN} - Show - 08`, '.zip');
  assert.ok(!fn.includes('\uFFFD') && !fn.includes('\u200D'));
  assert.ok(fn.endsWith('.zip'));
});

test('S8: extractTeamAndFormatTitle sanitizes the intake first line', () => {
  const t = extractTeamAndFormatTitle(`[REVIVE] ${BROKEN} - Tokyo Revengers - Santen Sensou-hen - 08 [1080p]\nhttps://revivesubs.com/anime/mal/59088\nBy Revive Subs`);
  assert.ok(!t.includes('\uFFFD') && !t.includes('\u200D'));
  assert.ok(t.includes('🔥'));
});