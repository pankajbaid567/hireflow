# AUDIT STATE
Branch: audit/flagship-hardening (from main @ cd2ac5d). Prompt: audit/AUDIT_PROMPT.md (user's file, untracked, keep).

## Environment recipe (needed to reproduce gates)
export PATH=$HOME/.nvm/versions/node/v22.23.4/bin:$PATH   # Node 22.23.4 (installed via `nvm install 22`; /usr/local/bin node 22.11 is too old)
export NPM_CONFIG_CACHE=<scratchpad>/npmcache              # ~/.npm has root-owned files (EACCES)
Python 3.11 venv: <scratchpad>/py311 (requirements-runtime.txt + pytest pytest-asyncio)
Postgres for Alembic/pytest: `docker run --rm --name hireflow-audit-pg -e POSTGRES_DB=hireflow_ci -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:56432:5432 postgres:16-alpine` (55432 is taken by another container)
Scratchpad: /private/tmp/claude-501/-Users-pankajbaid-pankajbaid567-hireflow-hireflow-ai-3/c7f92797-487b-4ab6-8f66-53f6dbec0e4f/scratchpad (session-specific; recreate if gone)

## Phases
- [x] Phase 0 — baseline (00-baseline.md, FINDINGS F-001..F-010, logs in evidence/logs). All CI gates green.
- [x] Phase 1 — traceability matrix (01-traceability-matrix.md/.csv, 172 rows, D-1..D-7 decisions, F-item triage). Generator: scratchpad/gen_matrix.py (rows are the source; regenerate by editing there if scratchpad survives, else edit md/csv directly)
- [x] Phase 2 — 02-architecture-review.md + 3 lane reports (_lane-*.md); findings F-018..F-028
- [x] Phase 3 — 03-security-privacy.md; probe: evidence/security/probe_worker.mjs (rerun: node audit/evidence/security/probe_worker.mjs, Node 22); findings F-029..F-036 (no S0/S1)
- [x] Phase 4 — 04-ai-genai-review.md; scripts+results in evidence/ai/ (run_probe.mjs [injection_probe.ts|property_probe.ts], eval_validity.py); findings F-037..F-042 (+F-011/F-031 updates); 0 real LLM calls
- [ ] Phases 5–9 not started

Findings: 42 (0 S0, 1 S1 [F-018], ~11 S2, rest S3/S4). Blockers: none. Deploy-drift check via Cloudflare API (read-only) deferred.

## Next action
Phase 5 (test-suite audit). Do: (1) mutation-style assertion-strength sampling of the 'VERIFIED' rows (flip a guard, see a test fail) for the invariants: duplicate-submission, approval binding, tenant isolation, session revoke; (2) coverage by risk (not %); flaky/skip inventory (4 skipped providers.live); (3) carry-overs: seed state for IDOR inconclusive set (resume download, prep-export HTML, email deliveries, hiring shortlists, backups, discover-by-id), hiring-data deletion test, authenticated LLM-route rate-limit test; (4) regression tests (red first) for F-037, F-039, F-040; (5) Python/Worker contract gaps (F-027). Output 05-test-strategy.md.
Open owner decisions: D-1..D-7, LICENSE, Gmail app password, branch protection.
