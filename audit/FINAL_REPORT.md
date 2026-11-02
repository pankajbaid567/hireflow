# HireFlow — final audit report

Branch `audit/flagship-hardening` (from main @ cd2ac5d), 2026-11-01/02. Everything below was run locally; **nothing was deployed and production was not probed.**

## 1. Executive verdict
HireFlow is a **genuinely strong portfolio project with an unusually defensible core** (the model can only select existing facts; submissions are claimed atomically, re-validated before the click, and never auto-resent after an uncertain outcome) and **a README that over-states in a few places** (100+ listings, "production verified", test counts, LangGraph in the original spec). No S0 was found; the one S1 (Python path lacked a unique constraint) is fixed. After this audit the repo is **ready to show once you (a) deploy the branch, (b) pick a LICENSE and (c) use the claim wording in `RESUME_TRUTH_LEDGER.md`**. It is not ready to be called "production-grade": the queue has no DLQ and one shared secret still has three roles.

## 2. Verification (re-run at branch head)
| Gate | Before | After |
|---|---|---|
| Worker typecheck | pass | pass |
| Worker tests (real workerd, D1, Chromium) | 782 pass / 4 skip | **821 pass / 4 skip** |
| `wrangler deploy --dry-run` | pass | pass |
| Python tests | 415 / 3 skip | **415 / 3 skip** (+1 added, placeholder removed; passes with langchain imports blocked) |
| Alembic up/down/up/check on Postgres 16 | 6 revisions | 7 revisions, dedupe path verified (3 rows → 1) |
| Frontend tests / build | 157 / ok | **164 / ok** |
| `npm audit` frontend | 1 high | **0** |
| Frozen AI eval | reproduced | reproduced unchanged (`evals/results` restored after run) |
| axe, 6 routes × 2 viewports | 49 violations | **0** |

## 3. Scorecard (before → after; A–F, my judgement from the evidence cited)
| Area | Before | After | Basis |
|---|---|---|---|
| Correctness of core workflow | B+ | **A−** | duplicate-submission design; F-037 parser bug fixed |
| Security (app) | B+ | **A−** | 0 IDOR in 39 probes; SSRF/ports, oracle, injection gaps closed; F-022 shared secret open |
| Security (platform/config) | C | **B** | CSP/HSTS added (unproven in prod), CI least privilege; no DLQ/pinning |
| AI/GenAI engineering | B | **B+** | IDs-only generation; validators; honest eval claim; benchmark still templated |
| Test quality | B | **B** | strong breadth; 5 submit-path guards untested for races; one flake |
| UX / a11y | C+ | **B+** | contrast, landmarks, titles, mobile bug; no SR testing, data views unscanned |
| Docs honesty | C+ | **B+** | counts fixed, claims scoped, ledger and defence notes |
| Operability | C | **C+** | log correlation; `/health` still blind, no DLQ |
| Resume-readiness | B− | **B+** | pending your decisions below |

## 4. Top 10 findings (by impact)
1. **F-018 (S1) FIXED** — Python `applications` lacked `UNIQUE(user_id, job_id)`; migration 007 + model + test.
2. **F-022 (S2) OPEN** — one `ACCESS_CODE` is signup bootstrap, login-as-any-user (confirmed) and checkpoint-key source.
3. **F-019 (S2) OPEN** — queue: 100 retries, no DLQ.
4. **F-006/017 (S2) FIXED locally** — no CSP/HSTS/frame protection on Pages.
5. **F-044 (S2) FIXED** — low contrast on every route (worst 1.9:1).
6. **F-021 (S2) OPEN** — global job rows keyed by URL writable by any user.
7. **F-038 (S3) DOC-FIXED** — headline eval gain was against a weak baseline on templated labels.
8. **F-037 (S3) FIXED** — mentor "10 years of experience" penalised freshers.
9. **F-039/040/041 (S3/S4) FIXED** — injection denylist bypass, URLs in generated questions, unbounded extracted profile.
10. **M01–M04, M06 OPEN** — five guards on the claim path have no race/crash test (layered defences hold today).

## 5. Requirement status (172 rows, `01-traceability-matrix.md`)
M1–M8: 58 verified · 29 implemented-unverified · 15 partial · 9 not done. Issues 1–26: 14 / 9 / 5 / 1 + 1 blocked-external. `future.md`: 15 / 2 / 6 / 0 + 3 blocked. Definition of completion: 2 / 1 / 2. The 9 "not done" M-rows are the defense-question rows, now answered in `INTERVIEW_DEFENSE.md` (not re-scored in the CSV). Seven scope decisions (D-1…D-7) await you.

## 6. What changed (10 commits on the branch)
Tests first (20 failing before fixes): experience-parser subject, prompt-injection directive filter, generated-question URL/markup rejection, URL port/wildcard-DNS rules, extraction bounds, resume-download isolation, prep-guide existence oracle, one-application-per-user-job. Product: Alembic 007, Pages `_headers`, route titles, contrast, landmarks, empty-state layout, CI permissions + Dependabot, log correlation id, dependency pruning (6 Python packages), frontend advisory, README/docs counts, placeholder test removed. Evidence harnesses: Phase 3 probe, Phase 4 injection/property/eval-validity scripts, mutation tool, local UX stack + axe runner.

## 7. What was NOT done (plainly)
Production deploy or any production request; live LLM/provider calls; real-portal submissions; email sending (no credentials); passkeys with a real authenticator; screen-reader testing; axe on seeded data views; TOCTOU/crash tests for M01–M04/M06; DLQ, F-021, F-022 (design/owner work); Worker `wrangler`/`miniflare` bump (breaking); SHA-pinning/CodeQL; benchmark v2; Prettier/ESLint (F-003); route splitting; the F-043 flake is unexplained.

## 8. Human actions required
1. **Approve and run a deploy** of this branch (Pages + Worker), then check response headers and `/health`.
2. **Pick a LICENSE.**
3. **Decide D-1…D-7** (matrix) — especially D-4 (fixtures only) and D-7 (freeze Python).
4. **Create the dead-letter queue** (`wrangler queues create`) and approve the retry-count change.
5. **Decide the `ACCESS_CODE` split** (F-022).
6. Provide a **Gmail app password** + authorize **one** test send if you want email receipt evidence.
7. Check **branch protection / `dev` default branch** in GitHub.
8. Approve (or decline) an optional **capped synthetic production smoke**.
9. Review `RESUME_TRUTH_LEDGER.md` against your actual resume wording; do not use the "36%" or "LangGraph" claims.

## 9. Production deployment and verification (2026-11-02, after the PR merged)
Neither Cloudflare project auto-deploys from GitHub (Pages is a direct upload, last deploy 26 Oct `7c9e3ad`; Worker last modified 28 Oct), so the merge changed nothing in production until deployed by hand from `main` @ `a0b0a56`.
- **Worker `hireflow-api`**: `wrangler deploy` → version `5244188b-1787-4c4a-a2f5-ed3db809574e`. All 33 bindings identical before/after (secrets, D1, KV, Queue, AI, Browser); no D1 migration needed; `/health` OK.
- **Pages `hireflow-dashboard`**: `npm run deploy:cloudflare` → deployment `ddf064f4`; the script's smoke check passed (health JSON, invalid profile → 422, 0 profiles created).
- **Live headers confirmed** on `/profile`: CSP, HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, COOP. The owned QA fixture page correctly carries no CSP.
- **Real-browser smoke on production** (read-only, no accounts created; `evidence/ux/prod-smoke.json`): 4 routes × desktop/mobile → **0 CSP violations, 0 console/page errors, 0 axe violations**, distinct page titles.
- F-006/F-017 → **FIXED and verified in production**. F-005 (no version in `/health`) remains open. Email: Gmail secrets are configured on the Worker; **no test email was sent**, so delivery is still unverified.
- Note: `FROM_EMAIL` in `wrangler.jsonc` is the placeholder `hireflow@example.com`; confirm the Gmail transport uses the authenticated sender before the first real send.
