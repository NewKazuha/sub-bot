# Tester Report — Episode Numbering Fix (independent runtime verification)

- **Date:** 2026-10-19
- **Repo:** D:\A\Anime Sub Bot (Node ESM, Windows; runner: node --test; npm test NOT used — forbidden on Windows)
- **Scope rules observed:** did NOT run src/index.mjs, src/action-runner.mjs, src/feed-monitor.mjs, scrapers/*; did NOT modify .env, SESSION_STRING.txt, data/posted.json, data/title-map.json, .github/workflows/, or any source/test file; no network calls; no secrets printed; no git commit/push.
- **Environment note:** no ENV-PROBE.md in the repo (glob returned nothing) — proceeded directly.
- Rendering note: inline code spans replaced with plain text / quotes because this harness hangs on commands containing 3+ backtick characters (empirically confirmed; see Harness note in section 9).

---

## 1) FULL SUITE — node --test (repo root)

Command: "node --test" (cwd D:\A\Anime Sub Bot)

Runner summary output:

~~~
tests 41
suites 0
pass 41
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 710.0319
~~~

Exit code (separate re-run with explicit capture): FULL_SUITE_EXIT=0, and on that re-run "tests 41 / pass 41 / fail 0" was re-confirmed.

- Total tests: **41** — Pass: **41** — Fail: **0** — Duration: **710 ms**
- **Requirement 0 fail: MET.**
- Benign stderr noise (also present in the builder's capture; pre-existing per builder section 2a): "title-map.json unreadable/corrupt - starting with empty cache: ENOENT ... <temp>\data\title-map.json" (each test file chdirs to a fresh temp cwd before importing src) and "ExperimentalWarning: localStorage is not available because --localstorage-file was not provided." Neither is a test failure; exit code 0.
- Step 7 (hang): NO HANG — full suite completed in <1 s, far under the 120 s kill threshold.
- Per-file test split observed in the output: dedup.test.mjs 13 tests (acceptance letters أ–ز2 + reconstruction + batch), episode-numbering.test.mjs 10 tests, title-identity.test.mjs 18 tests = 41.


---

## 2) NEW FILE ALONE — node --test test/episode-numbering.test.mjs

Command: "node --test test/episode-numbering.test.mjs" — exit code NEW_FILE_EXIT=0

Runner summary: tests 10 / pass 10 / fail 0 (duration ~611 ms).

Name verification via Select-String -Pattern "^\s*(test|it)\(" on test/episode-numbering.test.mjs: 10 "test(" occurrences total (line numbers below).

The seven REQUIRED names, present **verbatim and in the listed order**:

| # | Required name (exact string) | File line | Result |
|---|---|---|---|
| 1 | extractBatchRange: ignores 'Part 2 - 01' and false ranges (returns null) | 102 | PASS |
| 2 | extractBatchRange: preserves valid batch ranges ('01-13' and '[01 - 13 END]') | 115 | PASS |
| 3 | fast-path: extracts secondary episode from bracketed '[P2 - 01]' or '[Part 2 - 01]' | 127 | PASS |
| 4 | fast-path guard: ignores standalone '[Part 2]' or '[Season 2]' without secondary episode | 158 | PASS |
| 5 | sequel overflow: epNum > episodes calculates sequel difference (13 - 12 = 1) and emits sequel keys | 176 | PASS |
| 6 | sequel overflow: bidirectional deduplication (A blocks B, and B blocks A) | 212 | PASS |
| 7 | sequel overflow: fail-open when episodes is null or AniList is down | 242 | PASS |

All seven appear character-for-character as specified (no paraphrase, no rename, no missing name) and all seven PASS.

**DISCREPANCY (flagged explicitly, not a test failure):** the instruction says the file must contain "EXACTLY these seven test names". The file actually contains **10** tests — the 7 required names verbatim plus 3 additional tests:

- line 274: old cache entry without episodes/relations/sequel returns exactly {romaji, english} and emits no sequel keys
- line 310: episodes: 0 is treated as unknown (resolver omits it; no sequel overflow)
- line 342: resolved=null on defect title B yields the pre-fix-shaped base keys (no fast-path/sequel additions)

All 10 pass. The builder report explicitly documents this: ".reports/episode-numbering-builder.md" header line 6 "(10 tests)", section 3 "7 mandatory tests with EXACT names + 3 extras (total repo: 31 + 10 = 41 >= 40)", section 4 table "7 mandatory + 3 extras", and deviation #4 ("Implemented 10 tests ... plan required >= 2 extras / >= 40 total"). So my observation and the builder report AGREE (10 tests, same names, same order); the only tension is with the literal "exactly seven" wording of the tester instruction. The seven required names themselves are exact. Reported, not papered over.


---

## 3) SYNTAX — node --check on EVERY file in src/*.mjs

Command: "Get-ChildItem src\*.mjs" -> loop "node --check <file>", capturing $LASTEXITCODE per file:

~~~
action-runner.mjs exit=0
cloud-folders.mjs exit=0
config.mjs exit=0
feed-monitor.mjs exit=0
index.mjs exit=0
path-safety.mjs exit=0
site-scrapers.mjs exit=0
telegram-client.mjs exit=0
telegram.mjs exit=0
title-identity.mjs exit=0
~~~

10/10 files, **zero non-zero exits**, no output from node --check (clean).

---

## 4) GIT SCOPE VERIFICATION

Command: "git status --short"

~~~
 M src/telegram-client.mjs
 M src/title-identity.mjs
?? .reports/
?? test/episode-numbering.test.mjs
~~~

Command: "git diff --name-only"

~~~
src/telegram-client.mjs
src/title-identity.mjs
~~~

Command: "git diff --stat"

~~~
 src/telegram-client.mjs | 181 +++++++++++++++++++++++++++++++++++++++++++++---
 src/title-identity.mjs  |  69 ++++++++++++++++--
 2 files changed, 235 insertions(+), 15 deletions(-)
~~~

Checklist:

| Requirement | Result |
|---|---|
| Only src/title-identity.mjs and src/telegram-client.mjs modified | PASS — exactly these two appear in status and in diff |
| test/dedup.test.mjs and test/title-identity.test.mjs NOT modified | PASS — absent from git status --short and from git diff |
| data/posted.json, data/title-map.json, .env, SESSION_STRING.txt, .github/workflows/* NOT modified | PASS — none appear in status or diff; no untracked items under .github/ or data/ |
| New untracked items only test/episode-numbering.test.mjs and .reports/ | PASS — exactly those two ?? lines; .reports/ contains only episode-numbering-builder.md and this tester report |


---

## 5) BUILDER REPORT CROSS-CHECK — .reports/episode-numbering-builder.md (484 lines, 41334 bytes, read in full)

(a) **Pre-fix RED section EXISTS** — section "## 1) RED — BEFORE src changes (verbatim)". Command recorded there: node --test run of the finalized test file before any src edit. Totals in the capture: tests 10, pass 2, fail 8. **All seven mandatory tests fail in it** (each marked with the cross glyph): extractBatchRange ignores 'Part 2 - 01' / preserves valid ranges / fast-path secondary / fast-path guard / sequel overflow diff / bidirectional dedup / fail-open — with per-test reasons: "[2,1] !== null", "[13,1] !== null", "TypeError: tc.extractSecondaryEpisodeNumber is not a function" (x2), "undefined !== 12", "false !== true", "relations absent from resolve output". The 8th failure is bonus extra (ii) "episodes: 0 treated as unknown"; extras (i) and (iii) pass pre-fix by design (regression guards pinning old-correct behavior) — stated explicitly in the report.

(b) **GREEN section EXISTS** — section "## 2) GREEN — AFTER implementation (verbatim)" with 2a full suite (tests 41 / pass 41 / fail 0, duration_ms 700.7525), 2b node --check, 2c git diff --stat; plus an appended "# FIX PASS" section whose F-3 records a second GREEN verification (tests 41 / pass 41 / fail 0, duration_ms 616.3138; new file 10/10).

(c) **Count consistency vs MY independent run:**

| Metric | Builder report | My run | Match? |
|---|---|---|---|
| Full suite tests | 41 | 41 | YES |
| Full suite pass / fail | 41 / 0 | 41 / 0 | YES |
| New file tests | 10 (7 mandatory + 3 extras) | 10 (same 7 verbatim + same 3 extras, same lines) | YES |
| New file pass / fail | 10 / 0 | 10 / 0 | YES |
| dedup / title-identity / episode-numbering split | 13 / 18 / 10 | 13 / 18 / 10 (counted from my full-suite output) | YES |
| git diff --stat | 181 / 69 / 235 insertions, 15 deletions (F-3, cumulative) | 181 / 69 / 235 insertions, 15 deletions (byte-identical) | YES |
| RED totals | 10 tests, 2 pass, 8 fail | not re-executed by me (see coverage note 1); internally consistent | no contradiction |

**NO RED/GREEN COUNT CONTRADICTION was found with my observations.**

Minor consistency observations (do not change any count):

- RED capture stack anchors (test\episode-numbering.test.mjs lines 98, 111, 123, 143, 161, 191, 221, 289) are all LOWER than the current file lines (102, 115, 127, 158, 176, 212, 242, 310) by +4 to +21 — exactly the upward shift expected from the builder's documented fix-pass edits above those lines (constants at 84-90, test-3 rewrite at 130-153, test-5 rewrite at 196-206). Consistent, not contradictory.
- Cosmetic drift: RED shows assertion message "defect A '… Part 2 - 01' must not read as a range" (ellipsis); the current file line 103 reads "defect A '. Part 2 - 01' must not read as a range" (period). Message text only — same assertion, same expected value (null). Not a count contradiction; recorded for completeness.


---

## 6) ACCEPTANCE SPOT-CHECK — direct import, temp cwd, no repo writes

Command (cwd C:\Users\mohamed\AppData\Local\Temp\opencode, node --input-type=module -e "..." importing file:///D:/A/Anime%20Sub%20Bot/src/telegram-client.mjs, all three assertions computed in-process):

~~~
{"r1":null,"r2":[1,13],"r3":[1,13],"ok":true}
~~~

- extractBatchRange('[Subs] Some Show Part 2 - 01') returned null (pre-fix was [2,1] per the RED capture) — PASS
- extractBatchRange('[Subs] Some Show 01-13') returned [1,13] — PASS
- extractBatchRange('[Subs] Some Show [01 - 13 END]') returned [1,13] — PASS

Cwd was set to the temp dir BEFORE the import, so no repo data/ directory was touched; only the JSON result line was printed (no env values, no secrets).

---

## 7) TIMEOUT CHECK

node --test completed in 710 ms and the single-file run in ~611 ms — both far below the 120 s kill threshold. No hang occurred during any test run. (Harness hangs occurred only while writing this report — see section 9 harness note; they are not product/test failures.)

---

## 8) ACCEPTANCE MATRIX أ-ز (re-verified by me)

| # | Criterion | My evidence | Result |
|---|---|---|---|
| أ | A blocks B AND B blocks A (bidirectional) | test 6 "sequel overflow: bidirectional deduplication (A blocks B, and B blocks A)" green in both runs (full suite + single file) | PASS |
| ب | extractBatchRange('... Part 2 - 01') === null | test 1 green + my spot-check r1 = null | PASS |
| ج | extractBatchRange('... 01-13') === [1,13] | test 2 green + my spot-check r2 = [1,13] | PASS |
| د | extractBatchRange('... [01 - 13 END]') === [1,13] | test 2 green + my spot-check r3 = [1,13] | PASS |
| هـ | AniList down -> no throw, fail-open | test 7 "sequel overflow: fail-open when episodes is null or AniList is down" green | PASS |
| و | resolved=null -> key set identical to pre-fix (no fast-path/sequel keys on null path) | extra (iii) "resolved=null on defect title B yields the pre-fix-shaped base keys" green | PASS |
| ز | node --test green; node --check clean | 41/41 pass, exit 0; 10/10 src files exit 0 | PASS |


---

## 9) FAILURES

**None.** No failing test name, assertion, or file:line exists to report. Every command in sections 1-4 and 6 exited 0 with the outputs shown above.

---

## 10) COVERAGE NOTES (what I could NOT verify, and why)

1. **RED state not re-executed by me.** Reproducing it would require reverting/stashing src/title-identity.mjs and src/telegram-client.mjs — a file modification I am forbidden to perform. The RED evidence in the builder report is therefore a historical capture; I verified only its internal consistency (per-test failure reasons match the stated defects; stack-line anchors shift consistently with the documented fix-pass edits; totals 10/2/8 reconcile with 7 mandatory + extra (ii) failing and extras (i)/(iii) passing pre-fix).
2. **No production/live run.** src/index.mjs, src/action-runner.mjs, src/feed-monitor.mjs and scrapers were not executed (prohibited), and no network calls are allowed — so end-to-end behavior against real AniList/Telegram is unverified by design (this matches the builder's own open issue 3).
3. **Real data/ directory not inspected or touched.** Cache-shape claims are covered only by the tests, which run against temp-cwd stub data; the deploy-time operator note (delete stale positive entries in data/title-map.json) could not be validated without modifying that file.
4. **No baseline (pre-change) re-run** — HEAD is uncommitted work; proving "baseline was already broken" would require reverting the working tree, which is forbidden. Relied on the builder's RED capture instead (see note 1).
5. **Harness note (tooling, not product):** this shell tool reproducibly hangs (>20-45 s timeout) when a single command contains 3 or more backtick characters (verified: 4-backtick and 3-backtick commands hung 8+ times; 0-2 backtick commands always returned). Markdown code spans therefore were replaced with plain text/quotes in this file, and fences use tildes. No product/test conclusion depends on this.

---

**VERDICT: PASS**

- Full suite: 41 tests / 41 pass / **0 fail**, exit 0, 710 ms, no hang.
- New file: 10/10 pass, exit 0; **all seven required test names present verbatim (lines 102, 115, 127, 158, 176, 212, 242)** — flagged: file has 10 tests, not literally 7 (3 extras, documented by builder and required by the plan's >=40-total rule).
- node --check: 10/10 src files clean (exit 0, no output).
- Git scope: only src/title-identity.mjs + src/telegram-client.mjs modified; old test files, data/*, .env, SESSION_STRING.txt, .github/workflows untouched; untracked = test/episode-numbering.test.mjs + .reports/ only.
- Builder RED/GREEN report is internally consistent and its counts (41/41, 10 tests, diff-stat 235/15) match my independent observations exactly; no contradiction found.
