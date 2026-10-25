# Cloudflare Pages and Workers deployment

**Current deployment, 25 October 2026:** [Pages dashboard](https://hireflow-dashboard.pages.dev/profile), deployment `c11dc0d8` ([deployment URL](https://c11dc0d8.hireflow-dashboard.pages.dev)); [API Worker](https://hireflow-api.baidpankaj567.workers.dev/health), version `d3848a38-6007-41bf-8112-7a228a3a101d`. D1 migrations through `0012` are applied. P1 adds genuine hybrid matching, structured source facts, immutable listing history, company exclusion and Unicode PDF coverage. The final production two-mode acceptance passed; [P1 verification](p1-verification.md) records actual providers, controlled forms, CPU, cleanup and the demo. P0 production evidence remains [historical](p0-verification.md). Pages assets are `index-Bw4ERH04.js` and `index-B8vXzKsS.css`. Publish with `npm run build:cloudflare` to select the Cloudflare API capabilities.

**Historical baseline evidence:** public/deep-link, API health, anonymous-session and private-profile checks passed. Production UI made five source searches in 10.834 seconds and verified eight listings: Internshala three, Wellfound three, Greenhouse two; four new and four known. Nine cards displayed original links, with LinkedIn restrictions shown. No application was confirmed during discovery. The baseline controlled UI cycle passed PDF-only signup, edits, plan/swap/PDF, one controlled submission, prep, report/library, mobile and logout. Separate old-host migration passed same-owner transfer, fragment removal, replay rejection and both-origin logout. These earlier runs do not establish the new P0 production contract. No employer application or real email was sent.

This runtime is separate from the original Python/PostgreSQL application. It runs the React dashboard on Pages and the API on a TypeScript Worker with D1, private KV files, Queues, and Browser Run. See the [milestone audit](milestone-audit.md) for original specification gaps and evidence.

## Infrastructure and bindings

| Component | Actual resource / endpoint | Configuration / binding |
| --- | --- | --- |
| Frontend and same-origin API proxy | Pages project `hireflow-dashboard`, `https://hireflow-dashboard.pages.dev` | `frontend/wrangler.jsonc`, `functions/api/[[path]].js` |
| API, queue consumer, recovery cron | Worker `hireflow-api`, `https://hireflow-api.baidpankaj567.workers.dev` | `cloudflare/wrangler.jsonc` |
| Profiles, hashed sessions, application history | D1 `hireflow`, ID `e4664667-cedb-4f84-9da6-32610a77c127` | `DB`; migrations under `cloudflare/migrations/` |
| Private uploads, resume versions, reports | KV `hireflow-files`, ID `b2c25a76089c4c11aacf1d0fef9b1b51` | `FILES_KV` |
| Application dispatch | Queue `hireflow-applications` | `APPLICATION_QUEUE`; batch/concurrency one |
| Application browser | Cloudflare Browser Run | `BROWSER` |
| Bounded semantic matching | Workers AI BGE small, CLS pooling, 384 dimensions | `AI`; private versioned vectors in D1 |
| Recovery/expiry/retention work | Five-minute cron enqueues bounded Queue maintenance | `*/5 * * * *` |
| Pages → API transport | Service binding to `hireflow-api` | `API` in Pages |
| Transitional old-cookie bridge | `https://hireflow-blue-seven.vercel.app/api/workspace-migrate` | Legacy Vercel project; retained only for migration |
| Optional alternative file store | R2, not activated on this account | `FILES` when explicitly configured |

Pages Functions call the Worker through the service binding. Public browser requests stay on the dashboard's `/api` origin, including PDFs and reports. `frontend/public/_routes.json` routes `/api/*` to Functions; other dashboard paths use the SPA. Cloudflare documents [Pages service bindings](https://developers.cloudflare.com/pages/functions/bindings/#service-bindings) and their redeployment behavior.

D1 is a separate database; local PostgreSQL/SQLite records are not copied automatically. KV uses immutable keys with D1 references. Cross-region KV visibility can take up to 60 seconds; the application waits for a newly written resume before launching a browser. See [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/). R2 remains optional because this account did not enable its billing enrollment.

## Production configuration

The API's configured variables are:

| Variable | Value / purpose |
| --- | --- |
| `ALLOWED_ORIGINS` | `https://hireflow-dashboard.pages.dev,https://hireflow-blue-seven.vercel.app` during migration |
| `PUBLIC_BASE_URL` | `https://hireflow-dashboard.pages.dev/api` |
| `COOKIE_SAME_SITE` | `Lax` |
| `WEBAUTHN_RP_ID` | Optional; defaults to the `PUBLIC_BASE_URL` hostname and must match it exactly |
| `LLM_PROVIDER` / `GROQ_MODEL` | `groq` / `openai/gpt-oss-20b` |
| `GEMINI_MODEL` | `gemini-3.8-flash` primary |
| `GEMINI_FALLBACK_MODEL` | `gemini-3.5-flash-lite`; blank disables alternate models |
| `BROWSER_ENABLED` | `true` for authorized automatic attempts |
| `BROWSER_DAILY_BUDGET_SECONDS` | `540` or lower |
| `PLAN_WORK_IN_QUEUE` | `true`; bounded scoring and resume preparation run through versioned Queue leases |
| `SEMANTIC_MATCHING_ENABLED` | `true`; lexical fallback on unavailable provider, invalid vectors or exhausted allowance |
| `SEMANTIC_DAILY_TEXT_BUDGET` | `100` text reservations per UTC day; hard cap 100, no uncertain refunds |
| `EMAIL_PROVIDER` | Configured integration selection; `resend` currently |
| `FROM_EMAIL` | Currently a placeholder, **not a verified sender** |

Pages build configuration:

```text
VITE_DEPLOYMENT_TARGET=cloudflare
VITE_API_URL=/api
VITE_PREVIOUS_DASHBOARD_URL=https://hireflow-blue-seven.vercel.app
```

Pages runtime configuration uses service binding `API=hireflow-api`, public origin `WORKER_API_URL=https://hireflow-api.baidpankaj567.workers.dev`, and secret `WORKSPACE_ACCESS_CODE`. The secret must match the API's `ACCESS_CODE`. It is injected **only on `POST /profile`**. Caller copies of the access-code header are stripped everywhere; it is never injected into reads, updates, or `/session/login`. Missing configuration returns a clean 503 for signup.

Keep `ACCESS_CODE`, `WORKSPACE_ACCESS_CODE`, `GROQ_API_KEY`, `GEMINI_API_KEY`, search keys, email keys, and sessions out of Git, command arguments, logs, screenshots, PDFs, and browser bundles. Never prefix a secret with `VITE_`. Normal users do not enter the operator credential.

The new checkpoint implementation also derives its private-state encryption key
from `ACCESS_CODE`. Rotation prevents restoration of earlier encrypted browser
state; those attempts must hand off safely. Preserve durable no-replay markers
rather than deleting them to force a retry.

## Deploy or redeploy

Use Node 22+ and the locked Wrangler dependency in `cloudflare/`. Check the intended account, resource IDs, and current authorization before mutations. Existing resources already exist; **do not recreate them**.

From the repository root, validate and deploy the API:

```bash
npm ci --prefix cloudflare
npm run check --prefix cloudflare
npm run db:remote --prefix cloudflare
npm run deploy --prefix cloudflare
```

`check` runs type checking, tests, and a deployment dry run. `db:remote` applies
every pending migration: `0002` adds transfers; `0003` adds draft leases and
tailoring metadata; `0004` adds account/passkey/recovery tables, session metadata
and source-bound atomic transfers; `0005` adds private automation checkpoints;
`0006` adds immutable answer/PDF review authorization; `0007` adds operational
telemetry/diagnostics; `0008` adds source-backed listing facts, historical snapshots and review invalidation; `0009` adds private semantic cache/usage and matching metadata; `0010` adds the bounded operations-request index; `0011` adds durable owner-scoped discovery tickets; `0012` extends score/PDF leases with dispatch, kind, captured versions, bounded attempts and interrupted-upload cleanup. P2 adds `0013` discovery cycles/public read budgets, `0014` private guide export versions, `0015` weekly draft schedules, `0016` coordinated workspace lifecycle, `0017` immutable email delivery tickets and `0018` explicit prep refresh leases. Apply all pending migrations before code publication.
Back up D1 first; deployment does not copy local database contents. Existing
sessions survive `0004`, but old unbound transfer links require reminting.

Build and publish Pages **from `frontend`**, so the Functions directory and Pages configuration resolve correctly:

```bash
cd frontend
npm ci
npm test -- --run
npm run build:cloudflare
../cloudflare/node_modules/.bin/wrangler pages deploy dist \
  --project-name hireflow-dashboard --branch main --commit-dirty=true
```

In installed Wrangler 4.151.3, routine deployment of this existing Pages project uses the command above, without `--force`. Creating a new project has a separate compatibility path that may require `pages project create --force`; inspect that command’s installed help before provisioning another project. Check `pages deploy --help` before changing CLI versions. Do not run frontend publication from `cloudflare/` or create a second API Worker. Project creation is not part of routine redeployment.

Use `build:cloudflare` for Pages: it selects the tracked public
`frontend/.env.cloudflare` values. A generic `npm run build` targets the separate
local/Python runtime and is not a substitute for the Pages release build.

Configure the matching Pages bootstrap secret securely through the CLI prompt when setting up or rotating it:

```bash
cd frontend
../cloudflare/node_modules/.bin/wrangler pages secret put WORKSPACE_ACCESS_CODE \
  --project-name hireflow-dashboard --force
```

Keep the service binding and variables in `frontend/wrangler.jsonc`. A direct upload deploys local source/assets and does not require a Git push. A Git push alone is not proof of a Pages release. Record the actual Pages deployment ID and Worker version after publishing.

For another account, create its own D1 database, KV namespace, queue, and Pages project, then replace account/resource IDs in configuration. Do not reuse this owner's IDs. Worker secrets are entered with `wrangler secret put`; the normal setup uses `ACCESS_CODE`, `GROQ_API_KEY`, `GEMINI_API_KEY`, and `TAVILY_API_KEY`. Provider alternatives and email are optional integrations, not automatically provisioned services.

## Profiles and private sessions

Start by uploading a PDF and saving, or create a manual profile with a name and email. PDF-only signup leaves identity fields optional; blank form fields do not erase extracted facts. Uploads are limited to **3 MB** in cloud mode; Docker retains its 10 MB limit. Invalid manual input and malformed multipart/PDF envelopes do not spend signup quota. Valid signup attempts are limited to five per hashed IP in ten minutes and fifty globally per UTC day before provider work; failed provider attempts count toward those limits.

The editor supports identity, skills, human-readable education, experience years, structured experience and projects with highlights, summary, profile/project URLs, certifications, achievements, and spoken languages. Untouched structured education remains structured when preferences are saved. Existing submitted resume versions are immutable; edits invalidate future draft PDFs.

Preferences include internship/job mode, target roles, preferred locations, minimum stipend in INR/month or salary in INR/year, excluded companies, weekly quota, and batch/individual review. Individual review authorizes one selected opportunity at a time. **Exclude company** persists the company in profile preferences, so it stays out of future plans until removed there. Setting a quota does not schedule autonomous submissions; every application still requires confirmation.

Creation grants a 30-day host-only `HttpOnly; Secure; SameSite=Lax` cookie. D1
stores its token hash. Private reads, edits and artifacts require the owner;
numeric IDs and email addresses are not credentials. New P0 account security
supports authenticated passkey enrollment, signed-assertion login, eight
single-use hashed recovery keys, and session listing/revocation. Save a recovery
method before clearing cookies. Signed-out recovery is under **Already have a
workspace? Sign in**; no operator code is requested. No email verification or
email-only recovery is claimed. See [account security](account-security.md) for
configuration, atomic recovery, capabilities and proof. The production virtual-authenticator/key-recovery flow passed on the canonical Pages origin.

### Existing browser session migration

The old Vercel site is a **temporary migration bridge**, not a frontend mirror or the new hosting target. Deployment `dpl_DdxZgWdzsT78RJzRLLrokTJWMp5T` is promoted. Visiting an old dashboard SPA path automatically runs the bridge. Signed-out `/profile`, `/weekly-plan`, and `/applications` requests were verified to return HTTP 303 to the Pages profile screen, with `private, no-store` caching. The old API health check returns 200 and private profile reads return 401. A signed-in browser can transfer its workspace; that complete public transfer is a separate acceptance check. **Continue an existing workspace** on Pages opens the same old-origin bridge. Private old `/api/*` routes and the controlled QA asset remain temporarily for migration and bookmarks.

The bridge asks the Worker for an authenticated transfer and redirects with HTTP
303 to the approved Pages profile URL. The five-minute token appears only in a
fragment and is stored hashed. Pages clears the fragment and consumes it once
through `/api/session/transfer/consume`. The new `0004` contract requires its
source session to remain active and atomically claims the link, inserts the new
session and consumes it. Logout/individual revocation invalidates pending links;
a storage failure does not spend a link. Legacy unbound links are rejected and
must be reminted from a signed-in browser. IDs, emails and caller-supplied
destinations cannot choose an owner.

Keep the old bridge available while owners still need migration. It cannot
recover a lost old cookie; a previously saved passkey or recovery key is the
normal new recovery path. Administrative `POST /session/login` remains a
separate private operator mechanism, not the public sign-in UI. Do not share
transfer links or record token-bearing fragments in proofs. The stricter P0
transfer/recovery contract is deployed. New production proof passed same-owner migration, fragment removal and replay rejection. The separate transfer rerun also passed logout on both origins; [release evidence](p0-verification.md) retains the earlier timeout accurately.

## Resume extraction and PDF quality

PDF extraction uses Gemini **even when text generation uses Groq**. Configure `GEMINI_API_KEY` (or supported `GOOGLE_API_KEY` alias). Temporary provider/network failures allow bounded retry and the explicitly configured fallback, within a shared 45-second deadline. Larger PDFs use one temporary Files API upload and cleanup. Successful extraction records the model and fallback flag. Failed replacement extraction returns an error and preserves the existing profile; it must not save a partly read PDF as a complete profile.

Review extracted facts before applying. The deployed preparation pipeline asks Groq to select one or two existing source facts for a role-specific summary and two or three existing projects. The response contains only validated fact IDs and project indices; the renderer copies the selected facts and complete selected projects rather than accepting model-authored achievements. Internship summaries emphasize project evidence; job summaries favor actual experience. Skills are ordered by actual matches, and supplied experience, dates, education/GPA, links, certifications, achievements and languages are preserved. Missing sections are omitted. If the provider is unconfigured, fails, times out or selects invalid facts, preparation uses deterministic selection and exposes a review warning. Every saved version records method, model, selected evidence and profile version. Production draft metadata confirmed `llm_grounded` with `openai/gpt-oss-20b`. Two additional actual-Groq synthetic role/mode fixtures selected different relevant facts and project pairs, and both PDFs passed visual/bounds checks. The final complete browser cycle passed on the release above.

PDFs use a single-column A4 layout, core Helvetica fonts, clear headings, hanging bullets, clickable supplied HTTP(S) URLs, and page continuations. Typical profiles fit one or two pages; longer history can use more pages to preserve facts. A hard limit of **800 layout lines throws an explicit error** instead of silently truncating. ASCII/core-font constraints remain: accented Latin text is transliterated, and unsupported scripts such as CJK are not preserved. Check names, full facts, links, layout, and page count in the actual PDF; use the original resume manually when fidelity is insufficient.

The deployed Worker uses genuine Workers AI BGE CLS embeddings with private versioned D1 vectors and a bounded hybrid contribution to the existing six factors. Source/profile changes invalidate scores and reviews; unavailable inference or exhausted allowance has a visible lexical fallback. Python normal plans optionally use genuine BGE/FAISS separately. Neither matching nor interview predictions are hiring probabilities. See [AI evaluation](ai-evaluation.md) for frozen synthetic metrics, actual-model provenance and limitations.

## Discovery, confirmation, and manual action

**Find opportunities** searches for a bounded set of verified individual postings and imports full JDs; repeated listings are reported as duplicates rather than new additions. You may also add an actual URL and JD manually. Restricted portals, stale postings, and unsupported details can reduce results; a 100+ listing cycle is not established.

The 22 October production check used a repaired internship profile with 44 skills and no location restriction: two Tavily searches returned 16 candidates; 13 total network requests verified six listings from Wellfound, Greenhouse and Internshala. Old postings and LinkedIn's blocked responses were omitted. The six verified opportunities were imported, the temporary diagnostic session was revoked, and no employer submission was attempted. The earlier zero-result response was not reproduced after publication of the current bundle; its precise cause is unproven. Search diagnostics record only mode/counts, public host, HTTP status and rejection reason, never identity, query text, credentials or request headers. Private evidence: `/tmp/hireflow-discovery-production-diagnostic.json` and `/tmp/hireflow-discovery-production-safe-trace.json` on the verification machine.

Production sets `PLAN_WORK_IN_QUEUE=true`: matching and factual PDF preparation execute in owner-scoped Queue leases; HTTP polls render prepared results or progress. Lease admission captures profile/listing versions, rotates tokens on interrupted recovery, cleans unregistered uploads and stops after bounded failures. Refresh/regenerate explicitly retries a failed preparation; passive polling does not repeat provider calls indefinitely. Quota exhaustion avoids unnecessary inference. Small offline fixtures use the same helpers synchronously. Exact PDF/answer review and confirmation remain required before any application task can execute.

CAPTCHAs are detected, not solved. Expired listings, unsupported/missing form steps, login requirements, browser budget limits, and uncertain submission outcomes become explicit manual-action states. A failed listing must not be called applied. Check the employer page and submission state before retrying; no test authorizes submissions to real employers.

## Reports and email gap

Reports collect cycle applications, states/reasons, exact resume versions, standalone guide exports, match summaries and study priorities. HTML reports and downloads remain private. **Actual production email delivery is not configured or verified.** Set a supported `RESEND_API_KEY` or `SENDGRID_API_KEY` and a provider-verified `FROM_EMAIL` before an explicitly authorized send. The placeholder sender is rejected. A durable delivery ticket separates queued, provider-accepted and confirmed delivery states; uncertain sends cannot be blindly repeated. Report generation alone does not send email. The opt-in [weekly scheduler](p2-discovery-scheduler.md) prepares drafts and reminders, with separately opted-in email after configuration. It never authorizes applications. See [P2 verification](p2-verification.md) for measured release evidence and remaining external setup.

## Free-tier limits

This is a small-workload deployment, not unlimited service or a promise of future pricing.

- Workers Free: 100,000 requests/day, **10 ms CPU per invocation**. Pages Functions use Workers limits; static assets are separate. See [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [Pages limits](https://developers.cloudflare.com/pages/platform/limits/).
- D1 Free: 5 million rows read/day, 100,000 written/day, 5 GB storage. See [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).
- KV Free: 1 GB storage; 100,000 reads/day; 1,000 writes, deletes and lists/day. See [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/).
- Queues Free: 10,000 operations/day, 24-hour retention; writes, reads, deletions and retries count. See [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/).
- Browser Run Free: 600 browser seconds/day, three concurrent sessions, one new browser every 20 seconds. The app conservatively reserves 60 seconds per attempt against 540 seconds/day, at most nine reservations by default. See [Browser Run limits](https://developers.cloudflare.com/browser-run/limits/).

D1 coordinates budget and launch spacing; queue concurrency stays one. A weekly quota of ten does not promise ten automated applications in one day. The app's safeguards do not replace provider billing controls. No paid plan or R2 billing enrollment is automatically enabled. Search, LLM and email accounts have separate quotas.

Local tests and timing do not prove deployed 10 ms CPU compliance. Inspect actual metrics and error 1102 with representative profiles/JDs. Use the original local Docker runtime for workloads the free deployment cannot support; do not silently increase paid limits.

## Local development and checks

Use Node 22+, install both npm projects, and configure ignored local secrets:

```bash
npm ci --prefix cloudflare
npm ci --prefix frontend
cp cloudflare/.dev.vars.example cloudflare/.dev.vars
# Edit locally; never print or commit the secrets.
npm run db:local --prefix cloudflare
npm run dev --prefix cloudflare
```

In another terminal:

```bash
cd frontend
# Ignored .env.local: WORKSPACE_ACCESS_CODE must match the local Worker's ACCESS_CODE.
VITE_DEPLOYMENT_TARGET=cloudflare API_PROXY_TARGET=http://127.0.0.1:8787 npm run dev
```

The Vite server supplies the server bootstrap only on profile creation. Production uses Pages Functions/service bindings. For a local production-style Pages proxy, run the local Worker and use `wrangler pages dev` with the configured service binding; see [Pages local service bindings](https://developers.cloudflare.com/pages/functions/bindings/#interact-with-your-service-bindings-locally).

```bash
npm test --prefix frontend
npm run build --prefix frontend
npm audit --prefix frontend --audit-level=moderate
npm run check --prefix cloudflare
node scripts/verify_cloudflare_dashboard.mjs
```

The last script uses isolated D1/file storage, real React/Chromium, and a test-only queue hook with remote employer submission disabled. It checks structured edits, private PDFs, preparation/report views, mobile layout, restored sessions and logout. Servers are disposed afterward. Default tests do not send real email.

## Release verification

After actual publication, check:

```bash
curl --fail https://hireflow-dashboard.pages.dev/api/health
curl --fail -I https://hireflow-dashboard.pages.dev/profile
curl -i https://hireflow-dashboard.pages.dev/api/profile/1
```

The private profile request must return 401 without a session. Also verify deep links, nested PDF URLs, no credential values in assets, owned/foreign profile access, migration token replay rejection, logout revocation, and a complete **controlled** UI cycle. The fixture `/assets/hireflow-qa-form.html` only changes the DOM on submit and transmits no application data. Never substitute a JSON API-only cycle for PDF-upload UI evidence or use a real vacancy for automation QA.

Record exact deployment IDs, provider models, results and limits with release verification and the [audit](milestone-audit.md). Earlier Vercel evidence is historical; it does not prove the final Pages release.

Final P0 checks: Python **299 passed / 3 opt-in skipped**; Worker **369
passed / 4 opt-in skipped**, typecheck/dry-run passed; frontend **112 passed**,
both builds passed; isolated React/workerd/D1/file-storage browser E2E passed.
All three GitHub CI workflows passed for `a664041`, including PostgreSQL
migration rollback/checks. New live account recovery passed, and the new Pages
PDF-upload → exact review → controlled Browser Run → prep/report/mobile/logout
cycle passed. The combined script’s last old-Vercel logout POST timed out;
the official transfer-only rerun passed migration, replay rejection and logout
on both origins. See [P0 verification](p0-verification.md)
for exact scopes, private proof locations and measured CPU/capacity limits.
No real employer application or real email was sent. Private proofs stay outside
Git; existing real profiles, artifacts, opportunities and browser usage remain.

Discovery makes separate parallel provider requests per configured source, then verifies candidates in rotation. Internship mode searches Internshala, Wellfound, Greenhouse, Lever and LinkedIn; job mode searches Naukri, LinkedIn, Greenhouse and Lever. Each request asks for up to four candidates; the combined operation accepts at most eight verified listings within 24 total requests and 35 seconds. Provider domain filters are enforced again locally. Partial site failures preserve other results; total provider failure returns a sanitized 503 with current per-site statuses. Source inclusion does not imply authenticated feeds or portal-specific auto-application. The actual production search UI and 390 px mobile layout passed separately from the earlier controlled submission cycle.

A follow-up check of the real saved profile exposed a stale-data guard comparing serialized JSON text. Preparation/attachment/confirmation now compare the profile version instead, with a real-D1 formatted/reordered-JSON regression and the existing concurrency protections. All nine real planned PDFs were then downloaded successfully through private owned URLs. Three used actual Groq-selected evidence; six used the documented factual fallback after provider unavailability, with warning/provenance visible. No real application was confirmed. The temporary verification session was revoked.
