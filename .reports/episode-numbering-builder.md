# Builder Report — Episode Numbering Fix (sequel overflow + fast-path + batch-range gating)

- **Repo:** `D:\A\Anime Sub Bot` (Node ESM, node v26.7.0)
- **Plan:** APPROVED PLAN + PLAN-REVIEW corrections (binding), implemented TDD (RED → GREEN)
- **Touched src files:** `src/title-identity.mjs`, `src/telegram-client.mjs`
- **New test file:** `test/episode-numbering.test.mjs` (10 tests)
- **Existing tests:** `test/dedup.test.mjs` + `test/title-identity.test.mjs` — **untouched** (`git status` clean for both)
- **Forbidden files:** none touched (`.env`, `SESSION_STRING.txt`, `data/posted.json`, `data/title-map.json`, `.github/workflows/` all untouched). No network, no tokens, no git commit/push.

---

## 1) RED — BEFORE src changes (verbatim)

Command: `node --test test/episode-numbering.test.mjs` (run with the finalized test file, before any `src/` edit; captured via cmd redirection, byte-exact).

All **7 mandatory tests FAIL** (tests 3/4 via `TypeError` on the missing namespace export — a missing export must fail per-test, not at link time, hence namespace imports; tests 1/2/5/6/7 via assertions). Extra (ii) also fails pre-fix (enrichment missing). Extras (i)/(iii) pass pre-fix by design (regression guards pinning current-correct behavior of old-shaped entries and the resolved=null path).

```
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\episode-numbering-test-pD5XfR\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\episode-numbering-test-pD5XfR\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\episode-numbering-test-pD5XfR\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\episode-numbering-test-pD5XfR\data\title-map.json'
(node:28416) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
✖ extractBatchRange: ignores 'Part 2 - 01' and false ranges (returns null) (4.4179ms)
✖ extractBatchRange: preserves valid batch ranges ('01-13' and '[01 - 13 END]') (1.1539ms)
✖ fast-path: extracts secondary episode from bracketed '[P2 - 01]' or '[Part 2 - 01]' (0.3114ms)
✖ fast-path guard: ignores standalone '[Part 2]' or '[Season 2]' without secondary episode (0.3447ms)
✖ sequel overflow: epNum > episodes calculates sequel difference (13 - 12 = 1) and emits sequel keys (5.2284ms)
✖ sequel overflow: bidirectional deduplication (A blocks B, and B blocks A) (7.3067ms)
✖ sequel overflow: fail-open when episodes is null or AniList is down (2.19ms)
✔ old cache entry without episodes/relations/sequel returns exactly {romaji, english} and emits no sequel keys (2.0134ms)
✖ episodes: 0 is treated as unknown (resolver omits it; no sequel overflow) (2.0561ms)
✔ resolved=null on defect title B yields the pre-fix-shaped base keys (no fast-path/sequel additions) (2.0997ms)
ℹ tests 10
ℹ suites 0
ℹ pass 2
ℹ fail 8
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 591.5998

✖ failing tests:

test at test\episode-numbering.test.mjs:98:1
✖ extractBatchRange: ignores 'Part 2 - 01' and false ranges (returns null) (4.4179ms)
  AssertionError [ERR_ASSERTION]: defect A '… Part 2 - 01' must not read as a range
  + actual - expected

  + [
  +   2,
  +   1
  + ]
  - null

      at TestContext.<anonymous> (file:///D:/A/Anime%20Sub%20Bot/test/episode-numbering.test.mjs:99:10)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1397:25)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: [ 2, 1 ],
    expected: null,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\episode-numbering.test.mjs:111:1
✖ extractBatchRange: preserves valid batch ranges ('01-13' and '[01 - 13 END]') (1.1539ms)
  AssertionError [ERR_ASSERTION]: descending trailing range must be rejected
  + actual - expected

  + [
  +   13,
  +   1
  + ]
  - null

      at TestContext.<anonymous> (file:///D:/A/Anime%20Sub%20Bot/test/episode-numbering.test.mjs:115:10)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1397:25)
      at async Test.processPendingSubtests (node:internal/test_runner/test:969:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: [ 13, 1 ],
    expected: null,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\episode-numbering.test.mjs:123:1
✖ fast-path: extracts secondary episode from bracketed '[P2 - 01]' or '[Part 2 - 01]' (0.3114ms)
  TypeError: tc.extractSecondaryEpisodeNumber is not a function
      at TestContext.<anonymous> (file:///D:/A/Anime%20Sub%20Bot/test/episode-numbering.test.mjs:124:19)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1397:25)

test at test\episode-numbering.test.mjs:143:1
✖ fast-path guard: ignores standalone '[Part 2]' or '[Season 2]' without secondary episode (0.3447ms)
  TypeError: tc.extractSecondaryEpisodeNumber is not a function
      at TestContext.<anonymous> (file:///D:/A/Anime%20Sub%20Bot/test/episode-numbering.test.mjs:144:19)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1397:25)

test at test\episode-numbering.test.mjs:161:1
✖ sequel overflow: epNum > episodes calculates sequel difference (13 - 12 = 1) and emits sequel keys (5.2284ms)
  AssertionError [ERR_ASSERTION]: resolver must expose episodes=12

  undefined !== 12

      at TestContext.<anonymous> (file:///D:/A/Anime%20Sub%20Bot/test/episode-numbering.test.mjs:167:10)
      at async Test.run (node:internal/test_runner/test:1404:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:969:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: undefined,
    expected: 12,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\episode-numbering.test.mjs:191:1
✖ sequel overflow: bidirectional deduplication (A blocks B, and B blocks A) (7.3067ms)
  AssertionError [ERR_ASSERTION]: B must be blocked by A

  false !== true

      at TestContext.<anonymous> (file:///D:/A/Anime%20Sub%20Bot/test/episode-numbering.test.mjs:199:10)
      at async Test.run (node:internal/test_runner/test:1404:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:969:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\episode-numbering.test.mjs:221:1
✖ sequel overflow: fail-open when episodes is null or AniList is down (2.19ms)
  AssertionError [ERR_ASSERTION]: enriched resolve must expose relations when present
      at TestContext.<anonymous> (file:///D:/A/Anime%20Sub%20Bot/test/episode-numbering.test.mjs:228:10)
      at async Test.run (node:internal/test_runner/test:1404:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:969:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: '==',
    diff: 'simple'
  }

test at test\episode-numbering.test.mjs:289:1
✖ episodes: 0 is treated as unknown (resolver omits it; no sequel overflow) (2.0561ms)
  AssertionError [ERR_ASSERTION]: relations stay exposed when present
      at TestContext.<anonymous> (file:///D:/A/Anime%20Sub%20Bot/test/episode-numbering.test.mjs:295:10)
      at async Test.run (node:internal/test_runner/test:1404:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:969:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: '==',
    diff: 'simple'
  }
```

### RED-failure reasons (all for the right defect)

| # | Test | Pre-fix failure | Right reason? |
|---|---|---|---|
| 1 | extractBatchRange ignores 'Part 2 - 01' | `[2,1] ≠ null` | ✅ the live false-range defect |
| 2 | extractBatchRange preserves valid ranges | `[13,1] ≠ null` (rules 1-2 ungated) | ✅ missing `start < end` gate |
| 3 | fast-path secondary extraction | `TypeError: tc.extractSecondaryEpisodeNumber is not a function` | ✅ missing export (namespace import) |
| 4 | fast-path guard standalone brackets | same `TypeError` | ✅ missing export |
| 5 | sequel overflow diff 13-12=1 | `resolved.episodes === undefined` (no enrichment) | ✅ resolver lacks episodes/sequel |
| 6 | bidirectional dedup A↔B | `B must be blocked by A: false !== true` (zero intersection) | ✅ the live dedup defect |
| 7 | fail-open episodes null / AniList down | `relations` absent from resolve output | ✅ missing conditional enrichment |
| (ii) | episodes: 0 unknown | `relations` absent | ✅ missing enrichment (bonus RED) |

---

## 2) GREEN — AFTER implementation (verbatim)

### 2a) Full suite: `node --test`

```
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\dedup-test-cwepVq\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\dedup-test-cwepVq\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\dedup-test-cwepVq\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\dedup-test-cwepVq\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\dedup-test-cwepVq\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\dedup-test-cwepVq\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\dedup-test-cwepVq\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\dedup-test-cwepVq\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\dedup-test-cwepVq\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\dedup-test-cwepVq\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\dedup-test-cwepVq\data\title-map.json'
(node:11376) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
✔ أ: cross-language pair 1 (Overgeared <-> Tempal) blocked in both directions (18.7546ms)
✔ أ: cross-language pair 2 (Shinja Zero <-> Full Clearing) blocked in both directions (3.931ms)
✔ أ: cross-language pair 3 (Shuiro no Kamen <-> The Vermilion Mask) blocked in both directions (5.0903ms)
✔ ب: fansub team pairs (bam/bam25, celectial/celestial, zaraxsub/zaraxsubs, netfli/netflix) intersect (2.0849ms)
✔ ج: AniList fully down -> resolver returns null, keys equal base keys, zero throws (1.3453ms)
✔ د: same candidate title twice through resolve+keys flow -> exactly 1 fetch (3.273ms)
✔ هـ: getReleaseKeys(T, true, resolved) is a superset of getReleaseKeys(T, true) (4.6096ms)
✔ هـ: getFansubReleaseKeys(T, resolved) is a superset of getFansubReleaseKeys(T) (3.2274ms)
✔ و: resolved keys include explicit canonical family + synthetic re-runs of the other variant (3.2268ms)
✔ ز2 forward: old 2-arg post of variant A blocks variant B when B is resolved (2.0395ms)
✔ ز2 reverse: sync ingestion of synonym-side post blocks romaji-side arrival (4.4338ms)
✔ reconstruction fidelity: buildSyntheticTitle preserves platform bracket, episode token and tags (0.4401ms)
✔ batch: duplicates resolve with one fetch per unique title; getCachedCanonical populated (2.5444ms)
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\episode-numbering-test-nANW5Z\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\episode-numbering-test-nANW5Z\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\episode-numbering-test-nANW5Z\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\episode-numbering-test-nANW5Z\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\episode-numbering-test-nANW5Z\data\title-map.json'
(node:14312) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use `node --trace-warnings ...` to show where the warning was created)
✔ extractBatchRange: ignores 'Part 2 - 01' and false ranges (returns null) (3.2964ms)
✔ extractBatchRange: preserves valid batch ranges ('01-13' and '[01 - 13 END]') (0.6652ms)
✔ fast-path: extracts secondary episode from bracketed '[P2 - 01]' or '[Part 2 - 01]' (6.2106ms)
✔ fast-path guard: ignores standalone '[Part 2]' or '[Season 2]' without secondary episode (0.6369ms)
✔ sequel overflow: epNum > episodes calculates sequel difference (13 - 12 = 1) and emits sequel keys (8.0247ms)
✔ sequel overflow: bidirectional deduplication (A blocks B, and B blocks A) (3.5679ms)
✔ sequel overflow: fail-open when episodes is null or AniList is down (3.4874ms)
✔ old cache entry without episodes/relations/sequel returns exactly {romaji, english} and emits no sequel keys (1.5727ms)
✔ episodes: 0 is treated as unknown (resolver omits it; no sequel overflow) (4.9292ms)
✔ resolved=null on defect title B yields the pre-fix-shaped base keys (no fast-path/sequel additions) (0.8665ms)
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\title-identity-test-3Y7KGf\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\title-identity-test-3Y7KGf\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\title-identity-test-3Y7KGf\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\title-identity-test-3Y7KGf\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\title-identity-test-3Y7KGf\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\title-identity-test-3Y7KGf\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\title-identity-test-3Y7KGf\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\title-identity-test-3Y7KGf\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\title-identity-test-3Y7KGf\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\title-identity-test-3Y7KGf\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\title-identity-test-3Y7KGf\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\title-identity-test-3Y7KGf\data\title-map.json'
title-map.json unreadable/corrupt — starting with empty cache: ENOENT: no such file or directory, open 'C:\Users\mohamed\AppData\Local\Temp\title-identity-test-3Y7KGf\data\title-map.json'
✔ normalizeQuery contract examples (2.7985ms)
✔ normalizeTeamName aliases and year-suffix stripping (0.8388ms)
✔ trust guard: single-token query accepts ONLY exact token-set equality (4.8053ms)
✔ trust guard: single-token query REJECTS a multi-token field containing it (2.0215ms)
✔ trust guard: multi-token query accepts via synonym (Jaccard/exact) (2.7502ms)
✔ trust guard: low-similarity candidates are rejected (bias: reject) (2.6541ms)
✔ resolveCanonicalTitle fetches exactly once per unique title (cache hit on 2nd) (2.4623ms)
✔ transient fetch failure -> null, never throws, NOT cached (second call re-fetches) (0.7726ms)
✔ HTTP non-200 -> null, no cache write (second call re-fetches) (0.5524ms)
✔ genuine negative (successful fetch, no match) IS cached for 24h (1.7689ms)
✔ cache persistence: entry written to disk survives state reset (no new fetch) (3.4221ms)
✔ budget exhaustion -> null without fetching or caching (26.8578ms)
✔ resolveCanonicalTitlesBatch dedupes input; getCachedCanonical works afterwards (1.9281ms)
✔ circuit-breaker: 3 consecutive transport failures stop fetching for the rest of the cycle (0.784ms)
✔ cycle deadline: past CYCLE_BUDGET_MS the cycle fails open with zero fetches (0.3088ms)
✔ normalizeQuery strips URLs so URL fragments never become cache keys (0.2599ms)
✔ future-dated negative ts is clamped: fetch IS attempted and the entry is refreshed (3.7005ms)
✔ saveTitleMap: atomic write (tmp+rename) and prunes expired negatives (2.8785ms)
ℹ tests 41
ℹ suites 0
ℹ pass 41
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 700.7525
```

(The `title-map.json unreadable/corrupt — ENOENT` warnings are pre-existing benign noise: each test file starts in a fresh empty temp cwd and `loadTitleMap` warns before starting with an empty cache — identical noise appears in the untouched baseline suite.)

### 2b) Syntax checks

```
node --check src/title-identity.mjs   → OK (no output, exit 0)
node --check src/telegram-client.mjs  → OK (no output, exit 0)
```

### 2c) `git diff --stat` (read-only)

```
 src/telegram-client.mjs | 153 ++++++++++++++++++++++++++++++++++++++++++++++--
 src/title-identity.mjs  |  67 +++++++++++++++++++--
 2 files changed, 209 insertions(+), 11 deletions(-)
```

(`git status --porcelain`: ` M src/telegram-client.mjs`, ` M src/title-identity.mjs`, `?? test/episode-numbering.test.mjs` + this `.reports/` dir. Old test files not listed → untouched.)

---

## 3) Files changed (file:line, current positions)

### `src/title-identity.mjs` (435 → 492 lines; +query, +helper, 3 rewires)

| Lines | Change | Plan ref |
|---|---|---|
| `:29-33` | `ANILIST_QUERY` gains `episodes` + `relations { edges { relationType node { id episodes title { romaji english } } } }`; `Page(perPage: 5)` and everything else unchanged | 1a |
| `:233-270` | NEW internal `buildCanonicalResult(entry)` — conditional enrichment: base ALWAYS exactly `{ romaji, english }`; `episodes` only if `Number.isInteger && > 0`; `relations` only when non-empty array; `sequel` = first SEQUEL edge → `{ id, episodes, romaji, english }`; **never null placeholders** | 1b |
| `:283` | cache-hit return → `return buildCanonicalResult(entry)` | 1b/1c |
| `:344-375` | fresh-fetch entry build: persists `episodes` (number/null as returned) only when `candidate.episodes !== undefined`; persists `relations` (edges array verbatim) only when edges exist; persists derived `sequel` when a SEQUEL edge exists; returns `buildCanonicalResult(entryOut)` (same shape as cache hit) | 1b/1d |
| `:397-400` | `getCachedCanonical` → `return buildCanonicalResult(entry)` (feeds the telegram-client sync pre-pass) | 1c |

- No `getCachedTitleEntry` fallback added (plan 1e respected).
- Negative entries unchanged.

### `src/telegram-client.mjs` (2878 → 3019 lines; +49 extractor/helpers, +15 batch-range, +38 official enrichment, +33 fansub enrichment)

| Lines | Change | Plan ref |
|---|---|---|
| `:249-259` | NEW **exported** `extractSecondaryEpisodeNumber(title)` — one export only (no alias soup); regex `/\[\s*(?:part\|cour\|[ps])\s*(\d{1,2})\s*[-~]\s*(\d{1,4})\s*\]/i` → noPad group 2 or `''`; matches `[P2 - 01]`/`[Part 2 - 01]`/`[Cour 2 - 03]`; rejects `[Part 2]`/`[Season 2]`/`[P2]` | 2a |
| `:261-292` | NEW internal `replacePrimaryEpisode(title, ep)` — replaces FIRST episode token using the same 5 `EP_PATTERNS` as `buildSyntheticTitle` (title-identity:402-408, copied verbatim), writes pad2 form ` - 01`; returns null when no token | 2b |
| `:294-296` | NEW internal `stripSecondaryBracket(title)` — removes `[P<n> - <ep>]` / `[Part n - ep]` / `[Cour n - ep]` markers | 2b |
| `:349-386` | `extractBatchRange` rewritten: `start < end` gate on ALL THREE rules (1 tilde / 2 bracketed / 3 trailing); period-prefix exclusion `/\b(?:part\|cour\|season\|[ps])\s*$/i` on `title.slice(0, match.index)`; `/g` + `matchAll` scan that CONTINUES past invalid/excluded candidates; `[01 - 13 END]` → `[1,13]` and trailing `01-13` → `[1,13]` preserved | 2c |
| `:541-578` | `getReleaseKeys` resolved-branch additions (after the (b) synthetic re-runs, inside the existing try/catch): **(c) FAST-PATH** — `extractSecondaryEpisodeNumber`; if non-empty and `Number(secondary) !== Number(epNum)`, emit full `getReleaseKeys(alt, isOfficial, null)` additive; **(d) SEQUEL OVERFLOW** — gate `Number.isInteger(resolved.episodes) && > 0 && Number(epNum) > episodes && diff <= 100 && resolved.sequel.id != null`; `diff = epNum - episodes`; `buildSyntheticTitle` → `stripSecondaryBracket(replacePrimaryEpisode(·, String(diff)))` → emit full `getReleaseKeys(sequelTitle, isOfficial, null)`; original ep keys stay (cumulative) | 2e/2f |
| `:698-730` | `getFansubReleaseKeys` — identical (c)/(d) enrichment using `getFansubReleaseKeys(alt/sequelTitle, null)` | 2e/2f |

- **Public signatures UNCHANGED**: `getReleaseKeys(title, isOfficial=false, resolved=null)` / `getFansubReleaseKeys(title, resolved=null)` — no 4th param (plan 2d).
- All enrichment sits AFTER the null guard (`if (!resolved || typeof resolved !== 'object') return baseKeys;`), so recursive re-runs (which pass `resolved=null`) can never re-enter → no recursion, resolved=null path byte-identical (acceptance و).

### `test/episode-numbering.test.mjs` (NEW, 320 lines, 10 tests)

- cwd isolated with `mkdtempSync` + `process.chdir` BEFORE importing src (same pattern as existing tests); namespace imports (`const ti = await import(...)`, `const tc = await import(...)`) so a missing export fails per-test, not at link time.
- Uses `__setFetchImpl`, `__setTitleMapFile`, `__resetTitleIdentityState`, `resetCycleBudget`; **stub fetch only — no network, no tokens**; stub routes on the normalized search string `Yozakura san Chi no Daisakusen 2nd` (empirically verified: `normalizeQuery(A) === normalizeQuery(B)`).
- 7 mandatory tests with EXACT names + 3 extras (total repo: 31 + 10 = **41 ≥ 40**).

---

## 4) Test count

| File | Tests | Status |
|---|---|---|
| `test/dedup.test.mjs` | 13 | untouched, all green |
| `test/title-identity.test.mjs` | 18 | untouched, all green |
| `test/episode-numbering.test.mjs` | 10 | new: 7 mandatory + 3 extras |
| **Total** | **41** | **41 pass / 0 fail** (`node --test`) |

Extras: (i) old cache entry without episodes/relations/sequel → EXACTLY `{romaji, english}`, no sequel keys; (ii) `episodes: 0` treated as unknown (+contrast: same shape with `episodes: 12` DOES overflow); (iii) resolved=null on defect B = pre-fix-shaped base keys.

---

## 5) Acceptance matrix أ-ز

| # | Criterion | Result | Evidence |
|---|---|---|---|
| أ | A blocks B **AND** B blocks A | ✅ `A->B blocked: true \| B->A blocked: true` | test 6 green + stub probe |
| ب | `extractBatchRange('… Part 2 - 01') === null` | ✅ `null` (was `[2,1]`) | test 1 green + probe |
| ج | `extractBatchRange('… 01-13') === [1,13]` | ✅ `[1,13]` | test 2 green + probe |
| د | `extractBatchRange('… [01 - 13 END]') === [1,13]` | ✅ `[1,13]` | test 2 green + probe |
| هـ | AniList down → no throw | ✅ `resolved = null \| threw = false`, keys identical | test 7(b) green + corrected probe |
| و | resolved=null → key set identical to pre-fix (no fast-path/sequel additions on null path) | ✅ `keys(B,true,null) === keys(B,true)` true; fansub parity true; no `…part_2_01` / `…_01_p2_01` keys | test extras (iii) green + probe |
| ز | `node --test` green; `node --check` clean | ✅ 41/41 pass, 0 fail; `node --check` both files OK | outputs in §2 |

Additional verified behaviors (stub probes):
- `resolveCanonicalTitle(B)` exposes `episodes: 12`, `relations` (1 edge), `sequel: { id: 213657, episodes: null, romaji: 'Yozakura-san Chi no Daisakusen 2nd Season Part 2', english: … }`.
- Cache persistence (plan 1d): disk entry fields = `id,romaji,english,synonyms,negative,ts,episodes,relations,sequel`; cache-hit re-serves the same enriched shape (no refetch).
- Sequel synthesis fidelity: B's sequel key family includes `disney_yozakura_san_chi_no_daisakusen_2nd_season_part_2_01` — exactly A's fullNorm (synthesized `[Disney+] Yozakura-san Chi no Daisakusen 2nd Season Part 2 - 01`, pad2, secondary bracket stripped).
- `extractSecondaryEpisodeNumber(B) = '1'`, `extractEpisodeNumber(B) = '13'`, `extractEpisodeNumber(A) = '1'` (unchanged).

---

## 6) Deviations from the plan (with justification)

1. **Test 7 RED-forcing shape assertion.** Plan 7(a)'s assertions alone (`episodes` omitted; key-set equality with `{romaji, english}`) would have PASSED pre-fix, violating the plan's own "every one of the seven must fail" rule. Strengthened as the plan mandates: the (a) fixture keeps `relations`/SEQUEL edge with `episodes: null`, and the test asserts the enriched resolve exposes `relations`/`sequel` while omitting `episodes` — RED pre-fix ("enriched resolve must expose relations when present"), GREEN post-fix, and still verifies fail-open/no-throw/no-sequel-keys.
2. **Enrichment blocks inserted after the (b) synthetic re-runs block** (rather than literally between (a) and (b)): still inside the resolved branch and inside the existing try/catch; the result is a `Set` union, so insertion order cannot change membership — only array order, and no test deep-compares key arrays across different resolved shapes. Chosen to keep (a)/(b) comment numbering intact.
3. **`sequel` derived with a fallback**: primarily from the first SEQUEL edge in `relations`; if an entry somehow carries a persisted `sequel` but no `relations`, it is used instead. Purely defensive; the fresh-fetch write persists both.
4. **Implemented 10 tests** (7 mandatory + 3 extras; plan required ≥ 2 extras / ≥ 40 total). Extra (iii) covers the plan's "optional third" (resolved=null parity on B).
5. **No batch-range prefix false-positive guard beyond the plan's**: the mandated `/\b(?:part|cour|season|[ps])\s*$/i` also rejects e.g. a trailing `01-13` directly following a word ending in "part/cour/season/p/s" (e.g. `… Show Season 01-13`). Implemented exactly as specified (bias: reject); noted in open issues.

## 7) Notes on the (non-)fixes deliberately NOT done

- No band-aids: no extra `if`/`try`/`retry`/`timeout` guards beyond the ones the plan specifies (the fail-open try/catch already existed in both identity branches; the sequel/fast-path blocks live inside it by design).
- No `getCachedTitleEntry` fallback (plan 1e — proven no-op, would break resolved=null parity).
- No 4th `allowFastPath` parameter (plan 2d — null-parity proven by construction: enrichment is unreachable with `resolved=null`).
- The first acceptance probe for هـ reported `keys equal: false` — that was a **probe bug** (the probe forgot to delete the cache file, so resolve was a cache *hit* returning the enriched object, not a fetch failure). Confirmed harness-side; re-ran with `fs.rmSync(MAP)` → `resolved = null`, no throw, keys identical. Product code was not changed because of it.

## 8) Open issues

1. **Old positive cache entries self-heal only on invalidation.** Titles already cached in `data/title-map.json` before this deploy keep their old shape `{ romaji, english }` forever (positive entries never expire) — the A↔B pair gets sequel linking only for fresh resolutions or after the corresponding entry is removed from `data/title-map.json`. Plan forbade fallbacks/migrations; recommend an ops note (delete affected entries, or delete the file) at deploy time.
2. **Fast-path (c) fires for ANY non-null resolved object** with a bracketed secondary episode, including old-shaped `{ romaji, english }` entries (by design — plan 2f gates only on resolved being an object). It emits the per-part title's keys additively; extras (i)/(iii) pin that no *sequel* keys and no null-path keys leak.
3. **Production/visual run UNVERIFIED by builder** — hard constraints forbade running `src/index.mjs`, `action-runner.mjs`, `feed-monitor.mjs`, scrapers, and any network/token usage. All behavior above was verified through stubbed fetch + temp-cwd tests only.
4. `extractBatchRange` period-prefix exclusion (plan-mandated) is conservative: a legitimate batch tag placed immediately after a word ending in part/cour/season/p/s would be skipped (bias: reject, never over-guess).

---

# FIX PASS

Scope: ONLY the 7 accepted audit findings below. Sections 1-8 and the RED evidence above are untouched (this section was appended). Test count stays **41** — the F5 assertion was added INSIDE existing extra test (ii), no new test was created.

## F-1) Accepted findings → changes (file:line)

1. **[F6/F10] Test-5 dead disjunct + test-3 behavioral emission** — `test/episode-numbering.test.mjs`
   - Line 198-206: `assert.ok(fansubB.includes(A_CORE_KEY) || …part_2_01)` replaced with the exact deterministic `assert.ok(fansubB.includes('fansub_disney_' + A_CORE_KEY), …)`. **Team token verified**: platform bracket `[Disney+]` → `rawTeam` → non-alnum collapsed to `_` and trimmed → `disney` (telegram-client.mjs:611); the fansub core key is always prefixed `fansub_${tKey}_${coreKey}` (telegram-client.mjs:648), so the unprefixed disjunct was dead by construction. Assertion passes green with the real key `fansub_disney_yozakura_san_chi_no_daisakusen_2nd_season_part_2_01`.
   - Lines 130-153 (test 3): the hard-coded-implementation-title subset check replaced with behavior: `getReleaseKeys(B, true, resolved)` must contain every key of `getReleaseKeys('[Disney+] Yozakura-san Chi no Daisakusen 2nd Season - 01', true, null)` (the bracket-less per-part title, per the finding's prescribed form), plus stale-key assertions: `B_ALT_FULL_NORM` absent, and every key unique to the un-stripped `B_ALT` form (filtered vs per-part keys) absent from B's fast-path keys.
   - Constants lines 84-90: added `B_PER_PART` / `B_PER_PART_FULL_NORM`; `B_ALT` kept and now documented as the stale form used only to prove non-leakage.
2. **[F1] Fast-path strip** — `src/telegram-client.mjs:334-337` (inside new shared helper): fast-path alt is now `stripSecondaryBracket(replacePrimaryEpisode(title, secondary))` — additive; the recursion still passes `resolved=null`.
3. **[F7] `replacePrimaryEpisode` token locating** — `src/telegram-client.mjs:260-317`: now mirrors `buildSyntheticTitle`: strips/skips the leading platform bracket first (line 279-281), runs the batch-shape rejection `\d{1,4}\s*[-~]\s*\d{1,4}` on `rest` after stripping bracket contents (282-285), requires `idx > 0` (302), re-prefixes the platform bracket (303). EP_PATTERNS lookaheads keep numbers inside `[…]` unmatchable, so bracket-internal numbers are never rewritten. **Deviation (flagged)**: the batch guard carries the SAME `part|cour|season|[ps]` period-prefix exclusion used by `extractBatchRange` (acceptance-ب rule). A literal port of title-identity.mjs:455 would have batch-rejected the defect's own sequel title `…Season Part 2 - 13` (`2 - 13` is digits-dash-digits), returning null and breaking mandatory tests 5/6 — the hard "keep all 41 green" constraint makes the literal form impossible; the exclusion preserves the finding's intent (ambiguous batch regions rejected) while matching this fix pass's own period-marker rule.
4. **[F5] Fail-closed sequel guard** — `src/telegram-client.mjs:347-353` (inside shared helper, ONE place, both callers): when `Number.isInteger(resolved.sequel.episodes) && resolved.sequel.episodes > 0` and `diff > that total`, no sequel title is synthesized (bias REJECT); null/absent total still allows. Assertion added at `test/episode-numbering.test.mjs:330-335` (inside existing extra (ii)): `episodes=10`, `sequel.episodes=2`, `epNum=13` → diff 3 > 2 → `A_FULL_NORM` absent; the existing contrast (`episodes=12`, sequel total null → fires) pins the allow-when-unknown branch.
5. **[F2] De-duplication** — new module-private `collectIdentityExtraTitles(title, epNum, resolved) -> string[]` at `src/telegram-client.mjs:320-378`, used by BOTH callers: `getReleaseKeys` (617-621) and `getFansubReleaseKeys` (743-747) now loop it and re-run their OWN recursive key function with `resolved=null`. The two duplicated ~37-line (c)/(d) blocks are removed. No behavior change beyond findings 1-4. Helper self-guards with try/catch (fail-open → zero extras, base keys unchanged); the callers' outer try/catch is untouched.
6. **[F8] Comment reword** — `src/telegram-client.mjs:581-587`: "Base output above is IDENTICAL to pre-fix" → scoped to "base key FAMILIES above are unchanged … (scope: families, not every key — extractBatchRange's start<end / period-prefix gating intentionally applies on ALL paths per acceptance ب…)". Comment only; no behavior change. The fansub-side comment never made the IDENTICAL claim and was left as is.
7. **[F9] Cache edge cap** — `src/title-identity.mjs:362-364`: `entryOut.relations = edges.slice(0, 20)`; the SEQUEL derived at line 366 still scans the full response before capping. `episodes`/`relations`/`sequel` all still persisted (requirement #1 binding); negative entries untouched.

## F-2) REJECTED findings (recorded, NOT applied)

- **Drop `relations` from cache/resolved** — rejected: user requirement #1 explicitly requires storing `relations { edges { … } }` in `data/title-map.json`.
- **Drop persisted derived `sequel`** — rejected: requirement #1 references an entry's `episodes`/`sequel`; keeping both is acceptable (cache reads prefer `relations`, fall back to `sequel`).
- **F11 silent-catch logging** — rejected: the catch is deliberately quiet to avoid per-key log spam; the outer fail-open contract is unchanged.

## F-3) Verification outputs (verbatim)

**`node --test` (full suite) — EXACT count: 41 tests (41 pass, 0 fail):**
```
ℹ tests 41
ℹ suites 0
ℹ pass 41
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 616.3138
```
(41, not 42: the F5 assertion lives inside existing extra test (ii); test 3 and test 5 were strengthened in place. No test added, removed, or renamed; the 31 pre-existing tests remain untouched — `git status` shows no `test/dedup.test.mjs` / `test/title-identity.test.mjs` modification.)

**New test file only — `node --test test/episode-numbering.test.mjs` (10/10):**
```
✔ extractBatchRange: ignores 'Part 2 - 01' and false ranges (returns null) (2.8445ms)
✔ extractBatchRange: preserves valid batch ranges ('01-13' and '[01 - 13 END]') (0.3893ms)
✔ fast-path: extracts secondary episode from bracketed '[P2 - 01]' or '[Part 2 - 01]' (6.1325ms)
✔ fast-path guard: ignores standalone '[Part 2]' or '[Season 2]' without secondary episode (0.5285ms)
✔ sequel overflow: epNum > episodes calculates sequel difference (13 - 12 = 1) and emits sequel keys (6.4738ms)
✔ sequel overflow: bidirectional deduplication (A blocks B, and B blocks A) (2.3369ms)
✔ sequel overflow: fail-open when episodes is null or AniList is down (2.7548ms)
✔ old cache entry without episodes/relations/sequel returns exactly {romaji, english} and emits no sequel keys (1.419ms)
✔ episodes: 0 is treated as unknown (resolver omits it; no sequel overflow) (2.3136ms)
✔ resolved=null on defect title B yields the pre-fix-shaped base keys (no fast-path/sequel additions) (0.682ms)
ℹ tests 10
ℹ pass 10
ℹ fail 0
```

**`node --check` (both src files + test file):**
```
SYNTAX OK: all three files
```

**Diff of the fix pass:**
- `git diff --stat` (cumulative working tree vs HEAD — nothing is committed): `src/telegram-client.mjs | 181 ++…`, `src/title-identity.mjs | 69 ++…`, `2 files changed, 235 insertions(+), 15 deletions(-)`.
- First pass (recorded in section 4): `2 files changed, 209 insertions(+), 11 deletions(-)`. → **Fix-pass delta on src: +26 insertions, +4 deletions** (the test file is untracked, so its edits are not part of `git diff`).
- Exact lines changed (fix pass only):
  - `src/telegram-client.mjs:260-317` — `replacePrimaryEpisode` rewritten (F7).
  - `src/telegram-client.mjs:320-378` — NEW `collectIdentityExtraTitles` helper (F2, contains F1 strip at 334-337 and F5 guard at 347-353).
  - `src/telegram-client.mjs:581-587` — ADDITIVE-layer comment reworded (F8).
  - `src/telegram-client.mjs:617-621` — `getReleaseKeys` (c)/(d) blocks (~37 lines) replaced by the shared-helper loop.
  - `src/telegram-client.mjs:743-747` — `getFansubReleaseKeys` (c)/(d) blocks (~37 lines) replaced by the shared-helper loop.
  - `src/title-identity.mjs:362-364` — relations persistence capped with `.slice(0, 20)` (F9).
  - `test/episode-numbering.test.mjs:84-90, 130-153, 196-206, 327-335, 351` — constants + test-3 behavioral emission + test-5 exact fansub key + F5 assertion + stripped-null-path assertion (F1/F5/F6/F10).

**resolved=null parity + public signatures (probe run against the fixed module):**
```json
{
  "arity_getReleaseKeys": 1,
  "arity_getFansubReleaseKeys": 1,
  "modulePrivate_not_exported": true,
  "secondary_export_present": true,
  "null_equals_default_official": true,
  "null_equals_default_fansub": true,
  "null_has_stripped_perpart_key": false,
  "null_has_stale_p2_key": false,
  "null_has_A_sequel_key": false,
  "null_key_count": 12
}
```
Signatures unchanged: `getReleaseKeys(title, isOfficial = false, resolved = null)` and `getFansubReleaseKeys(title, resolved = null)` (arity 1 = first defaulted param, same as pre-fix). `collectIdentityExtraTitles` / `replacePrimaryEpisode` / `stripSecondaryBracket` are module-private (NOT exported); `extractSecondaryEpisodeNumber` remains the only export added by this task. The null path emits no fast-path key (stripped or stale) and no sequel key, and explicit-null equals default-call for both functions (also pinned by extra (iii), green).

## F-4) Operator note (F9)

**At deploy: delete stale positive entries from `data/title-map.json` to force re-enrichment** — pre-existing positive entries never re-enrich (they do not expire), so A↔B-style sequel linking only happens for entries written after this code deploys. Delete the affected entries (or the whole file, it rebuilds); do NOT edit it by hand while the bot is running. Builder did not modify this file (hard constraint).

## F-5) Deviations from the audit wording (flagged)

1. **F7 batch guard + period-prefix exception** (detailed in F-1.3): a literal `buildSyntheticTitle` batch guard would reject `…Part 2 - 13` (its `2 - 13` region is batch-shaped) and turn the defect's own sequel synthesis into `null`, failing mandatory tests 5/6 — i.e. the literal reading conflicts with "keep all 41 green". Applied with the same period-marker exclusion this task already established for `extractBatchRange`; semantics preserved: genuinely ambiguous batch regions (untagged `01-13`) are still rejected, bracket-internal numbers are still never rewritten.
2. No other deviations; the three REJECTED findings were left unapplied exactly as directed.
