# P0 implementation and verification

This release implements the six P0 items in [future.md](../future.md) for the
Cloudflare application. Python also receives authenticated ownership and recovery
keys; the rest of Python/Worker feature parity remains [P2-09](../future.md).
The full original eight-milestone specification is still partial.

## What changed

| Item | Result | Evidence |
| --- | --- | --- |
| P0-01 | Discoverable, user-verified passkeys; eight single-use recovery keys; session listing/revocation; source-bound workspace transfers. Python numeric IDs no longer authorize private requests. | Actual ES256/workerd/D1 tests, cross-user and atomic rollback tests, local Chromium with a virtual authenticator and three independent browser contexts. [Recovery details](account-security.md). |
| P0-02 | Per-opportunity resume editing, comparison, immutable version downloads, rejection and bounded regeneration. The master profile and submitted PDFs are retained. | Real D1/file-store concurrency tests; React tests; local full dashboard flow saves PDF v2 and approves that exact version. |
| P0-03 | Shared public-form engine with Greenhouse/Lever-shaped adapters and up to eight recognized steps; encrypted, approval-bound completed-step checkpoints. | Actual Chromium four-step forms, rotating CSRF state, transient failure/recovery, CAPTCHA/login/expiry and intermediate/final uncertainty cases. [Compatibility matrix](portal-compatibility.md). |
| P0-04 | Safe Groq/Gemini failure classification, visible factual fallback, bounded user regeneration and opt-in diagnostics for configured models only. | Rate-limit/model/timeout/malformed/outage regressions, unchanged saved-profile assertions and durable diagnostic throttling. [Provider details](p0-operations.md). |
| P0-05 | Redacted correlation IDs, owner/cycle telemetry, provider and stuck-work alerts, budget visibility, configurable 21–300-second submission spacing, and a repeatable platform metrics sampler. | Real D1 isolation/retention/budget tests; operations UI tests; actual deployed CPU/memory measurement is a separate release gate below. |
| P0-06 | Reviewed answers and exact PDF/profile/JD authorization; no newly generated answers during applying; atomic queued cancellation and stale-delivery rejection. | D1 tamper/expiry/revocation tests; cancellation-versus-claim and outbox-ID-reuse races; final-click authorization tests; full dashboard cancel/reapprove cycle. |

## Review and recovery behavior

Open **Review resume & answers** in the weekly plan. Edit only accurate resume
facts, save a new version if needed, open its PDF, review the answers and approve
that version. **Confirm and Apply** then authorizes the selected approved
snapshots. A missing or rejected PDF, changed profile/JD, changed answer approval
or expired/revoked snapshot blocks the operation and requires review again.

The application worker checks the SHA-256 of the reviewed PDF before browser
allocation, claims the exact authorization atomically and revalidates before
advancing or submitting. Form fields use the matching immutable resume snapshot.
Unreviewed questions and unsupported required fields become manual action.
Templates for review use existing resume facts; there is no applying-time LLM
call that could substitute a new, unreviewed answer.

**Cancel queued application** succeeds only before execution is claimed. An
already running or externally submitted application cannot be withdrawn by
changing a local status. Old queue generations cannot execute or mark a newer
authorization delivered. An uncertain external POST/final submission retains a
durable no-replay marker rather than being retried blindly.

Profile recovery is optional during ordinary signup. While signed in, save a
passkey or recovery keys under account security. On another browser, open
**Already have a workspace? Sign in**. Email/profile numbers alone never grant
access; email ownership is not verified or implied. Recovery-key use atomically
consumes one key, revokes previous sessions and creates the replacement session.
Pending workspace transfers also require their original source session to remain
active; revocation invalidates them.

## Runtime and API changes

- Cloudflare migrations **0004–0007** add account credentials/challenges,
  encrypted automation checkpoints, resume snapshots/review bindings and
  operations telemetry. Apply these before deploying the corresponding Worker.
- Python Alembic migration **004_account_security** adds local ownership and
  recovery-key storage. Python supports recovery keys and explicitly reports
  passkeys unavailable; it does not claim the Cloudflare review/checkpoint flow.
- Private browser API calls send their HttpOnly ownership cookie for either
  runtime. Browser storage and numeric IDs are not used to restore ownership.
- New `/account/*`, `/applications/{id}/resume-*`,
  `/applications/{id}/review`, `/applications/{id}/cancel` and
  `/operations/{user_id}` routes enforce ownership. Model diagnostics use
  `/operations/{user_id}/diagnostics` and never accept arbitrary endpoints/models.
- Confirmation requires `review_ids` for the chosen applications. Apply queue
  messages carry the exact `review_id`; old client/queue requests cannot bypass
  the review gate.

## Reproduce isolated verification

Use Node 22+ and the configured Python virtualenv. Install Playwright Chromium
for browser fixtures. These commands use isolated records and owned forms;
default tests do not send employer applications or real email.

```bash
cd cloudflare
npm run check
cd ../frontend
npm test
npm run build
cd ..
venv/bin/python -m pytest -q
node scripts/verify_account_security.mjs
node scripts/verify_cloudflare_dashboard.mjs
```

The dashboard browser check covers immutable PDF editing/comparison, exact
answer/PDF approval, cancellation, reapproval, stale queue rejection, tracker,
preparation, reports, mobile layout, session restoration and private logout.
It intentionally disables remote Browser Run and uses a manual-action result;
actual multi-step execution is exercised by real local Chromium fixtures.

## Production verification — 23 October 2026

| Release/check | Observed result |
| --- | --- |
| Worker | `cdaf5730-d2ea-4544-86b2-746b3694feb6`, deployed before `2026-10-23T03:38:58Z`. |
| Pages | `ede2bc0b`, canonical [dashboard](https://hireflow-dashboard.pages.dev/profile); JS `index-mGKqgBbi.js`, CSS `index-BMktSa3T.css`. Use `npm run build:cloudflare` for this runtime. |
| Production D1 | Migrations `0004`–`0007` applied successfully without deleting existing user data. |
| Local/CI | **369 Worker, 299 Python and 112 frontend tests passed** (seven opt-in tests skipped); typecheck, both frontend builds, Worker dry-run, actual local React/D1/PDF workflow and virtual-authenticator recovery passed. All three GitHub CI workflows passed for `a664041`, including PostgreSQL upgrade/downgrade/upgrade and schema checks. |
| Live account recovery | `/tmp/hireflow-account-security-live/1cd5a49d3f11/proof.json`: **passed**. Registered passkey, signed assertion on a second cookieless context, one-use key recovery on a third, old-session revocation, replay rejection and sign-out-all; zero browser runtime errors. Credential sync was simulated by a virtual authenticator, not by copying site cookies. |
| New Pages application cycle | `/tmp/hireflow-live-ui-proof/038727c0aaf7/proof.json`: **`pagesPipelineStatus: passed`**. PDF-only signup/extraction, profile facts, swap, native private PDF preview, exact PDF/answer approval, controlled Browser Run (`applied`, one attempt), complete status trail, prep, downloads, private report, mobile and logout. Extraction used the configured `gemini-3.5-flash-lite` fallback, not the primary model. The rendered PDF was also inspected visually. |
| Live per-opportunity review/operations | `/tmp/hireflow-p0-review-operations-live/a89af405d50a/proof.json`: **passed**. UI immutable v2 edit/comparison, unchanged master and v1 bytes, rejected-version approval 409, regenerate/review and three-request limit (fourth 429), v4 answer editing/reapproval, capacity display and mobile layout; no queue confirmation or submission. One opt-in diagnostic request found Groq `openai/gpt-oss-20b` and Gemini `gemini-3.5-flash-lite` healthy; Gemini `gemini-3.8-flash` timed out and was visibly degraded. This verifies truthful degradation, not universal provider health. |
| Legacy-host transfer | The combined script’s final old-Vercel logout POST timed out at 65 seconds, so its overall `failed` result is retained accurately. The official **transfer-only rerun passed**: `/tmp/hireflow-live-ui-proof/ef2bffb428d5/proof.json`, same-owner migration, fragment removal, replay rejection and logout/private denial on both hosts. Four focused authenticated transport/bridge checks also passed; the original timeout was not reproduced and its exact cause is unproven. |
| Post-release capacity sample | `/tmp/hireflow-capacity-postdeploy-final.json`, window beginning `2026-10-23T03:38:58Z`: 20/20 health responses, concurrency four, no HTTP/network failures. Platform metrics and limits are detailed in [operations evidence](p0-operations.md); they are measurements, not a sustained-load guarantee. |

The production account and application tests used only synthetic workspaces and
the owned HireFlow QA form. No employer application or real email was sent.
Scoped cleanup removed the six synthetic release workspaces, three unreferenced
QA jobs and eight private test objects. Snapshot comparisons verified that the
real owner, applications, PDF history and actual browser reservations were
unchanged. Proof: `/tmp/hireflow-p0-synthetic-cleanup-proof.json`.

The portal-shaped four-step recovery and failure matrix remain controlled local
Chromium evidence rather than production ATS certification.

Explicit, gated scripts are available for controlled production verification:

```bash
node scripts/verify_account_security_live.mjs --run-live
node scripts/verify_cloudflare_live_ui.mjs --run-live
node scripts/verify_p0_review_operations_live.mjs --run-live
node scripts/measure_cloudflare_capacity.mjs \
  --base https://hireflow-dashboard.pages.dev/api \
  --requests 20 --concurrency 4 --platform-metrics \
  --since DEPLOYMENT_COMPLETION_UTC_ISO \
  --output /tmp/hireflow-capacity-postdeploy.json
```

Use the real ISO timestamp, wait for analytics ingestion and inspect sample
counts. CPU and isolate memory come from Cloudflare platform metrics; request
wall time is reported separately. Baseline pre-release measurements in
[the operations guide](p0-operations.md) are not proof of the new bundle.

Live scripts create only synthetic workspaces, exercise credential recovery,
review/diagnostics or the owned HireFlow QA form, and retain private proof files
for scoped cleanup. Review diagnostics make one opt-in request for at most three
configured models; the review-only script never confirms or queues an application.
They must not submit a real employer application or send email. Never commit
keys, session cookies, browser credentials or private resumes with evidence.

## Remaining scope

P1/P2/P3 still include evaluated semantic matching, structured discovery at
100+ scale, company-wide application exclusion, richer preparation/exports,
verified report email delivery, weekly scheduling, mixed-mode proof, backend
parity and optional hiring/research work. Public native-form support is
conditional; login portals, Easy Apply, arbitrary embedded widgets and opaque
JavaScript-only multi-step state may still need manual action.
