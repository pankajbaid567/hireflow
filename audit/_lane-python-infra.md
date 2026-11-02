# Lane review: Python backend + infra (read-only)

Scope: src/, migrations/, tests/, Dockerfile, docker-compose.yml, .github/workflows, requirements, docs/, scripts/.
Labels: [F] confirmed fact, [I] inference, [U] unknown. No source modified; no .env values read. vulture not run (not verified installed; grep heuristics only).

## 1. FastAPI route table

Global auth: `FastAPI(dependencies=[Depends(enforce_ownership)])` at src/api/main.py:18 [F]. It runs on every route (including routers). Exempt: OPTIONS, `/ /health /docs /redoc /openapi.json /session`, and POST `/profile /account/recover /session/logout` (src/api/security.py:113-119) [F]. All else requires the `hireflow_session` cookie (sha256 token hash looked up in AuthSession, 30-day expiry; security.py:39-59). Then `user_id` path param must equal session user (else 404, security.py:135-141) and `application_id` under `/applications/` must be owned (126-134) [F]. Origin check on all requests: Origin header, if present, must be in allowed set (62-67) [F]. Requests with no Origin header pass (normal for non-browser clients).

| Method | Path | Auth/ownership | Validation | Notes |
| --- | --- | --- | --- | --- |
| GET | /, /health | public | - | health does `SELECT 1`, 503 on failure (main.py:45) |
| GET | /session | public (returns authenticated bool + user_id) | - | account.py:23 |
| POST | /session/logout | public | - | deletes session by cookie hash, clears cookie |
| POST | /profile | public (creates user, issues session) | multipart/JSON/PDF via `_profile_from_request`; pydantic | 409 on dup email; NO rate limit [F] (profile.py:118) |
| GET/PATCH | /profile/{user_id} | session + user_id match | PATCH re-validates through `_profile_from_request` | PATCH nulls resume_path on pending/planned apps |
| GET | /account/security | session | - | lists sessions/recovery-key counts |
| POST | /account/recovery-keys/rotate | session | - | returns 8 plaintext keys once (security.py:144) |
| POST | /account/recover | public | regex `hf-recovery-[a-f0-9]{64}` | only rate-limited route: 10 attempts/10 min per client IP (security.py:165-195) |
| DELETE | /account/sessions/{session_id} | session + user filter | - | 404 if not owned |
| POST | /account/sessions/revoke-all | session | - | |
| GET | /weekly-plan/{user_id} (prefix assumed from router) | session + user_id | - | scores jobs + generates plan; synchronous; 503 generic on error |
| POST | .../{user_id}/swap | same | pydantic SwapRequest | `except Exception` returns `detail=str(e)` with 500 (weekly_plan.py:60-61) leaks internals |
| POST | .../{user_id}/confirm | same | list[int], no max length | same `str(e)` leak (weekly_plan.py:109-110); BackgroundTasks, not restart-safe |
| GET | /applications/{application_id}/prep-guide | session + application owner | int | applications.py:11 |
| GET | /applications/{user_id} | session + user_id | status enum, page>=1, page_size 1..100 | only paginated route returning `{items,total,page,page_size}` |
| GET | /resumes/{user_id}, /{user_id}/{application_id}/download, /{user_id}/files/{filename} | session + user_id; download also checks `app.user_id == user_id` | filename regex; path resolved and `is_relative_to(root)` | traversal-safe [F] (resumes.py:79-96); no pagination on list |
| POST | /report/{user_id}/generate; GET .../latest, .../latest/html; POST .../latest/email | session + user_id | - | HTML served via FileResponse text/html without CSP (reports.py:67); emails to account email only, no recipient param (good) |
| POST | /hiring/shortlist | session; uses `request.state.owner_id` | jd 1..30000 chars, applicants<=10000 / 2MB str, size 1..200 | no user_id in path, so no IDOR |
| GET | /hiring/shortlists, /{id}, /{id}/report.html | session + `_owned()` row check | page_size<=50 | report.html has strict CSP (hiring.py:58) |

CORS: `allow_origins` from env `ALLOWED_ORIGINS` (default localhost:3000, settings.py:26), `allow_credentials=True`, `allow_methods=["*"]`, `allow_headers=["*"]` (main.py:19-27) [F]. No wildcard origin, so credentialed CORS is safe as long as the env list is explicit [I]. Hardening: restrict methods/headers.
Cookie flags: HttpOnly, SameSite=Lax, Path=/, Secure when https or APP_ENV=production, max_age 30d (security.py:89-97) [F]. No `__Host-` prefix (S4). Cache-Control private,no-store + nosniff on all responses (main.py:37-42).
Error shape: FastAPI default `{"detail": str}`; inconsistent but uniform enough [F].
Rate limiting: none except recovery [F]. grep for slowapi/limiter in src/api empty.

IDOR verdict: no IDOR-prone route found. Ownership is enforced centrally by a single dependency, and every `{user_id}` / `{application_id}` route is covered; unknown IDs and foreign IDs both 404 (no enumeration oracle). Residual risk is structural: security depends on that one dependency and on the param names `user_id`/`application_id`. A new route using a different name (e.g. `{shortlist_id}` is handled per-route via `_owned`, but `{job_id}`, `{report_id}`) would be silently unprotected beyond "has a session" [I]. Is there a test that walks `app.routes` and asserts every parameterized route is covered? [U] (not grepped; tests/test_account_security.py exists).

## 2. Models and migrations

- Models: User, Job, Application, PrepGuide, ApplicationStatusEvent, WeeklyReport, Shortlist, AuthSession, AccountRecoveryKey, AccountAttempt (src/models/*).
- FKs have `ondelete=CASCADE` for Application->user/job, PrepGuide, StatusEvent, WeeklyReport, auth tables [F]. `Shortlist.user_id` FK has no ondelete and is nullable (shortlist.py:13): deleting a user with shortlists fails or orphans; nullable by design for "legacy unassigned rows inaccessible" [F].
- Uniqueness: users.email unique (001:56), jobs.url unique, prep_guides.application_id unique, uq_weekly_report_user_week (003:95). **No UNIQUE(user_id, job_id) on applications** (application.py has no UniqueConstraint; grep for `uq_` found only the report one) [F].
- JSON: JSONB with SQLite JSON variant everywhere; no CHECK constraints or schema validation at DB level (S3).
- Enums: `Enum(ApplicationStatus)` native enum on Postgres; migration 002 handles confirmation_mode change; adding a status value later needs an ALTER TYPE migration [I].
- Drift control: CI runs `alembic upgrade head; downgrade base; upgrade head; alembic check` against Postgres 16 (backend-ci.yml:48-53) [F], which is strong. But the pytest suite builds schema via `Base.metadata.create_all` (tests/helpers.py:45, test_profile_api.py:31), so tests never exercise migrations; drift is caught only by `alembic check` on Postgres, not SQLite [F/I].
- Only 6 migrations; `006` adds nullable FK via batch_alter_table (fine for SQLite) [F].
- Indexes: user_id/job_id/cycle_start indexed; no composite (user_id, status) index for the list route; fine at current scale (S4).

### PY-001 · S1 · data integrity · No uniqueness on (user_id, job_id) for applications
Where: src/models/application.py:35-77; migrations 001/003 (no unique constraint)
Evidence: no UniqueConstraint; applications.py and resumes.py use `.filter_by(user_id, job_id).first()` (resumes.py:21) which presumes one row. Duplicate-submission prevention relies on app-level "atomic application claim" (docs/backend-parity.md) [F for missing constraint; I for any actual duplication].
Impact: concurrent plan generation (GET /weekly-plan runs `score_jobs_for_user` + generate on each call, weekly_plan.py:34) can in principle insert two rows for one job, leading to duplicate submission to an employer, the worst failure for this product.
Fix: add partial/plain UNIQUE(user_id, job_id) (or include cycle_start) in migration 007; make plan insert an upsert; add a concurrency test.
Effort: M. Confidence: Medium (need to read QuotaSelector to confirm whether it dedups under race; not read).

## 3. Python vs Worker parity

- docs/backend-parity.md (95 lines) states Cloudflare is the deployed product backend and Python is for local/offline/Playwright automation [F]. Matches reality: cloudflare/src is 6319 lines of TS across ~45 modules (queues, passkeys, scheduler, backups, exports, email webhooks) with no Python equivalent; Python is ~3.7k lines in utils/scrapers/agents plus pipelines [F].
- Both-sides features: profile, listing facts, six-factor scoring (cloudflare/src/semantic_matching.ts, hiring.ts weights `.4/.2/.15/.1/.1/.05` vs src/pipelines/match_scorer.py), compensation parse/fit (src/utils/listings.py:68-112 vs cloudflare/src/listing_details.ts:25-43), company_key (listings.py:14 vs company_policy.ts), hiring shortlist, reports, prep guide, resume PDF [F].
- Python-only: Playwright form-filling (src/automation, application_agent.py), FAISS. Worker-only: passkeys, queues, scheduler, workspace lifecycle, prep exports, dynamic sources, email webhooks [F].
- Shared contract fixture: `tests/fixtures/listing_contract.json` (20 cases; expected keys minimum/maximum/period/currency, i.e. pay normalization only) is consumed by BOTH tests/test_listing_facts.py:13 and cloudflare/tests/listing-facts.test.ts:6 (reads `../../tests/fixtures/...`) [F]. Evals under evals/ are consumed by scripts only, not by pytest [F].
- Gap: no shared fixture for company_key normalization, scoring weights/factor outputs, or status transition rules; the parity doc claims "Same authored listing fixtures" but only compensation fields are in the contract [F]. Scoring parity relies on parallel authored tests, not one shared dataset [I].

### PY-002 · S2 · architecture · Two diverging backends with only pay-parsing under a shared contract
Where: tests/fixtures/listing_contract.json; docs/backend-parity.md; src/utils/listings.py vs cloudflare/src/listing_details.ts, company_policy.ts
Evidence: fixture expected keys limited to pay fields; company_key, scoring, and status rules have no cross-runtime fixture.
Impact: silent behavior drift; portfolio reviewers see two implementations with unclear authority; maintenance cost doubles for each rule.
Fix: extend contract to company_key, six-factor score vectors (fixed profile+JD -> factor scores within epsilon), and status transition table; run in both suites. Or freeze Python scoring and declare it non-normative.
Effort: M. Confidence: High.

**Recommendation:** make the Cloudflare Worker the single primary path (it is deployed, has 782 tests, and has the stronger security/lifecycle model). Keep Python only as a clearly-labelled "reference/offline automation" module IF its Playwright application automation is a portfolio feature; otherwise the Python API duplicates ~half the product. A reasonable compromise: keep Python scrapers + automation + the shared fixtures, but archive or de-emphasize the FastAPI HTTP layer in README and CI (still keep its tests to avoid regressions). If time-boxed, freezing Python is lower risk than deleting it because docs, 415 tests, and compose all reference it [I].

## 4. Docker / compose / CI

Dockerfile:
- Non-root user uid 10001 (Dockerfile:25-28) [F]. HEALTHCHECK present (34-35) [F].
- Base `python:3.11-slim-bookworm` is tag-pinned, not digest-pinned (S3). Deps in requirements-runtime.txt use ranges (`fastapi>=0.111.0,<1`, `python-multipart>=0.0.9`, `lxml>=5.2.0`, `pypdf>=4.2.0` with no upper bound): non-reproducible builds, no lockfile or hashes [F].
- Cache: requirements copied before source, good; `playwright install --with-deps` in same layer as lists cleanup, good; optional torch behind build arg [F]. `.dockerignore` excludes .env, venv, data, node_modules [F].
- CMD runs `alembic upgrade head` on every container start (line 39): fine for single instance; races with multiple replicas (S3) [I].
- Image still contains full Chromium (+deps) running the API process, increasing attack surface [I].

docker-compose.yml:
- Only api (8000) and frontend (3000) publish ports; db has none [F]. Default DB password `hireflow_local` via `${POSTGRES_PASSWORD:-hireflow_local}` (compose:13,33) [F]: acceptable for local, unsafe if used on a reachable host (S3).
- `env_file: .env required:false` passes all secrets (LLM keys, Gmail password) into the API container; expected [F]. Volumes named, `application_data` for PDFs; `postgres:16-alpine` tag-pinned only. API has no read_only/cap_drop/no-new-privileges (S4).
- frontend depends_on api healthy; healthchecks on all three [F].

CI (.github/workflows/backend-ci.yml, cloudflare-ci.yml, frontend-ci.yml):
- No `permissions:` block in any workflow: defaults to repo setting (may be read/write token) [F]. Actions pinned by major tag (`checkout@v4`, `setup-python@v5`, `setup-node@v4`) rather than SHA [F].
- Caching: pip cache keyed on requirements-runtime.txt; npm cache present [F]. No OS/Python matrix (single 3.11, ubuntu-latest for backend vs pinned ubuntu-24.04 for Worker) [F].
- Secrets: backend CI sets provider keys to empty strings explicitly, good isolation; no secrets used in these workflows [F]. Backend CI has no `paths:` filter so it runs on every PR; Cloudflare CI is path-filtered [F].
- No `.github/dependabot.yml` and no CodeQL workflow (ls .github: ISSUE_TEMPLATE, PULL_REQUEST_TEMPLATE.md, workflows only) [F]. No `pip-audit`/`npm audit` step visible [F].
- Backend CI runs full pytest including Playwright install, but excludes live tests via skips (3 opt-in skipped) [F].

### PY-003 · S2 · supply chain/CI · No Dependabot, CodeQL, workflow permissions or SHA pinning
Where: .github/workflows/*.yml; .github/ (no dependabot.yml, no codeql)
Evidence: grep `permissions` returned nothing; `uses:` lines use floating major tags.
Impact: a "flagship" repo scoring poorly on basic supply-chain hygiene; token may be over-privileged; unbounded dependency ranges plus no automated updates.
Fix: add `permissions: contents: read` at workflow top; dependabot.yml for pip, npm (cloudflare, frontend), github-actions, docker; CodeQL workflow for python+js; pin actions to SHAs (Dependabot can maintain); generate a constraints/lock file (pip-compile) for runtime reqs.
Effort: S. Confidence: High.

## 5. Code quality, LLM client, SSRF

Heuristics:
- `except Exception: pass`-style swallowing: src/agents/company_intel_agent.py:42,57; prep_guide_agent.py:148; resume_service.py:73; application_pipeline.py:58,87; email_service.py:120,168,175-180,403; static_scraper.py:149,167; db_utils.py:49; utils/listings.py:181 (pass). Many are probably intentional "evidence unavailable" fallbacks, but several (email_service 175-180, application_pipeline 58/87) can hide delivery/submission failures [I; not each read]. No bare `except:` found [F].
- weekly_plan.py:60 and :109 return `str(e)` as 500 detail [F].
- Long/dense code: hiring.py:39 and companion lines are single 300+ char lines; static_scraper.py:187 likewise; scrapers (greenhouse 429, lever 339 lines) are large; `print()` used in scrapers (generic_scraper.py:~60) instead of logging [F]. src/automation/form_filler.py:16-24 has `pass` stubs (possibly dead) [I].
- Imports inside functions (`import re` in routes) and `from datetime import ...` inside loops: style only (S4).

LLM client (src/utils/llm_client.py, 292 lines):
- Groq: timeout=60, max_retries=1 (64); Gemini: timeout 60s, attempts 1 (92); Ollama: timeout 60 (166) [F].
- **OpenAI (123) and Anthropic (143) clients are created with no timeout and default SDK retries (OpenAI default ~10 min timeout)** [F]; their error wrapper does not redact the key (131, 153) while Groq/Gemini use `_safe_provider_error` (225) [F].
- Missing-key messages are clear and name the env var, no value echoed (189, 203, 214) [F]; placeholder keys detected (174).
- No backoff/jitter: retries are SDK-delegated (1 for Groq, 1 attempt for Gemini) [F].
- Structured output: `_parse_json_response` (263) extracts JSON then `extract_profile` checks only that it is an object (31); no schema validation for field types/lengths at this layer (validation occurs downstream per docs) [F/I].
- Ollama base_url is config-controlled (settings.py:23), not user-controlled [F].

### PY-004 · S2 · reliability/security · OpenAI and Anthropic clients lack timeouts and key redaction
Where: src/utils/llm_client.py:119-131, 139-153
Evidence: `OpenAI(api_key=...)` / `anthropic.Anthropic(api_key=...)` without timeout/max_retries; `raise LLMClientError(f"OpenAI API error: {exc}")` unredacted vs `_safe_provider_error` for Groq/Gemini.
Impact: a stalled provider can hang a request thread (sync FastAPI route, BackgroundTask) for minutes; exception strings may contain key fragments in logs/responses.
Fix: pass `timeout=60, max_retries=1`; route all providers through `_safe_provider_error`; add unit tests mirroring Groq/Gemini.
Effort: S. Confidence: High.

SSRF:
- Good: web_search.py `public_url` (22-36) rejects non-80/443 ports, localhost, metadata host, .local/.internal etc., and non-global IP literals; `accessible()` revalidates each of up to 5 manual redirects (80-93); static_scraper `load_static_detail` follows redirects manually with `_public_detail_url` and 500KB cap (190-212) [F].
- Gaps: `public_url` and `_public_detail_url` check only IP *literals* and hostname suffixes; a public hostname resolving to a private/loopback IP (DNS rebinding or `127.0.0.1.nip.io`-style) passes (web_search.py:31-34 returns True on non-IP host) [F]. The initial listing fetch `requests.get(self.url, timeout=10)` in StaticScraper.scrape (static_scraper.py:226) and generic_scraper.py:68 has no validation and follows redirects; Playwright `page.goto(self.url)` for generic/lever/greenhouse and application_agent.py:48 also unvalidated; `WebSearch` client is constructed with `follow_redirects=True` (web_search.py:42), though `accessible` overrides per request [F].
- Exposure: these scraper entry URLs come from operator config/CLI and DB job URLs, not from a public API route [I] (no API route accepts a URL; hiring/profile accept text/PDF). `company_url` into company_intel_agent (line 105-106) comes from the user's profile/JD flow and is gated by `public_url` [F]. So external exploitability is limited; application_agent navigates `application_url` from scraped listings, which a malicious listing could point at internal hosts [I].

### PY-005 · S2 · security · SSRF guard is literal-only; initial scraper/Playwright fetches unguarded
Where: src/utils/web_search.py:22-36; src/scrapers/static_scraper.py:226, 105-118; src/scrapers/generic_scraper.py:68; src/agents/application_agent.py:48
Evidence: see above; no `socket.getaddrinfo` resolution and re-check of resolved IPs.
Impact: scraped listing/application URLs can reach internal services in a deployed container (e.g. cloud metadata via hostname that resolves privately, or redirect from first hop).
Fix: one shared `safe_fetch(url)` that resolves DNS, rejects non-global addresses, pins the connection to the resolved IP, validates every redirect, caps size; use it in scrapers; for Playwright route-intercept requests with the same check.
Effort: M. Confidence: Medium-High.

### PY-006 · S2 · API hygiene · No rate limit on unauthenticated POST /profile and expensive routes; 500s echo exception text
Where: src/api/routes/profile.py:118; weekly_plan.py:60,109; src/api/main.py
Evidence: only `reserve_recovery_attempt` throttles; /profile accepts PDF/multipart and spawns a session per call; swap/confirm return `detail=str(e)`.
Impact: anonymous account/PDF-parse flood (DoS/storage growth), information leakage in error text. In the deployed Worker path this may be handled elsewhere [U], but the Python API is still the documented local/compose server.
Fix: per-IP limit via the existing AccountAttempt table pattern or slowapi; cap body size; replace `str(e)` with generic message and log server-side.
Effort: S-M. Confidence: High.

### PY-007 · S3 · XSS-in-depth · Weekly report HTML served without CSP
Where: src/api/routes/reports.py:67 (`FileResponse(path, media_type="text/html")`) vs hiring.py:58 which sets strict CSP
Evidence: report content includes scraped company/job strings; whether the generator escapes them is [U] (report_generator.py not read).
Impact: if any field is unescaped, stored XSS on the API origin (same site as session cookie though HttpOnly).
Fix: add the same CSP header and confirm Jinja/autoescape in src/templates.
Effort: S. Confidence: Medium.

Dead code: not scanned with vulture. Candidates [I]: src/automation/form_filler.py `pass` stubs (lines 16-24), tests/test_placeholder.py, notebooks/, `venv/`, `Screenshot ...png` at repo root, `output/` (untracked/ignored? `git ls-files` shows only data/fixtures/.gitkeep matched the secret-ish patterns, so venv/node_modules/.env are NOT tracked [F]). requirements.txt vs requirements-runtime.txt duplicate with LangChain extras unused in runtime [I from comment in runtime file].

## 6. Documentation sprawl

docs/ = 28 files, 4309 lines (largest: p1-capacity 430, cloudflare 278, p2-verification 274, ai-evaluation 236, p1-acceptance 225). Root has more: ISSUES_TRACKER.md 1425, MILESTONES.md 405, DEVELOPMENT_GUIDE.md 293, future.md 265, POD_GUIDE.md 168, CONTRIBUTING.md, README.md [F].

Test-count claims scattered and mutually inconsistent [F]:
- docs/cloudflare.md:247 "774 Worker (4 skipped), 407 Python (3 skipped), 157 frontend"
- docs/cloudflare.md:263-265 and p0-verification.md:97 "299 Python / 369 Worker / 112 frontend"
- docs/deployment.md:132 "293 tests, three skipped"
- docs/fresh-setup.md:147 "369 Python and 115 frontend"
- docs/p3-verification.md:36 "157 frontend"
- Measured today (per task brief): Python 415 passed/3 skipped, Worker 782/4 skipped, frontend 157. Only frontend matches any current doc; Worker and Python numbers are stale in docs/cloudflare.md.
- Same file (cloudflare.md) mixes historical and current ("Historical baseline" line 7, "Final P0 checks" 263, current 247).

Historical (point-in-time evidence; should move to docs/archive or docs/evidence): p0-verification, p1-verification, p1-acceptance, p1-capacity, p1-pdf-quality, p2-verification, p3-verification, milestone-audit, reranker-experiment, p2-* status docs [I from titles/content]. Current/reference: architecture, workflow, deployment, cloudflare (needs trimming), backend-parity, account-security, email-delivery, hiring, dynamic-sources, prep-exports, workspace-lifecycle, fresh-setup, portal-compatibility, demo, ai-evaluation [I]. Contradictions also: deployment.md:5 says P0 "remains historical" while cloudflare.md:170 links P0 as release evidence; docs reference `/tmp/...proof.json` paths that no longer exist (not reproducible) [F].

### PY-008 · S3 · documentation · Hard-coded, conflicting test counts and verification claims across 8+ docs
Where: docs/cloudflare.md:247,263; deployment.md:132; fresh-setup.md:147; p0-verification.md:97; p3-verification.md:36
Evidence: see list; five different Python/Worker totals.
Impact: undermines credibility with a reviewer who runs the suites; stale claims "passed" without date/commit linkage.
Fix: remove numeric counts from prose docs; keep one generated `docs/STATUS.md` (or README badge) written by a script from CI output with commit SHA and date; mark every p0/p1/p2/p3 doc with a "Historical, as of <date>/<sha>" banner.
Effort: S-M. Confidence: High.

Proposed structure (single source of truth):
- README.md: what it is, status table (generated), quick start, link map.
- docs/architecture.md (+ backend-parity.md folded in as "Runtimes").
- docs/operations/ (deployment, cloudflare, email-delivery, workspace-lifecycle, account-security).
- docs/guides/ (fresh-setup, demo, hiring, prep-exports, dynamic-sources, portal-compatibility).
- docs/evidence/ (all p0..p3 verification, acceptance, capacity, milestone-audit, reranker; each with banner and sha).
- docs/STATUS.md generated; move ISSUES_TRACKER.md, MILESTONES.md, POD_GUIDE.md, future.md, DEVELOPMENT_GUIDE.md into docs/archive or GitHub Issues.

## 7. scripts/

32 files (excluding __pycache__) [F]:
- Offline/safe, temp-dir cleanup: run_ai_evaluation.mjs, evaluate_prep_quality.mjs, evaluate_reranker.mjs (mkdtemp + rmSync of own temp dir only), verify_source_adapters.mjs, verify_resume_pdf_quality.{mjs,py}, build_pdf_intake_corpus.py, build_resume_fonts.py, verify_python_semantic_plan.py, verify_dashboard.py, verify_account_security.mjs, verify_cloudflare_dashboard.mjs (local; writes /tmp artifacts).
- Touch live production (read/drive deployed site, create synthetic workspaces; some call Cloudflare API with a token from `CLOUDFLARE_API_TOKEN` or `wrangler auth token`): verify_cloudflare_live.py, verify_cloudflare_live_ui.mjs (default site and previous Vercel host hard-coded, line 21-22), verify_p1_acceptance_live.mjs (restricted to canonical site, line 16), verify_p2_live.mjs, verify_p0_review_operations_live.mjs, verify_account_security_live.mjs, verify_gmail_connection_live.mjs, verify_dynamic_source_live.mjs, verify_resume_pdf_extraction_live.mjs, measure_cloudflare_capacity.mjs, profile_cloudflare_cycle.mjs, profile_cloudflare_routes.mjs, profile_worker_operations.mjs.
- Mutating deploy: deploy_cloudflare_pages.mjs (spawns wrangler; asserts pinned wrangler version 4.151.3, line 32) deploys to the live Pages project [F].
- restore_workspace_backup.mjs: offline only; asserts `--remote` unsupported (line 10), 0o700/0o600 modes [F].
- Tracked-file mutation: none found writing into the repo tree; outputs go to /tmp or mkdtemp [F]. Not read in full: [U] for each script.
- Sensitive output: proof files and session-state files in /tmp contain session cookies/user ids and are written 0o600 (profile_cloudflare_routes.mjs:28, verify_cloudflare_live_ui.mjs:56); verify_cloudflare_dashboard.mjs:128,173,198,211 write screenshots/report HTML/proof to fixed world-readable `/tmp/hireflow-*` paths without a mode, containing synthetic data only [F/I]. Reading API tokens from `~/Library/Preferences/.wrangler/config/default.toml` (measure_cloudflare_capacity.mjs:39) is a convention to be aware of; token is not written out in the lines seen [I].

### PY-009 · S3 · ops safety · Live-production scripts have no uniform dry-run/confirm guard
Where: scripts/verify_*_live*.mjs, profile_*.mjs, measure_cloudflare_capacity.mjs, deploy_cloudflare_pages.mjs
Evidence: only verify_p1_acceptance_live.mjs:16 asserts the canonical site; others default to production or accept env overrides; deploy has no `--yes` prompt.
Impact: accidental run creates synthetic data or deploys from a dirty tree against the real workspace; contributors cannot tell safe from unsafe by name.
Fix: move into scripts/live/ and scripts/offline/; require `HIREFLOW_ALLOW_LIVE=1` (or explicit `--yes`) for live scripts; deploy script should refuse when `git status` dirty.
Effort: S. Confidence: Medium.

## Other findings

### PY-010 · S3 · test strategy · Pytest suite bypasses Alembic
Where: tests/helpers.py:45; tests/test_profile_api.py:31
Evidence: `Base.metadata.create_all`. Only CI's Postgres `alembic check` verifies drift.
Impact: migration bugs on SQLite path (used locally per docs) undetected; ORM-only constraints may differ from migrated DB.
Fix: add one test that runs `alembic upgrade head` on a temp SQLite file and compares with `create_all` metadata via `alembic.autogenerate.compare_metadata`.
Effort: S. Confidence: High.

### PY-011 · S3 · dependency hygiene · Unbounded/unpinned runtime requirements
Where: requirements-runtime.txt (`python-multipart>=0.0.9`, `lxml>=5.2.0`, `pypdf>=4.2.0`, `uvicorn[standard]>=0.29`)
Impact: non-reproducible images; parser libraries handling untrusted PDFs/HTML drift silently.
Fix: pip-compile lock with hashes; Dependabot to update.
Effort: S. Confidence: High.

## Summary (10 lines)
1. No IDOR found: one global dependency (main.py:18, security.py:110) enforces session + user/application ownership; unknown and foreign IDs both 404.
2. Cookie flags are good (HttpOnly, Lax, Secure in prod); CORS is explicit-origin with credentials but wildcard methods/headers.
3. Only recovery is rate-limited; POST /profile and expensive routes are open, and swap/confirm echo `str(e)` in 500s (PY-006).
4. applications has no UNIQUE(user_id, job_id): the main duplicate-submission risk to verify and close (PY-001).
5. Alembic roundtrip + `alembic check` runs in Postgres CI, but pytest uses create_all (PY-010).
6. Shared contract fixture (listing_contract.json, 20 cases) IS consumed by both suites, but covers pay only; scoring/company/status rules are parallel, not shared (PY-002).
7. Recommend Cloudflare Worker as primary; keep Python as scoped reference/automation or freeze it.
8. Docker is solid (non-root, healthcheck, cache order, .dockerignore); CI lacks permissions, Dependabot, CodeQL, SHA pins (PY-003).
9. LLM: OpenAI/Anthropic clients have no timeout or redaction (PY-004); SSRF guards are literal-only and initial scraper/Playwright fetches unguarded (PY-005).
10. Docs hold five conflicting test counts across 8+ files and mix historical with current (PY-008); live scripts lack a safety gate (PY-009); no vulture run, scripts not read in full.
