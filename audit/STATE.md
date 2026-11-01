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
- [ ] Phases 3–9 not started

Findings: 28 (0 S0, 1 S1 [F-018], ~11 S2, rest S3/S4). Blockers: none. Deploy-drift check via Cloudflare API (read-only) deferred.

## Next action
Phase 3 (security, LOCAL instances only): start `wrangler dev` + local D1 (see docs/cloudflare.md#local-development-and-checks; env recipe above) and write a probe script under audit/evidence/ doing: IDOR sweep with 2 synthetic users over the lane route table (_lane-worker.md), unverified handlers discovery_tasks/discovery_cycles/plans, SSRF probes on public_url.ts/source_reader.ts/dynamic_source.ts, signup-limit test (FE-001), cookie flags, session-transfer replay, prompt-injection corpus (Phase 4 shares it). Candidate for parallel subagents: (a) IDOR/auth dynamic, (b) SSRF+input handling, (c) supply chain (npm audit/pip-audit need network: allowed read-only). Output 03-security-privacy.md with threat model + OWASP table.
Open owner decisions: D-1..D-7, LICENSE, Gmail app password, branch protection check.
