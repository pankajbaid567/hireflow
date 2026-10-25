# P2 implementation and release evidence

This work builds on P1 commit `fa07874` on `main`. It uses the existing free
Cloudflare deployment. No paid plan, R2 billing, real employer submission or
production email send is enabled by this work.

## Scope and acceptance boundaries

| Item | Implemented behavior | Evidence boundary |
| --- | --- | --- |
| P2-01 | Private resumable source/query checkpoints, bounded Queue steps, canonical deduplication, cancel/resume, actual full-JD verification, fit/geography checks, visible partial results and local persistent execution alternative | Actual workerd/D1 test collects 100 distinct synthetic full JDs and resumes a cancelled checkpoint. Live results and configured-account capacity are measured separately; search snippets do not count. |
| P2-02 | Public ATS/static detail adapters including Ashby, shared daily reservations, per-host scheduling/cache/backoff, bounded reads, explicit restrictions and closed-job rejection | Source fixtures and current public read checks distinguish accessible, restricted and unsupported sources. Discovery support does not establish application submission support. |
| P2-03 | Evidence-backed company/career claims, estimates labelled, dated news, topic reasons, contextual distinct questions and explicit guide refresh | [Preparation evaluation](p2-preparation-quality.md) compares the same 16 known P1 cases; exact behavioral duplication falls from 87.5% to 0%. Frozen 120-case gates remain unchanged. This is not independent human or live resource-usefulness evaluation. |
| P2-04 | Owner-only versioned HTML/PDF prep guides, provenance, expiry/stale/error states, guide/report links | [Export tests and visual checks](prep-exports.md), actual PDF readers and long/Unicode examples. |
| P2-05 | Immutable queued email payloads, ownership and consent checks, bounded attachments/private links, provider-specific idempotency and uncertain-send handling | **Actual sender setup and owner inbox receipt remain blocked.** Deployed secret names contain no SendGrid/Resend key and FROM_EMAIL is a rejected placeholder. Mocked provider acceptance is not delivery proof. |
| P2-06 | Opt-in timezone-aware weekly draft discovery/planning/guides/report/reminder, pause/resume, deduplicated local weeks and durable recovery | [Scheduling policy and tests](p2-discovery-scheduler.md). It never creates submission approval or confirms an application. Scheduled email additionally requires configured provider and explicit opt-in. |
| P2-07 | Both-mode summaries/shared quota, exact resume versions, standalone guide exports, immutable emailed content and action instructions | Actual HTML/provider-payload fixtures verify content. Real inbox delivery remains P2-05's external setup dependency. |
| P2-08 | Scoped private workspace export/deletion, bounded coordinated artifact snapshots, hashes, isolated offline restore and conservative retention | Synthetic workerd/D1/private-store round trips verify ownership/history/versions and tamper rejection. Production orphan cleanup remains disabled; no real workspace deletion is part of QA. |
| P2-09 | Explicit supported-runtime matrix, normal Python optional grounded tailoring, shared contracts and regression CI | Python support is deliberately narrower than Cloudflare for editor, refresh/export, multistep, passkeys and scheduling; unavailable features are stated rather than silently treated as parity. |

## Local verification

Frozen local gates: **587 Worker tests, 390 Python tests and 145 frontend tests passed** (four Worker and three Python opt-in tests skipped). Typecheck and deployment dry run passed.
Also verified: the frozen 120-case evaluation, 16-case preparation comparison,
actual isolated React/Worker/D1/private-file browser workflow, Cloudflare build,
Worker dry run, and a local discovery CLI process restart with durable D1 state.

The local CLI fixture performs six separately rotated searches and one complete
detail verification, writes private full-JD JSON, and reopens the same on-disk
checkpoint without new provider calls. Offline fixtures reject all network calls
outside their controlled adapters. CI runs both the first process and resume.

## Production release

Production publication and the synthetic P2 workflow are pending the final
source freeze. This document must not be read as evidence of an unpublished
release. Exact Worker/Pages IDs, migration list, QA result, measured discovery
counts and cleanup verification are recorded here after successful verification.

## Email setup still required

Place a supported provider key and verified sender in private configuration;
never commit or paste API keys into documentation or browser settings. An owner
must explicitly authorize the test recipient and confirm receipt. The application
derives the recipient from the authenticated workspace, preserves versioned
private links, and keeps provider acceptance separate from delivered evidence.
Until those external steps are done, **P2-05 and full P2 acceptance remain open**.
