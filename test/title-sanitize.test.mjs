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

test('S5: formatCleanTitle strips leading emojis and symbols', () => {
  assert.equal(formatCleanTitle(`📍 ${BROKEN} - Show - 08`), 'Show - 08');
  assert.equal(formatCleanTitle('✦ The World Is Dancing · 09 ~ 13'), 'The World Is Dancing - 09 ~ 13');
  assert.equal(formatCleanTitle('🐦‍🔥 - Tokyo Revengers - Santen Sensou-hen - 08 [1080p]'), 'Tokyo Revengers - Santen Sensou-hen - 08 [1080p]');
  assert.equal(formatCleanTitle('🎬 Ansatsu Kyoushitsu Movie || Minna no Jikan'), 'Ansatsu Kyoushitsu Movie || Minna no Jikan');
  assert.equal(formatCleanTitle('📌 الحلقة 7 من أنمي Toaru Anbu no ITEM مترجمة'), 'الحلقة 7 من أنمي Toaru Anbu no ITEM مترجمة');
});

test('S6: formatCleanCaption sanitizes and strips emojis (publish path)', () => {
  const cap = formatCleanCaption(`[REVIVE] ${BROKEN} - Tokyo Revengers - Santen Sensou-hen - 08 [1080p]`, true, false);
  assert.ok(!cap.includes('\uFFFD'), 'no replacement char in caption');
  assert.ok(!cap.includes('\u200D'), 'no orphaned ZWJ in caption');
  assert.ok(!cap.includes('🔥'), 'no emoji in caption');
  assert.equal(cap, '[REVIVE] Tokyo Revengers - Santen Sensou-hen - 08 [1080p] [+Fonts]');
});

test('S7: getSafeTelegramFileName sanitizes and strips emojis and symbols (document name path)', () => {
  const fn = getSafeTelegramFileName(`[REVIVE] ${BROKEN} - Show - 08`, '.zip');
  assert.ok(!fn.includes('\uFFFD') && !fn.includes('\u200D') && !fn.includes('🔥'));
  assert.equal(fn, '[REVIVE] Show - 08.zip');
  const fn2 = getSafeTelegramFileName('[Bruuhim] ✦ The World Is Dancing · 09 ~ 13', '.zip');
  assert.equal(fn2, '[Bruuhim] The World Is Dancing - 09 ~ 13.zip');
});

test('S8: extractTeamAndFormatTitle sanitizes the intake first line', () => {
  const t = extractTeamAndFormatTitle(`[REVIVE] ${BROKEN} - Tokyo Revengers - Santen Sensou-hen - 08 [1080p]\nhttps://revivesubs.com/anime/mal/59088\nBy Revive Subs`);
  assert.ok(!t.includes('\uFFFD') && !t.includes('\u200D') && !t.includes('🔥'));
  assert.equal(t, '[REVIVE] Tokyo Revengers - Santen Sensou-hen - 08 [1080p]');
  const t2 = extractTeamAndFormatTitle(`✦ The World Is Dancing · 09 ~ 13\nhttps://bruuhim-subs.pages.dev/episode/the-world-is-dancing-09x13/\nBy @bruuhim`);
  assert.equal(t2, '[Bruuhim] The World Is Dancing - 09 ~ 13');
});