# Roadmap — what is still open, in order

Effort S ≤ ½ day · M ≤ 2 days · L > 2 days. "Owner" = needs your decision or credentials; I cannot do it from here.

## Before you link the repo on a resume (this week)
| # | Item | Why | Effort | Owner? |
|---|---|---|---|---|
| 1 | **Deploy the branch** (Pages `_headers`, Worker log fix) and run the production header scan | CSP/HSTS are proven only locally | S | **yes**, deployment approval |
| 2 | Choose a **LICENSE** | No license file; recruiters/contributors can't legally reuse | S | **yes** |
| 3 | Decide D-1…D-7 (scope changes in `01-traceability-matrix.md`) and publish them as ADRs | Spec vs shipped is the first thing a reviewer compares | S | **yes** |
| 4 | Verify branch protection / default `dev` branch (Issue 2) | Needs GitHub UI/`gh` | S | **yes** |
| 5 | Merge `audit/flagship-hardening` via PR (it contains 8 fix commits, tests first) | | S | yes |

## High-value engineering
| # | Finding | Item | Effort |
|---|---|---|---|
| 6 | F-019 | Add a **dead-letter queue**, lower `max_retries` from 100 to ~5, alert on DLQ depth | S (needs `wrangler queues create`) |
| 7 | F-022 | Split `ACCESS_CODE` into signup token / break-glass login (off by default) / checkpoint key | M |
| 8 | M01–M04, M06 | TOCTOU + crash-after-click tests on the submit path (SQLite trigger and fault-injection) | M |
| 9 | F-021 | Per-user ownership of listing rows (or tenant-scoped copy-on-write) | M |
| 10 | F-005 | `/health` returns build SHA + probes D1/KV/Queue; stamp at deploy | S |
| 11 | F-023 | `useRemote` abort + 401 handling + error boundary; stop clearing data on poll | M |
| 12 | F-038 | Benchmark v2: add BM25 row and bootstrap CIs to `evals/evaluate.ts`; labels not generated from the same templates; independent reviewer on a 40-case sample | M–L |
| 13 | F-004 | Pin actions by SHA (Dependabot keeps them fresh), add CodeQL | S |
| 14 | F-032 | `wrangler`/`miniflare` bump in a branch with the full suite | S–M |
| 15 | F-035 | Test a *successful* workspace deletion with hiring rows | S |
| 16 | F-043 | Find the Miniflare boot stall (record per-test boot times; try `maxWorkers` / pool settings) | M |
| 17 | F-003 | Prettier + ESLint with a one-time format commit (lines up to 700 chars today) | S + review |
| 18 | Phase 6 | Automated axe in CI (Playwright + axe on the 6 routes); scan seeded data views; VoiceOver pass | M |

## Product / honesty items
- Real-portal validation stays **off** until you decide (D-4); keep fixtures and say so.
- Hiring shortlist: add a fairness review before presenting it as a feature (M7-3).
- Email: set Gmail app password, send one authorized test, and record inbox receipt — until then say "accepted by provider ≠ delivered".
- Frozen Python path (D-7): label it "reference implementation", stop adding features, keep CI green.
- Consider route-level code splitting (F-008) once Lighthouse numbers exist.
