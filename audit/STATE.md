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
- [ ] Phase 1 — traceability matrix
- [ ] Phases 2–9 not started

Findings: 10 (0 S0, 0 S1, 5 S2, 5 S3). Blockers: none. Deploy-drift check via Cloudflare API (read-only) deferred.

## Next action
Phase 1: read MILESTONES.md, ISSUES_TRACKER.md, future.md; build audit/01-traceability-matrix.md + .csv (one row per acceptance criterion, §1.2 statuses). Consider splitting by source across subagents (read-only) once approved. Then commit audit/ docs (small themed commit).
