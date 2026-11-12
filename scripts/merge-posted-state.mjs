#!/usr/bin/env node
// =====================================================================
// P0-4 — state merge + push resilience (F-01 … F-21)
//
// One script, pure functions + an injectable git runner, so the retry
// semantics are unit-testable. The CLI calls exactly the same exported
// functions as the tests (no "if exported" escape hatch).
//
// The push is built ON TOP of the freshly fetched remote tip: the commit's
// parent IS the remote tip, so a successful push is a fast-forward by
// construction — no rebase, no `git pull`, no `git merge`, no `checkout`.
//
// Only plumbing is used: fetch, show, read-tree (into a TEMP index),
// hash-object, update-index, write-tree, commit-tree, push.
// =====================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Measured thresholds (execution spec §0 — the audit's proposed numbers
// would have rejected real production data).
// ---------------------------------------------------------------------------
export const MAX_KEY_LENGTH = 512;          // measured max: 259
export const MAX_ELEMENTS = 250_000;        // measured: 42,382
export const MAX_BYTES = 8 * 1024 * 1024;   // measured: 2,094,016 bytes
export const MAX_SYNONYMS = 64;             // measured max: 16
export const MAX_RELATIONS = 64;            // measured max: 20
export const MIN_MERGED_ENTRIES = 1000;     // absolute floor (production: 42,382)
export const SHRINK_FACTOR = 0.98;
// The shrink alarm needs BOTH margins: a RELATIVE one (the remote is more
// than (1 - SHRINK_FACTOR) behind our local copy) AND an ABSOLUTE one (the
// gap is bigger than 1,000 keys). The relative margin ALONE is a
// catastrophic false positive on the real state: with 42,387 local keys,
// 2 % is 847 keys, so a single busy cycle that adds ~900 keys would turn
// the state push RED -> state_corrupt=true -> the chain is blocked -> the
// bot stops publishing (worse than the fault this guard was written for).
// With both margins the alarm needs a gap of more than 1,000 keys — a real
// truncation/tamper — instead of 865.
export const SHRINK_ABSOLUTE_MARGIN = 1000;
export const GROWTH_FACTOR = 1.25;
export const GROWTH_ALLOWANCE = 1000;
export const TRUSTED_AUTHOR = 'github-actions[bot]';
export const NEGATIVE_TTL_MS = 86_400_000;  // same TTL as saveTitleMap()

const COMMIT_MESSAGE = 'Update posted releases list [skip ci]';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Why is this posted key unusable? (null = usable) */
export function postedKeyProblem(value) {
  if (typeof value !== 'string') return 'not-a-string';
  if (value.trim() === '') return 'empty';
  // Unicode-aware: any non-control character is allowed (production has 402
  // non-ASCII keys — Arabic, Japanese and U+2171).
  if (/[\x00-\x1F\x7F]/.test(value)) return 'control-character';
  if (value.length > MAX_KEY_LENGTH) return 'too-long';
  return null;
}

/**
 * Validate one side of posted.json.
 * → { valid, rejected: [{ index, reason }], bytes }
 * `valid` is about the FILE (array shape + caps). Rejected ELEMENTS are
 * counted and reported, never silently dropped.
 *
 * P-2: the byte size is measured EXACTLY ONCE per side per attempt and
 * travels with the result, so the caller never re-serializes the array just
 * to learn its size.
 */
export function validatePostedIds(arr) {
  if (!Array.isArray(arr)) {
    return { valid: false, rejected: [{ index: -1, reason: 'not-an-array' }], bytes: 0 };
  }
  if (arr.length > MAX_ELEMENTS) {
    return { valid: false, rejected: [{ index: -1, reason: `too-many-elements:${arr.length}` }], bytes: 0 };
  }
  // P-3: measure the bytes that are ACTUALLY written — JSON.stringify(x, null, 2)
  // is the production format (~2.09 MB pretty vs ~1.2 MB compact), so the cap
  // MUST be enforced on the pretty serialization, not on the compact one.
  const serialized = JSON.stringify(arr, null, 2);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_BYTES) {
    return { valid: false, rejected: [{ index: -1, reason: `too-large:${bytes}` }], bytes };
  }
  const rejected = [];
  arr.forEach((value, index) => {
    const reason = postedKeyProblem(value);
    if (reason) rejected.push({ index, reason });
  });
  return { valid: true, rejected, bytes };
}

/**
 * Union-merge the two sides. No key of either side is lost (subset
 * property), modulo the explicitly reported rejections.
 * → { merged, rejected, localCount, remoteCount, invalid }
 *
 * `options.localCheck` / `options.remoteCheck` let a caller that ALREADY
 * validated the sides (P-2: validate once, then merge the validated sides)
 * pass them in instead of re-validating — behaviour is identical either way.
 * `options.remoteAbsent` marks a side that was NOT present (P-8/F-01): the
 * remote is then treated as authoritative-absent, i.e. the union is just the
 * local side and there is no baseline left to compare against.
 */
export function mergePostedIds(ours, theirs, options = {}) {
  const localCheck = options.localCheck || validatePostedIds(ours);
  const remoteCheck = options.remoteCheck || validatePostedIds(theirs);
  const remoteAbsent = options.remoteAbsent === true;
  const invalid = [];
  if (!localCheck.valid) invalid.push('local');
  if (!remoteAbsent && !remoteCheck.valid) invalid.push('remote');
  if (invalid.length > 0) {
    return {
      merged: [],
      rejected: localCheck.rejected.length + (remoteAbsent ? 0 : remoteCheck.rejected.length),
      localCount: 0,
      remoteCount: 0,
      invalid,
    };
  }

  const localBad = new Set(localCheck.rejected.map(r => r.index));
  const remoteBad = new Set(remoteCheck.rejected.map(r => r.index));

  const localSet = new Set();
  ours.forEach((v, i) => { if (!localBad.has(i)) localSet.add(v); });
  const remoteSet = new Set();
  if (!remoteAbsent) theirs.forEach((v, i) => { if (!remoteBad.has(i)) remoteSet.add(v); });

  // P-7: accumulate into ONE Set (no [...localSet, ...remoteSet] → Set →
  // spread round-trip over two ~42k Sets).
  const mergedSet = new Set();
  localSet.forEach(k => mergedSet.add(k));
  remoteSet.forEach(k => mergedSet.add(k));
  const merged = Array.from(mergedSet);
  const rejected = localCheck.rejected.length + (remoteAbsent ? 0 : remoteCheck.rejected.length);
  // P-8/F-01: with the remote absent there is no baseline to compare against,
  // so the local side is its own baseline — nothing can "shrink" below it.
  const effectiveRemoteCount = remoteAbsent ? localSet.size : remoteSet.size;
  return {
    merged,
    rejected,
    localCount: localSet.size,
    remoteCount: effectiveRemoteCount,
    invalid: [],
  };
}

/** Why is this title-map entry unusable? (null = usable) */
export function titleMapEntryProblem(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'not-an-object';
  if (!('ts' in entry) || !Number.isFinite(Number(entry.ts))) return 'ts-not-finite';
  if (!('negative' in entry) || typeof entry.negative !== 'boolean') return 'negative-not-boolean';
  if ('id' in entry && entry.id !== null && !Number.isFinite(Number(entry.id))) return 'id-not-number';
  if ('synonyms' in entry) {
    if (!Array.isArray(entry.synonyms)) return 'synonyms-not-an-array';
    if (entry.synonyms.length > MAX_SYNONYMS) return 'synonyms-too-many';
  }
  if ('relations' in entry) {
    if (!Array.isArray(entry.relations)) return 'relations-not-an-array';
    if (entry.relations.length > MAX_RELATIONS) return 'relations-too-many';
  }
  return null;
}

/**
 * Validate a title-map.json object.
 * → { valid, rejected: [{ key, reason }] }
 */
export function validateTitleMap(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, rejected: [{ key: null, reason: 'not-an-object' }] };
  }
  const rejected = [];
  for (const [key, entry] of Object.entries(obj)) {
    const reason = titleMapEntryProblem(entry);
    if (reason) rejected.push({ key, reason });
  }
  return { valid: true, rejected };
}

/**
 * Per-key merge: an entry with `negative === false` wins over a negative
 * one; otherwise the higher `ts` wins. The same prune rule as
 * saveTitleMap() is applied afterwards.
 */
export function mergeTitleMap(ours, theirs, { now = Date.now() } = {}) {
  const localCheck = validateTitleMap(ours);
  const remoteCheck = validateTitleMap(theirs);
  const invalid = [];
  if (!localCheck.valid) invalid.push('local');
  if (!remoteCheck.valid) invalid.push('remote');
  if (invalid.length > 0) {
    return {
      merged: {},
      rejected: localCheck.rejected.length + remoteCheck.rejected.length,
      localCount: 0,
      remoteCount: 0,
      invalid,
    };
  }

  const localBad = new Set(localCheck.rejected.map(r => r.key));
  const remoteBad = new Set(remoteCheck.rejected.map(r => r.key));

  // `__proto__` would REASSIGN the accumulator's prototype instead of being
  // stored (silent data loss / prototype confusion). Skip all prototype-ish
  // keys explicitly — no global Object.prototype pollution occurs, but the
  // merge must not drop or reinterpret attacker-supplied cache keys.
  const unsafeKey = (k) => k === '__proto__' || k === 'constructor' || k === 'prototype';
  const merged = {};
  for (const [k, v] of Object.entries(ours)) if (!localBad.has(k) && !unsafeKey(k)) merged[k] = v;
  for (const [k, v] of Object.entries(theirs)) {
    if (remoteBad.has(k) || unsafeKey(k)) continue;
    const local = merged[k];
    merged[k] = local === undefined ? v : pickTitleMapEntry(local, v);
  }

  // Same prune rule as saveTitleMap(): expired negative entries are dropped.
  const pruned = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v && v.negative === true && now - (Number(v.ts) || 0) > NEGATIVE_TTL_MS * 2) continue;
    pruned[k] = v;
  }

  return {
    merged: pruned,
    rejected: localCheck.rejected.length + remoteCheck.rejected.length,
    localCount: Object.keys(ours).length - localBad.size,
    remoteCount: Object.keys(theirs).length - remoteBad.size,
    invalid: [],
  };
}

/** `negative === false` wins; otherwise the higher `ts` wins. */
export function pickTitleMapEntry(a, b) {
  const aNegative = a && a.negative === true;
  const bNegative = b && b.negative === true;
  if (aNegative !== bNegative) return aNegative ? b : a;
  const aTs = Number(a && a.ts) || 0;
  const bTs = Number(b && b.ts) || 0;
  return bTs > aTs ? b : a;
}

/**
 * The merge guards (execution spec §5.4). The 98 % shrink rule is
 * VACUOUS on a set union (production has 0 duplicates, so |union| is always
 * max(|A|,|B|)) — it is replaced by the shrink/growth pair below.
 * → { corrupt, reason }
 */
export function classifyMerge({ localCount = 0, remoteCount = 0, mergedCount = 0, rejected = 0 } = {}) {
  if (mergedCount < MIN_MERGED_ENTRIES) {
    return { corrupt: true, reason: 'below-floor' };
  }
  // The remote is behind our local copy by MORE than BOTH margins: the
  // absolute one (SHRINK_ABSOLUTE_MARGIN keys) and the relative one
  // ((1 - SHRINK_FACTOR) of the local size). See SHRINK_ABSOLUTE_MARGIN for
  // why the relative margin alone is a catastrophic false positive.
  const shrinkMargin = Math.max(SHRINK_ABSOLUTE_MARGIN, (1 - SHRINK_FACTOR) * localCount);
  if (localCount - remoteCount > shrinkMargin) {
    return { corrupt: true, reason: 'shrink' };
  }
  if (remoteCount > GROWTH_FACTOR * localCount + GROWTH_ALLOWANCE) {
    return { corrupt: true, reason: 'growth' };
  }
  return { corrupt: false, reason: 'ok' };
}

/**
 * Provenance is a SANITY check, not an authenticity check: `%an`/`%cn` are
 * client-controlled and can be forged by any pusher. A KNOWN foreign author
 * is refused (it means a human/other app edited the state). An UNVERIFIABLE
 * author (empty log, e.g. at a shallow-fetch boundary) must NOT hard-block
 * the state push forever — it is reported as a warning instead.
 * → { corrupt, reason: 'ok' | 'unverifiable' | 'provenance' }
 */
export function classifyProvenance(author, committer = '') {
  const names = [author, committer].map((v) => String(v || '').trim()).filter(Boolean);
  if (names.length === 0) return { corrupt: false, reason: 'unverifiable' };
  if (names.every((n) => n === TRUSTED_AUTHOR)) return { corrupt: false, reason: 'ok' };
  return { corrupt: true, reason: 'provenance' };
}

// ---------------------------------------------------------------------------
// The retry loop (F-07 / F-12 / F-19)
// ---------------------------------------------------------------------------

/** Default git runner: no shell, no credential in a URL, no prompts. */
export function makeGitRunner({ cwd = process.cwd(), env = process.env } = {}) {
  return function runGit(args, opts = {}) {
    return new Promise((resolve) => {
      const child = spawn('git', args, {
        cwd: opts.cwd || cwd,
        env: { ...env, ...(opts.env || {}), GIT_TERMINAL_PROMPT: '0' },
      });
      // spawn() has NO `encoding` option (unlike execFile). Without an
      // explicit stream encoding, `stdout += buffer` re-decodes each chunk
      // separately and a multi-byte UTF-8 character split across a 64 KB
      // chunk boundary becomes U+FFFD — silently corrupting Arabic/Japanese
      // keys in posted.json. Set the encoding on the STREAMS instead.
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => {
        resolve({ code: typeof err.code === 'number' ? err.code : 1, stdout, stderr: String(err.message) });
      });
      child.on('close', (code) => {
        resolve({ code: typeof code === 'number' ? code : 0, stdout, stderr });
      });
      child.stdin.on('error', () => { });
      try {
        // opts.input carries the payload for `git hash-object -w --stdin`
        // (P-6): the buffer is hashed straight from memory, no re-read of the file.
        if (opts.input !== undefined && opts.input !== null) child.stdin.write(opts.input);
        child.stdin.end();
      } catch { }
    });
  };
}

/**
 * Atomic write: a crash or a second concurrent monitor run must never leave
 * a torn data/posted.json for the bot's own loader to read next cycle.
 * The temp name is unique per process AND attempt, and lives beside the
 * target so rename() stays on the same filesystem.
 */
function writeFileAtomic(dest, data) {
  const tmp = `${dest}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { }
    throw e;
  }
}

function parseJsonSide(raw, fallback = null) {
  if (raw === null || raw === undefined) return { present: false, valid: true, value: fallback };
  try {
    return { present: true, valid: true, value: JSON.parse(raw) };
  } catch {
    return { present: true, valid: false, value: fallback, reason: 'unparseable' };
  }
}

/**
 * Merge + guard + commit + push, with an injectable git runner.
 *
 * Each attempt re-fetches, re-materializes, re-merges, re-guards, rebuilds
 * the commit and pushes. On any RED nothing is written and nothing is
 * pushed.
 *
 * → { stateCorrupt, pushFailed, attempts, log, reason, noop }
 */
export async function pushStateWithRetries({
  runGit,
  attempts = 3,
  localPath = 'data/posted.json',
  titleMapLocalPath = 'data/title-map.json',
  outPath = 'data/posted.json',
  titleMapOutPath = 'data/title-map.json',
  remotePostedPath = 'data/posted.json',
  remoteTitleMapPath = 'data/title-map.json',
  remoteRef = 'main',
  branch = 'main',
  authorName = TRUSTED_AUTHOR,
  authorEmail = 'github-actions[bot]@users.noreply.github.com',
  token = process.env.GITHUB_TOKEN,
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  writeFile = (p, data) => writeFileAtomic(p, data),
  exists = (p) => fs.existsSync(p),
  log = console.log,
  cwd = process.cwd(),
  env = process.env,
  tempDir = process.env.RUNNER_TEMP || os.tmpdir(),
  now = Date.now(),
} = {}) {
  const lines = [];
  const emit = (msg) => { lines.push(msg); log(msg); };

  if (typeof runGit !== 'function') throw new Error('pushStateWithRetries requires an injectable runGit');

  // The LOCAL baseline is read once: every attempt merges the same local
  // state, so the retry is idempotent.
  let localRaw = null;
  try {
    if (exists(localPath)) localRaw = readFile(localPath);
  } catch (e) {
    emit(`::error::state corrupt: posted.json failed validation`);
    return { stateCorrupt: true, pushFailed: false, attempts: 0, log: lines, reason: 'posted-validation', noop: false };
  }
  let localTitleRaw = null;
  try {
    if (exists(titleMapLocalPath)) localTitleRaw = readFile(titleMapLocalPath);
  } catch {
    localTitleRaw = null; // the title map is a cache: it never blocks the run
  }

  let stateCorrupt = false;
  let pushFailed = false;
  let corruptReason = null;
  let usedAttempts = 0;
  let noop = false;
  let pushed = false;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    usedAttempts = attempt;
    emit(`ℹ️ state push attempt ${attempt}/${attempts}`);

    // F-02: a UNIQUE temp index per attempt — never reused across retries —
    // and always removed in a finally once the attempt is over.
    const indexFile = path.join(tempDir, `state-index-${process.pid}-${attempt}`);
    const gitEnv = { ...env, GIT_INDEX_FILE: indexFile, GIT_TERMINAL_PROMPT: '0' };
    const git = (args, opts = {}) => runGit(args, {
      env: { ...gitEnv, ...(opts.env || {}) },
      cwd,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    });
    try {
      // 1. fetch the remote tip
      const fetchRes = await runGit(['fetch', '--no-tags', '--depth=50', 'origin', remoteRef], { cwd });
      if (fetchRes.code !== 0) {
        emit(`⚠️ git fetch failed (exit ${fetchRes.code})`);
        continue;
      }

      // 2. the fetched tip
      const revRes = await runGit(['rev-parse', 'FETCH_HEAD'], { cwd });
      if (revRes.code !== 0) {
        emit(`⚠️ git rev-parse FETCH_HEAD failed (exit ${revRes.code})`);
        continue;
      }
      const sha = String(revRes.stdout || '').trim();
      if (!sha) {
        emit(`⚠️ git rev-parse FETCH_HEAD returned nothing`);
        continue;
      }

      // 3. materialize the remote blobs (read-only plumbing)
      const postedShow = await runGit(['show', `${sha}:${remotePostedPath}`], { cwd });
      const remotePostedRaw = postedShow.code === 0 ? postedShow.stdout : null;
      // P-8/F-01: an ABSENT remote state file is the legitimate bootstrap case.
      // But NOT every `git show` failure means absence: a corrupt object, a
      // permission error or a transient git failure must NOT be treated as a
      // missing baseline (that would skip shrink/growth/provenance guards).
      // Only git's own "path is not in this tree" diagnostics count as absent.
      // Only git's "this path is not in that tree" diagnostics. Patterns such
      // as "unable to read tree object" are CORRUPTION/transport errors and
      // must stay fail-closed — they are not an absent-file bootstrap case.
      const ABSENT_RE = /not in|does not exist|exists on disk, but not in/i;
      let remotePostedAbsent = false;
      if (postedShow.code !== 0) {
        const stderr = String(postedShow.stderr || '');
        remotePostedAbsent = ABSENT_RE.test(stderr);
        if (!remotePostedAbsent) {
          stateCorrupt = true;
          corruptReason = 'remote-read';
          emit(`::error::state corrupt: remote state could not be read (not an absent-file case)`);
          break; // fail closed: nothing is written and nothing is pushed
        }
        emit(`ℹ️ remote state file absent — treating the local state as authoritative for this push`);
      }
      const titleShow = await runGit(['show', `${sha}:${remoteTitleMapPath}`], { cwd });
      const remoteTitleRaw = titleShow.code === 0 ? titleShow.stdout : null;
      if (titleShow.code !== 0) emit(`ℹ️ no remote ${remoteTitleMapPath}`);

      // 4. provenance of the remote state (checked BEFORE it is trusted).
      //    P-8/F-01: with the remote absent there is no blob to attribute, so
      //    the provenance gate does not apply to the remote side.
      const authorRes = await runGit(['log', '-1', '--format=%an%n%cn', sha, '--', remotePostedPath], { cwd });
      const authorLines = authorRes.code === 0 ? String(authorRes.stdout || '').split(/\r?\n/) : [];
      const provenance = remotePostedAbsent
        ? { corrupt: false, reason: 'ok' }
        : classifyProvenance(authorLines[0] || '', authorLines[1] || '');
      if (provenance.reason === 'unverifiable') {
        // A shallow-fetch boundary can hide the last-touching commit. That is
        // an observability gap, not evidence of tampering: blocking the push
        // forever would silently stop the bot. Warn loudly instead.
        emit(`::warning::remote state provenance unverifiable (no author in shallow history) — proceeding with the merge`);
      }
      if (provenance.corrupt) {
        stateCorrupt = true;
        corruptReason = 'provenance';
        emit(`::error::state corrupt: remote provenance rejected`);
        break; // fail closed: nothing is written and nothing is pushed
      }

      // 5. validate + union-merge (P-2: validate each side ONCE, then merge
      //    the validated sides; P-8/F-01: an absent remote side is not a
      //    validation failure).
      const localPosted = parseJsonSide(localRaw, []);
      const remotePosted = parseJsonSide(remotePostedRaw, []);
      const localCheck = validatePostedIds(localPosted.value);
      const remoteCheck = remotePostedAbsent ? { valid: true, rejected: [] } : validatePostedIds(remotePosted.value);
      if (!localPosted.valid || !remotePosted.valid || !localCheck.valid || !remoteCheck.valid) {
        stateCorrupt = true;
        corruptReason = 'posted-validation';
        emit(`::error::state corrupt: posted.json failed validation`);
        break;
      }
      if (localCheck.rejected.length || (!remotePostedAbsent && remoteCheck.rejected.length)) {
        emit(`⚠️ rejected ${localCheck.rejected.length + (remotePostedAbsent ? 0 : remoteCheck.rejected.length)} invalid key(s) during validation`);
      }

      const merge = mergePostedIds(localPosted.value, remotePosted.value, { localCheck, remoteCheck, remoteAbsent: remotePostedAbsent });
      const verdict = classifyMerge({
        localCount: merge.localCount,
        remoteCount: merge.remoteCount,
        mergedCount: merge.merged.length,
        rejected: merge.rejected,
      });
      if (verdict.corrupt) {
        stateCorrupt = true;
        corruptReason = verdict.reason;
        if (verdict.reason === 'shrink') emit(`::error::state corrupt: shrink detected against remote baseline`);
        else if (verdict.reason === 'growth') emit(`::error::state corrupt: remote growth exceeds allowance`);
        else emit(`::error::state corrupt: merged state below the absolute floor`);
        break; // nothing is written and nothing is pushed
      }

      // The caps above are enforced on EACH SIDE. A union of two individually
      // valid sides can exceed both caps (200k + 200k disjoint keys => 400k
      // elements / >8 MB pretty). Validate the ARRAY THAT IS ACTUALLY WRITTEN
      // before any file is touched.
      const mergedCheck = validatePostedIds(merge.merged);
      if (!mergedCheck.valid || mergedCheck.rejected.length > 0) {
        stateCorrupt = true;
        corruptReason = 'merged-validation';
        emit(`::error::state corrupt: merged posted.json exceeds the output caps or contains invalid keys`);
        break; // nothing is written and nothing is pushed
      }

      // 6. the title map is a CACHE: an absent/corrupt side degrades to the
      //    other side. Only an invalid shape on BOTH sides is red.
      const localTitle = parseJsonSide(localTitleRaw, {});
      const remoteTitle = parseJsonSide(remoteTitleRaw, {});
      const localTitleOk = localTitle.valid && validateTitleMap(localTitle.value).valid;
      const remoteTitleOk = remoteTitle.valid && validateTitleMap(remoteTitle.value).valid;
      let titleMerged = {};
      if (localTitleOk && remoteTitleOk) {
        const tm = mergeTitleMap(localTitle.value, remoteTitle.value, { now });
        titleMerged = tm.merged;
      } else if (localTitleOk) {
        titleMerged = localTitle.value;
      } else if (remoteTitleOk) {
        titleMerged = remoteTitle.value;
      } else {
        stateCorrupt = true;
        corruptReason = 'title-map-validation';
        emit(`::error::state corrupt: title-map.json failed validation`);
        break;
      }

      // 7. write — only now, after every guard passed
      const postedJson = JSON.stringify(merge.merged, null, 2);
      const titleMapJson = JSON.stringify(titleMerged);
      writeFile(outPath, postedJson);
      writeFile(titleMapOutPath, titleMapJson);

      // 8. build the commit ON TOP of the fetched tip (temp index only —
      //    the working tree is NOT touched). P-6: hash the in-memory buffer
      //    (git hash-object -w --stdin) instead of re-reading the file.
      const readTree = await git(['read-tree', sha]);
      if (readTree.code !== 0) {
        emit(`⚠️ git read-tree failed (exit ${readTree.code})`);
        continue;
      }
      const postedBlob = await git(['hash-object', '-w', '--stdin'], { input: postedJson });
      if (postedBlob.code !== 0) {
        emit(`⚠️ git hash-object failed (exit ${postedBlob.code})`);
        continue;
      }
      const titleBlob = await git(['hash-object', '-w', '--stdin'], { input: titleMapJson });
      if (titleBlob.code !== 0) {
        emit(`⚠️ git hash-object failed (exit ${titleBlob.code})`);
        continue;
      }
      const updatePosted = await git(['update-index', '--add', '--cacheinfo', '100644', String(postedBlob.stdout || '').trim(), remotePostedPath]);
      if (updatePosted.code !== 0) {
        emit(`⚠️ git update-index failed (exit ${updatePosted.code})`);
        continue;
      }
      const updateTitle = await git(['update-index', '--add', '--cacheinfo', '100644', String(titleBlob.stdout || '').trim(), remoteTitleMapPath]);
      if (updateTitle.code !== 0) {
        emit(`⚠️ git update-index failed (exit ${updateTitle.code})`);
        continue;
      }
      const treeRes = await git(['write-tree']);
      if (treeRes.code !== 0) {
        emit(`⚠️ git write-tree failed (exit ${treeRes.code})`);
        continue;
      }
      const tree = String(treeRes.stdout || '').trim();
      const baseTreeRes = await git(['rev-parse', `${sha}^{tree}`]);
      const baseTree = baseTreeRes.code === 0 ? String(baseTreeRes.stdout || '').trim() : '';

      if (tree && tree === baseTree) {
        emit('ℹ️ No state changes to commit.');
        noop = true;
        pushed = true;
        break;
      }

      const commitRes = await git([
        '-c', `user.name=${authorName}`,
        '-c', `user.email=${authorEmail}`,
        'commit-tree', tree, '-p', sha, '-m', COMMIT_MESSAGE,
      ]);
      if (commitRes.code !== 0) {
        emit(`⚠️ git commit-tree failed (exit ${commitRes.code})`);
        continue;
      }
      const commit = String(commitRes.stdout || '').trim();
      if (!commit) {
        emit(`⚠️ git commit-tree returned no commit id`);
        continue;
      }

      // 9. push — explicit refspec. The credential travels through the
      //    child's ENVIRONMENT (GIT_CONFIG_*) instead of argv: a `-c
      //    http...extraheader=<base64 token>` argument is visible in process
      //    listings and git trace, and GitHub's log masking covers the raw
      //    token but NOT its base64 form. Never put it in a URL either.
      const pushEnv = token
        ? {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`,
        }
        : {};
      const pushRes = await git(['push', 'origin', `${commit}:refs/heads/${branch}`], { env: pushEnv });
      if (pushRes.code !== 0) {
        emit(`⚠️ git push failed (exit ${pushRes.code})`);
        continue; // the next attempt re-fetches and rebuilds on the new tip
      }
      emit('✅ State pushed.');
      pushed = true;
      break;
    } finally {
      // F-02: the temp index is a throwaway: it never lives in the repository.
      try { fs.rmSync(indexFile, { force: true }); } catch { }
    }
  }

  if (!stateCorrupt && !pushed && !noop) {
    pushFailed = true;
    emit(`::error::state push failed after ${attempts} attempts`);
  }

  return {
    stateCorrupt,
    pushFailed,
    attempts: usedAttempts,
    log: lines,
    reason: corruptReason,
    noop,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
// Usage (BOTH modes share the same defaults and the same flags — M-06):
//   node scripts/merge-posted-state.mjs [--push] [--attempts N]
//     [--local data/posted.json]      [--remote data/posted.json]
//     [--title-map-local data/title-map.json]
//     [--title-map-remote data/title-map.json]
//     [--out data/posted.json]        [--title-map-out data/title-map.json]
//     [--github-output "$GITHUB_OUTPUT"]
// Without --push the script only merges the two sides locally (no git, no
// push); with --push it fetches, merges, guards, commits and pushes.
function parseArgs(argv) {
  const args = { push: false, attempts: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--push') args.push = true;
    else if (a === '--attempts') args.attempts = Number(argv[++i]);
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const value = argv[++i];
      args[key] = value;
    }
  }
  return args;
}

function writeGithubOutputs(file, values) {
  if (!file) return;
  try {
    const body = Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    // The script is the SOLE writer of this step's output file (M-08): it
    // OVERWRITES its own default-deny instead of appending a second value
    // for the same key and relying on GitHub's duplicate-key resolution.
    fs.writeFileSync(file, body);
  } catch (e) {
    console.error(`could not write ${file}:`, e.message);
  }
}

/** Read a text file without throwing; null marks it as UNREADABLE. */
function readTextFile(file, fallback) {
  if (!file) return fallback;
  try {
    if (!fs.existsSync(file)) return fallback;
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`::error::state corrupt: ${file} could not be read`);
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputFile = args['github-output'] || process.env.GITHUB_OUTPUT || null;

  // Default-deny (F-07 / M-08): the state is treated as CORRUPT until a
  // verified merge AND a successful push have both happened. The default is
  // written FIRST, so a script that dies half-way through still leaves
  // state_corrupt=true behind and the chain stays blocked. The workflow
  // does not pre-seed the value any more — the script is the sole writer.
  writeGithubOutputs(outputFile, { state_corrupt: 'true', push_failed: 'false' });

  if (!args.push) {
    // Merge-only mode: no git, no push. Used for local verification.
    // The SAME defaults and the SAME title-map handling as the push mode
    // (M-06): a missing flag never crashes the CLI and no flag is ignored.
    const localPath = args.local || 'data/posted.json';
    const remotePath = args.remote || 'data/posted.json';
    const titleMapLocalPath = args['title-map-local'] || 'data/title-map.json';
    const titleMapRemotePath = args['title-map-remote'] || 'data/title-map.json';
    const outPath = args.out || 'data/posted.json';
    const titleMapOutPath = args['title-map-out'] || 'data/title-map.json';

    const localRaw = readTextFile(localPath, '[]');
    const remoteRaw = readTextFile(remotePath, '[]');
    // P-8/F-01: a MISSING remote file is ABSENT, not corrupt — it is the
    // bootstrap case (there is no baseline to compare against). A remote file
    // that exists but is empty/unparseable stays fail-closed.
    const remoteAbsent = !fs.existsSync(remotePath);
    let local, remote;
    if (localRaw !== null) { try { local = JSON.parse(localRaw); } catch { local = null; } }
    if (remoteRaw !== null) { try { remote = JSON.parse(remoteRaw); } catch { remote = null; } }
    if (!Array.isArray(local) || !Array.isArray(remote)) {
      console.error('::error::state corrupt: posted.json failed validation');
      writeGithubOutputs(outputFile, { state_corrupt: 'true', push_failed: 'false' });
      return 1;
    }
    const merge = mergePostedIds(local, remote, { remoteAbsent });
    // A side that failed the schema/caps validation is RED with the fixed
    // error line — the same line the push path emits.
    if (merge.invalid.length > 0) {
      console.error('::error::state corrupt: posted.json failed validation');
      writeGithubOutputs(outputFile, { state_corrupt: 'true', push_failed: 'false' });
      return 1;
    }
    const verdict = classifyMerge({
      localCount: merge.localCount,
      remoteCount: merge.remoteCount,
      mergedCount: merge.merged.length,
      rejected: merge.rejected,
    });
    if (verdict.corrupt) {
      console.error(`::error::state corrupt: ${verdict.reason}`);
      writeGithubOutputs(outputFile, { state_corrupt: 'true', push_failed: 'false' });
      return 1;
    }
    // Same output-cap guard as the push path: the union can exceed the caps
    // even when both sides are individually valid.
    const mergedCheck = validatePostedIds(merge.merged);
    if (!mergedCheck.valid || mergedCheck.rejected.length > 0) {
      console.error('::error::state corrupt: merged posted.json exceeds the output caps');
      writeGithubOutputs(outputFile, { state_corrupt: 'true', push_failed: 'false' });
      return 1;
    }

    // The title map is a CACHE: an absent/corrupt side degrades to the
    // other side — the same rule as the push mode.
    const localTitleRaw = readTextFile(titleMapLocalPath, '{}');
    const remoteTitleRaw = readTextFile(titleMapRemotePath, '{}');
    const localTitle = localTitleRaw === null
      ? { present: false, valid: false, value: {} }
      : parseJsonSide(localTitleRaw, {});
    const remoteTitle = remoteTitleRaw === null
      ? { present: false, valid: false, value: {} }
      : parseJsonSide(remoteTitleRaw, {});
    const localTitleOk = localTitle.valid && validateTitleMap(localTitle.value).valid;
    const remoteTitleOk = remoteTitle.valid && validateTitleMap(remoteTitle.value).valid;
    let titleMerged = {};
    if (localTitleOk && remoteTitleOk) {
      titleMerged = mergeTitleMap(localTitle.value, remoteTitle.value, { now: Date.now() }).merged;
    } else if (localTitleOk) {
      titleMerged = localTitle.value;
    } else if (remoteTitleOk) {
      titleMerged = remoteTitle.value;
    } else {
      console.error('::error::state corrupt: title-map.json failed validation');
      writeGithubOutputs(outputFile, { state_corrupt: 'true', push_failed: 'false' });
      return 1;
    }

    writeFileAtomic(outPath, JSON.stringify(merge.merged, null, 2));
    writeFileAtomic(titleMapOutPath, JSON.stringify(titleMerged));
    console.log(`✅ merged ${merge.merged.length} key(s) (rejected=${merge.rejected})`);
    writeGithubOutputs(outputFile, { state_corrupt: 'false', push_failed: 'false' });
    return 0;
  }

  const result = await pushStateWithRetries({
    attempts: Number.isInteger(args.attempts) && args.attempts > 0 ? args.attempts : 3,
    localPath: args.local || 'data/posted.json',
    titleMapLocalPath: args['title-map-local'] || 'data/title-map.json',
    outPath: args.out || 'data/posted.json',
    titleMapOutPath: args['title-map-out'] || 'data/title-map.json',
    runGit: makeGitRunner(),
  });

  writeGithubOutputs(outputFile, {
    state_corrupt: result.stateCorrupt ? 'true' : 'false',
    push_failed: result.pushFailed ? 'true' : 'false',
  });

  if (result.stateCorrupt || result.pushFailed) return 1;
  return 0;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error('state merge failed:', e);
    process.exitCode = 1;
  });
}
