# Findings register (Phase 0 seed; more to come)

F-001 · S2 · docs · README test counts stale
Where: README.md:125. Evidence: audit/00-baseline.md §2 (Python 415+3 skip vs 407; Worker 782+4 skip vs 774). Fix: single generated "Status & evidence" source. Effort S · high · open

F-002 · S2 · devex · No toolchain pinning; documented Node/Python versions can fail silently
Where: repo root (no .nvmrc/.python-version/engines). Evidence: §3 (Node 22.11 skips rolldown binding; Node 20 fails wrangler engine; Py 3.14 vs CI 3.11). Fix: .nvmrc=22, `engines`, .python-version=3.11. Effort S · high · open

F-003 · S2 · maintainability · Dense lines in TS/JS/CSS, no formatter/linter
Where: cloudflare/src (254 lines >300 chars), frontend/src (148), styles.css (72 lines/39.6 KB). Evidence: §5. Fix: Prettier+ESLint+ruff+editorconfig, isolated format commit + .git-blame-ignore-revs. Effort M · high · open

F-004 · S2 · devex · CI lacks least-privilege `permissions:`, actions not SHA-pinned, no Dependabot/CodeQL
Where: .github/workflows/*.yml. Evidence: grep in §4. Effort S · high · open

F-005 · S2 · docs · Deployed version unprovable; production likely behind HEAD
Where: README.md:49; Worker /health. Evidence: §2 (3 post-7c9e3ad commits touch prod code). Fix: expose build SHA in /health (or a /version), compare via Cloudflare API read. Effort S · med · open

F-006 · S2 · security · Pages serves no CSP/HSTS/frame-ancestors; ACAO:* on HTML
Where: frontend/public/_headers (check) / live response. Evidence: curl -I https://hireflow-dashboard.pages.dev/profile (2026-11-01). Phase 3 to confirm exploitability. Effort S · med · open

F-007 · S3 · reliability · Worker /health is shallow (no D1/KV/Queue probe)
Where: cloudflare/src/index.ts (confirm line in Phase 2). Evidence: live /health body. Effort S · high · open

F-008 · S3 · performance · Frontend ships one 430 kB (134 kB gz) JS chunk, no route splitting
Where: frontend build output. Evidence: fe-build.log. Effort S · high · open

F-009 · S3 · test · Eval scripts mutate tracked result files
Where: evals/results/offline.json, preparation-p2.json. Evidence: git diff after running CI steps (timestamps+latency only). Fix: write to untracked path unless --update. Effort S · high · open

F-010 · S3 · devex · `.env.example` missing DATABASE_URL_POOLED present in local .env
Evidence: name-only diff. Effort S · med · open

F-011 · S3 · maintainability · `langgraph` declared in requirements.txt but unused anywhere
Where: requirements.txt:10 (no StateGraph in repo; grep). Fix: remove, or ADR if adopted. M8 defense Q2 references it. Effort S · high · open

F-012 · S3 · correctness · Python scraper rate limit is a flat per-process sleep, not per-domain as M2 requires
Where: src/scrapers/greenhouse_scraper.py:27, lever_scraper.py:26. Effort S · high · open

F-013 · S3 · docs · Spec/design deviations recorded nowhere formally (FAISS vs D1 vectors, KV vs data/resumes, LaTeX vs ReportLab, Railway vs Cloudflare, LangGraph vs Queue)
Where: 01-traceability-matrix.md D-1..D-7. Fix: ADRs; milestone-audit marks "scope changed". Effort S · high · needs-owner

F-014 · S3 · devex · Branch protection / default `dev` branch (Issue 2) unverifiable from this machine (no gh CLI)
Evidence: no `dev` branch locally. Status: needs-owner (check GitHub Settings). Effort S

F-015 · S3 · docs · Embedding pipeline has no JD chunking and default model is BGE, not Issue 9's MiniLM; defense answers must say so
Where: src/config/settings.py:28, src/pipelines/embedding_pipeline.py. Effort S · high · open

F-016 · S4 · docs · Authorship is mixed (git shortlog: pankajbaid567 38 commits; 5 other contributors, ~25 commits) — resume ledger must not overclaim
Evidence: `git shortlog -sn`. Status: input to Phase 8 ledger.

F-017 · S3 · security · No `frontend/public/_headers` file → source of missing CSP/HSTS/frame-ancestors (extends F-006)
Evidence: ls frontend/public/_headers: not found. Effort S · high · open

## Phase 2 lane findings (full detail: _lane-worker.md, _lane-frontend.md, _lane-python-infra.md)
Registered here by reference; each becomes an F-### entry with repro/test when worked in Phase 7.
F-018 · S1 · correctness · Python `applications` lacks UNIQUE(user_id, job_id) (= PY-001; Worker has it) · confirmed · open
F-019 · S2 · reliability · Queue: no DLQ, 100 retries, concurrency 1, recovery depends on the queue (= W-001) · confirmed wrangler config · open
F-020 · S2 · observability · Unhandled Worker errors → 503 with no correlation id/error class (= W-002) · reported · open
F-021 · S2 · security · Global `jobs` keyed by URL writable by any user; first writer's content reused (= W-003) · reported · open
F-022 · S2 · security · Single shared ACCESS_CODE gates login and derives checkpoint key (= W-004) · reported · open
F-023 · S2 · reliability/ux · useRemote poll clears data, no abort/401/retry/error boundary (= FE-003/004/005) · reported · open
F-024 · S2 · a11y · 9px low-contrast badges, colour-only status, no route titles/focus mgmt (= FE-010/011) · reported · open
F-025 · S3 · security · Proxy bootstrap-code injection on POST /profile is intentional but undocumented (= FE-001, downgraded from lane's S1) · open
F-026 · S3 · security · Python OpenAI/Anthropic no timeout; SSRF guard IP-literals only; 500s leak str(e) (= PY-004/005/006) · reported · open
F-027 · S3 · test · Shared contract fixture covers pay facts only; scoring/company/status unshared (= PY-002) · reported · open
F-028 · S3 · docs · Five conflicting test-count claims across 8+ docs (= PY-008) · supersedes F-001 scope · open

## Phase 3 findings (local probes; evidence/security/)
F-029 · S4 · security · Missing Origin accepted on cookie-bearing mutating requests (non-browser clients only; SameSite=Lax covers browsers) · confirmed · wontfix-candidate
F-030 · S3 · security · Application-existence oracle: other user's real app → "Resource not found", missing → "Application not found" · confirmed (probe existence_oracle) · fix: identical message
F-031 · S3 · security · listing-URL validator accepts arbitrary ports (22, 6379) and wildcard-DNS names for loopback (127.0.0.1.nip.io) · confirmed · fix: port allowlist 80/443 (+ documented), low impact on Workers
F-032 · S3 · security · npm advisories in dev tooling: undici (via miniflare, 1 high), wrangler (moderate), follow-redirects (via axios, high) · confirmed (npm-audit-*.json) · fix: bump; not in shipped bundle
F-022 (update) · S2 · security · ACCESS_CODE = signup bootstrap + login-as-any-user + checkpoint key source — login-as-any-user CONFIRMED dynamically · fix: separate signup token, per-user break-glass off by default, separate key
F-034 · S4 · security · Header-only "%PDF-" file accepted for signup (honest warning shown); no structure validation · confirmed
F-035 · S3 · test · No test deletes a workspace populated with hiring rows; relies on cascade chain · static
F-036 · S4 · security · Login/recovery throttles are per-IP only · confirmed

## Phase 4 findings (offline probes; evidence/ai/; full detail 04-ai-genai-review.md)
F-037 · S3 · correctness · `parseExperience` treats a mentor/team "N years of experience" as a job requirement; fresher score 0.750→0.6075, experience_fit 1.00→0.05 · confirmed (property-results.json) · fix test-first: assert null for third-party subjects
F-038 · S3 · ai-eval · Headline nDCG gain measured vs weak comparator on a templated corpus; Recall@1 ceiling-bound (max 0.5); hybrid≈BGE-only (+0.005, CI 0–0.013); vs BM25 gain is +0.115 (CI +0.076..+0.152) · confirmed (eval_validity.json) · fix: add BM25/TF-IDF + CIs in a new benchmark version; reword claim
F-039 · S3 · ai-safety · Prompt-injection filter is a regex denylist; paraphrased instruction in a JD with no duty sentence is kept as a requirement and quoted into template questions · confirmed (INJ-P9b/P10b) · impact bounded: no tools/egress/cross-user data
F-040 · S4 · ai-safety · `validatePrepQuestions` accepts model questions containing URLs/HTML · confirmed (INJ-P6/P7)
F-041 · S4 · robustness · `extractProfile` passes experience/projects/education items through unvalidated (type/count/length); mock bypassed token cap · confirmed in mock (INJ-X5/X6)
F-042 · S4 · correctness · `parseCompensation` misses "1.2 crore per annum" with no currency symbol (safe-direction miss) · confirmed
F-011 (update) · S3 · maintainability · six unused Python packages (langgraph, langchain, langchain-openai/-anthropic/-groq/-google-genai); no imports anywhere · confirmed by grep
F-031 (update) · reuse stricter port rule from `intelligence.ts:311 publicUrl`; delete duplicate

## Phase 5–7 additions
F-043 · S3 · test · Intermittent ~50 s stall in per-test Miniflare boot (`tasks.test.ts`, 1 of 3 isolated runs; normally 0.8 s); caused 4 spurious mutation kills · confirmed once, cause not isolated · open
F-044 · S2 · a11y · Low text contrast across the app (35 colours, worst 1.9:1; 15–49 serious axe nodes per route) · confirmed · **FIXED** (0 violations)
F-045 · S3 · a11y · Same `<title>` on every route · confirmed · **FIXED**
F-046 · S3 · ux · Empty-state button overlapped paragraph on mobile · confirmed (screenshot) · **FIXED**
F-047 · S4 · ux · Fresh profile logs two console 404s (empty states modelled as errors) · confirmed · open
F-048 · S4 · ux · Faint grey gradient at the left edge on mobile · confirmed · open
F-020 (correction) · the response already carries `X-Request-ID` on every reply (index.ts); the gap was the *log line*, which lacked the id and error class · **FIXED** (log now has `request_id` + `error_class`)

## Status after Phase 7 (branch audit/flagship-hardening)
| ID | Sev | Status | How |
|---|---|---|---|
| F-018 | S1 | **FIXED** | Alembic 007 + model constraint; Postgres-verified |
| F-004 | S2 | **PARTLY FIXED** | `permissions: contents: read`, Dependabot added; SHA-pinning and CodeQL still open |
| F-006 / F-017 | S2/S3 | **FIXED in code, unproven in production** | `frontend/public/_headers` + test; verified locally in Chromium; takes effect only after a Pages deploy |
| F-011 | S3 | **FIXED** | six unused requirements removed; suite green with imports blocked |
| F-020 | S2 | **FIXED** (log correlation) | see above |
| F-024 | S2 | **PARTLY FIXED** | contrast, titles, landmarks; focus management on route change not changed |
| F-030 | S3 | **FIXED** | identical 404 for missing/foreign application on prep-guide; test |
| F-031 | S3 | **FIXED** | default ports only; wildcard-DNS names rejected; tests |
| F-032 | S3 | **PARTLY FIXED** | frontend lockfile clean (0 advisories); Worker dev-tooling (`wrangler`/`miniflare`, 3 advisories) needs `npm audit fix --force` → breaking bump, deferred |
| F-037 | S3 | **FIXED** | third-party "N years" no longer a requirement; tests |
| F-038 | S3 | **DOC-FIXED** | claim reworded in 04 / ledger / defense; benchmark v2 with BM25 row still to do |
| F-039 | S3 | **FIXED** | model-directive filter in `prepRequirements`; tests |
| F-040 | S4 | **FIXED** | URLs/markup/directives rejected in generated questions; tests |
| F-041 | S4 | **FIXED** | extracted collections typed and bounded; tests |
| F-001 / F-028 | S2/S3 | **PARTLY FIXED** | README + `docs/cloudflare.md` counts refreshed; historical verification docs left as dated records |
| F-019, F-021, F-022, F-023, F-005, F-007, F-008, F-012, F-013, F-014, F-015, F-025, F-026, F-027, F-029, F-033–F-036, F-042, F-043, F-047, F-048 | various | **OPEN** | see ROADMAP.md |

## Update after follow-up work
F-005 FIXED (`/health` returns the Workers version id via `version_metadata`; also, `/health` already probed D1, so F-007 is narrower than recorded: KV/Queue are not probed). M01/M02/M03/M06 race and ordering tests added and verified by mutation (M04 remains redundant). Profile-email delivery added (flag, per-account cap) — see FINAL_REPORT §9.
F-023 PARTLY FIXED: `useRemote` keeps data during reload/poll (`refreshing`), clears only on a new resource, ignores stale responses; 4 tests. Still open: request abort and 401 handling.
F-019 PARTLY FIXED: DLQ `hireflow-applications-dlq` attached to the consumer (retries unchanged at 100 by design). Open: DLQ alert and replay runbook.
F-005 FIXED in production: `/health` returns the Workers version id.
Email verification ADDED (closes the unverified-recipient abuse note on profile-email delivery): migration 0022 (`users.email_verified_at`, `email_verifications`), `POST/GET /account/email-verification`, `GET /email/verify?token=`; report email to a non-operator address now requires a confirmed address; link requests limited to 2/account/day; token is 256-bit, stored hashed, single-use, 24 h, bound to the address it was sent to; verification mail has no user-controlled text; changing the profile email clears verification. 9 module tests + route test + 3 UI tests.
