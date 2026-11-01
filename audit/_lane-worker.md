# Lane: Cloudflare Worker architecture / code-quality review (read-only)

Scope: cloudflare/src/*.ts (6,319 lines, 41 files), migrations 0001-0021 (734 lines), wrangler.jsonc, tests/. Paths below are relative to cloudflare/.
Legend: [C] confirmed from code, [I] inference, [U] unknown / not verified (no deploy or runtime access).

## 1. Route table (src/index.ts route(), plus sub-dispatchers it calls)

Global behaviours [C]:
- Origin allowlist in fetch(): index.ts:214-218 returns 403 for a disallowed Origin. A missing Origin is allowed. This is the CSRF defence, so SameSite is not the only layer.
- Errors are `{detail:string}` with ApiError.status. Any non-ApiError becomes **503**, not 500 (index.ts:223).
- Auth is cookie `hireflow_session` (64 hex, SHA-256 hashed in D1, 30-day expiry), checked by auth.ts:12-24. `requireUser(req,env,id)` returns **404** on a user-id mismatch (auth.ts:21). That is good, non-enumerating behaviour.
- JSON size limit: readJson default 100,000 B (profile.ts:9-30), enforced by content-length plus a streamed cap. The hiring shortlist uses 200,000. Multipart profile upload is capped at 3 MB + 100 KB (profile.ts:74).
- Rate limits exist ONLY on: login/access-code (auth.ts:25-36, 10 per 10 min per IP), profile creation (auth.ts:46-60, 5 per IP per 10 min and 50 per day globally), and passkey/recovery (account_security.ts:40-44). No other route is rate-limited. Budgets exist for discovery and browser use, not per HTTP route.
- Idempotency: there is no Idempotency-Key header anywhere [C, grep]. Dedup is by DB uniqueness, see section 3.

| # | Method Path | Auth | Ownership check | Validation | Notes / status codes |
|---|---|---|---|---|---|
| 1 | GET / | none | n/a | n/a | static JSON |
| 2 | GET /health | none | n/a | n/a | index.ts:42-45, `SELECT id FROM users LIMIT 1` only |
| 3 | GET /docs | none | n/a | n/a | index.ts:46, static endpoint list |
| 4 | POST /email/webhooks/(resend\|sendgrid) | HMAC signature plus timestamp tolerance | n/a | body bytes verified (email_webhooks.ts:40-58) | public by design, 401 on bad signature. Body-size limit [U] |
| 5 | /account/backups*, POST /account/deletion-preview, POST /account/delete | session | `WHERE id=? AND user_id=?` (workspace_backup.ts:319) | uuid regex | 404/410. The `/account/delete` confirmation is in confirmDeletion [U for details] |
| 6 | GET/PUT /account/schedule, GET /account/reminders | session | user_id from session | settings() validation | weekly_scheduler.ts:28-39, 405 on other methods |
| 7 | /account/passkeys/*, /account/recover, /account/security, /account/sessions/*, /account/recovery-keys/rotate | login-options, login-verify and recover are public (rateLimit plus requireOrigin). The rest need a session | `DELETE ... WHERE id=? AND user_id=?` (account_security.ts:165,167) | WebAuthn verify, regex on recovery key | challenge consumed with DELETE...RETURNING and browser binding (:68) |
| 8 | GET /operations/{uid}, POST /operations/{uid}/diagnostics | session plus uid==session | requireUser(id) | n/a | the POST triggers LLM calls and has no rate limit |
| 9 | GET /session | none (reports state) | n/a | n/a | |
| 10 | POST /session/login | global ACCESS_CODE plus email | n/a | email lowercase | 401 "Email or access code is incorrect" for both causes. See W-004 |
| 11 | POST /session/logout | cookie | token hash | n/a | |
| 12 | POST /session/transfer, /session/transfer/consume | session / one-time token | source session bound (session_transfer.ts:26,40) | 64-hex token, Origin==target | atomic batch claim, 3 results checked (:54) |
| 13 | POST /profile | ACCESS_CODE (header or body) | creates a new user | validate(), 100 KB JSON or 3 MB multipart | 409 on duplicate email, 429 on the signup cap |
| 14 | GET/PATCH /profile/{id} | session plus id match | requireUser(id) | validate() | PATCH with a PDF triggers LLM extraction, not rate-limited (profile.ts:96 only covers `!id`) |
| 15 | GET /jobs/{uid}/discover/{uuid} | session plus id | discoveryStatus(env,uid,...) [U whether the query filters user] | uuid regex | |
| 16 | POST/GET /jobs/{uid}/discovery-cycles[/{id}[/cancel\|resume]] | session plus id | uid passed to handlers [U] | numeric bounds inside startDiscoveryCycle [U] | 202 |
| 17 | POST /jobs/{uid}, POST /jobs/{uid}/discover | session plus id | uid | addJobs validation (plans.ts:30-50) | 201/202. Jobs are written to a GLOBAL table, see W-003 |
| 18 | GET/POST /weekly-plan/{uid}[/swap\|confirm\|refresh-matches] | session plus id | uid | number() on job ids | |
| 19 | GET/PUT/POST /applications/{appId}/(resume-draft\|resume-reject\|resume-regenerate\|review\|cancel) | session | `ownedApplication(env,owner,id)` (reviews.ts) | JSON, `reviewed===true`, version equality (reviews.ts:196-198) | 409 on stale versions |
| 20 | POST /applications/{appId}/prep-guide/refresh | session | startPrepRefresh(env,owner,id) | n/a | 202 |
| 21 | GET/POST /applications/{appId}/prep-guide/exports[/{uuid}[/html\|pdf]] | session | owner passed | JSON | 200/202 |
| 22 | GET /applications/{appId}/prep-guide | session | loads the app first, then `requireUser(app.user_id)` (index.ts:122-124) | n/a | a missing app yields 401 or 404, no existence oracle |
| 23 | GET /applications/{uid} | session plus id | `WHERE a.user_id=?` | page and page_size bounded to 100 (index.ts:25-29) | the path param is the USER id although the route sits under /applications. Confusing naming (W-014) |
| 24 | GET /resumes/{uid}[/{appId}/download] | session plus id | `WHERE id=? AND user_id=?` (index.ts:154) then the resume key via (application_id,version) | version via number() | |
| 25 | GET /report/{uid}/email-readiness\|email-deliveries/{uuid} | session plus id | emailDeliveryStatus(env,uid,...) | uuid | |
| 26 | POST /report/{uid}/generate, POST .../latest/email, GET .../latest[/html] | session plus id | uid | n/a | email returns 200 or 202. A malformed method or sub-path falls to 404 |
| 27 | POST /hiring/shortlist | session | owner | readJson(200000), normalizeHiringInput | 200/202 |
| 28 | GET /hiring/email-readiness, /hiring/shortlists, /hiring/email-deliveries/{uuid}, GET /hiring/shortlists/{id}[/report.html], POST .../email | session | `WHERE id=? AND user_id=?` (hiring.ts:90) | page_size bounded to 50 | |
| - | OPTIONS * | none | n/a | n/a | 204, CORS headers added after |
| - | everything else | | | | 404 `{detail:'Not found'}` |

Auth/ownership gaps: no route lacks both [C]. Every private route calls requireUser or a handler that does. Items marked [U] are the deeper handlers (discovery_tasks, discovery_cycles, plans) whose uid-scoping I did not fully read. Their callers do pass the session-verified uid.

## 2. Findings

W-001 · S2 · reliability · Queue has no DLQ; the maintenance task is a head-of-line single point
Where: wrangler.jsonc consumers block (max_retries 100, max_concurrency 1, max_batch_size 1, no dead_letter_queue); src/index.ts:233-238; src/tasks.ts:34.
Evidence [C]: every processTask throw is retried with `message.retry({delaySeconds:120})` (index.ts:236) up to 100 times, about 3.3 h, and then the message is dropped. A single `maintenance` message runs about 12 recovery functions serially (tasks.ts:34), so one throwing recovery step (for example recoverDiscovery) aborts all later ones and the message retries. With concurrency 1, a slow or failing maintenance run also blocks apply and prep work. Cron (index.ts:239) only does `APPLICATION_QUEUE.send`, so stuck-work recovery depends on the queue it is meant to recover. If send() throws, cron fails with no recovery.
Impact: a poison or failing task silently disappears after 100 tries. A bug in one recovery path stalls the others. Throughput is capped at roughly one task per delivery.
Fix: add a dead_letter_queue. Run each recover* in its own try/catch with a log. Let cron run the cheap DB-only recovery directly and enqueue only the heavy part. Consider separating "apply" and "background" queues.
Effort: S-M. Confidence: High for the config and code; the real-world impact is [I].

W-002 · S2 · observability · Unhandled errors log no correlation ID, error class or message
Where: src/index.ts:222; src/index.ts:236.
Evidence [C]: `console.error(JSON.stringify({event:'request_failed',path}))` carries no X-Request-ID/correlation_id (available at env.OPERATION_CONTEXT) and no error name. Queue failures log only application_id, and not for non-application tasks. Unknown errors return 503 with a generic message (index.ts:223), which looks like an outage to clients and monitors. The redaction intent is good (telemetry.ts whitelist), but there is no safe error-class field.
Impact: a production 5xx cannot be tied to its request or root cause. A correlation_id/status join exists only via operation_events in D1.
Fix: log {event, correlation_id, task_kind, error_name} (name only, no message). Return 500 for unknown errors. Add provider/kind where classified.
Effort: S. Confidence: High.

W-003 · S2 (S0 only if descriptions are ever trusted cross-user) · tenant isolation · Global jobs catalogue is writable by any user
Where: migrations/0001_initial.sql jobs.url UNIQUE; src/plans.ts:52.
Evidence [C]: `jobs` has no user_id. Any authenticated user can POST /jobs/{uid} with arbitrary url, title and description. The insert is `ON CONFLICT(url) DO NOTHING` for the manual path and DO UPDATE for the verified discovery path (plans.ts:52). So the first user to add a given URL decides the stored description, company and title that a later user (manual add) is scored and tailored against. Mitigations [C]: the claim step re-checks that the job columns equal the reviewed values (tasks.ts:123), and historicalListing snapshots after confirmation (storage.ts:65). I did not confirm what discovery's DO UPDATE does to rows another user has planned.
Impact: cross-tenant content poisoning of match scores and resume tailoring. It cannot trigger a submission without the victim's review binding.
Fix: key manual jobs per user (owner column, or UNIQUE(url,owner)). Treat manual rows as private. Only server-verified discovery writes the shared row.
Effort: M (migration plus query changes). Confidence: Medium-High.

W-004 · S2 · auth · One shared static ACCESS_CODE gates every login and signup, and also encrypts checkpoints
Where: src/auth.ts:25-43; src/automation_checkpoints.ts:24; src/index.ts:62-66.
Evidence [C]: /session/login needs only ACCESS_CODE plus an email. The code is global, not per user, so anyone holding it can sign in as any registered email. The same secret derives the AES-GCM key for browser checkpoints, by SHA-256 of a prefix plus the code with no KDF or salt. Rotating the login code therefore makes every stored checkpoint undecryptable. That fails closed (load() throws, automation_checkpoints.ts:50) but strands in-flight recoveries. Rate limiting is per IP only (10 per 10 min). The comparison is constant-time over digests (OK).
Impact: if the code leaks, all tenants are exposed. Rotation has a side effect on submissions in flight. This may be an accepted single-operator design [I]; the Pages server holds the code.
Fix: use a separate CHECKPOINT_KEY secret (with a key id). Prefer per-user credentials (passkeys already exist) and downgrade ACCESS_CODE to a signup-only gate.
Effort: M. Confidence: High on facts, Medium on the severity judgement.

W-005 · S3 · cost/abuse · No rate limit on authenticated LLM-triggering routes
Where: src/index.ts:57 (POST /operations/{uid}/diagnostics); src/profile.ts:96-100 (PATCH /profile with a PDF); regenerate/refresh routes (index.ts:107, 112).
Evidence [C]: reserveProfileCreation only applies to new profiles (`!id`). Authenticated PATCH uploads call the Gemini extraction without a counter. diagnostics calls providers on demand. [U] whether the downstream provider layer has its own budget (semantic budget and provider_health exist).
Impact: one session can burn the free provider quota for everyone (a denial of service on shared quota).
Fix: a per-user, per-day counter table (reuse the login_attempts upsert pattern). Effort: S. Confidence: Medium.

W-006 · S3 · migration safety · D1 forward-only, with table-rebuild migrations and no tested rollback story
Where: migrations/0020_gmail_delivery.sql:5-64 (DROP TABLE plus RENAME with defer_foreign_keys); 0008_listing_facts.sql:27 (DROP TRIGGER).
Evidence [C]: 0020 drops and recreates email_deliveries and sibling tables, saving and restoring rows in the same file. D1 has no down-migrations in the repo (21 up files, no down files). 0001 sets `PRAGMA foreign_keys = ON`, which D1 ignores per connection, so cascade behaviour relies on D1 defaults [I]. tests/migrations.ts and gmail-migration.test.ts exist, so the rebuild is tested.
Impact: a bad deploy after 0020-style migrations can only be rolled forward. Wrangler migrations are not wrapped in an application-level backup step [U].
Fix: document a "backup then migrate" step (the workspace export exists but is per user). Use D1 Time Travel as the documented rollback. Keep rebuilds additive where possible.
Effort: S (doc and runbook). Confidence: Medium.

W-007 · S3 · data model · JSON-in-TEXT columns mostly without json_valid CHECK
Where: users.master_profile, applications.skill_gaps/matched_skills, prep_guides.structured_data (0001_initial.sql:6,24,55).
Evidence [C]: only 3 CHECK(json_valid) occurrences in all migrations, all in 0021. Readers use parsed() with a silent fallback (types.ts:44-46), so corrupt JSON degrades to `{}`/`[]` without any signal. Example: master_profile is read through `parsed(...,{})` and a corrupt row would present an empty profile and could be re-saved over by PATCH.
Impact: silent data loss on a corrupt row. Low probability because writes go through JSON.stringify.
Fix: add json_valid CHECKs on new tables; log (counter only) when parsed() falls back on a column that should never fail.
Effort: S. Confidence: Medium.

W-008 · S3 · reliability · Queue message ordering and eviction: invariants hold, with two soft spots
Where: src/tasks.ts:58-66, 120-151, 159-177; src/automation.ts:484-489, 510-530; src/automation_checkpoints.ts:37-70.
Evidence [C] (the "no blind resubmission" invariant is well enforced):
- Atomic claim: `UPDATE applications SET status='applying' ... WHERE status='confirmed' AND confirmed_review_id=? AND ... EXISTS(users.profile_version, jobs fields, submission_reviews binding/unrevoked/unexpired)` (tasks.ts:120-126). Zero changes means the budget reservation is released and the message is acked.
- Durable `submitting` checkpoint is written BEFORE the click (automation.ts:484), and `submitted=true` is set before the click (:487).
- The checkpoint upsert refuses to overwrite submitting/submitted/uncertain except forward (automation_checkpoints.ts:62-69), and load() treats those phases as a hard stop (:37-42; automation.ts:299-301).
- A retry is allowed only when `!submitted && !mutationStarted && status==='failed'` (automation.ts:518), and at most 3 attempts (tasks.ts:139).
- Eviction mid-submit: the row stays `applying` (or phase `submitting`). The delivery path (tasks.ts:58-66) and the 5-minute cron path (tasks.ts:167-177) move it to needs_action unless the checkpoint is a fresh `ready` one, which is resumable.
- Cancel race: cancel only works from `confirmed`, with revoke plus outbox delete in one batch (reviews.ts:233-241). The claim re-checks `revoked_at IS NULL`.
- Duplicate deliveries are safe because the claim is conditional.
Soft spots: (a) the browser budget is reserved (tasks.ts:108) before the claim and released only on the claim miss. A crash between them leaks 60 s of the daily 540 s budget. (b) Checkpoint `ready` resumption after an eviction re-runs a browser session from storage state, so a site-side state change between runs is [U]. The invariant covers POSTs but is only as good as `mutation_started` detection at automation.ts:332.
Impact: no duplicate-submission path found. Budget leakage is minor.
Fix: reconcile browser_budget in the maintenance task; keep tests for the eviction cases (tests/p1-*, automation-runtime.test.ts exist). Effort: S. Confidence: High.

W-009 · S3 · structure · Circular import plans <-> plan_tasks
Where: src/plans.ts, src/plan_tasks.ts.
Evidence [C]: a DFS over the import graph finds exactly one cycle: `plans -> plan_tasks -> plans`. Fine today because the uses are functions, not module-level values.
Impact: fragile under bundling and refactors. Fix: extract the shared helpers to a third module. Effort: S. Confidence: High.

W-010 · S3 · structure · God files and a god-dispatcher
Where: src/intelligence.ts (742 lines, 62 KB, about 44 functions, 11 exports, max line 1,321 chars); src/workspace_backup.ts (442 lines, 51 KB, about 37 functions); src/automation.ts (543 lines, 34 KB, one giant `work()` closure at automation.ts:291-~505); src/index.ts (route() is a 157-line if-chain).
Evidence [C]: counted with wc and grep. tasks.ts:24-154 `processTask` is a 130-line function mixing 12 task kinds with the apply pipeline. Routing is split three ways: index.ts if-chain, `*Routes()` helpers that return null (workspace_backup, weekly_scheduler, account_security), and per-file regexes. Method dispatch is repeated inside each block, so an unhandled method falls through silently to 404 (for example PUT /operations/N).
Impact: reviewability and the blast radius of changes. Fix: a small route table (method, regex, handler, auth mode) and split processTask into a kind -> handler map. Effort: M. Confidence: High.

W-011 · S3 · duplication · Repeated patterns
Evidence [C]: lease/claim/recover logic is re-implemented in at least 8 files (email_delivery, hiring, hiring_email, discovery_cycles, weekly_scheduler, prep_exports, workspace_backup, prep_refresh), each with its own lease_token/lease_expires_at columns (migrations 0013, 0015, 0016, 0017, 0020, 0021). Two CSV parsers: index.ts:196-209 `parseCsv` (exported, no non-test caller) and hiring.ts's stricter one. Ownership predicates are hand-written per query rather than through a helper (about 20 `AND user_id=?` sites).
Fix: a generic `claimLease(table,id)` helper; delete or merge parseCsv. Effort: M. Confidence: Medium-High.

W-012 · S3 · observability · /health is shallow
Where: src/index.ts:42-45.
Evidence [C]: it checks only D1 (`SELECT id FROM users LIMIT 1`). KV, Queue, Browser and the provider keys are not checked. A D1 failure goes to the 503 path. No queue-lag, outbox-age or stuck-applying signal, although `getOperationsStatus` exists behind auth.
Fix: keep /health cheap, and add an operator-only /health/deep (outbox oldest undispatched age, count of applying > 5 min). Effort: S. Confidence: High.

W-013 · S4 · security hygiene · Public /docs endpoint, and `workers_dev:true`
Where: wrangler.jsonc ("workers_dev": true); index.ts:46.
Evidence [C]: endpoint list is public; the workers.dev hostname exposes the Worker directly beside the Pages proxy. The Origin allowlist limits browsers, not scripts. Impact is low because every route is authenticated. Fix: disable workers_dev in prod if the Pages proxy is the only entry. Effort: S. Confidence: Medium.

W-014 · S4 · naming · /applications/{id} takes a USER id
Where: src/index.ts:131-133, 148-149 (/resumes/{id}), 162, 168 (/report/{id}), 54, 72, 77, 80, 86, 91.
Evidence [C]: `number(match[1])` is passed to requireUser as the user id. The prep-guide route (:121) uses an application id on the same prefix. Ambiguous IDs invite a future mix-up bug. Fix: rename in a v2 or document it. Effort: S-M (client change). Confidence: High.

W-015 · S4 · dead code · Exports with no external user
Evidence [C] (each name appears in one src file only, with no test or other-file use): applicationData (storage.ts:70), parseCsv (index.ts:196), configuredModels, normalizeQuestion, researchPrepCompany, safePrepLink, renderHiringHtml, utf16Hex, ownedApplication, plus constants BACKUP_LIMITS, EMBEDDING_DIMENSIONS, MAX_UPLOAD, PREP_VERSION, SEMANTIC_ALPHA, WORKSPACE_ARCHIVE_FORMAT. Some are exports only so they can be unit-tested [I]. Fix: un-export or delete. Effort: S. Confidence: Medium.

W-016 · S2 · maintainability · Code density hides defects from review
Where: 256 lines over 300 chars in src/; max line 1,321 chars (intelligence.ts). See section 4.
Evidence [C]: see table. The long lines are mostly SQL strings and chained expressions packed on one line, with whole functions on a single line in hiring.ts, weekly_scheduler.ts and email_delivery.ts. Review of auth-sensitive branches is error-prone.
Impact: raises the chance that the next change introduces an auth or idempotency regression, and breaks line-based diff review. Fix: formatting (Prettier) fixes most; see section 4. Effort: S for formatting, M for the remainder. Confidence: High.

## 3. Data model notes (migrations 0001-0021) [C unless stated]

- 51 CREATE INDEX statements across about 59 CREATE TABLE statements. Core query paths are indexed: applications(user_id,cycle_start,status), UNIQUE(user_id,job_id), status_events(application_id,id), shortlists(user_id,id DESC) (0021:13), recovery indexes on (state, next_wake_at, lease_expires_at). `/applications/{uid}` uses `ORDER BY created_at DESC,id DESC LIMIT/OFFSET` filtered by user_id and status, and only applications_user_cycle(user_id,cycle_start,status) exists, so that list sorts in memory [I, no EXPLAIN run]. OFFSET paging is bounded (page_size at most 100), so S4.
- Idempotency by uniqueness: UNIQUE(user_id,job_id), outbox UNIQUE(application_id,kind), resumes UNIQUE(application_id,version) plus UNIQUE(object_key), weekly_reports UNIQUE(user_id,week_start_date), prep_guides.application_id UNIQUE with ON CONFLICT DO NOTHING (tasks.ts:48), automation_checkpoints keyed by application_id.
- Outbox: the dispatched_at update is guarded by id, application_id, kind and review_id (storage.ts:102) against rowid reuse. Re-dispatch after one hour (tasks.ts:180-181) is safe because of the conditional claim.
- FKs: nearly all child tables reference users or applications with ON DELETE CASCADE. `shortlists.user_id` (0001:67) has no ON DELETE; account deletion deletes it explicitly (workspace_backup.ts:245) before the user, so that is consistent. Foreign keys are enforced by D1 by default [I].
- Deletes: hard deletes (account deletion with a lease and a preview), a revoke_at soft marker for reviews, and a tombstone-like `expired` backup state. No generic soft delete.
- Triggers: status audit events (0001), review invalidation (dropped and recreated in 0008), the hiring_report_immutable trigger, the workspace_revision bump triggers (0020:49-51). The trigger count is large; every email_deliveries write bumps workspace_revisions, which is a write amplification [I].
- Tenant isolation at query level: no string-built SQL with user input. The only template-interpolated SQL uses constant column lists (plans.ts:52,75 `factsColumns`, and the static `where` fragments in index.ts:136-138 whose values are bound). `applicationQuery` is a shared SELECT and callers add `WHERE a.id=?` or `a.user_id=?`; callers that use `a.id=?` alone (tasks.ts:37, index.ts:122) are internal or followed by an ownership check. No query missing a user predicate on a user-facing route was found, except the global jobs table (W-003).
- Time values are ISO TEXT; counters in login_attempts use integer ms, so there are mixed time representations (S4).

## 4. Code density: top 15 files by lines >300 chars (total 256 lines in src/)

| # | File | lines >300 | total lines | bytes | Formatting alone fixes it? |
|---|---|---|---|---|---|
| 1 | workspace_backup.ts | 26 | 442 | 51,197 | Yes (SQL and object literals wrap) |
| 2 | email_delivery.ts | 24 | 138 | 23,644 | Yes; but 138 lines to 23 KB means one-line functions, so also split |
| 3 | discovery_cycles.ts | 21 | 190 | 27,289 | Yes |
| 4 | prep_intelligence.ts | 17 | 249 | 32,784 | Mostly (long string literals stay) |
| 5 | hiring.ts | 16 | 113 | 18,212 | Yes |
| 6 | intelligence.ts | 14 | 742 | 62,040 | Partly (a 1,321-char line holds prompt text; move prompts to constants) |
| 7 | plans.ts | 13 | 277 | 31,289 | Yes, except the SQL template at :52 |
| 8 | weekly_scheduler.ts | 13 | 91 | 14,233 | Yes |
| 9 | hiring_email.ts | 11 | 49 | 8,881 | Yes |
| 10 | prep_document.ts | 10 | 101 | 14,784 | Partly (HTML strings) |
| 11 | prep_exports.ts | 9 | 91 | 13,130 | Yes |
| 12 | email_webhooks.ts | 7 | 137 | 16,319 | Yes |
| 13 | discovery_tasks.ts | 7 | 78 | 8,804 | Yes |
| 14 | listing_details.ts | 6 | 105 | 12,152 | Yes |
| 15 | dynamic_source.ts | 5 | 246 | 21,850 | Yes |

Command used: `for f in src/*.ts; do awk 'length>300' $f | wc -l; done`. Formatting (Prettier with printWidth about 120) would fix most of these. No formatter or linter is present: package.json has no prettier or eslint entry [C, grep]. Long SQL and prompt strings should become named template constants; that is the manual part.

## 5. Async/queue summary table [C]

- At-least-once: handled by conditional claims (tasks.ts:120), DO NOTHING inserts, and leases in 8 modules.
- Retry/backoff: apply uses 40 s * 2^attempts for retryable pre-submit failures (tasks.ts:139-142), up to 3 attempts. The generic failure path is a flat 120 s with at most 100 retries and no DLQ (W-001).
- Timeouts: browser work has a 42 s timer (automation.ts:510) and a 2 s cleanup race (:537); each fetch has an AbortController (automation.ts:71-74).
- Stuck recovery: the cron runs every 5 minutes via the queue maintenance message (tasks.ts:159-183, wrangler `*/5 * * * *`).
- Uncertain outcome: enforced at automation_checkpoints.ts:37-42 and 62-69, automation.ts:299-301 and 518-519, tasks.ts:58-66, 150, 175.

## 6. Summary (10 lines)

1. No route was found without auth or an ownership check; ownership failures return 404, and the Origin allowlist (index.ts:214-218) is the CSRF control. [C]
2. No duplicate-submission path found. The claim, the pre-click durable `submitting` checkpoint and the forward-only checkpoint upsert enforce the no-blind-resubmission rule (W-008). [C]
3. Top risk: the queue has no DLQ, drops messages after 100 flat 120 s retries, and the maintenance message runs 12 recoveries serially on a concurrency-1 consumer (W-001, S2).
4. Unhandled errors return 503 and log neither request ID nor error class (W-002, S2), so production failures are hard to trace.
5. The global `jobs` table lets the first user to add a URL set its content for later manual adds (W-003, S2); cross-tenant poisoning, not a data leak.
6. One shared ACCESS_CODE gates all logins and is also the checkpoint encryption root (W-004, S2). Split the keys.
7. No rate limit exists on authenticated LLM routes (W-005); /health only checks D1 (W-012).
8. Data model is mostly sound: UNIQUE keys carry idempotency, cascades are consistent, SQL is parameterised. JSON-in-TEXT has only 3 json_valid checks (W-007), and D1 rollback is forward-only with table-rebuild migrations (W-006).
9. Structure: god files (intelligence 742 lines, workspace_backup 442, automation's single closure, processTask 130 lines, route() 157 lines), one import cycle (plans <-> plan_tasks), about 15 dead exports.
10. Density: 256 lines over 300 chars in 41 files, max 1,321 chars, no formatter or linter configured. Formatting fixes most of the top 15 files; prompt and SQL strings need manual extraction (W-016).
