# P2 implementation and release evidence

This document preserves the P2 release evidence. The later [P3/Gmail release](p3-verification.md)
adds Gmail/Nodemailer and supersedes the SMTP implementation status below;
actual authorized inbox receipt and the real 100+ pool remain open.

This work builds on P1 commit `fa07874` on `main`. It uses the existing free
Cloudflare deployment. No paid plan, R2 billing, real employer submission or
production email send is enabled by this work.

## Scope and acceptance boundaries

| Item | Implemented behavior | Evidence boundary |
| --- | --- | --- |
| P2-01 | Private resumable source/query checkpoints, bounded Queue steps, canonical deduplication, cancel/resume, actual full-JD verification, fit/geography checks, visible partial results and local persistent execution alternative | Actual workerd/D1 test collects 100 distinct synthetic full JDs and resumes a cancelled checkpoint. The first live 100-target pilot retained zero listings after 11 search attempts and 62 detail-check reservations. A later cycle verified/imported three listings before all remaining candidates were externally deferred; its measured QA checkpoint was then cancelled. A real 100+ pool remains unverified. Search snippets do not count. |
| P2-02 | Public ATS/static detail adapters including Ashby, bounded allowlisted public JavaScript rendering, shared reservations/cache/backoff, restrictions and closed-job rejection | Static fixtures/public reads and a native Queue/Browser Run probe on an owned synthetic source pass. That probe does not establish arbitrary external portal coverage. Discovery support does not establish application submission support. |
| P2-03 | Evidence-backed company/career claims, estimates labelled, dated news, topic reasons, contextual distinct questions and explicit guide refresh | [Preparation evaluation](p2-preparation-quality.md) compares the same 16 known P1 cases; exact behavioral duplication falls from 87.5% to 0%. Frozen 120-case gates remain unchanged. This is not independent human or live resource-usefulness evaluation. |
| P2-04 | Owner-only versioned HTML/PDF prep guides, provenance, expiry/stale/error states, guide/report links | [Export tests and visual checks](prep-exports.md), actual PDF readers and long/Unicode examples, plus a production four-page guide with authenticated HTML/PDF downloads and anonymous denial. |
| P2-05 | Immutable queued email payloads, consent checks, bounded attachments/private links, idempotency/recovery and signed Resend/SendGrid receipt ledger | **Actual sender setup and owner inbox receipt remain pending.** No supported provider key is deployed. Fifty-nine isolated email tests verify signatures, correlation, replay/order/race handling and distinct acceptance/delivery timestamps. These fixtures do not establish a real delivery. |
| P2-06 | Opt-in timezone-aware weekly draft discovery/planning/guides/report/reminder, pause/resume, deduplicated local weeks and durable recovery | [Scheduling policy and tests](p2-discovery-scheduler.md). It never creates submission approval or confirms an application. Scheduled email additionally requires configured provider and explicit opt-in. |
| P2-07 | Both-mode summaries/shared quota, exact resume versions, standalone guide exports, immutable emailed content and action instructions | HTML/provider-payload fixtures and the real-opportunity browser workflow verify content/links. Signed receipt handling is implemented, but real owner inbox receipt remains P2-05's external setup dependency. |
| P2-08 | Scoped private workspace export/deletion, bounded coordinated artifact snapshots, hashes, isolated offline restore and conservative retention | Synthetic workerd/D1/private-store round trips verify ownership/history/versions and tamper rejection. A production synthetic archive has five artifacts with every hash verified. An independent process also reopened its offline restore under schema 0019, with all 22 authority/execution tables empty; scoped cleanup is tracked below. Production orphan cleanup remains disabled; no real workspace deletion is part of QA. |
| P2-09 | Explicit supported-runtime matrix, normal Python optional grounded tailoring, shared contracts and regression CI | Python support is deliberately narrower than Cloudflare for editor, refresh/export, multistep, passkeys and scheduling; unavailable features are stated rather than silently treated as parity. |

## Local verification

Current local release gates: **706 Worker tests, 390 Python tests and 152 frontend tests passed** (four Worker and three Python opt-in tests skipped). Typecheck and deployment dry run passed. The Worker total includes **59 email tests** covering signed receipts and durable delivery, as well as native-source transport and resource/accounting regressions. The earlier 601-Worker/145-frontend gate belongs to the historical structured-geography release below.
Also verified: the frozen 120-case evaluation, 16-case preparation comparison,
actual isolated React/Worker/D1/private-file browser workflow, Cloudflare build,
Worker dry run, and a local discovery CLI process restart with durable D1 state.

The local CLI fixture performs six separately rotated searches and one complete
detail verification, writes private full-JD JSON, and reopens the same on-disk
checkpoint without new provider calls. Offline fixtures reject all network calls
outside their controlled adapters. CI runs both the first process and resume.

## Production release

Published on 2026-10-26 to the existing free deployment:

| Component | Release |
| --- | --- |
| Website | [hireflow-dashboard.pages.dev](https://hireflow-dashboard.pages.dev) |
| API | [hireflow-api.baidpankaj567.workers.dev](https://hireflow-api.baidpankaj567.workers.dev) |
| Worker | `70ad62bb-eca4-4be4-9c82-ef28ab64e02d` |
| Pages | `ec151322` |
| D1 schema | Ordered migrations `0013` through `0019` applied; applied migrations remain immutable. |
| Source | Worker `e6d5e4ca36f2568be449ba68731c21d216a1d0b0`; Pages assets `a6814e6` |

The earlier `a6814e6` Worker (`f2463dea-01c0-42d2-889b-9cd57f801a6b`)
has the native fixture evidence below. Its remote Cloudflare CI failed because
the Node evaluator bundled the Worker-only browser SDK. The followup lazily
loads that SDK and keeps it external in Node evaluation; local frozen
120-case and 16-case gates pass unchanged. Final full-suite/remote gates are
recorded for each source below. Source `35d93b5` passed all three remote CI workflows; the final preparation followup is `e6d5e4c`.

Historical releases include P2 implementation `a359653`, PDF repair `eed7ed1`,
local restore persistence repair `b64f4c6` and structured geography repair
`4beb13c` (Worker `4553fac4-4780-4f09-8f93-f456a4bf7abd`, Pages `b8c2f73e`).
Those releases passed their applicable workflows. Source `4beb13c` passed
[Cloudflare CI](https://github.com/pankajbaid567/hireflow/actions/runs/40347175473)
and [Backend CI](https://github.com/pankajbaid567/hireflow/actions/runs/40347175425).
Those gates include all 601 Worker tests, frozen evaluation, preparation
comparison, persistent local discovery/restart, isolated React/Worker/D1/file
browser E2E, frontend build, Worker dry run, Python tests and PostgreSQL
migration/rollback checks. No evaluation thresholds or frozen labels changed.

After that historical source-only release, direct API health, Pages profile and the
same-origin API proxy returned HTTP 200; anonymous access to the deleted
workspace export returned HTTP 401. API CORS retains the Pages origin.

Final source `e6d5e4c` passed [Cloudflare CI](https://github.com/pankajbaid567/hireflow/actions/runs/40376105018),
[Backend CI](https://github.com/pankajbaid567/hireflow/actions/runs/40376104984)
and [Frontend CI](https://github.com/pankajbaid567/hireflow/actions/runs/40376105087).
These checks include the frozen evaluations, persistent local discovery restart,
isolated React/Worker/D1/file E2E, frontend builds, Pages Functions publish-layout
validation, Worker dry run and PostgreSQL migration/rollback.

### Actual production browser and document checks

The earlier browser workflow used PDF release
`019e4986-817b-4466-8664-823d87103550`. An isolated Chromium session used one
disposable synthetic workspace and a synthetic uploaded PDF. It performed the
real Pages/API/Queue/private-KV flow:

- PDF intake and profile extraction, queued matching and a one-page tailored
  resume that preserves the uploaded project and does not invent professional
  experience.
- Preparation refresh with actual configured model output, six questions and
  two interview rounds; four evidence/fallback warnings remain visible.
- UI-created versioned guide exports and a four-page PDF, opened with actual
  PDF readers and visually inspected. The PDF is 641,541 bytes, contains the
  required sections and all six questions, and has 50 URI annotations. The
  resource evidence retains its source dates and warnings.
- Weekly HTML report links to the exact private standalone export; anonymous
  export requests return HTTP 401.
- Weekly preparation opt-in and pause from the UI, visible next-run state and
  a 390-pixel mobile layout without horizontal overflow. No submission consent
  or employer application is created by scheduling.
- A coordinated production backup containing five artifacts, with the
  separately authenticated manifest hash and every document SHA-256 verified.
  The real archive then restored into a new isolated local D1/KV workspace.
  Another process reopened the persisted state without reimporting or applying
  migrations and verified the application, guide, report, two guide-export
  records, two historical status events plus a safe-restoration event, and the
  resume version. All five artifact hashes matched: 656,700 bytes including
  three PDFs. The original restore verified twenty empty authority/execution
  tables. A later independent restore under migration 0019 also verified the
  four receipt columns, two receipt triggers, the same five artifact hashes and
  **22 empty tables**, including email deliveries, the receipt ledger and login
  attempts. Both restores made zero network requests or production changes.

This run uncovered a real PDF failure: a resource excerpt contained decorative
Unicode angle brackets outside the embedded font subset. The deployed repair
normalizes those typographic markers in PDF output; the original HTML/evidence
is preserved. A real-reader regression covers that failure. The backup test
helper was separately corrected to hash raw JSON-file bytes rather than parsed
objects. Neither failure is presented as a successful first attempt.

Private browser sessions, source snapshots, resumes and backup files stay
outside Git. The test sends **zero employer submissions and zero emails**.
After the scoped synthetic deletion, the exact Queue ticket reached `complete`
with all twelve files processed. An independent operator read verified all twelve
exact synthetic source/backup keys absent (HTTP 404), with workspace/session
access revoked. A final read-only comparison confirmed the existing real
workspace's seven table snapshots and all twelve private files unchanged,
including their SHA-256 hashes. Shared listings and usage counters were retained.

### Current real-opportunity browser check

The final source `e6d5e4c` completed the actual Pages/API/Queue workflow at
18:17:44 UTC on 26 October using a separate disposable workspace and a verified
**Internshala** opportunity: WEVSOCIAL's GTM Engineer internship. Its one-item
plan scored 0.6057. The tailored PDF preserved the declared project and did not
invent professional experience.

The final model-generated guide contains **eight JD-specific questions** across
technical, behavioral and design categories, two explicitly estimated rounds,
and ten visible evidence/budget warnings. Company facts and inaccessible
resources remain unknown/unavailable. Its fresh immutable export is version 3,
bound to guide revision 3: **654,102 bytes, four pages**. Actual PDF text checks
verify all eight questions and the latest guide generation time; all four guide
pages and the one-page resume were rendered and visually reviewed without
clipping or overlap. The report links to that exact private export; mobile at
390 pixels has no horizontal overflow and no page errors were recorded.

This final check follows actual repairs found during testing: portal section
headings were incorrectly used as duties; refresh status could be completed
while the same response held an older guide; two model templates asserted
unestablished candidate history; export metadata used the original database row
date after regeneration. Their regressions reproduce the old failures and pass
with the fixes. Existing PDF versions remain unchanged. QA helpers were also
corrected to wait for the actual export POST/ticket before accepting a ready
version, and to exclude page headers/footers when comparing a question split
across pages. Earlier failed/limited proofs remain private and are not relabelled
as this final pass.

Email setup was visibly missing, so sending remained disabled with zero attempts.
No employer submission or email occurred. The discovery checkpoint was measured
separately and cancelled for scoped QA cleanup; neither this browser flow nor
its eight interview questions establish a completed 100-listing cycle.

The final scoped deletion completed with eight referenced files processed.
Two exact known old report keys were removed only after their byte hashes
matched and a conditional global reference/tombstone guard confirmed no live
reference. All **ten** known old/new QA files independently returned HTTP 404;
the QA user, private-domain rows and session are gone. No broad prefix cleanup
or other-owner deletion occurred. The final original-workspace comparison
matched both the pre-cycle snapshot and the original P2 baseline: **all seven
table snapshots and all twelve private files (203,735 bytes) were unchanged**.
After cleanup, Pages still returned typed backend JSON and rejected an invalid
empty profile with HTTP 422; this smoke created no user.

### Native public JavaScript source probe

Source `a6814e6` also passed an actual Cloudflare Queue + Browser Run probe
against an owned, explicitly labelled synthetic career page. The bundled
production verifier accepted a 428-character rendered JD and explicit India
eligibility. It reused the checked initial document, acknowledged browser close,
and recorded two native resource reads, 15 D1 calls and 2,316 resource bytes.
The pipeline made four native GETs: the static redirect, HTML, JavaScript and
JSON. It reserved 90 browser seconds. The shared detail ledger rose by seven
during the overlapping discovery window; that is not a probe-only request
count. Operator preflight used two logical Node fetch calls whose implicit
redirect hops were not separately counted. No search/model calls, employer applications, emails, quota resets or
paid activation occurred. This validates the native guarded transport on that
fixture; it does not count as a real vacancy or certify external/authenticated
portals.

The first native probe failed with HTTP 503 instead of enqueue acceptance 202;
its initial cleanup was incomplete. That failed result is retained. A later
probe passed, and a subsequent independent read confirmed **both** probes'
exact Worker, Queue, private result and guard absent. The successful probe does
not rewrite the first attempt as a pass. Direct API and same-origin Pages API
health both returned HTTP 200 after cleanup.

### Measured discovery and remaining acceptance

The production India-internship cycle targeted 100 and made **11 Tavily search
attempts across multiple sources**, reserving **62 detail checks**, during an
eight-minute observation. It retained **zero verified relevant listings**.
The observation was explicitly cancelled with its checkpoint retained until the
subsequent scoped QA deletion; it was not reported as a completed cycle. These are reserved attempt counts, not a
claim that every detail request completed successfully.

Source outcomes include mode/geography/skill mismatches, unavailable or closed
postings and a LinkedIn rate-limit response. Investigation also confirmed that
one Internshala listing's structured India country metadata was dropped while
its locality was retained, causing an incorrect geography rejection. A parser
repair now retains structured countries and remote eligibility, with thirteen
regressions preserving US-only/Puerto Rico/unknown-geography rejections. A
[public-detail check](evidence/p2-structured-location-live.json) through the
actual isolated workerd/D1 reader verified the 5,610-character JD and accepted
`Remote — India` using the unchanged 180,000-byte cap. The repair is deployed
in `4553fac4-4780-4f09-8f93-f456a4bf7abd`. This is a separate one-detail
check, not a rerun of the production 100-target cycle.

A later real-source cycle verified/imported **three distinct complete JDs**
after **five** search attempts and **36** detail reservations. All three have
independent canonical URLs, body hashes and posting dates. Of 27 candidates,
18 were rejected, three verified, one errored and five remained pending. Healthy
source work had drained; every remaining candidate was externally deferred
behind LinkedIn HTTP 429 until at least 18:18:40 UTC. The exact QA checkpoint was
cancelled at 18:12:16 UTC before that retry, and is not described as naturally
completed. There was no arbitrary eight-minute cutoff on this later cycle.

The shared app safety counter already held 20 of its configured 25 daily searches
before that cycle, leaving five. This is application policy, **not** a measured
Tavily free-plan ceiling or evidence that a fresh dedicated cycle cannot collect
more. No quota counter was reset and no filter was relaxed to pad the result.
The explicit local runner is available; the real 100+ acceptance remains open.

Neither sample establishes a relevant 100+ live pool or a sustainable
free-account capacity ceiling. The deterministic 100-JD engine test and the
explicit local execution alternative establish different, narrower properties.
Do not relax eligibility checks or pad results with snippets to meet the target.

A bounded health sample made ten sequential GET requests, all HTTP 200 with no
errors; client wall-time P50/P95 was 765.8/2,326.3 ms. Separate Cloudflare
whole-Worker analytics for 14:00–15:03 UTC reported 52 invocations and zero
errors, CPU P50/P95/P99 of 3.315/35.764/44.715 ms and memory P99 of 29,996,848
bytes. This mixed HTTP/Queue window is not an HTTP-only CPU measurement or
proof of Free-tier headroom or sustainable discovery throughput.

The [sanitized machine-readable evidence](evidence/p2-production.json) records
the bounded browser, document, restore, cleanup and preservation checks.
Trigger-specific Observability queries returned HTTP 403, so no HTTP-only CPU
conclusion is inferred from the mixed metrics.

P2-05 inbox receipt and P2-07's real delivery acceptance also remain open as
explained below. P2 is not fully accepted on the strength of these functional
checks alone.

## Email setup still required

Place a supported provider key and verified sender in private configuration;
never commit or paste API keys into documentation or browser settings. An owner
must explicitly authorize the test recipient and confirm receipt. The application
derives the recipient from the authenticated workspace, preserves versioned
private links, and keeps provider acceptance separate from delivered evidence.
Signed callbacks are now implemented at `/email/webhooks/resend` and
`/email/webhooks/sendgrid`, with provider verification settings separate from
sending credentials. A provider `sent`/`processed` event can fill a missing
acceptance timestamp without replacing existing API facts or a later bounce.
Only a verified delivered event sets `delivered_at`; it establishes recipient
mail server acceptance, **not inbox placement or reading**. See
[email delivery setup](email-delivery.md) for signature, replay, privacy and
retention bounds.

At this P2 release checkpoint, SMTP/Nodemailer was not implemented and provider
selection was pending. The subsequent [P3 release](p3-verification.md) implements
the selected Gmail/App Password path. Credentials and an explicitly authorized
human receipt check are still required, so **P2-05 and full P2 acceptance remain
open**. No actual email was sent during either release verification.
