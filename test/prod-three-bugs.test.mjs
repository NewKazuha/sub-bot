import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolation: temp cwd BEFORE importing src modules so data/posted.json and
// data/title-map.json in the repo are never touched by these tests.
// node --test runs each test file in its own process.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-bugs-test-'));
process.chdir(tempDir);

const tc = await import('../src/telegram-client.mjs');
const rec = await import('../src/recovery.mjs');
const {
  getReleaseKeys,
  getFansubReleaseKeys,
  isReleaseAlreadyPosted,
  isReleaseAlreadyPostedOrDispatched,
  markReleaseAsPosted,
  isTempDownloadName,
  cleanEnglishTitleFromFilename,
  publishDocument,
  seasonOfReleaseTitle,
  qualifyKeysBySeason,
  computeReleaseKeySet,
  gateReleaseBeforePublish,
  parseEraiMessage,
  validateTorrentUrl,
} = tc;

const S1_KEY = 'official_ep_7_kikansha_no_mahou_wa';
const KIKANSHA_S2 = '[Erai-Raws] Kikansha no Mahou wa Tokubetsu desu 2nd Season - 07';

// ---------------------------------------------------------------------------
// Regression guards (these PASS before the fix — they must keep passing).
// ---------------------------------------------------------------------------

test('REGRESSION GUARD: S01E03 and "- 03" still dedup (passes pre-fix)', () => {
  const a = getReleaseKeys('[Crunchyroll] Show S01E03', true, null);
  const b = getReleaseKeys('[Crunchyroll] Show - 03', true, null);
  assert.ok(isReleaseAlreadyPosted(new Set(b), a), 'S01E03 must still be suppressed by "- 03"');
});

test('REGRESSION GUARD: Chitose sequel-overflow pair still intersects (passes pre-fix)', () => {
  const resolved = {
    romaji: 'Chitose-kun wa Ramune Bin no Naka',
    english: 'Chitose Is in the Ramune Bottle',
    episodes: 13,
    sequel: {
      id: 1, episodes: 11,
      romaji: 'Chitose-kun wa Ramune Bin no Naka Part 2',
      english: 'Chitose Is in the Ramune Bottle 2nd Cour',
    },
  };
  const a = getReleaseKeys('[Crunchyroll] Chitose-kun wa Ramune Bin no Naka Part 2 - 02', true, resolved);
  const b = getReleaseKeys('[Crunchyroll] Chitose Is In The Ramune Bottle S01E15 CR WEB-DL Arabic AR', false, resolved);
  assert.ok(a.some(k => b.includes(k)), 'sequel-overflow keys must still intersect');
});

test('REGRESSION GUARD: season-2 candidate with NO qualified keys falls back to today\'s guard (passes pre-fix)', () => {
  const posted = new Set(['plain_ep_2']);
  // No key carries a season marker, so the additive guard leaves the list
  // unchanged and the ordinary dedup decision applies.
  assert.equal(isReleaseAlreadyPostedOrDispatched(posted, ['plain_ep_2'], { season: 2 }), true);
});

// ---------------------------------------------------------------------------
// BUG A — season-isolated dedup.
// ---------------------------------------------------------------------------

test('BUG A: S2 07 publishes despite the S1 key, then suppresses after storing the qualified key', () => {
  const posted = new Set([S1_KEY]);
  const p = computeReleaseKeySet(KIKANSHA_S2, { isOfficial: true, resolved: null });
  assert.equal(p.season, 2);
  assert.equal(isReleaseAlreadyPostedOrDispatched(posted, p.keys, { season: p.season }), false,
    'the season-1 official key must not suppress season-2 episode 07');

  markReleaseAsPosted(posted, 'tg_erai_1', p.keys);
  assert.ok([...posted].some(k => /2nd_season_07/.test(k)), 'the season-qualified key must be stored');

  const again = computeReleaseKeySet(KIKANSHA_S2, { isOfficial: true, resolved: null });
  assert.equal(isReleaseAlreadyPostedOrDispatched(posted, again.keys, { season: again.season }), true,
    'a re-arrival must be suppressed by the stored season-qualified key');
});

test('BUG A: S02E03 does not collide with "- 03"', () => {
  const posted = new Set(getReleaseKeys('[Crunchyroll] Show - 03', true, null));
  const p = computeReleaseKeySet('[Crunchyroll] Show S02E03', { isOfficial: true, resolved: null });
  assert.equal(p.season, 2);
  assert.equal(isReleaseAlreadyPostedOrDispatched(posted, p.keys, { season: p.season }), false,
    'season-2 episode 03 must not be suppressed by an unmarked episode 03');
});

test('BUG A: dispatch-ledger key does not cross seasons (season:2 no hit, season:null hit)', () => {
  const posted = new Set([`dispatched:${S1_KEY}`]);
  const p = computeReleaseKeySet(KIKANSHA_S2, { isOfficial: true, resolved: null });
  assert.equal(isReleaseAlreadyPostedOrDispatched(posted, p.keys, { season: p.season }), false,
    'the dispatch-ledger half must be season-qualified too');
  assert.equal(isReleaseAlreadyPostedOrDispatched(posted, p.keys, { season: null }), true,
    'with no season the legacy guard must still hit');
});

test('BUG A: ASCII "Season II" derives season 2; multi-digit seasons have no 2..9 clamp', () => {
  assert.equal(seasonOfReleaseTitle('Bleach Season II - 03'), 2);
  assert.equal(seasonOfReleaseTitle('Some Show 3rd Season - 01'), 3);
  assert.equal(seasonOfReleaseTitle('Some Show Season 10 - 01'), 10);
  assert.equal(seasonOfReleaseTitle('Some Show Season 12 - 01'), 12);
  assert.equal(seasonOfReleaseTitle('Some Show S01E03'), null, 'season 1 keeps today\'s behaviour');
});

// ---------------------------------------------------------------------------
// BUG B — two-phase dedup + fansub union.
// ---------------------------------------------------------------------------

test('BUG B: Arabic-then-English fansub arrivals intersect and publish once', () => {
  const posted = new Set();
  const resolved = { romaji: 'Jujutsu Kaisen S3', english: 'Jujutsu Kaisen S3' };
  const arabic = '[Stellar Saber] جوجوتسو كايزن - 03';
  const english = '[Stellar Saber] Jujutsu Kaisen S3 - 03';

  const p1 = computeReleaseKeySet(arabic, { isOfficial: false, resolved });
  const g1 = gateReleaseBeforePublish(posted, 'tg_stellar_1', p1, {
    effectiveTitle: english, resolved, isOfficial: false,
  });
  assert.equal(g1.proceed, true, 'first arrival must publish');
  markReleaseAsPosted(posted, 'tg_stellar_1', g1.mergedKeys);

  const p2 = computeReleaseKeySet(english, { isOfficial: false, resolved });
  assert.equal(isReleaseAlreadyPostedOrDispatched(posted, p2.keys, { season: p2.season }), true,
    'the English re-arrival must be suppressed by the union stored on the Arabic arrival');
});

test('BUG B: two-phase gate skips a known duplicate without reaching publish', () => {
  const english = '[Stellar Saber] Jujutsu Kaisen S3 - 03';
  const posted = new Set(getFansubReleaseKeys(english, null));
  const p1 = computeReleaseKeySet(english, { isOfficial: false, resolved: null });
  assert.equal(isReleaseAlreadyPostedOrDispatched(posted, p1.keys, { season: p1.season }), true,
    'phase 1 already rejects a known duplicate — no download/publish happens');
  const g = gateReleaseBeforePublish(posted, 'tg_stellar_2', p1, {
    effectiveTitle: english, resolved: null, isOfficial: false,
  });
  assert.equal(g.proceed, false);
});

test('BUG B: fansub union emits no fansub_unknown_* keys', () => {
  const resolved = { romaji: 'Jujutsu Kaisen S3', english: 'Jujutsu Kaisen S3' };
  const { keys } = computeReleaseKeySet('[Stellar Saber] جوجوتسو كايزن - 03', {
    isOfficial: false, resolved,
  });
  assert.ok(keys.length > 0);
  assert.equal(keys.some(k => k.startsWith('fansub_unknown_')), false,
    'resolved dictionary names must carry the raw title\'s [team]');
});

test('BUG B: phase-2 hit also marks the linked poster message', () => {
  const english = '[Stellar Saber] Jujutsu Kaisen S3 - 03';
  const englishKey = getFansubReleaseKeys(english, null)[0];
  const posted = new Set([englishKey]);
  const arabic = '[Stellar Saber] جوجوتسو كايزن - 03';
  const p1 = computeReleaseKeySet(arabic, { isOfficial: false, resolved: null });
  const linked = 'tg_999_55';
  const gate = gateReleaseBeforePublish(posted, 'tg_999_54', p1, {
    effectiveTitle: english, resolved: null, isOfficial: false, linkedMsgKey: linked,
  });
  assert.equal(gate.proceed, false, 'phase 2 must catch the English effective-title key');
  assert.ok(posted.has(linked), 'the linked poster message must be marked on a phase-2 hit');
});

// ---------------------------------------------------------------------------
// BUG C — temporary downloader names are never titles.
// ---------------------------------------------------------------------------

test('BUG C: temp download names are rejected; a legitimate "Direct 10" is not', () => {
  const temps = [
    'direct_1795059597549',
    'direct_1795059597549_10',
    'buzz_1795059597549',
    'font_1795059597549',
    'ep_12',
    'cloud_file_1234',
    'direct 1795059597549 - 10',
  ];
  for (const name of temps) {
    assert.equal(isTempDownloadName(name), true, `must reject ${name}`);
    assert.equal(cleanEnglishTitleFromFilename(`${name}.ass`), null, `title cleaner must reject ${name}`);
  }
  assert.equal(isTempDownloadName('Direct 10'), false);
  assert.equal(isTempDownloadName('Ep 12'), false);
  assert.notEqual(cleanEnglishTitleFromFilename('Direct 10.ass'), null, 'a legitimate title survives');
  assert.equal(cleanEnglishTitleFromFilename('[Stellar Saber] direct 1795059597549 - 10.ass'), null,
    'a temp token behind a [team] bracket is rejected too');
});

test('BUG C: publishDocument refuses a temp-derived caption/file at entry', async () => {
  const result = await publishDocument(
    null,
    path.join(tempDir, 'direct_1795059597549.ass'),
    '[Stellar Saber] direct 1795059597549 - 10',
  );
  assert.equal(result.ok, false);
  assert.match(result.description, /Temporary download name refused/);
});

// ---------------------------------------------------------------------------
// Recovery — synthetic Erai-style message (synthetic only; no live replay).
// ---------------------------------------------------------------------------

test('RECOVERY: synthetic Kikansha S2 07 parses and publishes exactly once', () => {
  const spec = JSON.stringify({
    tasks: [{
      kind: 'synthetic',
      chatId: '2084152036', // pinned to the Erai-Raws channel
      title: 'Kikansha no Mahou wa Tokubetsu desu 2nd Season - 07',
      postUrl: 'https://erai-raws.blogspot.com/2026/11/kikansha-2nd-07.torrent',
    }],
  });
  const { tasks } = rec.parseRecoverySpec(spec);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].chatId, '2084152036');

  const msg = rec.syntheticMessage(tasks[0]);
  const parsed = parseEraiMessage(msg);
  assert.equal(parsed.title, 'Kikansha no Mahou wa Tokubetsu desu 2nd Season - 07');
  assert.equal(parsed.hasArabic, true);
  assert.match(parsed.torrentUrl, /\.torrent$/);

  const formatted = `[${parsed.sourceName}] ${parsed.title}`;
  const posted = new Set([S1_KEY]); // the S1 key that caused the original bug
  const p = computeReleaseKeySet(formatted, { isOfficial: true, resolved: null });
  const gate = gateReleaseBeforePublish(posted, `tg_2084152036_${msg.id}`, p, {
    effectiveTitle: formatted, resolved: null, isOfficial: true,
  });
  assert.equal(gate.proceed, true, 'the recovered S2 07 must publish despite the S1 key');
  markReleaseAsPosted(posted, `tg_2084152036_${msg.id}`, gate.mergedKeys); // exactly one post
  assert.ok([...posted].some(k => /2nd_season_07/.test(k)), 'the stored key must be season-qualified');

  const again = computeReleaseKeySet(formatted, { isOfficial: true, resolved: null });
  assert.equal(isReleaseAlreadyPostedOrDispatched(posted, again.keys, { season: again.season }), true,
    'a subsequent normal re-arrival must be suppressed');
});

// ---------------------------------------------------------------------------
// SECURITY PASS — S1..S4 (offline; no network, no data/** access)
// ---------------------------------------------------------------------------

test('SEC T1: validateTorrentUrl rejects http/userinfo/IP literals; recovery uses real siteHosts()', () => {
  const rejects = [
    'http://host/x.torrent',
    'https://user:pass@host/x.torrent',
    'https://127.0.0.1/x.torrent',
    'https://169.254.169.254/x.torrent',
    'https://[::1]/x.torrent',
    'https://10.1.2.3/x.torrent',
    'https://192.168.1.1/x.torrent',
    'https://example.com./x.torrent',
    'https://xn--bcher-kva.example/x.torrent',
    'https://2130706433/x.torrent', // normalises to 127.0.0.1
  ];
  for (const u of rejects) {
    assert.throws(() => validateTorrentUrl(u), undefined, `must reject ${u}`);
  }
  assert.equal(validateTorrentUrl('https://example.com/x.torrent'), 'example.com');

  // Recovery mode uses the REAL allowlist from src/recovery.mjs (siteHosts()).
  const allowed = [...rec.siteHosts()];
  assert.ok(allowed.length > 0, 'siteHosts() must expose real configured hosts');
  assert.throws(() => validateTorrentUrl('https://evil.example.net/x.torrent', { recovery: true }),
    undefined, 'a non-allowlisted host must be refused in recovery mode');
  const allowHost = allowed.find(h => h === 'rhythm-sub.com') || allowed.find(h => !h.includes('blogspot')) || allowed[0];
  assert.equal(validateTorrentUrl(`https://sub.${allowHost}/x.torrent`, { recovery: true }), `sub.${allowHost}`);
  assert.equal(validateTorrentUrl(`https://${allowHost}/x.torrent`, { recovery: true }), allowHost);
  assert.equal(validateTorrentUrl('https://nyaa.si/download/123.torrent', { recovery: true }), 'nyaa.si');
  assert.equal(validateTorrentUrl('https://www.erai-raws.info/123.torrent', { recovery: true }), 'www.erai-raws.info');
});

test('SEC T2: isTempDownloadName normalises / strips compound extensions and still refuses false positives', () => {
  const temps = [
    'direct_1795059597549_10',
    'direct_1795059597549.tar.gz',
    '\u200Bdirect_1795059597549',
    'buzz_1791171461820',
    'font_1791171461820',
    'ep_3',
    'cloud_file_1791171461820',
    'cloud_file_1234', // legacy short form — existing regression fixture
  ];
  for (const name of temps) {
    assert.equal(isTempDownloadName(name), true, `must reject ${JSON.stringify(name)}`);
  }
  for (const legit of ['Ep 12', 'Direct 10', 'directive_10', 'direct-12345']) {
    assert.equal(isTempDownloadName(legit), false, `must NOT reject ${legit}`);
  }
});

test('SEC T3: synthetic Erai https .torrent parses; http-only body yields no torrent URL', () => {
  const httpsBody = 'Title: Kikansha no Mahou wa Tokubetsu desu 2nd Season - 07\n'
    + 'Source: Erai-Raws\nSubtitles: Arabic\n'
    + 'https://erai-raws.blogspot.com/2026/11/kikansha-2nd-07.torrent';
  const parsedHttps = parseEraiMessage({ message: httpsBody });
  assert.ok(parsedHttps);
  assert.equal(parsedHttps.torrentUrl,
    'https://erai-raws.blogspot.com/2026/11/kikansha-2nd-07.torrent');

  const httpBody = 'Title: Kikansha no Mahou wa Tokubetsu desu 2nd Season - 07\n'
    + 'Source: Erai-Raws\nSubtitles: Arabic\n'
    + 'http://erai-raws.blogspot.com/2026/11/x.torrent';
  const parsedHttp = parseEraiMessage({ message: httpBody });
  assert.ok(parsedHttp);
  assert.ok(!parsedHttp.torrentUrl,
    'http torrent URL must never be returned — it must never reach the download sink');

  // A private-IP https URL in a synthetic body is likewise refused.
  const privateBody = 'Title: Test Show - 07\nSource: Erai-Raws\nSubtitles: Arabic\n'
    + 'https://169.254.169.254/latest/x.torrent';
  assert.ok(!parseEraiMessage({ message: privateBody }).torrentUrl);
});

test('SEC T4: pending ledger records synthetic negative ids (MSG_KEY_RE accepts -?<id>)', () => {
  const posted = new Set();
  // recordPendingAttempt is exported from src/recovery.mjs and applies MSG_KEY_RE.
  assert.equal(rec.recordPendingAttempt(posted, 'tg_-100123_-42'), true,
    'synthetic negative message id must be recorded');
  assert.equal(rec.recordPendingAttempt(posted, 'tg_-100123_42'), true,
    'normal positive message id must still be recorded');
  const entries = rec.pendingFor(posted, '-100123');
  const keys = entries.map(e => e.msgKey);
  assert.ok(keys.includes('tg_-100123_-42'), 'the synthetic negative id must appear in the ledger');
  assert.ok(keys.includes('tg_-100123_42'), 'the positive id must appear in the ledger');
  assert.equal(rec.recordPendingAttempt(posted, 'not-a-msg-key'), false,
    'invalid keys must still be refused');
});

// ---------------------------------------------------------------------------
// FIX PASS 2 — F1/F3 (deny-by-default host validation), F5/F10 (temp names)
// ---------------------------------------------------------------------------

test('F1/F3: validateTorrentUrl denies hex/decimal/octal IPs, IPv6 and special ranges', () => {
  // Node normalises these at URL-parse time; they MUST still throw afterwards.
  const evil = [
    'https://0x7f000001/x.torrent',   // -> 127.0.0.1
    'https://0x7f.0.0.1/x.torrent',   // -> 127.0.0.1
    'https://2130706433/x.torrent',   // -> 127.0.0.1
    'https://0177.0.0.1/x.torrent',   // -> 127.0.0.1
    'https://0.0.0.0/x.torrent',      // -> 0.0.0.0
    'https://[::1]/x.torrent',        // -> [::1]
    // F3 private / special ranges (0/8, multicast, CGNAT, benchmarking).
    'https://224.0.0.1/x.torrent',
    'https://100.64.0.1/x.torrent',
    'https://198.18.0.1/x.torrent',
  ];
  for (const u of evil) {
    assert.throws(() => validateTorrentUrl(u), undefined, `must reject ${u}`);
  }
  // A plausible DNS name is still accepted.
  assert.equal(validateTorrentUrl('https://sub.example.com/x.torrent'), 'sub.example.com');
});

test('F5: isTempDownloadName strips all default-ignorable code points', () => {
  assert.equal(isTempDownloadName('direct\u2060_1795059597549'), true, 'WORD JOINER evasion');
  assert.equal(isTempDownloadName('direct\u00AD_1795059597549'), true, 'SOFT HYPHEN evasion');
  assert.equal(isTempDownloadName('direct\u200B_1795059597549'), true, 'ZERO WIDTH SPACE evasion');
});

test('F10: compound-extension strip is limited to known archive suffixes', () => {
  // Known archive suffixes still stripped -> temp name recognised.
  for (const n of [
    'direct_1795059597549.tar.gz',
    'direct_1795059597549.tgz',
    'direct_1795059597549.zip',
    'direct_1795059597549.rar',
  ]) {
    assert.equal(isTempDownloadName(n), true, `must reject ${n}`);
  }
  // A non-archive extension must NOT be stripped into a false positive.
  assert.equal(isTempDownloadName('direct_1795059597549.abcde'), false,
    'an arbitrary extension is not an archive suffix');
  // Existing false positives remain false.
  for (const legit of ['Ep 12', 'Direct 10', 'directive_10', 'direct-12345']) {
    assert.equal(isTempDownloadName(legit), false, `must NOT reject ${legit}`);
  }
});

test('N Season regression: computeReleaseKeySet attaches episode token to canonical titles', () => {
  const cases = [
    {
      title: '[Crunchyroll] Black Clover 2nd Season - 08',
      resolved: { romaji: 'Black Clover 2nd Season', english: 'Black Clover Season 2' },
      season: 2,
      expectedEpisode: 8,
      forbiddenEpisode: 2,
    },
    {
      title: '[Netflix] Ranma 1/2 3rd Season - 08',
      resolved: { romaji: 'Ranma 1/2 (2024) 3rd Season', english: 'Ranma1/2 (2024) Season 3' },
      season: 3,
      expectedEpisode: 8,
      forbiddenEpisode: 3,
    },
    {
      title: '[Crunchyroll] Yasei no Last Boss ga Arawareta 2nd Season - 09',
      resolved: { romaji: 'Yasei no Last Boss ga Arawareta! 2nd Season', english: 'A Wild Last Boss Appeared! Season 2' },
      season: 2,
      expectedEpisode: 9,
      forbiddenEpisode: 2,
    },
  ];

  for (const c of cases) {
    const { keys, season } = computeReleaseKeySet(c.title, { isOfficial: true, resolved: c.resolved });
    assert.equal(season, c.season, `season for ${c.title} must match`);

    // Must NOT contain any key scoped to the season number as an episode
    const badKeys = keys.filter(k => new RegExp(`(?:^|_)ep_0?${c.forbiddenEpisode}(?:_|$)`).test(k));
    assert.deepEqual(badKeys, [], `${c.title} must NOT generate false keys for episode ${c.forbiddenEpisode}`);

    // Must contain episode-scoped keys for the actual episode
    const goodKeys = keys.filter(k => new RegExp(`(?:^|_)ep_0?${c.expectedEpisode}(?:_|$)`).test(k));
    assert.ok(goodKeys.length > 0, `${c.title} must generate episode-scoped keys for episode ${c.expectedEpisode}`);

    // Simulate an existing posted.json containing previous episode keys (e.g. ep 2)
    const mockPosted = new Set([
      `official_ep_${c.forbiddenEpisode}_dummy`,
      `token_ep_${c.forbiddenEpisode}_dummy`,
      `black_clover_2nd_season_ep_${c.forbiddenEpisode}_crunchyroll`,
      `ranma_1_2_2024_3rd_season_ep_${c.forbiddenEpisode}_netflix`,
      `yasei_no_last_boss_ga_arawareta_2nd_season_ep_${c.forbiddenEpisode}_crunchyroll`,
    ]);

    assert.equal(
      isReleaseAlreadyPostedOrDispatched(mockPosted, keys, { season }),
      false,
      `episode ${c.expectedEpisode} must NOT be suppressed by earlier episode ${c.forbiddenEpisode} keys in posted.json`
    );
  }
});

test('RETRACTED_KEYS eviction: false sequel dedup keys are filtered in load and merge', async () => {
  const { RETRACTED_KEYS } = await import('../src/retracted-keys.mjs');
  const { mergePostedIds } = await import('../scripts/merge-posted-state.mjs');
  const { loadPostedIds } = tc;

  assert.equal(RETRACTED_KEYS.size, 477);
  assert.ok(RETRACTED_KEYS.has('tg_-1002084152036_-6038336722933852'));
  assert.ok(RETRACTED_KEYS.has('tg_-1002084152036_11484'));
  assert.ok(RETRACTED_KEYS.has('tg_-1002084152036_11486'));
  assert.ok(RETRACTED_KEYS.has('tg_-1002084152036_11490'));
  assert.ok(RETRACTED_KEYS.has('tg_-1002084152036_11268'));
  assert.ok(RETRACTED_KEYS.has('tg_-1002084152036_11331'));
  assert.ok(RETRACTED_KEYS.has('tg_-1002084152036_11472'));
  assert.ok(RETRACTED_KEYS.has('tg_-1002084152036_11464'));
  assert.ok(RETRACTED_KEYS.has('tg_-1001031770723_25377'));

  // Test mergePostedIds excludes RETRACTED_KEYS
  const mergeResult = mergePostedIds(
    ['tg_-1002084152036_11486', 'legit_key_1'],
    ['tg_-1002084152036_11484', 'legit_key_2']
  );
  assert.deepEqual(mergeResult.merged.sort(), ['legit_key_1', 'legit_key_2']);

  // Test loadPostedIds excludes RETRACTED_KEYS from loaded set
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/posted.json', JSON.stringify(['tg_-1002084152036_11490', 'clean_saved_key']));
  const loaded = loadPostedIds();
  assert.equal(loaded.has('clean_saved_key'), true);
  assert.equal(loaded.has('tg_-1002084152036_11490'), false);
  assert.equal(loaded.size, 1);
});
