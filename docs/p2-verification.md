# P2 implementation and release evidence

This work builds on P1 commit `fa07874` on `main`. It uses the existing free
Cloudflare deployment. No paid plan, R2 billing, real employer submission or
production email send is enabled by this work.

## Scope and acceptance boundaries

| Item | Implemented behavior | Evidence boundary |
| --- | --- | --- |
| P2-01 | Private resumable source/query checkpoints, bounded Queue steps, canonical deduplication, cancel/resume, actual full-JD verification, fit/geography checks, visible partial results and local persistent execution alternative | Actual workerd/D1 test collects 100 distinct synthetic full JDs and resumes a cancelled checkpoint. The live 100-target pilot retained zero listings after 11 search attempts and 62 detail-check reservations; the real 100+ pool remains unverified. Search snippets do not count. |
| P2-02 | Public ATS/static detail adapters including Ashby, shared daily reservations, per-host scheduling/cache/backoff, bounded reads, explicit restrictions and closed-job rejection | Source fixtures and current public read checks distinguish accessible, restricted and unsupported sources. Discovery support does not establish application submission support. |
| P2-03 | Evidence-backed company/career claims, estimates labelled, dated news, topic reasons, contextual distinct questions and explicit guide refresh | [Preparation evaluation](p2-preparation-quality.md) compares the same 16 known P1 cases; exact behavioral duplication falls from 87.5% to 0%. Frozen 120-case gates remain unchanged. This is not independent human or live resource-usefulness evaluation. |
| P2-04 | Owner-only versioned HTML/PDF prep guides, provenance, expiry/stale/error states, guide/report links | [Export tests and visual checks](prep-exports.md), actual PDF readers and long/Unicode examples, plus a production four-page guide with authenticated HTML/PDF downloads and anonymous denial. |
| P2-05 | Immutable queued email payloads, ownership and consent checks, bounded attachments/private links, provider-specific idempotency and uncertain-send handling | **Actual sender setup and owner inbox receipt remain blocked.** Deployed secret names contain no SendGrid/Resend key and FROM_EMAIL is a rejected placeholder. Mocked provider acceptance is not delivery proof. |
| P2-06 | Opt-in timezone-aware weekly draft discovery/planning/guides/report/reminder, pause/resume, deduplicated local weeks and durable recovery | [Scheduling policy and tests](p2-discovery-scheduler.md). It never creates submission approval or confirms an application. Scheduled email additionally requires configured provider and explicit opt-in. |
| P2-07 | Both-mode summaries/shared quota, exact resume versions, standalone guide exports, immutable emailed content and action instructions | Actual HTML/provider-payload fixtures verify content. Real inbox delivery remains P2-05's external setup dependency. |
| P2-08 | Scoped private workspace export/deletion, bounded coordinated artifact snapshots, hashes, isolated offline restore and conservative retention | Synthetic workerd/D1/private-store round trips verify ownership/history/versions and tamper rejection. A production synthetic archive has five artifacts with every hash verified. Its independent offline restore passed; scoped cleanup is tracked below. Production orphan cleanup remains disabled; no real workspace deletion is part of QA. |
| P2-09 | Explicit supported-runtime matrix, normal Python optional grounded tailoring, shared contracts and regression CI | Python support is deliberately narrower than Cloudflare for editor, refresh/export, multistep, passkeys and scheduling; unavailable features are stated rather than silently treated as parity. |

## Local verification

Release gates: **601 Worker tests, 390 Python tests and 145 frontend tests passed** (four Worker and three Python opt-in tests skipped). Typecheck and deployment dry run passed.
The Worker count includes the production resource-excerpt PDF regression and thirteen structured-location regressions added after the initial 587-test freeze.
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
| Worker | `4553fac4-4780-4f09-8f93-f456a4bf7abd` (structured geography repair); browser workflow below used PDF release `019e4986-817b-4466-8664-823d87103550`. |
| Pages | `b8c2f73e` |
| D1 schema | Ordered migrations `0013` through `0018` applied; applied migrations remain immutable. |
| Source | P2 implementation `a359653`, PDF repair `eed7ed1`, local restore persistence repair `b64f4c6`, structured geography repair `4beb13c`. |

The initial P2 implementation, PDF repair and local restore repair passed their
applicable workflows. The final deployed source `4beb13c` passed
[Cloudflare CI](https://github.com/pankajbaid567/hireflow/actions/runs/40347175473)
and [Backend CI](https://github.com/pankajbaid567/hireflow/actions/runs/40347175425).
Those gates include all 601 Worker tests, frozen evaluation, preparation
comparison, persistent local discovery/restart, isolated React/Worker/D1/file
browser E2E, frontend build, Worker dry run, Python tests and PostgreSQL
migration/rollback checks. No evaluation thresholds or frozen labels changed.

After the final source-only release, direct API health, Pages profile and the
same-origin API proxy returned HTTP 200; anonymous access to the deleted
workspace export returned HTTP 401. API CORS retains the Pages origin.

### Actual production browser and document checks

An isolated Chromium session used one disposable synthetic workspace and a
synthetic uploaded PDF. It performed the real Pages/API/Queue/private-KV flow:

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
  three PDFs. Twenty authentication/execution/scheduler/mail-authority tables
  were empty; the restore made zero network requests or production changes.

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

This sample does **not** establish a relevant 100+ live pool or a sustainable
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
Until those external steps are done, **P2-05 and full P2 acceptance remain open**.
