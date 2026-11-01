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
- [ ] Phases 2–9 not started

Findings: 17 (0 S0, 0 S1, 5 S2, 11 S3, 1 S4). Blockers: none. Deploy-drift check via Cloudflare API (read-only) deferred.

## Next action
Phase 2 (read-only; may use 3 parallel subagents: Worker / frontend+CSS / Python+infra). Each writes audit/_lane-*.md; merge into 02-architecture-review.md with route table (read `route()` in cloudflare/src/index.ts and src/api/routes/*), data-model review, queue semantics, Mermaid diagram. Then Phase 3 (local-only exploit attempts), Phase 4, 5, 6, 7...
Open owner decisions: D-1..D-7 (matrix), LICENSE choice, Gmail app password, branch protection check, whether AUDIT_PROMPT.md is committed.
