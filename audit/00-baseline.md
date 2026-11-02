# Phase 0 — Baseline (2026-11-01, branch `audit/flagship-hardening`, base `cd2ac5d`)

Status labels: **confirmed** = reproduced here; **inference** = reasoned, not run; **unknown**.

## 1. CI gates mirrored locally (CI parity: Node 22.23.4, Python 3.11, Postgres 16-alpine)
| Gate | Result | Log |
|---|---|---|
| Worker `npm ci` / `typecheck` | pass / pass | evidence/logs/cf-npm-ci.log, cf-typecheck.log |
| Worker `npm test` (vitest) | **782 passed, 4 skipped**, 49 files + 1 skipped file, 284 s | cf-test.log |
| Frozen AI eval | pass; heldout hybrid nDCG@3 0.9511 vs lexical 0.6991 (20 heldout queries) | ai-eval.log |
| Prep-quality eval | pass | prep-eval.log |
| Reranker reproduction | pass, `cmp model.json` byte-identical | reranker.log |
| Offline local discovery + resume | pass | local-discovery.log |
| Isolated React/Worker/D1/R2 E2E (`verify_cloudflare_dashboard.mjs`) | pass, no pageErrors | e2e-dashboard.log |
| Frontend `npm test` | **157 passed** (18 files) | fe-test.log |
| Frontend build | pass; **single JS chunk 429.9 kB (134.3 kB gz)**, CSS 41.1 kB (9.3 kB gz) | fe-build.log |
| `build:cloudflare`, Pages `--check-build`, `wrangler deploy --dry-run` | pass / pass / pass | fe-build-cf.log, pages-check.log, wrangler-dry.log |
| Alembic upgrade → downgrade base → upgrade → check | pass ("No new upgrade operations") | alembic.log |
| `pytest tests/` | **415 passed, 3 skipped** | pytest.log |

Nothing red. Skipped tests (4 Worker, 3 Python) not yet inspected → Phase 5.

## 2. README claims vs measured
| Claim (README:125) | Measured | Verdict |
|---|---|---|
| 407 Python tests | 415 passed + 3 skipped | MISMATCH (stale) |
| 774 Worker tests | 782 passed + 4 skipped | MISMATCH (stale) |
| 157 frontend tests | 157 | match |
| D1 migrations through 0021 | 21 files in `cloudflare/migrations` | match |
| Deploy source `7c9e3ad`, Worker `705de1ec…`, Pages `712c55b3` | Not verifiable from outside: live `/health` returns only `{"status":"ok","runtime":"cloudflare-workers"}` — no version/commit. HEAD is 4 commits later; 3 of them change `cloudflare/src/prep_intelligence.ts` / `src/utils/prep_quality.py`, so **production likely lags HEAD for prep question wording** (inference). Cloudflare API read of the deployed version is a read-only follow-up. | UNKNOWN |
| Eval metrics (ai-eval) | Reproduced exactly; only `created_at` and latency p50/95/99 differ | match |

## 3. Environment traps found while reproducing (all confirmed)
- Node 22.11 (`/usr/local/bin`) silently skips `@rolldown/binding-darwin-arm64` (needs ≥22.12) → vitest dies with "Cannot find native binding". No `.nvmrc`/`engines` to steer a contributor. Wrangler needs ≥22; Node 20 (nvm default here) fails `npm ci` engine check.
- Local default Python is 3.14; CI uses 3.11; no `.python-version`.
- `~/.npm` cache was root-owned (EACCES) — local machine issue, not repo.

## 4. Hygiene (confirmed)
- No secret-shaped strings in `git log -p --all` (patterns: Google, Groq, OpenAI-style, GitHub, Slack, Resend, private-key blocks). No email addresses in `docs/evidence/*.json`; only `discovery_id` hex values (non-secret).
- `.env` has name `DATABASE_URL_POOLED` absent from `.env.example` (name drift only; values not read).
- **Suspicion 3 partly refuted:** `output/`, root `node_modules/`, `venv/`, and the root screenshot are untracked/ignored. Root has no tracked junk. Demo `frontend/public/assets/hireflow-p1-demo.webm` (5.6 MB) is tracked.
- Missing: LICENSE, SECURITY.md, CHANGELOG, `.editorconfig`, Prettier/ESLint/ruff config, `.nvmrc`, `.python-version`, pre-commit, Dependabot/CodeQL.
- CI: no `permissions:` blocks; actions pinned by tag (`@v4`), not SHA.
- 28 docs, ~7.2k lines total including top-level md.

## 5. Density (suspicion 1, corrected)
Original "197 chars/line" counted the 617 KB `resume_font_data.ts` blob. Excluding it:
| Dir | lines | avg chars/line | lines >300 chars |
|---|---|---|---|
| cloudflare/src | 6316 | 99 | 254 |
| frontend/src | 2010 | 139 | 148 |
| src (Python) | 7692 | 41 | 25 |
`frontend/src/styles.css`: 72 lines / 39.6 KB, 3 lines >3000 chars; `App.jsx`: 26 lines / 4.3 KB. Still a real skimmability problem for TS/JS/CSS; Python is fine.

## 6. Other
- Live Pages response: only `referrer-policy`, `x-content-type-options`; **no CSP, HSTS, frame-ancestors**; `access-control-allow-origin: *` on the HTML (Phase 3 to assess impact). Worker `/health` shallow.
- Eval scripts rewrite tracked `evals/results/*.json` (timestamps/latencies) → CI-equivalent runs dirty the tree. Restored.
