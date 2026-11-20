import { test } from 'node:test';
import assert from 'node:assert/strict';

// These imports are side-effect safe: several existing test files already
// import telegram-client.mjs (dedup, episode-numbering, state-persistence).
import { noteNoLinksOutcome } from '../src/telegram-client.mjs';
import { pendingFor, cappedPendingRetryKeys, withRecoveryMessages } from '../src/recovery.mjs';

const CHAT = '-1001031770723';
const MSG_KEY = `tg_${CHAT}_42`;
const POST_URL = 'https://rhythm-sub.com/post-123';
const NOW0 = Date.now() - 10_000; // recent: the 7-day TTL cannot mask the cap

// A FRESH process has an empty negative-cache Map and a real scrape result
// whose page has no usable download link. This is the branch that used to call
// only countNoLinks() and never wrote a pending attempt.
function freshNoLinksRun(posted, logs = []) {
  return noteNoLinksOutcome(
    { bestDownloadUrl: null, videoLinks: {} }, // pageData: a page, but no links
    posted,
    MSG_KEY,
    POST_URL,
    () => {},                                   // countNoLinks (observability only)
    (level, text) => logs.push(`${level}:${text}`),
  );
}

function maxAttempts(posted) {
  const entries = pendingFor(posted, CHAT);
  return entries.length ? Math.max(...entries.map(e => e.attempts)) : 0;
}

test('fresh-process no-links scrapes record pending attempts and cap the 4th recovery fetch', async () => {
  const posted = new Set();
  // A prior dispatch already recorded attempt 1.
  posted.add(`pending:${CHAT}:1:${NOW0}:${MSG_KEY}`);
  assert.equal(maxAttempts(posted), 1, 'precondition: one pending attempt');

  // Run 2 — FRESH process, empty negative cache, scrape returns a page with no
  // links. This must deterministically record attempt 2.
  const logs = [];
  assert.equal(freshNoLinksRun(posted, logs), true, 'fresh no-links outcome is classified/recorded');
  assert.equal(maxAttempts(posted), 2, 'fresh-process no-links recorded attempt 2');
  assert.ok(
    logs.some(l => l.startsWith('warn:') && l.includes('No download links found')),
    'the original no-download-links warning is preserved',
  );

  // Run 3 → attempt 3; Run 4 → the write cap refuses a 4th attempt.
  freshNoLinksRun(posted);
  assert.equal(maxAttempts(posted), 3, 'third no-links run reaches the 3-attempt cap');
  freshNoLinksRun(posted);
  assert.equal(maxAttempts(posted), 3, 'fourth no-links run is refused by the write cap');
  assert.equal(pendingFor(posted, CHAT).length, 3, 'no extra pending key written');

  // 4th RECOVERY dispatch: the capped READ side (cappedPendingRetryKeys) must
  // not re-queue the message, so withRecoveryMessages never fetches it.
  assert.deepEqual(
    cappedPendingRetryKeys(posted, CHAT, [], { now: NOW0 + 4000 }),
    [],
    'capped message is no longer a pending retry key',
  );

  const fetched = [];
  const result = await withRecoveryMessages({
    chat: { id: Number(CHAT) },
    windowMsgs: [],                             // message is outside the live window
    posted,
    tasks: [{ kind: 'id', chatId: CHAT, messageId: 999 }], // a real task so the seam runs
    fetchByIds: async (_chatId, ids) => {
      fetched.push(ids[0]);
      return ids[0] === '999' ? [{ id: 999, message: 'task body' }] : [];
    },
    log() {},
  });
  assert.equal(result.fatal, undefined);
  assert.deepEqual(fetched, ['999'], 'only the explicit task is fetched — capped message 42 is NOT');
  assert.ok(!fetched.includes('42'), 'the capped message is never re-fetched');
});
