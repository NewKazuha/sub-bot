import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  validatePostedIds,
  mergePostedIds,
  validateTitleMap,
  mergeTitleMap,
  classifyMerge,
  classifyProvenance,
  pushStateWithRetries,
  makeGitRunner,
  MAX_ELEMENTS,
  MAX_BYTES,
} from '../scripts/merge-posted-state.mjs';
import { createCycleCounters, formatNoLinksBySource } from '../src/telegram-client.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLIENT_URL = pathToFileURL(path.join(REPO_ROOT, 'src', 'telegram-client.mjs')).href;
const IDENTITY_URL = pathToFileURL(path.join(REPO_ROOT, 'src', 'title-identity.mjs')).href;
const MERGE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'merge-posted-state.mjs');
const dirs = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'posted-state-')); dirs.push(d); return d; }
function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function runCode(cwd, code, env = process.env) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  return { status: res.status ?? 1, signal: res.signal ?? null, stdout: res.stdout || '', stderr: res.stderr || '' };
}
function runIn(cwd, body, env = process.env) {
  const code = `const m = await import(${JSON.stringify(CLIENT_URL)});\n${body}`;
  // spawnSync (not execFileSync): the child's stderr must be observable even when
  // it exits 0 — the git-recovery path reports on stderr and still succeeds.
  return runCode(cwd, code, env);
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** Run the merge/push CLI in a directory (never in the repository!). */
function runMerge(cwd, args = []) {
  const res = spawnSync(process.execPath, [MERGE_SCRIPT, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  return { status: res.status ?? 1, stdout: res.stdout || '', stderr: res.stderr || '' };
}

// ---------------------------------------------------------------------------
// (أ) corrupt posted.json + healthy git HEAD -> keys are recovered from git
// ---------------------------------------------------------------------------
test('أ: corrupt posted.json with a healthy git HEAD is recovered from git', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'posted.json'), JSON.stringify(['k1', 'k2', 'k3']));

  git(dir, ['init', '-q']);
  git(dir, ['add', 'data/posted.json']);
  git(dir, ['-c', 'user.name=state-test', '-c', 'user.email=state@test.local', 'commit', '-q', '-m', 'init']);

  // Corrupt the working-tree copy only — git history stays intact.
  fs.writeFileSync(path.join(dir, 'data', 'posted.json'), '{broken');

  const r = runIn(dir, "const s = m.loadPostedIds(); console.log('KEYS=' + s.size);");
  assert.equal(r.status, 0, `expected exit 0, got ${r.status} (stderr=${r.stderr})`);
  assert.match(r.stdout, /KEYS=3/);
  assert.match(r.stderr, /HEAD/);
});

// ---------------------------------------------------------------------------
// (ب) corrupt posted.json + unusable git history -> throws, and never writes
// ---------------------------------------------------------------------------
test('ب: corrupt posted.json with no usable git history throws and leaves the file untouched', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'posted.json'), '{broken');

  git(dir, ['init', '-q']); // no commit at all -> HEAD and HEAD~1 do not resolve

  const r = runIn(
    dir,
    "try { m.loadPostedIds(); console.log('NO_THROW'); } catch (e) { console.error('THREW: ' + e.message); process.exit(9); }"
  );
  assert.notEqual(r.status, 0, `expected a non-zero exit, got ${r.status}`);
  assert.match(r.stderr, /THREW|corrupt|recovery failed/i);
  assert.equal(
    fs.readFileSync(path.join(dir, 'data', 'posted.json'), 'utf8'),
    '{broken',
    'corrupt file must not be rewritten (no silent state loss)'
  );
});

// ---------------------------------------------------------------------------
// (ج) missing posted.json -> empty set, no throw (legitimate first run)
// ---------------------------------------------------------------------------
test('ج: missing posted.json returns an empty set without throwing', async () => {
  const dir = tmp(); // no data/ directory and no git repo at all

  const r = runIn(dir, "const s = m.loadPostedIds(); console.log('KEYS=' + s.size);");
  assert.equal(r.status, 0, `expected exit 0, got ${r.status} (stderr=${r.stderr})`);
  assert.match(r.stdout, /KEYS=0/);
});

// ---------------------------------------------------------------------------
// (د) savePostedIds writes atomically and leaves no tmp/bak residue
// ---------------------------------------------------------------------------
test('د: savePostedIds writes atomically and leaves no tmp/bak files behind', async () => {
  const dir = tmp();

  const r = runIn(dir, "m.savePostedIds(new Set(['a', 'b', 'c'])); console.log('SAVED');");
  assert.equal(r.status, 0, `expected exit 0, got ${r.status} (stderr=${r.stderr})`);
  assert.match(r.stdout, /SAVED/);

  const dataDir = path.join(dir, 'data');
  const written = JSON.parse(fs.readFileSync(path.join(dataDir, 'posted.json'), 'utf8'));
  assert.deepEqual(written, ['a', 'b', 'c']);
  assert.equal(fs.existsSync(path.join(dataDir, 'posted.json.tmp')), false, 'temp file must be renamed away');
  const leftovers = fs.readdirSync(dataDir).filter(f => f.endsWith('.tmp') || f.endsWith('.bak'));
  assert.deepEqual(leftovers, [], `unexpected leftover files: ${JSON.stringify(leftovers)}`);
});

// ---------------------------------------------------------------------------
// (هـ) corrupt file AND corrupt HEAD, but a healthy HEAD~1 -> recovered from HEAD~1
// ---------------------------------------------------------------------------
test('هـ: corrupt posted.json with a corrupt HEAD is recovered from git HEAD~1', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'posted.json'), JSON.stringify(['k1', 'k2', 'k3']));

  git(dir, ['init', '-q']);
  git(dir, ['add', 'data/posted.json']);
  git(dir, ['-c', 'user.name=state-test', '-c', 'user.email=state@test.local', 'commit', '-q', '-m', 'init']);

  // Second commit stores a corrupt file: HEAD is unusable, HEAD~1 stays healthy.
  fs.writeFileSync(path.join(dir, 'data', 'posted.json'), '{broken');
  git(dir, ['add', 'data/posted.json']);
  git(dir, ['-c', 'user.name=state-test', '-c', 'user.email=state@test.local', 'commit', '-q', '-m', 'corrupt']);

  const r = runIn(dir, "const s = m.loadPostedIds(); console.log('KEYS=' + s.size);");
  assert.equal(r.status, 0, `expected exit 0, got ${r.status} (stderr=${r.stderr})`);
  assert.match(r.stdout, /KEYS=3/);
  assert.match(r.stderr, /HEAD~1/, `expected recovery from HEAD~1, stderr=${r.stderr}`);
});

// ---------------------------------------------------------------------------
// (و) valid JSON that is NOT an array + healthy git -> must recover, never
//     return an empty set or a literal value
// ---------------------------------------------------------------------------
test('و: valid non-array JSON in posted.json is rejected and recovered from git HEAD', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'posted.json'), JSON.stringify(['k1', 'k2', 'k3']));

  git(dir, ['init', '-q']);
  git(dir, ['add', 'data/posted.json']);
  git(dir, ['-c', 'user.name=state-test', '-c', 'user.email=state@test.local', 'commit', '-q', '-m', 'init']);

  // Valid JSON, but not an array — parsePosted must reject it and fall back to git.
  fs.writeFileSync(path.join(dir, 'data', 'posted.json'), '{}');

  const r = runIn(dir, "const s = m.loadPostedIds(); console.log('KEYS=' + s.size);");
  assert.equal(r.status, 0, `expected exit 0, got ${r.status} (stderr=${r.stderr})`);
  assert.match(r.stdout, /KEYS=3/);
  assert.match(r.stderr, /HEAD/, `expected recovery from git HEAD, stderr=${r.stderr}`);
});

// ---------------------------------------------------------------------------
// (ز) a posted.json larger than execSync's default 1 MB maxBuffer is still
//     recovered (proves the explicit maxBuffer on the git show call)
// ---------------------------------------------------------------------------
test('ز: a posted.json above the default 1 MB maxBuffer is still recovered from git', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const keys = [];
  for (let i = 0; i < 20000; i++) keys.push('anime-episode-key-' + i + '-' + 'x'.repeat(40));
  const payload = JSON.stringify(keys);
  assert.ok(Buffer.byteLength(payload) > 1024 * 1024, 'payload must exceed the default 1 MB maxBuffer');
  fs.writeFileSync(path.join(dir, 'data', 'posted.json'), payload);

  git(dir, ['init', '-q']);
  git(dir, ['add', 'data/posted.json']);
  git(dir, ['-c', 'user.name=state-test', '-c', 'user.email=state@test.local', 'commit', '-q', '-m', 'init']);

  // Corrupt the working-tree copy only — the committed HEAD stays intact.
  fs.writeFileSync(path.join(dir, 'data', 'posted.json'), '{broken');

  const r = runIn(dir, "const s = m.loadPostedIds(); console.log('KEYS=' + s.size);");
  assert.equal(r.status, 0, `expected exit 0, got ${r.status} (stderr=${r.stderr})`);
  assert.match(r.stdout, /KEYS=20000/);
});

// ---------------------------------------------------------------------------
// (ح) markReleaseAsPosted persists immediately — no explicit save
// ---------------------------------------------------------------------------
test('ح: markReleaseAsPosted writes the key to disk immediately (no explicit save)', async () => {
  const dir = tmp();
  const r = runIn(dir, `
    const s = m.loadPostedIds();
    m.markReleaseAsPosted(s, 'tg_1_100', ['anime_ep_1']);
    const fs = (await import('node:fs')).default;
    console.log('DISK=' + fs.readFileSync('data/posted.json', 'utf8'));
  `);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status} (stderr=${r.stderr})`);
  const disk = JSON.parse(r.stdout.slice(r.stdout.indexOf('DISK=') + 5).trim());
  assert.ok(disk.includes('tg_1_100'), 'msgKey must be on disk right after mark');
  assert.ok(disk.includes('anime_ep_1'), 'release key must be on disk right after mark');
});

// ---------------------------------------------------------------------------
// (ط) crash simulation: SIGKILL immediately after mark; a fresh process reloads
// ---------------------------------------------------------------------------
test('ط: keys marked before a SIGKILL survive a fresh loadPostedIds (crash simulation)', async () => {
  const dir = tmp();
  const crash = runIn(dir, `
    const s = m.loadPostedIds();
    m.markReleaseAsPosted(s, 'tg_2_200', ['crash_ep_7']);
    process.kill(process.pid, 'SIGKILL');
    console.log('REACHED_AFTER_KILL');
  `);
  // Windows reports a SIGKILL as exit status 1 with signal=null; POSIX reports signal=SIGKILL.
  assert.ok(crash.signal === 'SIGKILL' || crash.status !== 0, `child must die abruptly, got signal=${crash.signal} status=${crash.status} (stderr=${crash.stderr})`);
  assert.ok(!crash.stdout.includes('REACHED_AFTER_KILL'), 'the kill must terminate the process before the next statement');

  const reload = runIn(dir, `
    const s = m.loadPostedIds();
    console.log('HAS_MSG=' + s.has('tg_2_200'));
    console.log('HAS_REL=' + s.has('crash_ep_7'));
    console.log('SIZE=' + s.size);
  `);
  assert.equal(reload.status, 0, `expected exit 0, got ${reload.status} (stderr=${reload.stderr})`);
  assert.match(reload.stdout, /HAS_MSG=true/);
  assert.match(reload.stdout, /HAS_REL=true/);
  assert.match(reload.stdout, /SIZE=2/);
});

// ---------------------------------------------------------------------------
// (ي) skip-path shape: msgKey-only mark is durable before the loop moves on
// ---------------------------------------------------------------------------
test('ي: a skip decision (msgKey-only mark) is durable without the end-of-cycle save', async () => {
  const dir = tmp();
  const r = runIn(dir, `
    const s = m.loadPostedIds();
    m.markReleaseAsPosted(s, 'tg_3_300');
    const fs = (await import('node:fs')).default;
    console.log('DISK=' + fs.readFileSync('data/posted.json', 'utf8'));
  `);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status} (stderr=${r.stderr})`);
  const disk = JSON.parse(r.stdout.slice(r.stdout.indexOf('DISK=') + 5).trim());
  assert.deepEqual(disk, ['tg_3_300']);

  const reload = runIn(dir, "const s = m.loadPostedIds(); console.log('POSTED=' + s.has('tg_3_300'));");
  assert.equal(reload.status, 0, `expected exit 0 (stderr=${reload.stderr})`);
  assert.match(reload.stdout, /POSTED=true/);
});

// ---------------------------------------------------------------------------
// (ك) no-op: re-marking an existing key and a redundant explicit save perform
//     zero writes (fs.writeFileSync / fs.renameSync spies prove the size guard)
// ---------------------------------------------------------------------------
test('ك: marking an existing key performs no write (size-guard no-op)', async () => {
  const dir = tmp();
  const r = runIn(dir, `
    const fs = (await import('node:fs')).default;
    const origWrite = fs.writeFileSync, origRename = fs.renameSync;
    let writes = 0, renames = 0;
    fs.writeFileSync = (...a) => { writes++; return origWrite.apply(fs, a); };
    fs.renameSync = (...a) => { renames++; return origRename.apply(fs, a); };
    const s = m.loadPostedIds();
    m.markReleaseAsPosted(s, 'tg_4_400', ['noop_ep_1']);
    const afterFirst = writes;
    m.markReleaseAsPosted(s, 'tg_4_400', ['noop_ep_1']);
    m.savePostedIds(s);
    console.log('FIRST=' + afterFirst);
    console.log('WRITES=' + writes);
    console.log('RENAMES=' + renames);
    fs.writeFileSync = origWrite; fs.renameSync = origRename;
  `);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status} (stderr=${r.stderr})`);
  assert.match(r.stdout, /FIRST=1/, 'the first mark must write exactly once');
  assert.match(r.stdout, /WRITES=1/, 'duplicate mark + redundant save must not write again');
  assert.match(r.stdout, /RENAMES=1/, 'duplicate mark + redundant save must not rename again');
});

// ---------------------------------------------------------------------------
// (ل) the end-of-cycle savePostedIds still persists keys added outside mark
// ---------------------------------------------------------------------------
test('ل: the end-of-cycle savePostedIds still persists keys added outside mark', async () => {
  const dir = tmp();
  const r = runIn(dir, `
    const s = m.loadPostedIds();
    s.add('manual_end_of_cycle');
    m.savePostedIds(s);
    const fs = (await import('node:fs')).default;
    console.log('DISK=' + fs.readFileSync('data/posted.json', 'utf8'));
  `);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status} (stderr=${r.stderr})`);
  const disk = JSON.parse(r.stdout.slice(r.stdout.indexOf('DISK=') + 5).trim());
  assert.ok(disk.includes('manual_end_of_cycle'), 'explicit end-of-cycle save must still write');
});

// ---------------------------------------------------------------------------
// (م) successive marks each persist; the size guard advances with growth and
//     a later duplicate is still a no-op
// ---------------------------------------------------------------------------
test('م: successive marks each persist and the size guard tracks growth', async () => {
  const dir = tmp();
  const r = runIn(dir, `
    const s = m.loadPostedIds();
    m.markReleaseAsPosted(s, 'a');
    m.markReleaseAsPosted(s, 'b');
    m.markReleaseAsPosted(s, 'b');
    const fs = (await import('node:fs')).default;
    console.log('DISK=' + fs.readFileSync('data/posted.json', 'utf8'));
    console.log('SIZE=' + s.size);
  `);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status} (stderr=${r.stderr})`);
  const disk = JSON.parse(r.stdout.slice(r.stdout.indexOf('DISK=') + 5).trim().split('\nSIZE=')[0]);
  assert.deepEqual(disk, ['a', 'b']);
  assert.match(r.stdout, /SIZE=2/);

  const reload = runIn(dir, "const s = m.loadPostedIds(); console.log('SIZE=' + s.size);");
  assert.equal(reload.status, 0, `expected exit 0 (stderr=${reload.stderr})`);
  assert.match(reload.stdout, /SIZE=2/);
});

// ===========================================================================
// P0-4 — state merge, guards and push (execution spec §5 / §7)
// ===========================================================================

/** A local baseline above the absolute floor (production has 42,382). */
function makeKeys(n, prefix = 'k') {
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(`${prefix}_${i}`);
  return keys;
}

/** A fake git runner: only the plumbing the script uses is emulated. */
function makeGitFake({ remotePosted = '[]', remoteTitleMap = '{"k":{"negative":false,"ts":1}}', author = 'github-actions[bot]', pushCode = 0, calls = [], onPush = null } = {}) {
  return async (args, opts = {}) => {
    calls.push({ args: args.slice(), env: (opts && opts.env) || null });
    if (args.includes('fetch')) return { code: 0, stdout: '', stderr: '' };
    if (args.includes('rev-parse')) return { code: 0, stdout: args[1] === 'FETCH_HEAD' ? 'deadbeef\n' : 'tree0000\n', stderr: '' };
    if (args.includes('show')) return { code: 0, stdout: String(args[args.length - 1]).includes('title-map') ? remoteTitleMap : remotePosted, stderr: '' };
    if (args.includes('log')) return { code: 0, stdout: `${author}\n`, stderr: '' };
    if (args.includes('hash-object')) return { code: 0, stdout: 'blob0000\n', stderr: '' };
    if (args.includes('write-tree')) return { code: 0, stdout: 'tree1111\n', stderr: '' };
    if (args.includes('commit-tree')) return { code: 0, stdout: 'commit1111\n', stderr: '' };
    if (args.includes('push')) {
      if (onPush) return onPush(args, calls);
      return { code: pushCode, stdout: '', stderr: pushCode ? 'rejected' : '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

/** A path-aware reader: posted.json and title-map.json have different shapes. */
function makeReadFile(localKeys, titleMap = '{"k":{"negative":false,"ts":1}}') {
  return (p) => String(p).includes('title-map') ? titleMap : JSON.stringify(localKeys);
}

test('mergePostedIds: every key of both sides survives the union and the merge is idempotent', () => {
  const ours = ['a', 'b', 'c'];
  const theirs = ['c', 'd', 'e'];
  const merged = mergePostedIds(ours, theirs);
  assert.deepEqual(merged.merged.slice().sort(), ['a', 'b', 'c', 'd', 'e']);
  for (const k of ours) assert.ok(merged.merged.includes(k), `local key ${k} was lost`);
  for (const k of theirs) assert.ok(merged.merged.includes(k), `remote key ${k} was lost`);
  assert.equal(merged.localCount, 3);
  assert.equal(merged.remoteCount, 3);
  // Idempotent: the retry loop merges up to 3 times.
  const again = mergePostedIds(merged.merged, merged.merged);
  assert.deepEqual(again.merged.slice().sort(), merged.merged.slice().sort());
  assert.equal(again.merged.length, merged.merged.length);
});

test('validatePostedIds: the unusable keys are rejected and the real production shapes are accepted', () => {
  assert.equal(validatePostedIds([42]).rejected[0].reason, 'not-a-string');
  assert.equal(validatePostedIds(['ok\u0000bad']).rejected[0].reason, 'control-character');
  assert.equal(validatePostedIds(['x'.repeat(513)]).rejected[0].reason, 'too-long');
  assert.equal(validatePostedIds(['']).rejected[0].reason, 'empty');
  // A non-array / unparseable side is invalid (fail closed).
  assert.equal(validatePostedIds({}).valid, false);
  assert.equal(validatePostedIds('nope').valid, false);
  assert.equal(validatePostedIds(null).valid, false);
  // The measured production shapes are accepted.
  assert.equal(validatePostedIds(['x'.repeat(259)]).rejected.length, 0, 'a 259-char key is legal');
  assert.equal(validatePostedIds(['ANIME タイトル 日本語']).rejected.length, 0, 'a Japanese key is legal');
  assert.equal(validatePostedIds(['عربي']).rejected.length, 0, 'an Arabic key is legal');
  assert.equal(validatePostedIds(['ⅱ']).rejected.length, 0, 'U+2171 is legal');
  assert.equal(validatePostedIds(['x'.repeat(512)]).rejected.length, 0, '512 chars is the cap');
});

test('validatePostedIds: the element and byte caps make the side invalid (red, no write)', () => {
  const tooMany = new Array(MAX_ELEMENTS + 1).fill('k');
  assert.equal(validatePostedIds(tooMany).valid, false, 'more than 250,000 elements must be invalid');
  assert.match(validatePostedIds(tooMany).rejected[0].reason, /too-many-elements/);
  // ~10 MB of keys -> the byte cap trips (the element count is still legal).
  const tooBig = new Array(200000).fill('x'.repeat(50));
  assert.equal(tooBig.length <= MAX_ELEMENTS, true);
  assert.equal(validatePostedIds(tooBig).valid, false, 'more than 8 MB must be invalid');
  assert.match(validatePostedIds(tooBig).rejected[0].reason, /too-large/);
});

test('classifyMerge: the floor, the shrink and the growth guards', () => {
  assert.equal(classifyMerge({ localCount: 2000, remoteCount: 2000, mergedCount: 2000 }).corrupt, false);
  assert.equal(classifyMerge({ localCount: 2000, remoteCount: 2000, mergedCount: 999 }).corrupt, true, 'below the absolute floor');
  // The shrink alarm needs BOTH margins (S-01): a 100-key gap is below the
  // absolute margin of 1,000 keys, so it is not a shrink any more.
  assert.equal(classifyMerge({ localCount: 2000, remoteCount: 1900, mergedCount: 2000 }).corrupt, false, 'a 100-key gap is below the absolute margin');
  assert.equal(classifyMerge({ localCount: 2000, remoteCount: 900, mergedCount: 2000 }).corrupt, true, 'a 1,100-key gap is a real shrink');
  assert.equal(classifyMerge({ localCount: 2000, remoteCount: 4000, mergedCount: 4000 }).corrupt, true, 'additive poisoning');
  assert.equal(classifyMerge({ localCount: 2000, remoteCount: 2100, mergedCount: 2100 }).corrupt, false, 'normal growth must pass');
});

test('classifyMerge: the shrink alarm needs BOTH margins — 900 keys green, 5,000 keys red (S-01)', () => {
  // The production geometry: 42,382 keys in the real state.
  const local = 42387;
  // A busy cycle that adds 900 keys: the OLD relative-only rule (2 % = 847
  // keys) turned this RED, blocked the chain and stopped the bot from
  // publishing. It must be GREEN.
  const busy = classifyMerge({ localCount: local, remoteCount: local - 900, mergedCount: local });
  assert.equal(busy.corrupt, false, 'a 900-key gap must not block the state push');
  assert.equal(busy.reason, 'ok');
  // A real truncation of 5,000 keys must still be RED.
  const truncated = classifyMerge({ localCount: local, remoteCount: local - 5000, mergedCount: local });
  assert.equal(truncated.corrupt, true, 'a 5,000-key gap is a real truncation');
  assert.equal(truncated.reason, 'shrink');
  // The relative margin still applies on top of the absolute one.
  const relative = classifyMerge({ localCount: 200000, remoteCount: 200000 - 5000, mergedCount: 200000 });
  assert.equal(relative.corrupt, true, '5 % of 200,000 keys is above the relative margin');
  // The floor and the growth guard are unchanged.
  assert.equal(classifyMerge({ localCount: 2000, remoteCount: 2000, mergedCount: 999 }).corrupt, true, 'the floor still holds');
  assert.equal(classifyMerge({ localCount: 2000, remoteCount: 4000, mergedCount: 4000 }).reason, 'growth', 'the growth guard still holds');
});

test('classifyProvenance: a known foreign author is refused; an unverifiable one cannot block forever', () => {
  assert.equal(classifyProvenance('github-actions[bot]').corrupt, false);
  assert.equal(classifyProvenance('mohamed').corrupt, true);
  // A shallow-fetch boundary can hide the last-touching commit. Treating an
  // empty author as corruption blocked the state push permanently.
  assert.equal(classifyProvenance('').corrupt, false);
  assert.equal(classifyProvenance('').reason, 'unverifiable');
  // Both author and committer are checked; a forged committer is refused.
  assert.equal(classifyProvenance('github-actions[bot]', 'mohamed').corrupt, true);
  assert.equal(classifyProvenance('github-actions[bot]', 'github-actions[bot]').corrupt, false);
});

test('mergeTitleMap: negative === false wins, otherwise the higher ts wins, and both sides are preserved', () => {
  const now = Date.now();
  const ours = {
    a: { negative: true, ts: now - 5000 },
    b: { negative: false, ts: now - 1000 },
    d: { negative: false, ts: now - 9000 },
  };
  const theirs = {
    a: { negative: false, ts: now - 100 },
    c: { negative: false, ts: now - 100 },
    d: { negative: false, ts: now - 1000 },
  };
  const merged = mergeTitleMap(ours, theirs, { now });
  assert.equal(merged.merged.a.negative, false, 'negative === false must win');
  assert.equal(merged.merged.d.ts, now - 1000, 'equal negative -> the higher ts wins');
  assert.ok(merged.merged.b, 'a local-only entry must be preserved');
  assert.ok(merged.merged.c, 'a remote-only entry must be preserved');
});

test('validateTitleMap: the measured maxima are accepted and an invalid shape is rejected', () => {
  const entry = {
    id: 209219,
    romaji: 'Tensei Goblin',
    english: "So What's Wrong with Getting Reborn as a Goblin?",
    synonyms: new Array(16).fill('s'),
    relations: new Array(20).fill({ relationType: 'ADAPTATION' }),
    negative: false,
    ts: 1792415450596,
  };
  const ok = validateTitleMap({ k: entry });
  assert.equal(ok.valid, true);
  assert.equal(ok.rejected.length, 0, '16 synonyms / 20 relations are the measured maxima');
  assert.equal(validateTitleMap({ k: { ...entry, synonyms: new Array(65).fill('s') } }).rejected[0].reason, 'synonyms-too-many');
  assert.equal(validateTitleMap({ k: { ...entry, relations: new Array(65).fill({}) } }).rejected[0].reason, 'relations-too-many');
  assert.equal(validateTitleMap({ k: 'not-an-object' }).rejected[0].reason, 'not-an-object');
  assert.equal(validateTitleMap({ k: { negative: false } }).rejected[0].reason, 'ts-not-finite');
  assert.equal(validateTitleMap({ k: { ts: 1 } }).rejected[0].reason, 'negative-not-boolean');
  assert.equal(validateTitleMap([]).valid, false);
});

test('pushStateWithRetries: the push succeeds on the third attempt', async () => {
  const calls = [];
  let pushAttempts = 0;
  const runGit = makeGitFake({
    remotePosted: JSON.stringify(makeKeys(1500, 'remote')),
    calls,
    onPush: () => {
      pushAttempts++;
      return { code: pushAttempts < 3 ? 1 : 0, stdout: '', stderr: pushAttempts < 3 ? 'rejected' : '' };
    }
  });
  const writes = new Map();
  const local = makeKeys(1500, 'local');

  const result = await pushStateWithRetries({
    runGit,
    attempts: 3,
    readFile: makeReadFile(local),
    exists: () => true,
    writeFile: (p, data) => writes.set(p, data),
    log: () => {}
  });

  assert.equal(result.stateCorrupt, false);
  assert.equal(result.pushFailed, false);
  assert.equal(result.attempts, 3, 'the third attempt must be used');
  assert.equal(pushAttempts, 3);
  assert.ok(result.log.some(l => l.includes('✅ State pushed.')));
});

test('pushStateWithRetries: three failed pushes are reported as push_failed', async () => {
  const calls = [];
  const runGit = makeGitFake({
    remotePosted: JSON.stringify(makeKeys(1500, 'remote')),
    calls,
    pushCode: 1
  });
  const result = await pushStateWithRetries({
    runGit,
    attempts: 3,
    readFile: makeReadFile(makeKeys(1500, 'local')),
    exists: () => true,
    writeFile: () => {},
    log: () => {}
  });
  assert.equal(result.stateCorrupt, false);
  assert.equal(result.pushFailed, true, 'three failed attempts must set push_failed');
  assert.equal(result.attempts, 3);
  assert.ok(result.log.some(l => l.includes('::error::state push failed after 3 attempts')));
});

test('pushStateWithRetries: a corrupt merge is red — nothing is written and nothing is pushed', async () => {
  const calls = [];
  const writes = [];
  // The remote lost most of its keys -> the shrink guard trips.
  const runGit = makeGitFake({
    remotePosted: JSON.stringify(makeKeys(10, 'remote')),
    calls
  });
  const result = await pushStateWithRetries({
    runGit,
    attempts: 3,
    readFile: makeReadFile(makeKeys(2000, 'local')),
    exists: () => true,
    writeFile: (p) => writes.push(p),
    log: () => {}
  });
  assert.equal(result.stateCorrupt, true, 'a shrink must be red');
  assert.equal(result.reason, 'shrink');
  assert.deepEqual(writes, [], 'nothing may be written on a red merge');
  assert.equal(calls.some(c => c.args.includes('push')), false, 'no push may be attempted on a red merge');
  assert.ok(result.log.some(l => l.includes('::error::state corrupt: shrink detected against remote baseline')));
});

test('pushStateWithRetries: a remote that is not authored by github-actions[bot] is refused', async () => {
  const calls = [];
  const writes = [];
  const runGit = makeGitFake({
    remotePosted: JSON.stringify(makeKeys(2000, 'remote')),
    author: 'somebody-else',
    calls
  });
  const result = await pushStateWithRetries({
    runGit,
    attempts: 3,
    readFile: makeReadFile(makeKeys(2000, 'local')),
    exists: () => true,
    writeFile: (p) => writes.push(p),
    log: () => {}
  });
  assert.equal(result.stateCorrupt, true, 'a foreign provenance must be red');
  assert.equal(result.reason, 'provenance');
  assert.deepEqual(writes, [], 'nothing may be written');
  assert.equal(calls.some(c => c.args.includes('push')), false, 'no push may be attempted');
  assert.ok(result.log.some(l => l.includes('::error::state corrupt: remote provenance rejected')));
});

test('pushStateWithRetries: the commit is built on the fetched tip and pushed with an explicit refspec', async () => {
  const calls = [];
  const runGit = makeGitFake({
    remotePosted: JSON.stringify(makeKeys(1500, 'remote')),
    calls
  });
  const result = await pushStateWithRetries({
    runGit,
    attempts: 3,
    readFile: makeReadFile(makeKeys(1500, 'local')),
    exists: () => true,
    writeFile: () => {},
    log: () => {}
  });
  assert.equal(result.pushFailed, false);
  const commitCall = calls.find(c => c.args.includes('commit-tree'));
  assert.ok(commitCall, 'commit-tree must be used');
  assert.equal(commitCall.args[commitCall.args.indexOf('-p') + 1], 'deadbeef', 'the commit parent must be the fetched remote tip');
  const pushCall = calls.find(c => c.args.includes('push'));
  assert.ok(pushCall.args.includes('commit1111:refs/heads/main'), `the push must use an explicit refspec: ${JSON.stringify(pushCall.args)}`);
  // The index commands must run against a TEMP index: the repository's own
  // index (and therefore the working tree) must never be touched.
  for (const c of calls) {
    if (c.args.includes('read-tree') || c.args.includes('hash-object') || c.args.includes('update-index') || c.args.includes('write-tree') || c.args.includes('commit-tree')) {
      assert.ok(c.env && c.env.GIT_INDEX_FILE, `${c.args[0]} must run with GIT_INDEX_FILE set to a temp index`);
    }
  }
  // No pull / merge / checkout is ever used.
  for (const c of calls) {
    assert.equal(c.args.includes('pull'), false, 'git pull must never be used');
    assert.equal(c.args.includes('merge'), false, 'git merge must never be used');
    assert.equal(c.args.includes('checkout'), false, 'git checkout must never be used');
  }
});

test('pushStateWithRetries: the credential is a per-command extraheader, never part of a URL', async () => {
  const calls = [];
  const runGit = makeGitFake({
    remotePosted: JSON.stringify(makeKeys(1500, 'remote')),
    calls
  });
  await pushStateWithRetries({
    runGit,
    attempts: 3,
    token: 'SUPER-SECRET-TOKEN',
    readFile: makeReadFile(makeKeys(1500, 'local')),
    exists: () => true,
    writeFile: () => {},
    log: () => {}
  });
  const pushCall = calls.find(c => c.args.includes('push'));
  assert.ok(pushCall, 'a push must be attempted');
  // The credential travels in the child's ENVIRONMENT, never in argv: a
  // `-c ...extraheader=<base64 token>` argument is visible in process
  // listings and git trace, and log masking does not cover the base64 value.
  const env = pushCall.env || {};
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.match(String(env.GIT_CONFIG_VALUE_0 || ''), /^AUTHORIZATION: basic [A-Za-z0-9+/=]+$/);
  assert.equal(pushCall.args.some(a => a.startsWith('http.https://github.com/.extraheader=')), false,
    'the credential must NOT be a git -c argument');
  assert.equal(pushCall.args.some(a => a.includes('SUPER-SECRET-TOKEN')), false, 'the token must never appear in an argument');
  assert.equal(JSON.stringify(pushCall.args).includes('AUTHORIZATION'), false, 'no auth material in argv');
  assert.equal(pushCall.args.some(a => a.includes('@github.com')), false, 'no credential may be part of a URL');
});

test('the merged file is written with JSON.stringify(x, null, 2) and parses back to the merged size', async () => {
  const writes = new Map();
  const local = makeKeys(1500, 'local');
  const remote = makeKeys(1500, 'remote');
  const runGit = makeGitFake({ remotePosted: JSON.stringify(remote) });
  await pushStateWithRetries({
    runGit,
    attempts: 1,
    readFile: makeReadFile(local),
    exists: () => true,
    writeFile: (p, data) => writes.set(p, data),
    log: () => {}
  });
  const content = writes.get('data/posted.json');
  assert.ok(content, 'data/posted.json must be written');
  const expected = [...new Set([...local, ...remote])];
  assert.equal(content, JSON.stringify(expected, null, 2), 'the file must use the production format');
  assert.equal(JSON.parse(content).length, expected.length);
});

test('a key containing Arabic text and ⅱ survives merge -> write -> read unchanged', async () => {
  const key = 'Anime Season 2 ⅱ [عربي]';
  const writes = new Map();
  const local = [...makeKeys(1500, 'local'), key];
  const runGit = makeGitFake({ remotePosted: JSON.stringify(makeKeys(1500, 'remote')) });
  await pushStateWithRetries({
    runGit,
    attempts: 1,
    readFile: makeReadFile(local),
    exists: () => true,
    writeFile: (p, data) => writes.set(p, data),
    log: () => {}
  });
  const content = writes.get('data/posted.json');
  const parsed = JSON.parse(content);
  assert.ok(parsed.includes(key), 'the UTF-8 key must survive the round trip');
  assert.equal(parsed.filter(k => k === key).length, 1, 'the key must appear exactly once');
  assert.ok(content.includes(key), 'the key must be written verbatim (UTF-8)');
});

test('pushStateWithRetries: a remote that grew far beyond the allowance is refused', async () => {
  const calls = [];
  const writes = [];
  const runGit = makeGitFake({
    remotePosted: JSON.stringify(makeKeys(3000, 'remote')),
    calls
  });
  const result = await pushStateWithRetries({
    runGit,
    attempts: 3,
    readFile: makeReadFile(makeKeys(1000, 'local')),
    exists: () => true,
    writeFile: (p) => writes.push(p),
    log: () => {}
  });
  assert.equal(result.stateCorrupt, true, 'an oversized remote must be red');
  assert.equal(result.reason, 'growth');
  assert.deepEqual(writes, [], 'nothing may be written');
  assert.equal(calls.some(c => c.args.includes('push')), false, 'no push may be attempted');
  assert.ok(result.log.some(l => l.includes('::error::state corrupt: remote growth exceeds allowance')));
});

// ===========================================================================
// FIX ROUND 1 — M-03 / M-04 / M-05 / M-06 / M-08
// ===========================================================================

test('a failed state write is visible: the cycle summary carries failed >= 1 (M-03)', async () => {
  const dir = tmp();
  const r = runIn(dir, `
    const fs = (await import('node:fs')).default;
    fs.writeFileSync = () => { throw new Error('disk full'); };
    const summary = { attempted: 1, published: 1, failed: 0, deferred: 0, skipped: 0, sourceErrors: 0 };
    const saved = m.finalizePostedState(new Set(['k1']), summary);
    console.log('SAVED=' + saved);
    console.log('FAILED=' + summary.failed);
  `);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status} (stderr=${r.stderr})`);
  assert.match(r.stdout, /SAVED=false/, 'the failed write must be reported to the caller');
  assert.match(r.stdout, /FAILED=1/, 'the failed write must count as a failure (not a deferral)');
  assert.match(r.stderr, /state write failed/, `the failed write needs its own log line: ${r.stderr}`);
});

test('the size guard: a duplicate mark performs no write and resetPostedSizeGuard() makes the next mark write again (M-04)', async () => {
  const dir = tmp();
  const r = runIn(dir, `
    const fs = (await import('node:fs')).default;
    const origWrite = fs.writeFileSync, origRename = fs.renameSync;
    let writes = 0;
    fs.writeFileSync = (...a) => { writes++; return origWrite.apply(fs, a); };
    fs.renameSync = (...a) => origRename.apply(fs, a);
    const s = m.loadPostedIds();
    m.markReleaseAsPosted(s, 'tg_5_500', ['guard_ep_1']);
    console.log('WRITES_1=' + writes);
    m.markReleaseAsPosted(s, 'tg_5_500', ['guard_ep_1']);
    console.log('WRITES_2=' + writes);
    console.log('GUARD=' + m.getPostedSizeGuard());
    m.resetPostedSizeGuard();
    console.log('GUARD_AFTER_RESET=' + m.getPostedSizeGuard());
    m.markReleaseAsPosted(s, 'tg_5_500', ['guard_ep_1']);
    console.log('WRITES_3=' + writes);
    fs.writeFileSync = origWrite; fs.renameSync = origRename;
  `);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status} (stderr=${r.stderr})`);
  assert.match(r.stdout, /WRITES_1=1/, 'the first mark must write exactly once');
  assert.match(r.stdout, /WRITES_2=1/, 'a duplicate mark must not write again');
  assert.match(r.stdout, /GUARD=2/, 'the guard counter must track the written size');
  assert.match(r.stdout, /GUARD_AFTER_RESET=-1/, 'the reset must clear the guard');
  assert.match(r.stdout, /WRITES_3=2/, 'after the reset the next mark must write again');
});

test('the fatal creator does not print the fatal code — the runner logs it once (M-05)', async () => {
  const dir = tmp();
  const r = runIn(dir, "const e = m.createFatalError('CHANNELS_ZERO', 'boom'); console.log('CODE=' + e.fatalCode);");
  assert.equal(r.status, 0, `expected exit 0, got ${r.status} (stderr=${r.stderr})`);
  assert.match(r.stdout, /CODE=CHANNELS_ZERO/, 'the fatal error must carry its code');
  assert.equal(/🔴 fatal:/.test(r.stderr), false, `the creator must not print the fatal code: ${r.stderr}`);
  assert.equal(/🔴 fatal:/.test(r.stdout), false, `the creator must not print the fatal code: ${r.stdout}`);
});

test('merge-only CLI: the defaults do not crash and the title-map flags are honoured (M-06)', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'posted.json'), JSON.stringify(makeKeys(1500, 'local'), null, 2));
  fs.writeFileSync(path.join(dir, 'title-local.json'), JSON.stringify({ a: { negative: false, ts: 1000 } }));
  fs.writeFileSync(path.join(dir, 'title-remote.json'), JSON.stringify({ b: { negative: false, ts: 2000 } }));

  // (1) NO flags at all: the defaults must not crash (the old code
  // dereferenced args.local / args.remote without a default).
  const plain = runMerge(dir);
  assert.equal(plain.status, 0, `the merge-only CLI must not crash: ${plain.stderr}`);
  assert.match(plain.stdout, /merged 1500 key/, 'the default paths must be merged');
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'posted.json'), 'utf8'));
  assert.equal(written.length, 1500, 'the merged state must be written');

  // (2) the title-map flags are honoured — never silently ignored.
  const withTitles = runMerge(dir, [
    '--title-map-local', 'title-local.json',
    '--title-map-remote', 'title-remote.json',
    '--title-map-out', 'title-out.json',
  ]);
  assert.equal(withTitles.status, 0, `the merge-only CLI must not crash: ${withTitles.stderr}`);
  const mergedTitle = JSON.parse(fs.readFileSync(path.join(dir, 'title-out.json'), 'utf8'));
  assert.deepEqual(Object.keys(mergedTitle).sort(), ['a', 'b'], 'both title-map sides must survive the per-key merge');
  assert.equal(mergedTitle.a.ts, 1000);
  assert.equal(mergedTitle.b.ts, 2000);
});

test('the merge script is the sole writer of the state outputs and keeps the default-deny (M-08)', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'posted.json'), JSON.stringify(makeKeys(1500, 'local'), null, 2));
  const outputFile = path.join(dir, 'github-output');

  // (1) a successful merge writes exactly ONE state_corrupt=false.
  const ok = runMerge(dir, ['--github-output', outputFile]);
  assert.equal(ok.status, 0, `expected exit 0, got ${ok.status} (stderr=${ok.stderr})`);
  const body = fs.readFileSync(outputFile, 'utf8');
  assert.equal((body.match(/^state_corrupt=/gm) || []).length, 1, `the script is the sole writer: ${JSON.stringify(body)}`);
  assert.match(body, /^state_corrupt=false$/m, `the merge must clear the default-deny: ${JSON.stringify(body)}`);
  assert.match(body, /^push_failed=false$/m);

  // (2) a corrupt state keeps the default-deny (the chain stays blocked).
  fs.writeFileSync(path.join(dir, 'data', 'posted.json'), '{broken');
  const bad = runMerge(dir, ['--github-output', outputFile]);
  assert.notEqual(bad.status, 0, 'a corrupt state must be red');
  const badBody = fs.readFileSync(outputFile, 'utf8');
  assert.match(badBody, /^state_corrupt=true$/m, `the default-deny must survive: ${JSON.stringify(badBody)}`);
});

// ===========================================================================
// FIX ROUND 2 — P-8/F-01 / F-02 / P-2 / P-3 / P-6 / P-7 / P-9 + new gates
// ===========================================================================

test('P-8/F-01: an absent remote state file bootstraps — the local state is pushed, not blocked forever', async () => {
  const calls = [];
  const writes = new Map();
  let pushCalls = 0;
  const runGit = async (args, opts = {}) => {
    calls.push({ args: args.slice(), env: (opts && opts.env) || null, cwd: (opts && opts.cwd) || null });
    if (args.includes('fetch')) return { code: 0, stdout: '', stderr: '' };
    if (args.includes('rev-parse')) return { code: 0, stdout: 'deadbeef\n', stderr: '' };
    if (args.includes('show')) return { code: 1, stdout: '', stderr: 'fatal: path data/posted.json not in HEAD' };
    if (args.includes('log')) return { code: 0, stdout: 'github-actions[bot]\n', stderr: '' };
    if (args.includes('hash-object')) return { code: 0, stdout: 'blob0000\n', stderr: '' };
    if (args.includes('write-tree')) return { code: 0, stdout: 'tree1111\n', stderr: '' };
    if (args.includes('commit-tree')) return { code: 0, stdout: 'commit1111\n', stderr: '' };
    if (args.includes('push')) { pushCalls++; return { code: pushCalls < 2 ? 1 : 0, stdout: '', stderr: pushCalls < 2 ? 'rejected' : '' }; }
    return { code: 0, stdout: '', stderr: '' };
  };
  const local = makeKeys(1500, 'local');
  const result = await pushStateWithRetries({
    runGit,
    attempts: 3,
    readFile: makeReadFile(local),
    exists: () => true,
    writeFile: (p, data) => writes.set(p, data),
    log: () => {},
    cwd: '/repo',
  });
  assert.equal(result.stateCorrupt, false, 'an ABSENT remote must bootstrap, not fail closed');
  assert.equal(result.pushFailed, false);
  assert.equal(result.attempts, 2, 'the retry loop must recover on the next attempt');
  assert.ok(calls.some(c => c.args.includes('push')), 'the local state must be pushed on the bootstrap path');
  assert.ok(result.log.some(l => l.includes('ℹ️ remote state file absent — treating the local state as authoritative for this push')), JSON.stringify(result.log));
  assert.equal(result.log.some(l => l.includes('::error::state corrupt:')), false, 'no corrupt error may be emitted for an absent remote');
  const content = writes.get('data/posted.json');
  assert.ok(content, 'the local state must be written');
  assert.equal(JSON.parse(content).length, 1500);
});

test('P-8/F-01: a present-but-corrupt remote state file stays fail-closed red', async () => {
  const calls = [];
  const writes = [];
  const result = await pushStateWithRetries({
    runGit: makeGitFake({ remotePosted: '{broken', calls }),
    attempts: 2,
    readFile: makeReadFile(makeKeys(1500, 'local')),
    exists: () => true,
    writeFile: (p) => writes.push(p),
    log: () => {},
  });
  assert.equal(result.stateCorrupt, true, 'a PRESENT corrupt remote must be red');
  assert.equal(result.reason, 'posted-validation');
  assert.deepEqual(writes, [], 'nothing may be written on a red merge');
  assert.equal(calls.some(c => c.args.includes('push')), false, 'no push may be attempted on a red merge');
  assert.ok(result.log.some(l => l.includes('::error::state corrupt: posted.json failed validation')));
});

test('P-8/F-01: a present-but-empty remote state array is fail-closed red (empty is not absent)', async () => {
  const calls = [];
  const writes = [];
  const result = await pushStateWithRetries({
    runGit: makeGitFake({ remotePosted: '[]', calls }),
    attempts: 2,
    readFile: makeReadFile(makeKeys(1500, 'local')),
    exists: () => true,
    writeFile: (p) => writes.push(p),
    log: () => {},
  });
  assert.equal(result.stateCorrupt, true, 'an EMPTY-but-present remote array must stay red');
  assert.equal(result.reason, 'shrink');
  assert.deepEqual(writes, []);
  assert.equal(calls.some(c => c.args.includes('push')), false);
  assert.ok(result.log.some(l => l.includes('::error::state corrupt: shrink detected against remote baseline')));
});

test('P-8/F-01: with the remote absent, an invalid local side is still red (the local validation holds)', async () => {
  const calls = [];
  const writes = [];
  const runGit = async (args, opts = {}) => {
    calls.push({ args: args.slice(), env: (opts && opts.env) || null, cwd: (opts && opts.cwd) || null });
    if (args.includes('fetch')) return { code: 0, stdout: '', stderr: '' };
    if (args.includes('rev-parse')) return { code: 0, stdout: 'deadbeef\n', stderr: '' };
    if (args.includes('show')) return { code: 1, stdout: '', stderr: 'fatal: path data/posted.json not in HEAD' };
    if (args.includes('log')) return { code: 0, stdout: 'github-actions[bot]\n', stderr: '' };
    if (args.includes('hash-object')) return { code: 0, stdout: 'blob0000\n', stderr: '' };
    if (args.includes('write-tree')) return { code: 0, stdout: 'tree1111\n', stderr: '' };
    if (args.includes('commit-tree')) return { code: 0, stdout: 'commit1111\n', stderr: '' };
    if (args.includes('push')) return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const result = await pushStateWithRetries({
    runGit,
    attempts: 2,
    readFile: () => '{broken',
    exists: () => true,
    writeFile: (p) => writes.push(p),
    log: () => {},
  });
  assert.equal(result.stateCorrupt, true, 'the LOCAL side must still be validated when the remote is absent');
  assert.equal(result.reason, 'posted-validation');
  assert.deepEqual(writes, []);
  assert.equal(calls.some(c => c.args.includes('push')), false);
  assert.ok(result.log.some(l => l.includes('::error::state corrupt: posted.json failed validation')));
});

test('P-3: the byte cap measures the pretty serialization that is actually written', () => {
  // ~80,000 keys of 100 chars: compact ≈ 8.24 MB (under the cap), pretty ≈ 8.48 MB (over).
  const keys = new Array(80_000).fill(0).map((_, i) => {
    let k = `anime_episode_${String(i).padStart(6, '0')}_`;
    while (k.length < 100) k += 'y';
    return k;
  });
  const compactBytes = Buffer.byteLength(JSON.stringify(keys));
  const prettyBytes = Buffer.byteLength(JSON.stringify(keys, null, 2));
  assert.ok(compactBytes <= MAX_BYTES, `the compact serialization (${compactBytes}) must stay under the cap`);
  assert.ok(prettyBytes > MAX_BYTES, `the pretty serialization (${prettyBytes}) must exceed the cap`);
  const res = validatePostedIds(keys);
  assert.equal(res.valid, false, 'a pretty payload over the cap must be rejected even if its compact form is under');
  assert.match(res.rejected[0].reason, /too-large/);
});

test('P-6: git hash-object -w --stdin and git hash-object -w <path> produce the same SHA', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const content = JSON.stringify(makeKeys(1500, 'local'), null, 2);
  fs.writeFileSync(path.join(dir, 'data', 'posted.json'), content);
  // `hash-object -w` writes into the object database — it needs a repository.
  git(dir, ['init', '-q']);
  const byPath = String(git(dir, ['hash-object', '-w', 'data/posted.json'])).trim();
  const byStdin = String(execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: content, encoding: 'utf8' })).trim();
  assert.equal(byPath, byStdin, 'hashing the in-memory buffer and hashing the written file must give the same blob SHA');
});

test('P-7: the union result is identical to the previous implementation (single Set, duplicates included)', () => {
  const local = ['a', 'b', 'a', 'c'];
  const remote = ['c', 'd', 'b'];
  const merged = mergePostedIds(local, remote);
  const expected = [...new Set([...new Set(local), ...new Set(remote)])];
  assert.deepEqual(merged.merged, expected, 'the union must keep insertion order and drop duplicates exactly like before');
  assert.deepEqual(merged.merged, ['a', 'b', 'c', 'd']);
  assert.equal(merged.localCount, 3);
  assert.equal(merged.remoteCount, 3);
  const again = mergePostedIds(merged.merged, merged.merged);
  assert.deepEqual(again.merged, merged.merged);
});

test('P-9: the posted set is add-only (never shrunk via delete/clear)', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'telegram-client.mjs'), 'utf8');
  assert.equal(/posted\.delete\(/.test(src), false, 'the posted set must never be deleted from');
  assert.equal(/\.clear\(/.test(src), false, 'the posted set must never be cleared');
});

test('push-path fail-closed: an invalid local side writes nothing, pushes nothing and is red', async () => {
  const calls = [];
  const writes = [];
  const result = await pushStateWithRetries({
    runGit: makeGitFake({ remotePosted: JSON.stringify(makeKeys(1500, 'remote')), calls }),
    attempts: 2,
    readFile: () => '{broken',
    exists: () => true,
    writeFile: (p) => writes.push(p),
    log: () => {},
  });
  assert.equal(result.stateCorrupt, true, 'an unparseable local side must be red');
  assert.equal(result.reason, 'posted-validation');
  assert.deepEqual(writes, [], 'zero file writes may happen on a red push path');
  assert.equal(calls.some(c => c.args.includes('push')), false, 'zero git push calls may happen on a red push path');
  assert.ok(result.log.some(l => l.includes('::error::state corrupt: posted.json failed validation')));

  // The merge-only CLI shares the same fail-closed contract: exit 1 + the
  // same fixed error line, and the default-deny survives.
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'posted.json'), JSON.stringify({ not: 'an array' }, null, 2));
  const outputFile = path.join(dir, 'github-output');
  const bad = runMerge(dir, ['--github-output', outputFile]);
  assert.notEqual(bad.status, 0, 'a non-array local side must be red through the merge-only CLI');
  assert.ok(bad.stderr.includes('::error::state corrupt: posted.json failed validation'), `stderr=${bad.stderr}`);
  assert.match(fs.readFileSync(outputFile, 'utf8'), /^state_corrupt=true$/m);
});

test('push-path fail-closed: an oversize REMOTE side is red — nothing is written, nothing is pushed', async () => {
  const calls = [];
  const writes = [];
  const tooMany = JSON.stringify(new Array(MAX_ELEMENTS + 1).fill('k'));
  const result = await pushStateWithRetries({
    runGit: makeGitFake({ remotePosted: tooMany, calls }),
    attempts: 2,
    readFile: makeReadFile(makeKeys(1500, 'local')),
    exists: () => true,
    writeFile: (p) => writes.push(p),
    log: () => {},
  });
  assert.equal(result.stateCorrupt, true, 'an oversize remote side must be red');
  assert.equal(result.reason, 'posted-validation');
  assert.deepEqual(writes, [], 'nothing may be written on a red push path');
  assert.equal(calls.some(c => c.args.includes('push')), false, 'no push may be attempted on a red push path');
  assert.ok(result.log.some(l => l.includes('::error::state corrupt: posted.json failed validation')));
});

test('push-path: rejected elements are counted and the valid keys still merge', async () => {
  const writes = new Map();
  const local = [...makeKeys(1500, 'local'), ''];
  const result = await pushStateWithRetries({
    runGit: makeGitFake({ remotePosted: JSON.stringify(makeKeys(1500, 'remote')) }),
    attempts: 1,
    readFile: makeReadFile(local),
    exists: () => true,
    writeFile: (p, data) => writes.set(p, data),
    log: () => {},
  });
  assert.equal(result.stateCorrupt, false, 'a side holding a few invalid elements is red only for those');
  assert.equal(result.pushFailed, false);
  assert.ok(result.log.some(l => l.includes('⚠️ rejected 1 invalid key(s) during validation')), JSON.stringify(result.log));
  const merged = JSON.parse(writes.get('data/posted.json'));
  assert.equal(merged.length, 3000, 'the valid keys of both sides merge (1500 local + 1500 remote), the invalid element is dropped and counted');
  assert.equal(merged.includes(''), false, 'the rejected element must not survive the merge');
});

test('push-path title-map: an absent/corrupt remote degrades to the valid local side, both-invalid is red', async () => {
  const writes = new Map();
  const corruptTitleFake = async (args, opts = {}) => {
    if (args.includes('fetch')) return { code: 0, stdout: '', stderr: '' };
    if (args.includes('rev-parse')) return { code: 0, stdout: 'deadbeef\n', stderr: '' };
    if (args.includes('show')) return { code: 0, stdout: String(args[args.length - 1]).includes('title-map') ? '{broken' : JSON.stringify(makeKeys(1500, 'remote')), stderr: '' };
    if (args.includes('log')) return { code: 0, stdout: 'github-actions[bot]\n', stderr: '' };
    if (args.includes('hash-object')) return { code: 0, stdout: 'blob0000\n', stderr: '' };
    if (args.includes('write-tree')) return { code: 0, stdout: 'tree1111\n', stderr: '' };
    if (args.includes('commit-tree')) return { code: 0, stdout: 'commit1111\n', stderr: '' };
    if (args.includes('push')) return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const ok = await pushStateWithRetries({
    runGit: corruptTitleFake,
    attempts: 1,
    readFile: makeReadFile(makeKeys(1500, 'local')),
    exists: () => true,
    writeFile: (p, data) => writes.set(p, data),
    log: () => {},
  });
  assert.equal(ok.stateCorrupt, false, 'a corrupt REMOTE title-map with a valid local side degrades to the valid side');
  assert.equal(ok.pushFailed, false);

  const writes2 = [];
  const bothBad = await pushStateWithRetries({
    runGit: corruptTitleFake,
    attempts: 1,
    readFile: (p) => String(p).includes('title-map') ? '{broken' : JSON.stringify(makeKeys(1500, 'local')),
    exists: () => true,
    writeFile: (p) => writes2.push(p),
    log: () => {},
  });
  assert.equal(bothBad.stateCorrupt, true, 'an invalid shape on BOTH title-map sides is red');
  assert.equal(bothBad.reason, 'title-map-validation');
  assert.deepEqual(writes2, [], 'nothing may be written when the title map is red');
});

test('F-02: the temp index is unique per attempt, cleaned up after each attempt, and carries the configured cwd', async () => {
  const calls = [];
  const writes = new Map();
  let pushCalls = 0;
  const runGit = async (args, opts = {}) => {
    calls.push({ args: args.slice(), env: (opts && opts.env) || null, cwd: (opts && opts.cwd) || null });
    if (args.includes('fetch')) return { code: 0, stdout: '', stderr: '' };
    if (args.includes('rev-parse')) return { code: 0, stdout: 'deadbeef\n', stderr: '' };
    if (args.includes('show')) return { code: 1, stdout: '', stderr: 'fatal: path data/posted.json not in HEAD' };
    if (args.includes('log')) return { code: 0, stdout: 'github-actions[bot]\n', stderr: '' };
    if (args.includes('hash-object')) return { code: 0, stdout: 'blob0000\n', stderr: '' };
    if (args.includes('write-tree')) return { code: 0, stdout: 'tree1111\n', stderr: '' };
    if (args.includes('commit-tree')) return { code: 0, stdout: 'commit1111\n', stderr: '' };
    if (args.includes('push')) { pushCalls++; return { code: pushCalls < 2 ? 1 : 0, stdout: '', stderr: pushCalls < 2 ? 'rejected' : '' }; }
    return { code: 0, stdout: '', stderr: '' };
  };
  const tempDir = tmp();
  const result = await pushStateWithRetries({
    runGit,
    attempts: 3,
    readFile: makeReadFile(makeKeys(1500, 'local')),
    exists: () => true,
    writeFile: (p, data) => writes.set(p, data),
    log: () => {},
    cwd: '/repo',
    tempDir,
  });
  assert.equal(result.attempts, 2, 'the second attempt must succeed after the first push failure');
  // (c) EVERY git call carries the configured cwd — not only the plumbing.
  for (const c of calls) {
    assert.equal(c.cwd, '/repo', `every git call must carry the configured cwd: ${JSON.stringify(c.args)}`);
  }
  const indexCalls = calls.filter(c => c.args.some(a => ['read-tree', 'hash-object', 'update-index', 'write-tree', 'commit-tree', 'push'].includes(a)));
  assert.ok(indexCalls.length > 0, 'the plumbing calls must run');
  for (const c of indexCalls) {
    assert.ok(c.env && c.env.GIT_INDEX_FILE, `${c.args[0]} must run with GIT_INDEX_FILE set`);
  }
  // (a) two attempts, two different temp indexes.
  const indexFiles = new Set(indexCalls.map(c => c.env.GIT_INDEX_FILE));
  assert.equal(indexFiles.size, 2, `two attempts must use two different temp indexes: ${JSON.stringify([...indexFiles])}`);
  for (const f of indexFiles) {
    const base = path.basename(f);
    assert.match(base, new RegExp(`^state-index-${process.pid}-\\d+$`), `the temp index must be per-attempt: ${base}`);
  }
  // (b) EVERY attempt's index file is gone once the attempt is over.
  for (const f of indexFiles) {
    assert.equal(fs.existsSync(f), false, `the temp index must be cleaned up after the attempt: ${f}`);
  }
});

test('F-02: the GIT_INDEX_FILE travels across a multi-attempt failure scenario', async () => {
  const calls = [];
  let pushCalls = 0;
  const runGit = async (args, opts = {}) => {
    calls.push({ args: args.slice(), env: (opts && opts.env) || null, cwd: (opts && opts.cwd) || null });
    if (args.includes('fetch')) return { code: 0, stdout: '', stderr: '' };
    if (args.includes('rev-parse')) return { code: 0, stdout: 'deadbeef\n', stderr: '' };
    if (args.includes('show')) return { code: 1, stdout: '', stderr: 'fatal: path data/posted.json not in HEAD' };
    if (args.includes('log')) return { code: 0, stdout: 'github-actions[bot]\n', stderr: '' };
    if (args.includes('hash-object')) return { code: 0, stdout: 'blob0000\n', stderr: '' };
    if (args.includes('write-tree')) return { code: 0, stdout: 'tree1111\n', stderr: '' };
    if (args.includes('commit-tree')) return { code: 0, stdout: 'commit1111\n', stderr: '' };
    if (args.includes('push')) { pushCalls++; return { code: pushCalls < 2 ? 1 : 0, stdout: '', stderr: pushCalls < 2 ? 'rejected' : '' }; }
    return { code: 0, stdout: '', stderr: '' };
  };
  const tempDir = tmp();
  const result = await pushStateWithRetries({ runGit, attempts: 3, readFile: makeReadFile(makeKeys(1500, 'local')), exists: () => true, writeFile: () => {}, log: () => {}, cwd: '/repo', tempDir });
  assert.equal(result.attempts, 2);
  const readTreeCalls = calls.filter(c => c.args.includes('read-tree'));
  assert.equal(readTreeCalls.length, 2, 'each attempt re-runs read-tree on the fresh tip');
  assert.notEqual(readTreeCalls[0].env.GIT_INDEX_FILE, readTreeCalls[1].env.GIT_INDEX_FILE, 'the temp index must differ per attempt');
  assert.equal(readTreeCalls[0].env.GIT_INDEX_FILE, path.join(tempDir, `state-index-${process.pid}-1`), 'the first attempt must use its own index');
});

test('real-git integration: a ≥2.1 MB posted.json blob pushes over a real remote', async () => {
  const remoteDir = tmp();
  git(remoteDir, ['init', '-q', '--bare', '-b', 'main']);
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const keys = [];
  for (let i = 0; i < 20_000; i++) keys.push(`anime_real_git_${i}_${'z'.repeat(90)}`);
  const payload = JSON.stringify(keys, null, 2);
  assert.ok(Buffer.byteLength(payload) >= 2.1 * 1024 * 1024, `the fixture must be ≥2.1 MB (was ${Buffer.byteLength(payload)})`);
  fs.writeFileSync(path.join(dir, 'data', 'posted.json'), payload);
  fs.writeFileSync(path.join(dir, 'data', 'title-map.json'), JSON.stringify({ k: { negative: false, ts: 1 } }));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', 'data/posted.json', 'data/title-map.json']);
  // The provenance gate only trusts the bot's own author for the remote tip.
  git(dir, ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=github-actions[bot]@users.noreply.github.com', 'commit', '-q', '-m', 'init']);
  git(dir, ['remote', 'add', 'origin', remoteDir]);
  git(dir, ['push', '-q', 'origin', 'main']);

  // The local side gains exactly one key on top of the ≥2.1 MB remote state.
  fs.writeFileSync(path.join(dir, 'data', 'posted.json'), JSON.stringify([...keys, 'anime_real_git_local_only_999'], null, 2));

  const gitCalls = [];
  const runner = makeGitRunner({ cwd: dir });
  const runGit = async (args, opts = {}) => { gitCalls.push(args.slice()); return runner(args, opts); };

  const realIndex = path.join(dir, '.git', 'index');
  const indexBefore = fs.existsSync(realIndex) ? fs.statSync(realIndex).mtimeMs : null;

  const writes = new Map();
  const result = await pushStateWithRetries({
    runGit,
    attempts: 1,
    // F-02: the CONFIGURED cwd must be the one every git call runs in —
    // never the repository of the test runner.
    cwd: dir,
    localPath: path.join(dir, 'data', 'posted.json'),
    titleMapLocalPath: path.join(dir, 'data', 'title-map.json'),
    outPath: path.join(dir, 'data', 'posted.json'),
    titleMapOutPath: path.join(dir, 'data', 'title-map.json'),
    remotePostedPath: 'data/posted.json',
    remoteTitleMapPath: 'data/title-map.json',
    remoteRef: 'main',
    branch: 'main',
    authorName: 'github-actions[bot]',
    authorEmail: 'github-actions[bot]@users.noreply.github.com',
    exists: (p) => fs.existsSync(p),
    writeFile: (p, data) => writes.set(p, data),
    log: () => {},
    tempDir: tmp(),
    env: { ...process.env, GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_AUTHOR_EMAIL: 'github-actions[bot]@users.noreply.github.com', GIT_COMMITTER_NAME: 'github-actions[bot]', GIT_COMMITTER_EMAIL: 'github-actions[bot]@users.noreply.github.com' },
  });
  assert.equal(result.stateCorrupt, false, JSON.stringify(result.log));
  assert.equal(result.pushFailed, false, JSON.stringify(result.log));
  assert.equal(result.noop, false, 'the ≥2.1 MB state must actually be pushed');

  // Only the two state files are written.
  assert.deepEqual([...writes.keys()].sort(), [
    path.join(dir, 'data', 'posted.json'),
    path.join(dir, 'data', 'title-map.json'),
  ], `unexpected writes: ${JSON.stringify([...writes.keys()])}`);
  assert.equal(JSON.parse(writes.get(path.join(dir, 'data', 'posted.json'))).length, 20_001);

  // No checkout / pull / merge / reset — the commit is built on the fetched
  // tip with plumbing only.
  for (const forbidden of ['checkout', 'pull', 'merge', 'reset']) {
    assert.equal(gitCalls.some(args => args.includes(forbidden)), false, `${forbidden} must never be used: ${JSON.stringify(gitCalls)}`);
  }
  // The REAL index of the repository is never written (a temp index is used).
  const indexAfter = fs.existsSync(realIndex) ? fs.statSync(realIndex).mtimeMs : null;
  assert.equal(indexAfter, indexBefore, 'the real git index must never be written');

  // The remote really holds the new tip.
  const remoteHead = String(git(remoteDir, ['rev-parse', 'main'])).trim();
  assert.ok(remoteHead.length === 40, 'the remote must have a new tip');
});

// ===========================================================================
// FIX ROUND 3 — F-1 / F-2 + the contract shape (a) and (b)
// ===========================================================================

/**
 * Run a check cycle with a STUB client in an isolated cwd.
 *
 * - the AniList lookup is stubbed (NO network, ever);
 * - the media tools are removed from the PATH, so the "tools missing" path
 *   is deterministic on every machine (CI installs aria2c/mkvextract);
 * - the state files are written into the temporary cwd — the repository's
 *   data/ directory is never touched.
 */
function runStubbedCycle(dir, body, extraEnv = {}) {
  const emptyPath = path.join(dir, 'empty-path');
  fs.mkdirSync(emptyPath, { recursive: true });
  const code = `
import fs from 'node:fs';
const m = await import(${JSON.stringify(CLIENT_URL)});
const ti = await import(${JSON.stringify(IDENTITY_URL)});
ti.__setFetchImpl(async () => ({
  status: 200,
  json: async () => ({ data: { Page: { media: [] } } }),
}));
${body}
`;
  return runCode(dir, code, {
    ...process.env,
    TELEGRAM_SESSION: 'test-session',
    TELEGRAM_API_ID: '1',
    TELEGRAM_API_HASH: 'test-hash',
    TELEGRAM_TARGET_CHANNEL: '-1001234567890',
    TELEGRAM_BOT_TOKEN: '',
    PATH: emptyPath,
    ...extraEnv,
  });
}

/** A valid .ass payload (validateFileMagic needs >= 50 bytes and a header). */
const VALID_ASS = `[Script Info]
Title: Test
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Arial,40

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,مرحبا
`;

function emptySummary() {
  return {
    attempted: 0, published: 0, failed: 0, deferred: 0, skipped: 0,
    sourceErrors: 0, syncFailed: false, immediateFatal: null,
  };
}

test('F-1: a message is classified in EXACTLY ONE terminal counter (the first classification wins)', () => {
  // CASE A fails, CASE B publishes (the old fall-through): the message must
  // be counted ONCE — as the failure, never as both.
  const s1 = emptySummary();
  const c1 = createCycleCounters(s1);
  c1.countAttempted('k1');
  c1.countFailed('k1');
  c1.countPublished('k1');
  assert.equal(s1.failed, 1);
  assert.equal(s1.published, 0, 'a message must never be counted twice');
  assert.equal(s1.attempted, 1);
  assert.equal(s1.published + s1.failed + s1.deferred + s1.skipped, 1);

  // A deferral is NEVER a failure (the fansub post-page loop).
  const s2 = emptySummary();
  const c2 = createCycleCounters(s2);
  c2.countAttempted('k2');
  c2.countDeferred('k2');
  c2.countFailed('k2');
  assert.equal(s2.deferred, 1);
  assert.equal(s2.failed, 0, 'a deferral must never be counted as a failure');

  // The first classification wins in the other direction too.
  const s3 = emptySummary();
  const c3 = createCycleCounters(s3);
  c3.countAttempted('k3');
  c3.countPublished('k3');
  c3.countFailed('k3');
  c3.countDeferred('k3');
  c3.countSkipped('k3');
  assert.equal(s3.published, 1);
  assert.equal(s3.failed + s3.deferred + s3.skipped, 0);
});

test('F-1: a Subdl CASE A failure is not re-attempted as CASE B and is counted once', () => {
  const dir = tmp();
  const body = `
const summary = await m.checkTelegramChannels({
  connected: true,
  getMessages: async (chatId) => chatId === 1224725097 ? [{
    id: 7,
    message: '[Subdl] Some Anime Title',
    media: { document: { attributes: [{ fileName: 'Some.Anime.01.ass' }] } },
  }] : [],
  getDialogs: async () => [{ id: 1224725097, title: 'KokoBoko [subdl]' }],
  downloadMedia: async () => { throw new Error('download exploded'); },
});
console.log('SUMMARY=' + JSON.stringify(summary));
`;
  const r = runStubbedCycle(dir, body);
  assert.equal(r.status, 0, `the child must finish cleanly: ${r.stderr}`);
  const line = (r.stdout.match(/SUMMARY=(.*)/) || [])[1];
  assert.ok(line, `the summary must be printed: ${r.stdout}\n${r.stderr}`);
  const summary = JSON.parse(line);
  assert.equal(summary.attempted, 1);
  assert.equal(summary.failed, 1, 'the CASE A failure must be counted');
  assert.equal(summary.published, 0, 'the message must not be counted as published too');
  assert.equal(summary.deferred, 0);
  assert.equal(summary.skipped, 0);
  assert.ok(
    summary.attempted <= summary.published + summary.failed + summary.deferred + summary.skipped,
    `the classification invariant must hold: ${JSON.stringify(summary)}`
  );
  // The release is NOT re-attempted as CASE B in the same cycle (the source
  // must `continue` out of the CASE A failure).
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'telegram-client.mjs'), 'utf8');
  const catchAt = src.indexOf('Subdl direct file error:');
  assert.ok(catchAt > 0, 'the Subdl CASE A catch must exist');
  const afterCatch = src.slice(catchAt, catchAt + 400);
  assert.ok(
    /Subdl direct file error:[\s\S]*?continue;/.test(afterCatch),
    'a CASE A failure must not fall through into CASE B for the same message'
  );
});

test('F-2: a fansub attachment that produces nothing usable is a FAILED cycle', () => {
  const dir = tmp();
  const body = `
const summary = await m.checkTelegramChannels({
  connected: true,
  getMessages: async (chatId) => chatId === 1031770723 ? [{
    id: 77,
    message: '[Some Team] Some Anime Title',
    media: { document: { attributes: [{ fileName: 'broken.ass' }] } },
  }] : [],
  getDialogs: async () => [{ id: 1031770723, title: 'Arabic Anime Publisher' }],
  downloadMedia: async (msg, opts) => { fs.writeFileSync(opts.outputFile, 'not a subtitle'); },
});
console.log('SUMMARY=' + JSON.stringify(summary));
`;
  const r = runStubbedCycle(dir, body);
  assert.equal(r.status, 0, `the child must finish cleanly: ${r.stderr}`);
  const line = (r.stdout.match(/SUMMARY=(.*)/) || [])[1];
  assert.ok(line, `the summary must be printed: ${r.stdout}\n${r.stderr}`);
  const summary = JSON.parse(line);
  assert.equal(summary.attempted, 1);
  assert.equal(summary.failed, 1, 'an unusable download must be a failure, not an unclassified attempt');
  assert.equal(summary.published, 0);
  assert.equal(summary.skipped, 0);
  assert.ok(
    summary.attempted <= summary.published + summary.failed + summary.deferred + summary.skipped,
    `the classification invariant must hold: ${JSON.stringify(summary)}`
  );
  // The release must NOT be marked as posted (it is retried next cycle).
  const posted = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'posted.json'), 'utf8'));
  assert.equal(posted.includes('tg_1031770723_77'), false, 'a failed release must not be marked as posted');
});

test('P-8/F-01: the merge-only CLI bootstraps when the remote state file is ABSENT', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'posted.json'), JSON.stringify(makeKeys(1500, 'local'), null, 2));
  const outputFile = path.join(dir, 'github-output');
  // The remote file does not exist at all: absent is not corrupt.
  const r = runMerge(dir, [
    '--local', 'data/posted.json',
    '--remote', 'missing-remote.json',
    '--out', 'merged.json',
    '--github-output', outputFile,
  ]);
  assert.equal(r.status, 0, `an absent remote must bootstrap, not block the merge: ${r.stderr}`);
  assert.match(r.stdout, /merged 1500 key/, r.stdout);
  assert.match(fs.readFileSync(outputFile, 'utf8'), /^state_corrupt=false$/m);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'merged.json'), 'utf8'));
  assert.equal(written.length, 1500, 'the local state must be merged as-is');
});

test('push-path fail-closed: an oversize side is red with the fixed validation line (merge-only CLI)', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  // More elements than the cap -> the side is invalid (red), not "empty".
  fs.writeFileSync(path.join(dir, 'data', 'posted.json'), JSON.stringify(new Array(MAX_ELEMENTS + 1).fill('k')));
  const outputFile = path.join(dir, 'github-output');
  const r = runMerge(dir, ['--github-output', outputFile]);
  assert.notEqual(r.status, 0, 'an oversize side must be red');
  assert.ok(
    r.stderr.includes('::error::state corrupt: posted.json failed validation'),
    `the fixed validation line must be emitted: ${r.stderr}`
  );
  assert.match(fs.readFileSync(outputFile, 'utf8'), /^state_corrupt=true$/m);
});

test('the cycle summary has exactly the eight contract keys (immediateFatal is null)', () => {
  const dir = tmp();
  const body = `
const summary = await m.checkTelegramChannels({
  connected: true,
  getMessages: async (chatId) => chatId === 2084152036 ? [{
    id: 4242,
    message: 'Title: Some Anime Title\\nSource: Erai-Raws\\nSubtitles: Arabic \\u{1F1F8}\\u{1F1E6}',
    media: null,
  }] : [],
  getDialogs: async () => [{ id: 2084152036, title: 'Erai-Raws [Official]' }],
});
console.log('SUMMARY=' + JSON.stringify(summary));
`;
  const r = runStubbedCycle(dir, body);
  assert.equal(r.status, 0, `the child must finish cleanly: ${r.stderr}`);
  const line = (r.stdout.match(/SUMMARY=(.*)/) || [])[1];
  assert.ok(line, `the summary must be printed: ${r.stdout}\n${r.stderr}`);
  const summary = JSON.parse(line);
  assert.deepEqual(
    Object.keys(summary).sort(),
    ['attempted', 'deferred', 'failed', 'immediateFatal', 'published', 'skipped', 'sourceErrors', 'syncFailed'],
    `the summary must have exactly the eight contract keys: ${JSON.stringify(summary)}`
  );
  assert.equal(summary.immediateFatal, null, 'immediateFatal is always null on the returned path');
  // The tools are missing -> the release is DEFERRED, never failed.
  assert.equal(summary.deferred, 1, `a deferred release must be counted as deferred: ${JSON.stringify(summary)}`);
  assert.equal(summary.failed, 0, 'a deferral is never a failure');
  assert.equal(summary.published, 0);
  // The deferred release is NOT marked as posted.
  const posted = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'posted.json'), 'utf8'));
  assert.equal(posted.includes('tg_2084152036_4242'), false, 'a deferred release must not be marked as posted');
});

test('a publish-site failure is a FAILED cycle and the release stays unposted', () => {
  const dir = tmp();
  const body = `
const summary = await m.checkTelegramChannels({
  connected: true,
  getMessages: async (chatId) => chatId === 1224725097 ? [{
    id: 7,
    message: '[Subdl] Some Anime Title',
    media: { document: { attributes: [{ fileName: 'Some.Anime.01.ass' }] } },
  }] : [],
  getDialogs: async () => [{ id: 1224725097, title: 'KokoBoko [subdl]' }],
  downloadMedia: async (msg, opts) => { fs.writeFileSync(opts.outputFile, ${JSON.stringify(VALID_ASS)}); },
  getEntity: async () => ({}),
  sendFile: async () => { throw new Error('telegram rejected the upload'); },
});
console.log('SUMMARY=' + JSON.stringify(summary));
`;
  const r = runStubbedCycle(dir, body);
  assert.equal(r.status, 0, `the child must finish cleanly: ${r.stderr}`);
  const line = (r.stdout.match(/SUMMARY=(.*)/) || [])[1];
  assert.ok(line, `the summary must be printed: ${r.stdout}\n${r.stderr}`);
  const summary = JSON.parse(line);
  assert.equal(summary.attempted, 1);
  assert.equal(summary.failed, 1, 'a rejected publication is a failure');
  assert.equal(summary.published, 0, 'nothing was published');
  assert.match(r.stderr + r.stdout, /Failed to send document/, 'the failure must be logged');
  const posted = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'posted.json'), 'utf8'));
  assert.equal(posted.includes('tg_1224725097_7'), false, 'a failed publication must not be marked as posted');
});


// ---------------------------------------------------------------------------
// R4 regressions — independent review of scripts/merge-posted-state.mjs
// ---------------------------------------------------------------------------

test('R4: the OUTPUT caps hold on the merged union, not just on each side (push path)', async () => {
  const n = 200000;
  const side = (suffix) => Array.from({ length: n }, (_, i) => `key_${String(i).padStart(20, '0')}${suffix}`);
  const local = side('_a');
  const remote = side('_b');
  const calls = [];
  const writes = [];
  const runGit = makeGitFake({ remotePosted: JSON.stringify(remote), calls });
  const result = await pushStateWithRetries({
    runGit,
    attempts: 1,
    readFile: (p) => String(p).includes('title-map') ? '{"k":{"negative":false,"ts":1}}' : JSON.stringify(local),
    exists: () => true,
    writeFile: (p) => writes.push(p),
    log: () => {},
  });
  const unionBytes = Buffer.byteLength(JSON.stringify([...local, ...remote], null, 2));
  assert.ok(unionBytes > MAX_BYTES, 'the fixture must actually exceed the byte cap');
  assert.equal(result.stateCorrupt, true, 'the merged array must be refused');
  assert.equal(result.reason, 'merged-validation');
  assert.deepEqual(writes, [], 'nothing may be written on a red merge');
  assert.equal(calls.some(c => c.args.includes('push')), false, 'no push on a red merge');
});

test('R4: the merge-only CLI refuses an oversized union and writes no output file', () => {
  const dir = tmp();
  const n = 200000;
  const side = (suffix) => Array.from({ length: n }, (_, i) => `key_${String(i).padStart(20, '0')}${suffix}`);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'local.json'), JSON.stringify(side('_a')));
  fs.writeFileSync(path.join(dir, 'remote.json'), JSON.stringify(side('_b')));
  fs.writeFileSync(path.join(dir, 'title-local.json'), '{"a":{"negative":false,"ts":1000}}');
  fs.writeFileSync(path.join(dir, 'title-remote.json'), '{"b":{"negative":false,"ts":2000}}');
  const out = path.join(dir, 'out.json');
  const r = runMerge(dir, [
    '--local', 'local.json', '--remote', 'remote.json', '--out', 'out.json',
    '--title-map-local', 'title-local.json', '--title-map-remote', 'title-remote.json',
    '--title-map-out', 'title-out.json',
  ]);
  assert.notEqual(r.status, 0, 'an oversized union must be red');
  assert.match(r.stderr, /exceeds the output caps/);
  assert.equal(fs.existsSync(out), false, 'no output file may be created');
});

test('R4: a git show failure that is NOT an absent file is fail-closed, not bootstrap', async () => {
  const calls = [];
  const writes = [];
  const runGit = async (args, opts = {}) => {
    calls.push({ args: args.slice(), env: (opts && opts.env) || null });
    if (args.includes('fetch')) return { code: 0, stdout: '', stderr: '' };
    if (args.includes('rev-parse')) return { code: 0, stdout: 'deadbeef\n', stderr: '' };
    if (args.includes('show')) return { code: 128, stdout: '', stderr: 'fatal: unable to read tree object (corrupt)' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const result = await pushStateWithRetries({
    runGit,
    attempts: 1,
    readFile: makeReadFile(makeKeys(1500, 'local')),
    exists: () => true,
    writeFile: (p) => writes.push(p),
    log: () => {},
  });
  assert.equal(result.stateCorrupt, true, 'a real git error must not be treated as an absent file');
  assert.equal(result.reason, 'remote-read');
  assert.deepEqual(writes, []);
  assert.equal(calls.some(c => c.args.includes('push')), false);
});

test('R4: unverifiable provenance warns but never blocks the state push', async () => {
  const calls = [];
  const runGit = makeGitFake({ remotePosted: JSON.stringify(makeKeys(1500, 'remote')), author: '', calls });
  const result = await pushStateWithRetries({
    runGit,
    attempts: 1,
    readFile: makeReadFile(makeKeys(1500, 'local')),
    exists: () => true,
    writeFile: () => {},
    log: () => {},
  });
  assert.equal(result.stateCorrupt, false, 'an empty author at a shallow boundary must not hard-block');
  assert.ok(result.log.some(l => l.includes('provenance unverifiable')), JSON.stringify(result.log));
  assert.ok(calls.some(c => c.args.includes('push')), 'the state must still be pushed');
});

test('R4: prototype-ish title-map keys cannot reassign the accumulator prototype', () => {
  const local = { a: { negative: false, ts: 1000 } };
  const remote = JSON.parse('{"__proto__":{"negative":true,"ts":1},"constructor":{"negative":true,"ts":2},"b":{"negative":false,"ts":3}}');
  const merged = mergeTitleMap(local, remote, { now: Date.now() });
  assert.equal(Object.getPrototypeOf(merged.merged), Object.prototype, 'the accumulator prototype must be intact');
  assert.equal(Object.prototype.hasOwnProperty.call(merged.merged, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(merged.merged, 'constructor'), false);
  assert.equal(merged.merged.a.negative, false, 'the valid local entry survives');
  assert.equal(merged.merged.b.negative, false, 'a valid remote entry survives');
});

test('R4: the git runner preserves multi-byte UTF-8 across 64 KB stream chunk boundaries', async () => {
  const dir = tmp();
  git(dir, ['init', '-q']);
  const payload = 'x'.repeat(65535) + 'é' + 'y'.repeat(65535);
  const file = path.join(dir, 'blob.txt');
  fs.writeFileSync(file, payload, 'utf8');
  const sha = git(dir, ['hash-object', '-w', file]).trim();
  const runner = makeGitRunner({ cwd: dir });
  const res = await runner(['cat-file', '-p', sha]);
  assert.equal(res.code, 0, `git cat-file failed: ${res.stderr}`);
  assert.equal(res.stdout.includes('\uFFFD'), false, 'no replacement characters may appear');
  assert.equal(res.stdout.includes('é'), true, 'the multi-byte character must survive');
});

test('R4: the default state writer is atomic and leaves no temp residue', () => {
  const dir = tmp();
  const dest = path.join(dir, 'posted.json');
  const code = `
    import { pushStateWithRetries } from ${JSON.stringify(pathToFileURL(MERGE_SCRIPT).href)};
    const d = ${JSON.stringify(dir)};
    const r = await pushStateWithRetries({
      runGit: async (args) => {
        if (args.includes('fetch')) return { code: 0, stdout: '', stderr: '' };
        if (args.includes('rev-parse')) return { code: 0, stdout: 'deadbeef\\n', stderr: '' };
        if (args.includes('show')) return { code: 0, stdout: JSON.stringify(Array.from({length:1500},(_,i)=>'k'+i)), stderr: '' };
        if (args.includes('log')) return { code: 0, stdout: 'github-actions[bot]\\n', stderr: '' };
        if (args.includes('hash-object')) return { code: 0, stdout: 'blob0000\\n', stderr: '' };
        if (args.includes('write-tree')) return { code: 0, stdout: 'tree1111\\n', stderr: '' };
        if (args.includes('commit-tree')) return { code: 0, stdout: 'commit1111\\n', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      attempts: 1,
      localPath: d + '/local.json', titleMapLocalPath: d + '/local-title.json',
      outPath: d + '/posted.json', titleMapOutPath: d + '/title-out.json',
      readFile: (p) => String(p).includes('title') ? '{"a":{"negative":false,"ts":1}}' : JSON.stringify(Array.from({length:1500},(_,i)=>'k'+i)),
      exists: () => true,
      log: () => {},
      cwd: d,
    });
    console.log('CORRUPT=' + r.stateCorrupt + ' PUSHED=' + !r.pushFailed);
  `;
  const r = runCode(dir, code);
  assert.equal(r.status, 0, `child failed: ${r.stderr}`);
  assert.ok(fs.existsSync(dest), 'the state file must be written');
  const residue = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
  assert.deepEqual(residue, [], `no temp residue may remain: ${residue.join(',')}`);
});

// ===========================================================================
// P1 TRANCHE 1 — ITEM 1 (the dispatch ledger) + ITEM 3 (the source counter)
// ===========================================================================

test('P1-5: a dispatched batch is DEFERRED and recorded in the dispatch ledger, never as published', async () => {
  const dir = tmp();
  const message = [
    'Title: Some Anime Title 01~03',
    'Source: Erai-Raws',
    'Subtitles: Arabic \u{1F1F8}\u{1F1E6}',
  ].join('\n');
  const body = `
let dispatches = 0;
globalThis.fetch = async () => { dispatches++; return { status: 204, ok: true, headers: { get: () => null }, text: async () => '' }; };
const summary = await m.checkTelegramChannels({
  connected: true,
  getMessages: async (chatId) => chatId === 2084152036 ? [{
    id: 4242,
    message: ${JSON.stringify(message)},
    entities: [{ className: 'MessageEntityTextUrl', url: 'https://nyaa.si/download/Some.Anime.01.torrent' }],
    media: null,
  }] : [],
  getDialogs: async () => [{ id: 2084152036, title: 'Erai-Raws [Official]' }],
});
console.log('SUMMARY=' + JSON.stringify(summary));
console.log('DISPATCHES=' + dispatches);
`;
  const r = runStubbedCycle(dir, body, { GH_PAT: 'test-pat' });
  assert.equal(r.status, 0, `the child must finish cleanly: ${r.stderr}`);
  const line = (r.stdout.match(/SUMMARY=(.*)/) || [])[1];
  assert.ok(line, `the summary must be printed: ${r.stdout}\n${r.stderr}`);
  const summary = JSON.parse(line);

  // The counters say what happened: DEFERRED, never published, never skipped.
  assert.equal(summary.deferred, 1, `a dispatched batch must be DEFERRED: ${JSON.stringify(summary)}`);
  assert.equal(summary.published, 0, 'a dispatched batch is never published');
  assert.equal(summary.skipped, 0, 'a dispatched batch is never skipped');
  assert.match(r.stdout + r.stderr, /DEFERRED \(dispatched to sub-extractor, publication NOT confirmed\)/,
    'the dispatch must have its own log line');
  assert.match(r.stdout, /DISPATCHES=1/, 'the batch must have been dispatched exactly once');

  // The state records the DISPATCH — never a publication.
  const posted = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'posted.json'), 'utf8'));
  assert.ok(posted.includes('dispatched:tg_2084152036_4242'),
    `the message must be in the dispatch ledger: ${JSON.stringify(posted)}`);
  assert.ok(posted.some(k => k.startsWith('dispatched:') && k !== 'dispatched:tg_2084152036_4242'),
    `the release keys must be in the dispatch ledger: ${JSON.stringify(posted)}`);
  assert.equal(posted.includes('tg_2084152036_4242'), false,
    'a dispatch must NOT be stored as a plain posted key');

  // The next cycle sees the same message and must NOT dispatch it again.
  const second = runStubbedCycle(dir, body, { GH_PAT: 'test-pat' });
  assert.equal(second.status, 0, `the second child must finish cleanly: ${second.stderr}`);
  const secondLine = (second.stdout.match(/SUMMARY=(.*)/) || [])[1];
  assert.ok(secondLine, `the second summary must be printed: ${second.stdout}\n${second.stderr}`);
  const secondSummary = JSON.parse(secondLine);
  assert.match(second.stdout, /DISPATCHES=0/, 'a dispatched batch must not be dispatched again');
  assert.equal(secondSummary.deferred, 0, 'the second cycle must not defer the batch again');
  assert.equal(secondSummary.skipped, 1, 'the already-dispatched message is skipped');
});

test('P1-5: a legacy plain posted key keeps suppressing re-processing and is never moved into the ledger', async () => {
  const dir = tmp();
  const r = runIn(dir, `
    const s = m.loadPostedIds();
    m.markReleaseAsPosted(s, 'tg_7_77', ['legacy_ep_9']);
    console.log('HANDLED=' + m.isMessageAlreadyHandled(s, 'tg_7_77'));
    console.log('KNOWN=' + m.isReleaseAlreadyPostedOrDispatched(s, ['legacy_ep_9']));
    console.log('DISPATCHED=' + m.isReleaseDispatched(s, ['legacy_ep_9']));
    m.markReleaseAsKnown(s, 'tg_8_88', ['legacy_ep_9']);
    console.log('PLAIN=' + s.has('tg_8_88'));
    console.log('LEDGER=' + s.has('dispatched:tg_8_88'));
  `);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status} (stderr=${r.stderr})`);
  assert.match(r.stdout, /HANDLED=true/, 'a legacy plain key must still suppress the message');
  assert.match(r.stdout, /KNOWN=true/, 'a legacy plain key must still suppress the release');
  assert.match(r.stdout, /DISPATCHED=false/, 'a published release is not a dispatched one');
  assert.match(r.stdout, /PLAIN=true/, 'a published release stays a plain posted key');
  assert.match(r.stdout, /LEDGER=false/, 'a published release must not be moved into the dispatch ledger');
});

test('P1-1c: the per-source no-links counter prints ONE line per cycle', () => {
  assert.equal(formatNoLinksBySource(new Map()), null, 'an empty counter prints no line');
  const line = formatNoLinksBySource(new Map([
    ['lazysano.com', 6],
    ['rhythm-sub.com', 5],
    ['celestial-dragons.com', 3],
  ]));
  assert.equal(line, 'ℹ️ sources with no links this cycle: lazysano.com=6, rhythm-sub.com=5, celestial-dragons.com=3');
});
