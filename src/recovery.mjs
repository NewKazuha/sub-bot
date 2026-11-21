// Recovery / backfill support (pure logic — NO I/O).
//
// All network access is injected by the caller (fetchByIds / the scraper).
// This module only parses the recovery spec, builds synthetic message shapes,
// and manages the in-memory `pending:` ledger inside the posted Set.
//
// Security contract (C1/C5):
//   * a spec is completely inert unless it is a non-blank JSON object;
//   * unknown object keys are refused by an explicit whitelist;
//   * a synthetic postUrl is validated BEFORE any fetch: https only, no
//     userinfo, and a dot-anchored hostname match against the allowlist.
//   * fatal diagnostics carry a CODE only — never the raw spec or a URL.

import { CONFIG } from './config.mjs';

export const RECOVERY_CODES = Object.freeze({
  SPEC_INVALID: 'RECOVERY_SPEC_INVALID',
  CHAT_UNKNOWN: 'RECOVERY_CHAT_UNKNOWN',
  MSG_MISSING: 'RECOVERY_MSG_MISSING',
  REDIRECT: 'RECOVERY_REDIRECT',
  FETCH_UNSAFE: 'RECOVERY_FETCH_UNSAFE',
});

/**
 * F4: the ONE no-redirect mode for the recovery path. `manual` is a real fetch
 * redirect mode: a 3xx comes back as a Response and is turned into a typed
 * RECOVERY_REDIRECT before any body can be published.
 */
export const RECOVERY_REDIRECT_MODE = 'manual';
/** Pre-F4 callers/tests used 'error'; kept as a single legacy alias. */
export const RECOVERY_REDIRECT_LEGACY_MODE = 'error';

/** True for either spelling of the recovery no-redirect option (no literals at call sites). */
export function isRecoveryRedirectOption(value) {
  return value === RECOVERY_REDIRECT_MODE || value === RECOVERY_REDIRECT_LEGACY_MODE;
}

/** Only these typed codes are fatal on the recovery path; all else propagates. */
export function recoveryFatalCodeFor(error) {
  if (error?.code === RECOVERY_CODES.REDIRECT || error?.code === RECOVERY_CODES.FETCH_UNSAFE) {
    return error.code;
  }
  return null;
}

const RECOVERY_KINDS = new Set(['synthetic', 'id', 'pending']);
const RECOVERY_MARKER = '__recovery';

/**
 * F1: mark a message that entered the window from the recovery seam. The marker
 * is NON-ENUMERABLE so it never changes msgKey, dedup, or any state write; it is
 * only read by isRecoveryMessage() in the scrape guard.
 */
function tagRecoveryMessage(msg, kind) {
  if (msg && typeof msg === 'object' && !Object.hasOwn(msg, RECOVERY_MARKER)) {
    Object.defineProperty(msg, RECOVERY_MARKER, {
      value: kind, enumerable: false, configurable: true, writable: false,
    });
  }
  return msg;
}

/** True only for messages appended by the recovery seam (all three sources). */
export function isRecoveryMessage(msg) {
  return Boolean(msg && typeof msg === 'object' && RECOVERY_KINDS.has(msg[RECOVERY_MARKER]));
}

/**
 * G2: options for the SECOND directory call site (the fansub direct-download
 * path in telegram-client). A marked message gets the single no-redirect mode;
 * a normal message gets `{}` so normal cron callers stay byte-identical.
 */
export function recoveryScrapeOptions(msg) {
  return isRecoveryMessage(msg) ? { redirect: RECOVERY_REDIRECT_MODE } : {};
}

/**
 * G4: pure seam for the telegram-client scrape guard. `state` is the mutable
 * `{ active }` holder shared by the guard and the scrape wrapper; the flag is
 * set from the message marker for the duration of `fn` and restored afterwards
 * even when `fn` throws. Normal (unmarked) messages set it to false.
 */
export async function withRecoveryMode(msg, fn, state) {
  const wasActive = Boolean(state.active);
  const wasMsg = state.msg;
  state.active = isRecoveryMessage(msg);
  state.msg = state.active ? msg : null;
  try {
    return await fn();
  } finally {
    state.active = wasActive;
    state.msg = wasMsg;
  }
}

/** G4: options the scrape wrapper injects while recovery mode is active. */
export function scrapeOptionsForState(options, state) {
  return state.active ? { ...options, redirect: RECOVERY_REDIRECT_MODE } : options;
}

/** Typed parse error. `code` is safe to log; `message` never echoes raw input. */
export class RecoverySpecError extends Error {
  constructor(code = RECOVERY_CODES.SPEC_INVALID, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'RecoverySpecError';
    this.code = code;
    this.isFatal = true;
  }
}

const MAX_RAW_CHARS = 4096;
const MAX_TASKS = 4;
const MIN_TASKS = 1;
const MAX_TITLE = 200;
const MIN_TITLE = 3;
const MSG_ID_MIN = 1;
const MSG_ID_MAX = 2147483647;
const CHAT_ID_RE = /^-?\d{1,16}$/;
const PENDING_PREFIX = 'pending:';
const MAX_PENDING_KEYS = 200;
const MAX_PENDING_ATTEMPTS = 3;
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// S4: synthetic recovery ids are NEGATIVE (`tg_<chat>_-<id>`). The old
// second group was digits-only, so every synthetic message failed this match
// and the 3-attempt pending-ledger bound was silently void on that path.
const MSG_KEY_RE = /^tg_(-?\d+)_(-?\d+)$/;

const TOP_LEVEL_KEYS = new Set(['tasks']);
const ID_TASK_KEYS = new Set(['kind', 'chatId', 'messageId']);
const SYNTH_TASK_KEYS = new Set(['kind', 'chatId', 'title', 'postUrl']);

// ---------------------------------------------------------------------------
// Host allowlist (C1). Hosts of CONFIG.SITES bases + blogspot.com/*.
// ---------------------------------------------------------------------------
export function siteHosts() {
  const hosts = new Set(['blogspot.com', 'nyaa.si', 'erai-raws.info']);
  for (const site of CONFIG.SITES || []) {
    try {
      const h = new URL(site.base).hostname.toLowerCase();
      if (h) hosts.add(h);
    } catch { /* a malformed configured base is simply ignored */ }
  }
  return hosts;
}

/** Validate a recovery postUrl. Returns the normalised hostname or throws. */
export function validateRecoveryUrl(raw) {
  // Control characters (CR/LF/TAB/NUL/DEL) must never appear in a raw URL —
  // URL parsers silently strip some of them, so check the raw input first.
  if (/[\x00-\x1F\x7F]/.test(String(raw))) {
    throw new RecoverySpecError(RECOVERY_CODES.SPEC_INVALID, 'postUrl has control characters');
  }
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new RecoverySpecError(RECOVERY_CODES.SPEC_INVALID, 'invalid postUrl');
  }
  if (url.protocol !== 'https:') {
    throw new RecoverySpecError(RECOVERY_CODES.SPEC_INVALID, 'postUrl must be https');
  }
  // userinfo must be absent — `https://blogspot.com@evil.tld` is NOT blogspot.
  if (url.username !== '' || url.password !== '') {
    throw new RecoverySpecError(RECOVERY_CODES.SPEC_INVALID, 'postUrl has userinfo');
  }
  const host = url.hostname.toLowerCase();
  // trailing-dot and IPv6 literals are never allowlisted hosts.
  if (host.endsWith('.') || host.startsWith('[')) {
    throw new RecoverySpecError(RECOVERY_CODES.SPEC_INVALID, 'postUrl host rejected');
  }
  // IDN/punycode labels that are not in the allowlist are rejected by the
  // dot-anchored comparison below (punycode never equals an ASCII allowlist
  // entry). Reject an explicit xn-- label too, so no look-alike can pass.
  if (host.split('.').some(label => label.startsWith('xn--'))) {
    throw new RecoverySpecError(RECOVERY_CODES.SPEC_INVALID, 'postUrl host rejected');
  }
  const allowed = siteHosts();
  const ok = [...allowed].some(d => host === d || host.endsWith(`.${d}`));
  if (!ok) {
    throw new RecoverySpecError(RECOVERY_CODES.SPEC_INVALID, 'postUrl host rejected');
  }
  return host;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------
function assertOnlyKeys(obj, whitelist) {
  for (const key of Object.keys(obj)) {
    if (!whitelist.has(key)) {
      throw new RecoverySpecError(RECOVERY_CODES.SPEC_INVALID, 'unknown key');
    }
  }
}

function parseIdTask(obj) {
  assertOnlyKeys(obj, ID_TASK_KEYS);
  if (typeof obj.chatId !== 'string' || !CHAT_ID_RE.test(obj.chatId)) {
    throw new RecoverySpecError(RECOVERY_CODES.SPEC_INVALID, 'invalid chatId');
  }
  if (!Number.isInteger(obj.messageId) || obj.messageId < MSG_ID_MIN || obj.messageId > MSG_ID_MAX) {
    throw new RecoverySpecError(RECOVERY_CODES.SPEC_INVALID, 'invalid messageId');
  }
  return { kind: 'id', chatId: obj.chatId, messageId: obj.messageId };
}

function parseSyntheticTask(obj) {
  assertOnlyKeys(obj, SYNTH_TASK_KEYS);
  if (typeof obj.chatId !== 'string' || !CHAT_ID_RE.test(obj.chatId)) {
    throw new RecoverySpecError(RECOVERY_CODES.SPEC_INVALID, 'invalid chatId');
  }
  // G3: the title becomes public caption text AND feeds release/dedup keys — a wrong title can suppress a legitimate episode and is never retried; operator-only (repo write required).
  if (typeof obj.title !== 'string' || obj.title.length < MIN_TITLE || obj.title.length > MAX_TITLE ||
      /[\r\n]/.test(obj.title) || /http/i.test(obj.title)) {
    throw new RecoverySpecError(RECOVERY_CODES.SPEC_INVALID, 'invalid title');
  }
  if (typeof obj.postUrl !== 'string') {
    throw new RecoverySpecError(RECOVERY_CODES.SPEC_INVALID, 'invalid postUrl');
  }
  validateRecoveryUrl(obj.postUrl);
  return { kind: 'synthetic', chatId: obj.chatId, title: obj.title, postUrl: obj.postUrl };
}

/**
 * Parse the RECOVERY_SPEC environment value.
 * Inert (returns { tasks: [] }) iff the raw value is empty / whitespace-only.
 */
export function parseRecoverySpec(raw) {
  const value = String(raw ?? '');
  if (value.trim() === '') return { tasks: [] };
  if (value.length > MAX_RAW_CHARS) {
    throw new RecoverySpecError(RECOVERY_CODES.SPEC_INVALID, 'spec too large');
  }
  let spec;
  try {
    spec = JSON.parse(value);
  } catch {
    throw new RecoverySpecError(RECOVERY_CODES.SPEC_INVALID, 'invalid JSON');
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new RecoverySpecError(RECOVERY_CODES.SPEC_INVALID, 'spec must be an object');
  }
  assertOnlyKeys(spec, TOP_LEVEL_KEYS);
  if (!Array.isArray(spec.tasks) || spec.tasks.length < MIN_TASKS || spec.tasks.length > MAX_TASKS) {
    throw new RecoverySpecError(RECOVERY_CODES.SPEC_INVALID, 'tasks length');
  }
  const tasks = spec.tasks.map((t) => {
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      throw new RecoverySpecError(RECOVERY_CODES.SPEC_INVALID, 'invalid task');
    }
    if (t.kind === 'id') return parseIdTask(t);
    if (t.kind === 'synthetic') return parseSyntheticTask(t);
    throw new RecoverySpecError(RECOVERY_CODES.SPEC_INVALID, 'unknown task kind');
  });
  return { tasks };
}

// ---------------------------------------------------------------------------
// Synthetic ids
// ---------------------------------------------------------------------------
/** 32-bit FNV-1a, returned as an unsigned integer. */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * F6: deterministic NEGATIVE message id, widened to 53 bits by combining two
 * independent FNV-1a32 lanes. Still a safe integer and never zero.
 */
export function syntheticIdFor(url) {
  const s = String(url);
  const a = fnv1a32(s);
  const b = fnv1a32(`${s}\u0000#2`);
  const v = (a >>> 0) * 0x200000 + (b & 0x1fffff);
  return v === 0 ? -1 : -v;
}

/** The message shape consumed by the fansub branch (id + text only). */
export function syntheticMessage(task) {
  // A `.torrent` postUrl is an Erai-Raws style post. The spec's `title` field
  // cannot hold newlines, so build the multi-line body here — otherwise
  // parseEraiMessage finds no `Title:`/`Source:`/torrent URL and skips it.
  const title = String(task.title || '');
  const platformMatch = title.match(/^\[([^\]]+)\]\s*(.*)$/);
  const source = platformMatch ? platformMatch[1].trim() : 'Erai-Raws';
  const cleanTitle = platformMatch ? platformMatch[2].trim() : title;
  const message = /\.torrent(?:[?#]|$)/i.test(String(task.postUrl || ''))
    ? `Title: ${cleanTitle}\nSource: ${source}\nSubtitles: Arabic\n${task.postUrl}`
    : `${task.title}\n${task.postUrl}`;
  return tagRecoveryMessage({
    id: syntheticIdFor(task.postUrl),
    message,
  }, 'synthetic');
}

// ---------------------------------------------------------------------------
// Pending ledger over the posted Set
// ---------------------------------------------------------------------------
function encodePendingKey(chatId, msgKey, attempts, ts) {
  // msgKey is `tg_<chat>_<id>` and can never contain ':' (verified against the
  // normalisers at telegram-client.mjs:633-664 and :727-738).
  return `${PENDING_PREFIX}${chatId}:${attempts}:${ts}:${msgKey}`;
}

function decodePendingKey(key) {
  if (typeof key !== 'string' || !key.startsWith(PENDING_PREFIX)) return null;
  const parts = key.slice(PENDING_PREFIX.length).split(':');
  if (parts.length !== 4) return null;
  const [chatId, attemptsRaw, tsRaw, msgKey] = parts;
  const attempts = Number(attemptsRaw);
  const ts = Number(tsRaw);
  if (!Number.isInteger(attempts) || !Number.isFinite(ts)) return null;
  return { key, chatId, attempts, ts, msgKey };
}

function allPending(posted) {
  const out = [];
  for (const key of posted) {
    const entry = decodePendingKey(key);
    if (entry) out.push(entry);
  }
  return out;
}

function pruneToCap(posted, now) {
  const pending = allPending(posted);
  if (pending.length < MAX_PENDING_KEYS) return;
  // Drop the oldest first until there is room for one more key. Only pending
  // keys are ever removed; release keys are untouched. Dropping <=200 keys
  // cannot trip the merge script's 1000-key shrink margin.
  const sorted = pending.sort((a, b) => a.ts - b.ts);
  const toDrop = pending.length - MAX_PENDING_KEYS + 1;
  for (let i = 0; i < toDrop; i++) posted.delete(sorted[i].key);
}

/** All pending entries for a chat (decoded), including expired ones. */
export function pendingFor(posted, chatId) {
  const cid = String(chatId);
  return allPending(posted).filter(e => e.chatId === cid);
}

/**
 * Record one "no links" attempt for a message. Add-only: a 4th write is
 * refused. Returns true when an entry was (re)written.
 */
export function recordPendingAttempt(posted, msgKey, { now = Date.now() } = {}) {
  const m = MSG_KEY_RE.exec(String(msgKey));
  if (!m) return false;
  const chatId = m[1];
  const key = String(msgKey);
  const existing = allPending(posted).filter(e => e.msgKey === key);
  const attempts = existing.reduce((mx, e) => Math.max(mx, e.attempts), 0) + 1;
  if (attempts > MAX_PENDING_ATTEMPTS) return false; // read/write cap
  const ts = existing.length ? Math.min(...existing.map(e => e.ts)) : now;
  pruneToCap(posted, ts);
  posted.add(encodePendingKey(chatId, key, attempts, ts));
  return true;
}

/**
 * Pending message keys that should be re-fetched by id for this chat:
 *   - not already present in the current window,
 *   - attempts < 3,
 *   - not older than 7 days.
 * One key per message (the highest attempt count wins).
 */
export function pendingRetryKeys(posted, chatId, windowIds = [], { now = Date.now() } = {}) {
  const windowSet = new Set((windowIds || []).map(id => String(id)));
  const byMsg = new Map();
  for (const e of pendingFor(posted, chatId)) {
    if (e.attempts >= MAX_PENDING_ATTEMPTS) continue;
    if (now - e.ts > PENDING_TTL_MS) continue;
    const id = e.msgKey.split('_').pop();
    // Synthetic ids are negative and can never be fetched by id — skip them.
    if (id.startsWith('-')) continue;
    if (windowSet.has(id)) continue;
    const prev = byMsg.get(e.msgKey);
    if (!prev || e.attempts > prev.attempts) byMsg.set(e.msgKey, e);
  }
  return [...byMsg.keys()];
}

/**
 * G5: the read-side cap ACTUALLY used by the recovery run. `pendingRetryKeys`
 * above keeps its legacy per-entry contract (and its direct unit test), but on
 * its own it can resurrect a message: with entries at attempts 1/2/3 the 3-attempt
 * entry is skipped and the surviving 2-attempt one still queues a fetch. Here we
 * group by message FIRST and apply the cap to the HIGHEST attempt count, so once
 * a message has exhausted its 3 retries no legacy lower-attempt entry can fetch
 * it again. The write cap, the 200-key cap, the 7-day TTL and the window check
 * are unchanged.
 */
export function cappedPendingRetryKeys(posted, chatId, windowIds = [], { now = Date.now() } = {}) {
  const windowSet = new Set((windowIds || []).map(id => String(id)));
  const byMsg = new Map();
  for (const e of pendingFor(posted, chatId)) {
    if (now - e.ts > PENDING_TTL_MS) continue;
    const id = e.msgKey.split('_').pop();
    // Synthetic ids are negative and can never be fetched by id — skip them.
    if (id.startsWith('-')) continue;
    if (windowSet.has(id)) continue;
    const prev = byMsg.get(e.msgKey);
    if (!prev || e.attempts > prev.attempts) byMsg.set(e.msgKey, e);
  }
  return [...byMsg.values()]
    .filter(e => e.attempts < MAX_PENDING_ATTEMPTS)
    .map(e => e.msgKey);
}

// ---------------------------------------------------------------------------
// Window extension seam
// ---------------------------------------------------------------------------

/**
 * F5: EVERY task must name a known dialog id (strict String equality) — a
 * single bogus chatId next to a valid one is a fatal configuration error, not
 * a silently ignored task. Returns the raw unknown ids; callers log a code only.
 */
export function unknownRecoveryChatIds(tasks, knownIds) {
  const ids = new Set((knownIds || []).map(id => String(id)));
  return (Array.isArray(tasks) ? tasks : [])
    .map(t => String(t && t.chatId))
    .filter(cid => !ids.has(cid));
}

function msgIdOf(msg) {
  const id = msg && msg.id;
  return id == null ? '' : String(id);
}

/**
 * Build the per-chat `msgs` array: the live window first, then recovery
 * results appended in ascending id order and deduped by String(msg.id).
 *
 * Returns { msgs, fatal? }. A fatal is a plain { code, message } descriptor —
 * the caller turns it into a typed runner fatal.
 */
export async function withRecoveryMessages({ chat, windowMsgs, posted, tasks, fetchByIds, log } = {}) {
  const base = Array.isArray(windowMsgs) ? [...windowMsgs] : [];
  const taskList = Array.isArray(tasks) ? tasks : [];
  if (taskList.length === 0) return { msgs: base };

  const chatId = String(chat && chat.id);
  const mine = taskList.filter(t => String(t.chatId) === chatId);
  const otherChat = taskList.find(t => String(t.chatId) !== chatId);
  if (!mine.length && otherChat) {
    // A spec was supplied but none of its tasks target this dialog. This is a
    // configuration error (strict full-dialog-id match), not a silent no-op.
    return {
      msgs: base,
      fatal: {
        code: RECOVERY_CODES.CHAT_UNKNOWN,
        message: RECOVERY_CODES.CHAT_UNKNOWN,
      },
    };
  }

  const extra = [];

  for (const task of mine) {
    if (task.kind === 'synthetic') {
      extra.push(syntheticMessage(task));
      continue;
    }
    // id task: fetch by id. Missing ⇒ fatal (no publish).
    const found = await fetchByIds(chatId, [String(task.messageId)]);
    if (!Array.isArray(found) || found.length === 0) {
      return {
        msgs: base,
        fatal: {
          code: RECOVERY_CODES.MSG_MISSING,
          message: RECOVERY_CODES.MSG_MISSING,
        },
      };
    }
    extra.push(tagRecoveryMessage(found[0], 'id'));
  }

  // Pending ledger retries: messages that previously yielded no links.
  // G5: use the message-level cap so a message with 3 recorded "no links"
  // attempts is NOT re-fetched on a later recovery run by a stale lower-entry.
  const windowIds = base.map(msgIdOf);
  for (const pendingKey of cappedPendingRetryKeys(posted, chatId, windowIds)) {
    const id = pendingKey.split('_').pop();
    let found;
    try {
      found = await fetchByIds(chatId, [id]);
    } catch {
      // The ledger is best-effort: a synthetic/invalid id can make the Telegram
      // layer throw (e.g. MESSAGE_IDS_INVALID). ONE bad pending entry must never
      // abort the whole channel — skip it and keep processing the rest.
      continue;
    }
    if (!Array.isArray(found) || found.length === 0) {
      // A pending entry that can no longer be fetched is simply skipped —
      // never a fatal (the ledger is best-effort).
      continue;
    }
    extra.push(tagRecoveryMessage(found[0], 'pending'));
  }

  extra.sort((a, b) => {
    const na = Number(msgIdOf(a));
    const nb = Number(msgIdOf(b));
    if (!Number.isFinite(na) || !Number.isFinite(nb)) return 0;
    return na - nb;
  });

  const seen = new Set();
  const msgs = [];
  for (const msg of [...base, ...extra]) {
    const id = msgIdOf(msg);
    if (seen.has(id)) continue;
    seen.add(id);
    msgs.push(msg);
  }
  if (typeof log === 'function' && extra.length) {
    log(`   ♻️ recovery: appended ${extra.length} message(s) for chat ${chatId}`);
  }
  return { msgs };
}

export { PENDING_PREFIX, MAX_PENDING_KEYS, MAX_PENDING_ATTEMPTS, PENDING_TTL_MS };
