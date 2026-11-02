# Phase 5 — Test-suite audit

Question asked: **would these tests fail if the guard they claim to protect were broken?** A green count cannot answer that; mutation sampling can. Everything here was run locally; `audit/evidence/tests/mutate.py` reproduces it.

## 1. Inventory

| Suite | Tests (start → end of audit) | Skips | Notes |
|---|---|---|---|
| Worker (vitest, real workerd/Miniflare, real D1 + migrations, real Chromium for form tests) | 782 → **821** | 4, all `providers.live` (opt-in, needs `RUN_CLOUDFLARE_LIVE=1`) | `automation.test.ts` browser block and `pdf-quality.test.ts` skip *only* if Chromium/`pdftotext` is missing locally; CI installs both and `pdf-quality` throws if poppler is absent in CI, so they cannot silently skip there |
| Python (pytest) | 415 → **415** (+1 new, −1 `test_placeholder`) | 3 live-LLM opt-ins | |
| Frontend (vitest + Testing Library) | 157 → **164** | 0 | |
| Offline AI eval | frozen, reproduced byte-identical | — | Phase 4 |

No `.only`, no `todo`, no tests without assertions (static scan of 521 `it()` blocks: 0 without an `expect`/`assert`). `tests/test_placeholder.py` (`assert True`) was removed.

## 2. Mutation sampling (20 hand-written guard breaks)

Method: for each security/correctness invariant, flip one guard in the source (e.g. `AND revoked_at IS NULL` → removed), run the targeted test files, then re-run every survivor against the **full 786-test suite**. KILLED = at least one *relevant* test failed.

| # | Invariant | Mutation | Result |
|---|---|---|---|
| M05 | Final re-check immediately before the irreversible click | skip `beforeFinalSubmit()` | **KILLED** (real-browser form test) |
| M07 | Checkpoints only move forward | `WHERE phase='ready'` → `1=1` | **KILLED** |
| M08 | Session expiry | ignore `expires_at` | **KILLED** (`plan-regressions`) |
| M09 | Logout revokes the session | skip `DELETE FROM sessions` | **KILLED** |
| M12 | Match weights 40/20/15/10/10/5 | technical weight .4 → .5 | **KILLED** |
| M13 | SSRF: block cloud-metadata range | `169.254` check broken | **KILLED** |
| M14 | Email attachment must be a PDF | drop `%PDF-` magic check | **KILLED** |
| M15 | LLM may only choose existing fact IDs | drop `ids.has(id)` | **KILLED** |
| M17 | Login throttle (10 / 10 min) | cap 10 → 1000 | **KILLED** |
| M18/M19 | HTML escaping in reports / prep exports | stop escaping `<`,`>` | **KILLED** (both) |
| M20 | Session-transfer token single-use | make the delete a no-op | **KILLED** |
| **M01** | Duplicate-submission: atomic claim requires `status='confirmed'` | remove | **SURVIVED** |
| **M02** | …claim requires review not revoked | remove | **SURVIVED** |
| **M03** | …claim requires review not expired | `OR 1=1` | **SURVIVED** |
| **M04** | …claim requires profile_version unchanged | `OR 1=1` | **SURVIVED** |
| **M06** | …persist `submitting` checkpoint before the click | delete the write | **SURVIVED** |
| **M10** | Application list scoped by owner | `OR 1=1` | **SURVIVED — equivalent mutant** (route first calls `requireUser(request, env, id)`; the SQL filter is a second layer) |
| **M11** | Resume download scoped by owner | `OR 1=1` | **SURVIVED — real gap**, closed this phase (see §4) |
| **M16** | Prep-question validator rejects instruction text | remove | **SURVIVED — real gap**, closed this phase |

**Score: 12 of 20 killed; of the 8 survivors, 1 is an equivalent mutant, 2 were real gaps now closed by new tests, and 5 (M01–M04, M06) remain open.** Raw: `evidence/tests/mutation-targeted.json`, `mutation-full-survivors.json`, `mutation-full-rerun.json`.

### Interpreting the five open survivors (M01–M04, M06)
All are on the duplicate-submission / approval path, the product's headline safety claim. They are **layered defences, not single points of failure**: the same conditions are checked earlier (`getValidSubmissionReview`, tasks.ts:107) and again by `beforeFinalSubmit` right before the click, and those layers *are* tested (M05 killed). What no test exercises is the **TOCTOU window** between the pre-check and the atomic `UPDATE … WHERE` claim — i.e. a review revoked, or a profile edited, *after* validation but *before* the claim. So: the invariant holds today because three independent layers agree; a refactor that removed the SQL layer would not be caught. Recommended test (roadmap, S2): an SQLite `AFTER INSERT` trigger on a table written between the check and the claim (e.g. `application_events`) that revokes the review, then assert the message is acknowledged without a browser launch. M06 needs a crash-injection test (throw immediately after the click) asserting the checkpoint reads `submitting` and recovery yields `uncertain/needs_action`, not a resend.

### A mutation-testing artefact worth recording
In the first full-suite pass, four survivors were "killed" by tests unrelated to the mutated line (all inside `tasks.test.ts`). Re-running the unmodified file reproduced a failure: *"requires re-review for a legacy confirmation…" took 52 s and timed out* once in three isolated runs (0.8 s normally). I re-ran those four mutants without `--bail` to separate noise from signal; only M17 remained killed (by a relevant test). **F-043 (S3): intermittent multi-second stall in the per-test Miniflare boot; cause not isolated.** `vitest.config.ts` deliberately has no retries ("rather than retrying failed submissions"), so I left that as-is and logged the flake instead of masking it.

## 3. Coverage by risk, not percentage

| Risk | Evidence it is tested | Verdict |
|---|---|---|
| Cross-tenant access | Per-feature other-user 404 tests: prep exports (`prep-exports.test.ts:96`), backups (`workspace-backup.test.ts:94`), discovery by id (`discovery-tasks.test.ts:85`), hiring (`hiring-reports.test.ts:53`), prep refresh, passkey delete (`account-security.test.ts:68`), cross-owner edit (`review-workflow.test.ts:142`); plus Phase 3 dynamic sweep: 39 routes, 0 leaks | Good. Phase 3's "inconclusive" list was a harness limitation, not a test gap: 4 of 6 already have tests. Resume download by foreign user had none → **added** |
| Duplicate/uncertain submission | claim, checkpoint, uncertain→needs_action, replay rejection | Strong on outcomes; TOCTOU layer untested (above) |
| Approval binding (exact PDF + answers) | `review-workflow`, `tasks`, `automation-runtime` | Strong |
| Secrets / PII in logs & evidence | telemetry tests, Phase 0 scan | Good |
| AI truthfulness | `resume-tailoring`, `prep-quality`, frozen eval, Phase 4 probes | Strong (IDs-only design) |
| Prompt injection | few before this audit; 37 offline probe cases; **now regression-tested** | Improved |
| PDF generation | `pdf.test.ts`, `pdf-quality.test.ts` (real `pdftotext` round-trip) | Strong |
| Migrations | forward apply in every Worker test; Alembic up/down/check in CI | Python up/down verified here on Postgres 16 |
| Frontend a11y | Testing Library tests; **no automated axe in CI** | Gap → roadmap |
| Rate limits | signup, login, profile-creation tested; authenticated LLM routes not | Gap (W-005) |
| Workspace deletion with hiring rows | preview counts hiring rows (`workspace-backup.test.ts:244`); blocked by in-flight send. **No assertion that a *successful* delete removes `shortlists`/`hiring_email_deliveries`** | F-035 stays open, narrowed |

## 4. Tests added this audit (all written to fail first)

`cloudflare/tests/audit-hardening.test.ts` — 39 tests, **20 failed before the fixes** (controls passed):
F-037 experience-parser subject (4 negative, 7 positive controls, 1 end-to-end score), F-039 JD directive filtering (3 variants + control), F-040/M16 question validator (6 hostile + control), F-031 URL validator (6 rejects, 4 allows), F-041 extraction bounds (3), M11/F-030 resume-download isolation and prep-guide existence oracle (1 integration).
Also: `tests/test_models.py` (one-application-per-user-job; red without the constraint), `frontend/src/test/security-headers.test.js` (3), `route-title.test.js` (2), `empty-state.test.jsx` (2).

## 5. Honest gaps remaining
1. TOCTOU and crash-after-click tests (M01–M04, M06) — roadmap S2.
2. No automated axe/Lighthouse in CI; the Phase 6 harness is manual.
3. No successful-delete assertion for hiring data (F-035).
4. Authenticated LLM-route rate-limit test (needs a route to hit with a mocked provider).
5. Flaky Miniflare boot (F-043).
6. Python/Worker contract fixture covers pay facts only (F-027).
7. `automation.test.ts` real-browser block depends on a local Chromium; CI installs it, but a local run without it silently skips that block (not counted here).
