# HireFlow: what is left after the November 2026 audit

Updated **2 November 2026**. This continues [`future.md`](future.md) (the older P0–P3 product backlog) using the results of the independent audit in [`audit/`](audit/FINAL_REPORT.md). Where the two disagree, this file is newer. Every item names the finding it closes so you can find the evidence.

**Rule used here:** nothing is marked done unless a test or a live check proved it. "Deployed" means it is running in Cloudflare production; "in `main`" means merged but not yet deployed.

## 1. Where things stand

| Area | State |
| --- | --- |
| Production Worker `hireflow-api` | version `dbe8c66a-3bbd-450a-a23d-8f226e3e29be` (returned by `/health`), D1 migrations through `0022`, dead-letter queue attached |
| Production Pages `hireflow-dashboard` | deployment `d1bd953d`: CSP/HSTS headers, accessibility fixes, email-verification UI |
| `main` ahead of production | **F-021** (per-owner manual listings, commit `3ba6fcc`): tested, **not deployed** |
| Gates at `main` | Worker 842 pass (4 opt-in skipped), Python 415 (3 skipped), frontend 171, typecheck, `wrangler deploy --dry-run` |
| Audit findings | 0 S0; the one S1 (F-018) fixed; see [`audit/FINDINGS.md`](audit/FINDINGS.md) |

## 2. How to deploy (runbook)

Pages and the Worker are **direct uploads**, so merging to `main` deploys nothing. Order matters: **database migration first** (migrations here are additive, so the running Worker keeps working), then the Worker, then Pages.

```bash
git checkout main && git pull
export PATH=$HOME/.nvm/versions/node/v22.23.4/bin:$PATH   # Node >= 22.12 is required; Node 20 and 22.11 fail

cd cloudflare
npx wrangler d1 migrations list DB --remote                 # see what is pending
npx wrangler d1 migrations apply DB --remote                # only if something is pending
npx wrangler deploy                                         # prints the new Version ID
curl -s https://hireflow-api.baidpankaj567.workers.dev/health   # "version" must equal that ID

cd ../frontend
npm run deploy:cloudflare                                   # builds, deploys, runs its own smoke check (creates no users)
```

After a deploy:
1. `curl -sI https://hireflow-dashboard.pages.dev/profile` must show `content-security-policy` and `strict-transport-security`.
2. Run the read-only smoke: `node audit/evidence/ux/prod_smoke.mjs <path-to>/axe.min.js` (0 axe, 0 CSP, 0 console errors expected).
3. Update the deployment IDs in `README.md` and `audit/FINAL_REPORT.md`.
4. **Rollback:** Pages → Deployments → promote the previous build. Worker → `npx wrangler rollback`. Migrations are forward-only; never write a destructive one without a backup (see the workspace backup feature).

Secrets live in Cloudflare, never in git: `ACCESS_CODE`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `TAVILY_API_KEY`. Plain-text vars come from `cloudflare/wrangler.jsonc` and **overwrite** the dashboard on every `wrangler deploy`.

## 3. Do these next (needs you, in this order)

| # | Action | Why |
| --- | --- | --- |
| 1 | **Deploy F-021** with the runbook above (code-only, no migration), then run one end-to-end check: two synthetic accounts add the same URL with different text; each sees only their own | Closes the last S2 tenant-isolation finding in production |
| 2 | **Test email end to end in production**: sign up with a synthetic account, press "Send verification link", open the mail, then "Send report to my email" | The Worker-side Gmail path (TLS socket inside workerd) is only proven in tests |
| 3 | **Rotate the Gmail app password** (it was pasted into a chat), then update the Worker secret: `npx wrangler secret put GMAIL_APP_PASSWORD` | Credential hygiene |
| 4 | Choose a **LICENSE** (MIT or Apache-2.0 for a portfolio; the repo has none) | Reuse is legally undefined without it |
| 5 | Decide **D-1…D-7** in [`audit/01-traceability-matrix.md`](audit/01-traceability-matrix.md) (scope changes such as "100+ listings" and "real-portal auto-apply") and record them as short ADRs | The spec-versus-shipped gap is the first thing a reviewer compares |
| 6 | **Close the 17 old Dependabot PRs** on GitHub (the config now ignores majors and caps open PRs at 3); merge only green minor/patch ones, one at a time | Avoid a surprise major bump (TypeScript 7, vitest 5) |
| 7 | Check **branch protection** and the default branch, delete merged branches | Needs GitHub UI |
| 8 | Fill `FROM_EMAIL` in `wrangler.jsonc` with the real sender (it is the placeholder `hireflow@example.com`) | The transport pins the sender to `GMAIL_USER`, so mail works, but the config is misleading |

## 4. Engineering backlog (I can do these)

### Security and isolation
- **F-022 (S2) `ACCESS_CODE` has three jobs** (signup bootstrap, login-as-any-user, checkpoint-encryption key). The web UI never sends the code to `/session/login`, so that route is an operator break-glass path. Plan: a flag that disables code login by default, a separate key for checkpoints, and a documented operator recovery. *Your decision needed on removing the break-glass path.*
- **Legacy manual rows (F-021 follow-up):** rows added before the fix keep a clean URL and stay shared. Optional one-off migration: for each such row used by exactly one user, rewrite its key to the owner form. Needs a production data change, so ask first.
- **F-004 (S2) remaining:** pin GitHub Actions by commit SHA (Dependabot keeps them fresh), add CodeQL.
- **F-032 (S3):** `wrangler`/`miniflare` bump (breaking), done in a branch with the full suite; 3 dev-tool advisories remain.
- **F-029/F-036 (S4):** accept a missing `Origin` only for non-cookie requests; add per-account login throttling beside the per-IP one.

### Reliability and operations
- **F-019 (S2) remaining:** alert when `hireflow-applications-dlq` is non-empty and write the replay runbook. Retries stay at 100 on purpose (the consumer uses `message.retry()` as a delay).
- **F-007 (S3):** `/health` already probes D1; add KV and Queue probes behind a separate authenticated deep-health route.
- **F-043 (S3):** an intermittent ~50 s stall in the per-test Miniflare boot (seen once in three isolated runs). Record per-test boot times and find the cause; do not add retries.
- **F-047 (S4):** a fresh profile logs two console 404s (`discovery-cycles`, `report/latest`); return an empty 200 instead of a 404 for "nothing yet".
- **F-023 remaining:** abort in-flight requests on unmount and handle a 401 by returning to the sign-in state.

### Quality and evidence
- **F-038 (S3) benchmark v2:** add BM25/TF-IDF rows and bootstrap intervals to `evals/evaluate.ts`; write labels independently of the case generator; have one independent reviewer rate a 40-case sample. Do not edit the frozen v1 labels or thresholds.
- **F-035 (S3):** a test that a *successful* workspace deletion removes hiring shortlists and deliveries.
- **Mutation gaps:** M04 (the `profile_version` clause inside the atomic claim) is redundant with other conditions; decide to keep it as defence in depth or remove it. Add a crash-after-click recovery test (kill the consumer right after the click; recovery must yield `uncertain → needs_action`, never a resend).
- **Accessibility in CI:** add Playwright + axe on the six routes to the frontend workflow, scan seeded data views (plan cards, tracker, prep guide, the review modal), and do one VoiceOver pass.
- **F-003 (S2):** introduce Prettier and ESLint with a single formatting commit (some lines are 700 characters long).
- **F-008 (S3):** route-level code splitting once a Lighthouse baseline exists (single 458 kB bundle today).

### Product honesty (keep these true)
- Real employer portals stay **unvalidated** until you decide (D-4): say "validated on owned synthetic forms".
- Do not present the hiring shortlist as a feature until a fairness review exists (skill-overlap ranking can disadvantage non-traditional backgrounds).
- "Accepted by Gmail" is not "delivered to the inbox"; keep the UI wording.
- Do not claim "36% better matching", "LangGraph" or "multi-agent"; see [`audit/RESUME_TRUTH_LEDGER.md`](audit/RESUME_TRUTH_LEDGER.md).

## 5. Larger ideas (only after sections 3 and 4)
- Per-user email unsubscribe link and a bounce/complaint suppression list before raising the 10-per-day Gmail allowance.
- A real transactional sender (Resend or SendGrid are already supported by the code) on a verified domain instead of a personal Gmail.
- Move the frozen Python path to a `legacy/` folder with its own README, or archive it (D-7).
- An interviewer-facing demo script and a short architecture video using only synthetic data.

## 6. Reference
[`audit/FINAL_REPORT.md`](audit/FINAL_REPORT.md) · [`audit/ROADMAP.md`](audit/ROADMAP.md) · [`audit/FINDINGS.md`](audit/FINDINGS.md) · [`audit/INTERVIEW_DEFENSE.md`](audit/INTERVIEW_DEFENSE.md) · [`audit/RESUME_TRUTH_LEDGER.md`](audit/RESUME_TRUTH_LEDGER.md) · [`future.md`](future.md)
