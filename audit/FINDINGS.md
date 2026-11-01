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
