import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Isolation: run in a temp working directory BEFORE importing src modules so
// no data/ file or .env from the repo is ever touched (node --test isolates
// each test file in its own process).
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-test-'));
process.chdir(tempDir);

const r = await import('../src/recovery.mjs');
const ss = await import('../src/site-scrapers.mjs');

const CHAT = '-1001031770723';
const NORMAL_CHAT = '1031770723';
const GOOD_URL = 'https://rhythm-sub.com/post-123';

function idTask(overrides = {}) {
  return { kind: 'id', chatId: CHAT, messageId: 42, ...overrides };
}
function synthTask(overrides = {}) {
  return { kind: 'synthetic', chatId: CHAT, title: 'Test Release Title', postUrl: GOOD_URL, ...overrides };
}
function raw(spec) {
  return JSON.stringify(spec);
}
function expectInvalid(input, label) {
  assert.throws(() => r.parseRecoverySpec(input), (e) => {
    assert.equal(e.name, 'RecoverySpecError', `${label}: wrong error name`);
    assert.equal(e.code, 'RECOVERY_SPEC_INVALID', `${label}: wrong code`);
    assert.equal(e.isFatal, true, `${label}: must be fatal`);
    return true;
  }, label);
}
function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = original; });
}

// ===========================================================================
// 1. Parser matrix
// ===========================================================================
test('parser: valid id task', () => {
  const { tasks } = r.parseRecoverySpec(raw({ tasks: [idTask()] }));
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0], { kind: 'id', chatId: CHAT, messageId: 42 });
});

test('parser: valid synthetic task', () => {
  const { tasks } = r.parseRecoverySpec(raw({ tasks: [synthTask()] }));
  assert.deepEqual(tasks[0], {
    kind: 'synthetic', chatId: CHAT, title: 'Test Release Title', postUrl: GOOD_URL,
  });
});

test('parser: both kinds in one object', () => {
  const { tasks } = r.parseRecoverySpec(raw({ tasks: [idTask(), synthTask()] }));
  assert.deepEqual(tasks.map(t => t.kind), ['id', 'synthetic']);
});

test('parser: neither kind is rejected', () => {
  expectInvalid(raw({ tasks: [{ chatId: CHAT, messageId: 42 }] }), 'no kind');
  expectInvalid(raw({ tasks: [{ kind: 'bogus', chatId: CHAT }] }), 'unknown kind');
});

test('parser: unknown top-level and task keys rejected (whitelist)', () => {
  expectInvalid(raw({ tasks: [idTask()], extra: 1 }), 'unknown top-level key');
  expectInvalid(raw({ tasks: [{ ...idTask(), extra: 1 }] }), 'unknown task key');
  expectInvalid('{"tasks":[' + JSON.stringify(idTask()) + '],"constructor":1}', 'constructor key');
});

test('parser: __proto__ key rejected', () => {
  expectInvalid('{"tasks":[' + JSON.stringify(idTask()) + '],"__proto__":{"polluted":true}}', '__proto__');
});

test('parser: 5 tasks rejected', () => {
  expectInvalid(raw({ tasks: [idTask(), idTask(), idTask(), idTask(), idTask()] }), 'too many tasks');
});

test('parser: " 123" and 1e3 rejected (not objects)', () => {
  expectInvalid(' 123', 'numeric string');
  expectInvalid('1e3', 'exponent number');
});

test('parser: messageId bounds 1..2147483647', () => {
  expectInvalid(raw({ tasks: [idTask({ messageId: 0 })] }), 'messageId 0');
  expectInvalid(raw({ tasks: [idTask({ messageId: 2147483648 })] }), 'messageId too large');
  assert.equal(r.parseRecoverySpec(raw({ tasks: [idTask({ messageId: 1 })] })).tasks.length, 1);
  assert.equal(r.parseRecoverySpec(raw({ tasks: [idTask({ messageId: 2147483647 })] })).tasks.length, 1);
});

test('parser: http postUrl rejected', () => {
  expectInvalid(raw({ tasks: [synthTask({ postUrl: 'http://rhythm-sub.com/x' })] }), 'http scheme');
});

test('parser: SSRF host shapes rejected', () => {
  expectInvalid(raw({ tasks: [synthTask({ postUrl: 'https://blogspot.com.evil.tld/x' })] }), 'suffix trick');
  expectInvalid(raw({ tasks: [synthTask({ postUrl: 'https://blogspot.com@evil.tld/x' })] }), 'userinfo');
  expectInvalid(raw({ tasks: [synthTask({ postUrl: 'https://blogspot.com./x' })] }), 'trailing dot');
  expectInvalid(raw({ tasks: [synthTask({ postUrl: 'https://[::1]/x' })] }), 'IPv6 literal');
  expectInvalid(raw({ tasks: [synthTask({ postUrl: 'https://xn--e1afmkfd.xn--p1ai/x' })] }), 'punycode');
});

test('parser: valid blogspot subdomain accepted', () => {
  const out = r.parseRecoverySpec(raw({ tasks: [synthTask({ postUrl: 'https://myblog.blogspot.com/p/1' })] }));
  assert.equal(out.tasks.length, 1);
});

test('parser: title with newline or http rejected', () => {
  expectInvalid(raw({ tasks: [synthTask({ title: 'Line One\nLine Two' })] }), 'newline title');
  expectInvalid(raw({ tasks: [synthTask({ title: 'Visit http://evil.tld' })] }), 'http in title');
  expectInvalid(raw({ tasks: [synthTask({ title: 'ab' })] }), 'short title');
});

test('parser: whitespace-only and empty raw are inert', () => {
  assert.deepEqual(r.parseRecoverySpec('   \n\t  '), { tasks: [] });
  assert.deepEqual(r.parseRecoverySpec(''), { tasks: [] });
  assert.deepEqual(r.parseRecoverySpec(undefined), { tasks: [] });
});

// ===========================================================================
// 2. chatId strict equality
// ===========================================================================
test('chatId: full dialog id accepted', async () => {
  const fetched = [{ id: 42, message: 'hello' }];
  const result = await r.withRecoveryMessages({
    chat: { id: Number(CHAT) },
    windowMsgs: [],
    posted: new Set(),
    tasks: [idTask()],
    fetchByIds: async () => fetched,
    log() {},
  });
  assert.equal(result.fatal, undefined);
  assert.deepEqual(result.msgs, fetched);
});

test('chatId: bare id rejected as RECOVERY_CHAT_UNKNOWN', async () => {
  const result = await r.withRecoveryMessages({
    chat: { id: Number(CHAT) },
    windowMsgs: [],
    posted: new Set(),
    tasks: [idTask({ chatId: NORMAL_CHAT })],
    fetchByIds: async () => [{ id: 42, message: 'x' }],
    log() {},
  });
  assert.equal(result.fatal?.code, 'RECOVERY_CHAT_UNKNOWN');
});

// ===========================================================================
// 3. Pending ledger
// ===========================================================================
const MSG_KEY = `tg_${CHAT}_42`;

test('pending: attempts 1..3 recorded, 4th write refused', () => {
  const posted = new Set();
  assert.equal(r.recordPendingAttempt(posted, MSG_KEY, { now: 1000 }), true);
  assert.equal(r.recordPendingAttempt(posted, MSG_KEY, { now: 2000 }), true);
  assert.equal(r.recordPendingAttempt(posted, MSG_KEY, { now: 3000 }), true);
  const entries = r.pendingFor(posted, CHAT);
  assert.deepEqual(entries.map(e => e.attempts).sort(), [1, 2, 3]);
  assert.equal(r.recordPendingAttempt(posted, MSG_KEY, { now: 4000 }), false);
  assert.equal(r.pendingFor(posted, CHAT).length, 3);
});

test('pending: read-side ignores attempts >= 3', () => {
  const posted = new Set();
  r.recordPendingAttempt(posted, MSG_KEY, { now: 1000 });
  r.recordPendingAttempt(posted, MSG_KEY, { now: 2000 });
  r.recordPendingAttempt(posted, MSG_KEY, { now: 3000 });
  // One retryable entry (attempt 2) remains; the attempt-3 key is ignored.
  assert.deepEqual(r.pendingRetryKeys(posted, CHAT, [], { now: 4000 }), [MSG_KEY]);
  // With only a 3-attempt entry, nothing is retried.
  const onlyThree = new Set();
  onlyThree.add(`pending:${CHAT}:3:1000:${MSG_KEY}`);
  assert.deepEqual(r.pendingRetryKeys(onlyThree, CHAT, [], { now: 4000 }), []);
});

test('pending: >200 entries pruned oldest-first', () => {
  const posted = new Set();
  for (let i = 1; i <= 200; i++) {
    r.recordPendingAttempt(posted, `tg_${CHAT}_${i}`, { now: i });
  }
  assert.equal(r.pendingFor(posted, CHAT).length, 200);
  r.recordPendingAttempt(posted, `tg_${CHAT}_201`, { now: 1000 });
  const pending = r.pendingFor(posted, CHAT);
  assert.equal(pending.length, 200);
  const keys = new Set(pending.map(e => e.msgKey));
  assert.equal(keys.has(`tg_${CHAT}_1`), false, 'oldest entry dropped');
  assert.equal(keys.has(`tg_${CHAT}_201`), true, 'newest entry kept');
});

test('pending: entries older than 7 days skipped on read', () => {
  const posted = new Set();
  const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
  r.recordPendingAttempt(posted, MSG_KEY, { now: old });
  assert.equal(r.pendingFor(posted, CHAT).length, 1); // still present in the set
  assert.deepEqual(r.pendingRetryKeys(posted, CHAT, [], { now: Date.now() }), []);
});

test('pending: dedup hit never deletes a pending key', async () => {
  const posted = new Set();
  r.recordPendingAttempt(posted, MSG_KEY, { now: Date.now() });
  const before = r.pendingFor(posted, CHAT).length;
  // Cron-inert seam: no tasks ⇒ msgs unchanged, posted untouched.
  await r.withRecoveryMessages({
    chat: { id: Number(CHAT) },
    windowMsgs: [{ id: 42, message: 'already handled' }],
    posted,
    tasks: [],
    fetchByIds: async () => [],
    log() {},
  });
  assert.equal(r.pendingFor(posted, CHAT).length, before);
});

// ===========================================================================
// 4. Retry semantics
// ===========================================================================
test('retry: no-links writes pending; pending msg re-fetched by id after window', async () => {
  const posted = new Set();
  r.recordPendingAttempt(posted, MSG_KEY, { now: Date.now() });
  assert.equal(r.pendingFor(posted, CHAT).length, 1);

  const fetchedPending = { id: 42, message: 'recovered body' };
  const fetchedTask = { id: 43, message: 'explicit task body' };
  const calls = [];
  const result = await r.withRecoveryMessages({
    chat: { id: Number(CHAT) },
    windowMsgs: [{ id: 1, message: 'window' }],
    posted,
    tasks: [idTask({ messageId: 43 })],
    fetchByIds: async (_chatId, ids) => {
      calls.push(ids);
      if (ids[0] === '42') return [fetchedPending];
      if (ids[0] === '43') return [fetchedTask];
      return [];
    },
    log() {},
  });
  assert.equal(result.fatal, undefined);
  assert.ok(calls.some(c => c[0] === '42'), 'pending message re-fetched by id');
  assert.deepEqual(result.msgs.map(m => m.id), [1, 42, 43]);
});

test('retry: id task missing ⇒ fatal RECOVERY_MSG_MISSING', async () => {
  const result = await r.withRecoveryMessages({
    chat: { id: Number(CHAT) },
    windowMsgs: [],
    posted: new Set(),
    tasks: [idTask()],
    fetchByIds: async () => [],
    log() {},
  });
  assert.equal(result.fatal?.code, 'RECOVERY_MSG_MISSING');
});

test('retry: pending entry that cannot be fetched is simply skipped', async () => {
  const posted = new Set();
  r.recordPendingAttempt(posted, MSG_KEY, { now: Date.now() });
  const result = await r.withRecoveryMessages({
    chat: { id: Number(CHAT) },
    windowMsgs: [{ id: 1, message: 'window' }],
    posted,
    tasks: [idTask({ messageId: 43 })],
    fetchByIds: async (_chatId, ids) => ids[0] === '43' ? [{ id: 43, message: 'ok' }] : [],
    log() {},
  });
  assert.equal(result.fatal, undefined);
  assert.deepEqual(result.msgs.map(m => m.id), [1, 43]);
});

// ===========================================================================
// 5. No double publish
// ===========================================================================
test('no double publish: seam twice over one posted set ⇒ second run publishes 0', async () => {
  const posted = new Set();
  const chat = { id: Number(CHAT) };
  const tasks = [synthTask()];
  const runOnce = async () => {
    const { msgs } = await r.withRecoveryMessages({
      chat, windowMsgs: [], posted, tasks, fetchByIds: async () => [], log() {},
    });
    let published = 0;
    for (const msg of msgs) {
      const key = `tg_${chat.id}_${msg.id}`;
      if (posted.has(key)) continue; // mirrors isMessageAlreadyHandled in the loop
      published++;
      posted.add(key);
    }
    return published;
  };
  assert.equal(await runOnce(), 1);
  assert.equal(await runOnce(), 0);
});

test('synthetic message shape: only id (negative) and message "title\\nurl"', () => {
  const task = synthTask();
  const msg = r.syntheticMessage(task);
  assert.deepEqual(Object.keys(msg).sort(), ['id', 'message']);
  assert.ok(msg.id < 0, 'id must be negative');
  assert.equal(msg.message, `${task.title}\n${task.postUrl}`);
  assert.equal(msg.media, undefined);
  assert.equal(msg.date, undefined);
  assert.equal(r.syntheticIdFor(task.postUrl), r.syntheticIdFor(task.postUrl));
});

// ===========================================================================
// 6. Cron-inert
// ===========================================================================
test('cron-inert: env absent ⇒ zero tasks, no throw, identical msgs array', async () => {
  delete process.env.RECOVERY_SPEC;
  const { tasks } = r.parseRecoverySpec(process.env.RECOVERY_SPEC || '');
  assert.deepEqual(tasks, []);
  const windowMsgs = [{ id: 1, message: 'a' }, { id: 2, message: 'b' }];
  const result = await r.withRecoveryMessages({
    chat: { id: Number(CHAT) }, windowMsgs, posted: new Set(), tasks,
    fetchByIds: async () => { throw new Error('must not fetch'); }, log() {},
  });
  assert.equal(result.fatal, undefined);
  assert.deepEqual(result.msgs, windowMsgs);
});

// ===========================================================================
// 7. Redirect refusal
// ===========================================================================
test('redirect refusal: thrown redirect on recovery scrape rejects (fatal)', async () => {
  await withFetch(async () => {
    const e = new Error('fetch failed');
    e.cause = new Error('unexpected redirect');
    throw e;
  }, async () => {
    await assert.rejects(
      ss.scrapePostPage(GOOD_URL, null, null, 'Test Release Title', { redirect: 'error' }),
      /fetch failed|redirect/i,
    );
  });
});

test('redirect refusal: 3xx response on recovery scrape rejects', async () => {
  await withFetch(async () => new Response('', {
    status: 302, headers: { location: 'https://evil.tld/steal' },
  }), async () => {
    await assert.rejects(
      ss.scrapePostPage(GOOD_URL, null, null, 'Test Release Title', { redirect: 'error' }),
      (e) => e.code === 'RECOVERY_REDIRECT',
    );
  });
});

test('redirect option defaults to current behaviour for other callers', async () => {
  let seen;
  await withFetch(async (_url, opts) => {
    seen = opts;
    return new Response('<html><body>nothing</body></html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    });
  }, async () => {
    await ss.scrapePostPage(GOOD_URL, null, null, 'Test Release Title');
  });
  assert.equal(seen.redirect, undefined, 'no redirect override for normal callers');
});

// ===========================================================================
// 8. FIX ROUND 2 — F1..F7
// ===========================================================================
test('F1: synthetic, id-task and pending-retry messages are ALL marked', async () => {
  const posted = new Set();
  r.recordPendingAttempt(posted, MSG_KEY, { now: Date.now() });
  const fetchedPending = { id: 42, message: 'pending body' };
  const fetchedTask = { id: 43, message: 'task body' };
  const result = await r.withRecoveryMessages({
    chat: { id: Number(CHAT) },
    windowMsgs: [{ id: 1, message: 'live window message' }],
    posted,
    tasks: [idTask({ messageId: 43 }), synthTask()],
    fetchByIds: async (_chatId, ids) => {
      if (ids[0] === '42') return [fetchedPending];
      if (ids[0] === '43') return [fetchedTask];
      return [];
    },
    log() {},
  });
  assert.equal(result.fatal, undefined);
  const byId = new Map(result.msgs.map(m => [m.id, m]));
  const synth = result.msgs.find(m => typeof m.message === 'string' && m.message.includes(GOOD_URL));
  assert.ok(synth, 'synthetic message present');

  assert.equal(byId.get(43).__recovery, 'id', 'id-task message tagged');
  assert.equal(byId.get(42).__recovery, 'pending', 'pending-retry message tagged');
  assert.equal(synth.__recovery, 'synthetic', 'synthetic message tagged');
  assert.equal(byId.get(1).__recovery, undefined, 'live window message stays unmarked');

  assert.equal(r.isRecoveryMessage(byId.get(43)), true);
  assert.equal(r.isRecoveryMessage(byId.get(42)), true);
  assert.equal(r.isRecoveryMessage(synth), true);
  assert.equal(r.isRecoveryMessage(byId.get(1)), false);
  assert.equal(r.isRecoveryMessage(null), false);

  // The marker is non-enumerable: msgKey / dedup / state writes are unaffected.
  assert.equal(Object.keys(byId.get(43)).includes('__recovery'), false);
  assert.equal(Object.keys(synth).sort().join(','), 'id,message');
  assert.equal(new Set(result.msgs.map(m => String(m.id))).size, result.msgs.length, 'dedup by id intact');
});

test('F2: Cloudflare challenge on recovery path throws typed FETCH_UNSAFE', async () => {
  const url = 'https://revivesubs.example/post-challenge-f2';
  const revive = { id: 'revive', name: 'Revive', base: 'https://revivesubs.example' };
  await withFetch(async () => new Response('<html><body>Just a moment...</body></html>', {
    status: 403, headers: { 'content-type': 'text/html' },
  }), async () => {
    await assert.rejects(
      () => ss.scrapePostPage(url, revive, null, 'Release Challenge', { redirect: r.RECOVERY_REDIRECT_MODE }),
      (e) => e.code === r.RECOVERY_CODES.FETCH_UNSAFE,
    );
  });
  assert.equal(r.RECOVERY_CODES.FETCH_UNSAFE, 'RECOVERY_FETCH_UNSAFE');
});

test('F2: normal callers still use the challenge fallback (no typed error)', async () => {
  const url = 'https://revivesubs.example/post-challenge-normal-f2';
  const revive = { id: 'revive', name: 'Revive', base: 'https://revivesubs.example' };
  await withFetch(async () => new Response('<html><body>nothing</body></html>', {
    status: 200, headers: { 'content-type': 'text/html' },
  }), async () => {
    const out = await ss.scrapePostPage(url, revive, null, 'Release Normal');
    assert.ok(out, 'normal scrape still returns a result');
  });
});

test('F3: directory fetch threads the no-redirect mode into every GoIndex fetch', async () => {
  const seen = [];
  await withFetch(async (_url, opts) => {
    seen.push(opts);
    return new Response('', { status: 302, headers: { location: 'https://evil.tld/steal' } });
  }, async () => {
    await assert.rejects(
      () => ss.resolveSubtitleFromDirectory('https://example.workers.dev/dir', null, { redirect: r.RECOVERY_REDIRECT_MODE }),
      (e) => e.code === r.RECOVERY_CODES.REDIRECT,
    );
  });
  assert.ok(seen.length >= 1, 'at least the GoIndex POST was attempted');
  for (const opts of seen) {
    assert.equal(opts.redirect, r.RECOVERY_REDIRECT_MODE, 'manual redirect threaded');
    assert.equal(opts.recovery, true, 'internal recovery marker threaded');
  }
});

test('F3: browser-rendered directory refuses FETCH_UNSAFE on recovery path', async () => {
  let fetched = false;
  await withFetch(async () => { fetched = true; throw new Error('must not fetch'); }, async () => {
    await assert.rejects(
      () => ss.resolveSubtitleFromDirectory('https://ddl.rocks-team.net/0:/subs', null, { redirect: r.RECOVERY_REDIRECT_MODE }),
      (e) => e.code === r.RECOVERY_CODES.FETCH_UNSAFE,
    );
  });
  assert.equal(fetched, false, 'no fetch at all on the browser-only recovery path');
});

test('F3: normal directory callers are byte-identical (no redirect options)', async () => {
  const seen = [];
  await withFetch(async (_url, opts) => {
    seen.push(opts);
    return new Response('<html><body>nothing</body></html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    });
  }, async () => {
    await ss.resolveSubtitleFromDirectory('https://example.workers.dev/dir', null);
  });
  assert.ok(seen.length >= 1);
  assert.ok(seen.every(o => o.redirect === undefined && o.recovery === undefined), 'no option leak to normal callers');
});

test('F4: a real local 302 becomes typed RECOVERY_REDIRECT (fatal), no page result', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { location: 'https://evil.tld/steal' });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await assert.rejects(
      () => ss.scrapePostPage(`http://127.0.0.1:${port}/post-f4`, null, null, 'Release F4', { redirect: r.RECOVERY_REDIRECT_MODE }),
      (e) => e.code === r.RECOVERY_CODES.REDIRECT,
    );
    assert.equal(r.recoveryFatalCodeFor({ code: r.RECOVERY_CODES.REDIRECT }), r.RECOVERY_CODES.REDIRECT);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('F4: a plain timeout on a recovery message is NOT converted to a fatal', () => {
  assert.equal(r.recoveryFatalCodeFor(new Error('timeout')), null);
  assert.equal(r.recoveryFatalCodeFor({ code: 'ECONNRESET' }), null);
  assert.equal(r.recoveryFatalCodeFor({ code: r.RECOVERY_CODES.FETCH_UNSAFE }), r.RECOVERY_CODES.FETCH_UNSAFE);
  assert.equal(r.isRecoveryRedirectOption(r.RECOVERY_REDIRECT_MODE), true);
  assert.equal(r.isRecoveryRedirectOption('error'), true, 'legacy alias accepted');
  assert.equal(r.isRecoveryRedirectOption(undefined), false);
});

test('F5: one bogus chatId beside a valid one is rejected (strict String equality)', () => {
  assert.deepEqual(
    r.unknownRecoveryChatIds([idTask(), idTask({ chatId: '999' })], [CHAT, '123']),
    ['999'],
  );
  assert.deepEqual(r.unknownRecoveryChatIds([idTask(), idTask({ chatId: '123' })], [CHAT, '123']), []);
  assert.deepEqual(r.unknownRecoveryChatIds([idTask()], [Number(CHAT)]), [], 'numeric dialog id coerced');
});

test('F6: synthetic ids are 53-bit, safe, negative, deterministic and distinct', () => {
  const urls = [GOOD_URL, 'https://myblog.blogspot.com/p/other'];
  const ids = urls.map(r.syntheticIdFor);
  for (const id of ids) {
    assert.ok(id < 0, 'id must be negative');
    assert.ok(Number.isSafeInteger(id), 'id must be a safe integer');
    assert.ok(Math.abs(id) > 0x7fffffff, 'id must be wider than 32 bits');
  }
  assert.notEqual(ids[0], ids[1], 'different URLs get different ids');
  assert.equal(r.syntheticIdFor(urls[0]), ids[0], 'deterministic');
});

test('F7: the 200-key prune deletes ONLY pending: keys, never release keys', () => {
  const posted = new Set();
  for (let i = 1; i <= 200; i++) posted.add(`pending:${CHAT}:1:${i}:tg_${CHAT}_${i}`);
  const releaseKeys = [`tg_${CHAT}_999`, 'Some::Release::Key', 'pendingish'];
  for (const key of releaseKeys) posted.add(key);
  assert.equal(r.recordPendingAttempt(posted, `tg_${CHAT}_500`, { now: 1000 }), true);
  for (const key of releaseKeys) assert.ok(posted.has(key), `non-pending key kept: ${key}`);
  assert.equal(r.pendingFor(posted, CHAT).length, 200, 'pending cap still held');
  assert.equal([...posted].filter(k => !k.startsWith('pending:')).length, releaseKeys.length);
});

// ===========================================================================
// 9. FINAL FIX PASS — G1..G5
// ===========================================================================

test('G1: recovery scrape threads no-redirect into BOTH site login GETs; normal callers unchanged', async () => {
  const seen = [];
  const stub = async (url, opts) => {
    seen.push({ url, method: opts.method || 'GET', redirect: opts.redirect });
    return new Response('<html><body>nothing</body></html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    });
  };
  const site = (id, base) => ({ id, name: id, base, user: 'u', pass: 'p' });
  const prev = process.env.REVIVE_COOKIE;
  delete process.env.REVIVE_COOKIE;
  try {
    await withFetch(stub, async () => {
      // Laravel /login GET (revive-style base).
      await ss.scrapePostPage('https://posts.example/g1-laravel', site('revive-g1-a', 'https://revivesubs.example'), null, 'Rel', { redirect: r.RECOVERY_REDIRECT_MODE });
      // WordPress wp-login.php GET.
      await ss.scrapePostPage('https://posts.example/g1-wp', site('wp-g1-b', 'https://wp.example'), null, 'Rel', { redirect: r.RECOVERY_REDIRECT_MODE });
      // Normal caller: no redirect override on its login GET.
      await ss.scrapePostPage('https://posts.example/g1-normal', site('wp-g1-c', 'https://wp.example'), null, 'Rel');
    });
  } finally {
    if (prev !== undefined) process.env.REVIVE_COOKIE = prev;
  }
  const laravelGet = seen.find(x => x.method === 'GET' && x.url === 'https://revivesubs.example/login');
  const wpGet = seen.find(x => x.method === 'GET' && x.url === 'https://wp.example/wp-login.php' && x.redirect !== undefined);
  const normalGet = seen.find(x => x.method === 'GET' && x.url === 'https://wp.example/wp-login.php' && x.redirect === undefined);
  assert.ok(laravelGet, 'Laravel /login GET observed');
  assert.ok(wpGet, 'WordPress wp-login.php GET observed (recovery)');
  assert.ok(normalGet, 'WordPress wp-login.php GET observed (normal)');
  assert.equal(laravelGet.redirect, r.RECOVERY_REDIRECT_MODE, 'Laravel login GET gets manual');
  assert.equal(wpGet.redirect, r.RECOVERY_REDIRECT_MODE, 'WordPress login GET gets manual');
  // The POSTs were already manual and must stay that way.
  for (const x of seen.filter(p => p.method === 'POST' && /login/.test(p.url))) {
    assert.equal(x.redirect, 'manual', 'login POST stays manual');
  }
});

test('G2: recoveryScrapeOptions only sets no-redirect for marked messages', () => {
  const marked = r.syntheticMessage(synthTask());
  assert.equal(r.isRecoveryMessage(marked), true, 'fixture is marked');
  assert.deepEqual(r.recoveryScrapeOptions(marked), { redirect: r.RECOVERY_REDIRECT_MODE });
  assert.equal(r.recoveryScrapeOptions(marked).redirect, 'manual');
  assert.deepEqual(r.recoveryScrapeOptions({ id: 42, message: 'normal' }), {}, 'unmarked ⇒ no options');
  assert.deepEqual(r.recoveryScrapeOptions(null), {}, 'null ⇒ no options');
  // The second directory call site is threaded via the guard-state wrapper.
  // The literal call shape is kept for the T38 source contract; the wrapper
  // injects the same options from the active message.
  const tc = fs.readFileSync(new URL('../src/telegram-client.mjs', import.meta.url), 'utf8');
  assert.match(tc, /resolveSubtitleFromDirectory\([^)]*batch: isCollectionTitle\(titleLine\)[^)]*\)/, 'literal call shape kept');
  assert.match(tc, /recoveryScrapeOptions\(recoveryState\.msg\)/, 'wrapper threads the helper');
  assert.match(tc, /recoveryState\.msg = isRecoveryMessage\(msg\) \? msg : null/, 'loop exposes the active message for the whole iteration');
});

test('G3: recovery title dedup authority is documented in code and workflow', () => {
  const rec = fs.readFileSync(new URL('../src/recovery.mjs', import.meta.url), 'utf8');
  const wf = fs.readFileSync(new URL('../.github/workflows/bot-monitor.yml', import.meta.url), 'utf8');
  for (const [label, text] of [['recovery.mjs', rec], ['bot-monitor.yml', wf]]) {
    assert.match(text, /feeds release\/dedup keys/, `${label}: dedup-key note present`);
    assert.match(text, /never retried/, `${label}: no-retry warning present`);
    assert.match(text, /operator-only/, `${label}: operator-only note present`);
  }
});

test('G4: marked positive-id message injects manual redirect; flag restored after throw', async () => {
  // A genuinely marked POSITIVE-id message from the recovery 'id' seam.
  const seam = await r.withRecoveryMessages({
    chat: { id: Number(CHAT) },
    windowMsgs: [],
    posted: new Set(),
    tasks: [idTask({ messageId: 42 })],
    fetchByIds: async () => [{ id: 42, message: 'recovered body' }],
    log() {},
  });
  const msg = seam.msgs.find(m => m.id === 42);
  assert.ok(msg && msg.id > 0, 'positive id present');
  assert.equal(r.isRecoveryMessage(msg), true, 'message is marked');

  const state = { active: false, msg: null };
  const seen = [];
  // Mirrors telegram-client's scrapePostPage → baseScrapePostPage glue: the
  // guard sets the state, then the wrapper reads it to build effective options.
  const run = (m, fn) => r.withRecoveryMode(m, () => {
    seen.push(r.scrapeOptionsForState({ batch: true }, state));
    return fn();
  }, state);

  assert.equal(await run(msg, () => 'ok'), 'ok');
  assert.deepEqual(seen[0], { batch: true, redirect: 'manual' }, 'baseScrape receives redirect:manual');
  assert.equal(state.active, false, 'flag restored after normal run');

  await run({ id: 7, message: 'normal' }, () => {});
  assert.deepEqual(seen[1], { batch: true }, 'unmarked message ⇒ no redirect override');

  await assert.rejects(run(msg, () => { throw new Error('boom'); }), /boom/);
  assert.equal(state.active, false, 'flag restored after throw');
  assert.equal(state.msg, null, 'message reference restored after throw');

  // The production wrapper is wired to these exact helpers (single source of truth).
  const tc = fs.readFileSync(new URL('../src/telegram-client.mjs', import.meta.url), 'utf8');
  assert.match(tc, /scrapeOptionsForState\(options, recoveryState\)/, 'wrapper uses the tested option helper');
  assert.match(tc, /withRecoveryMode\(msg,/, 'guard uses the tested toggle helper');
});

test('G5: 3 no-links cycles cap the read side — 4th recovery run does not fetch', async () => {
  const posted = new Set();
  const now0 = Date.now() - 10_000; // recent, so the 7-day TTL cannot mask the cap
  for (const delta of [0, 1000, 2000]) {
    assert.equal(r.recordPendingAttempt(posted, MSG_KEY, { now: now0 + delta }), true);
  }
  assert.equal(r.recordPendingAttempt(posted, MSG_KEY, { now: now0 + 3000 }), false, 'write cap unchanged (4th write refused)');

  // Legacy per-entry view still lists it — exactly why the capped read side exists.
  assert.deepEqual(r.pendingRetryKeys(posted, CHAT, [], { now: now0 + 4000 }), [MSG_KEY]);
  // Message-level view (used by withRecoveryMessages) applies the cap to the max attempt.
  assert.deepEqual(r.cappedPendingRetryKeys(posted, CHAT, [], { now: now0 + 4000 }), []);

  const fetchedIds = [];
  const result = await r.withRecoveryMessages({
    chat: { id: Number(CHAT) },
    windowMsgs: [],                       // message is outside the live window
    posted,
    tasks: [idTask({ messageId: 999 })],  // a real task so the seam runs
    fetchByIds: async (_chatId, ids) => {
      fetchedIds.push(ids[0]);
      return ids[0] === '999' ? [{ id: 999, message: 'task body' }] : [];
    },
    log() {},
  });
  assert.equal(result.fatal, undefined);
  assert.deepEqual(fetchedIds, ['999'], 'only the explicit task fetched — capped message NOT re-fetched');
});
