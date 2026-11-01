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
