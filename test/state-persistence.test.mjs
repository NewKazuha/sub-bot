import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLIENT_URL = pathToFileURL(path.join(REPO_ROOT, 'src', 'telegram-client.mjs')).href;
const dirs = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'posted-state-')); dirs.push(d); return d; }
function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function runIn(cwd, body) {
  const code = `const m = await import(${JSON.stringify(CLIENT_URL)});\n${body}`;
  // spawnSync (not execFileSync): the child's stderr must be observable even when
  // it exits 0 — the git-recovery path reports on stderr and still succeeds.
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  return { status: res.status ?? 1, stdout: res.stdout || '', stderr: res.stderr || '' };
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

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
