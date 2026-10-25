# P1 implementation and release verification

The P1 source builds on P0 commit `358510a`. The first P1 implementation was
published as `bd6fff2`; the final queued-plan release passed production verification on 25 October 2026.
This file distinguishes implemented behavior, controlled tests and actual
production evidence. It does not certify arbitrary employer portals or complete
all original milestones.

## Implemented scope

| Item | Behavior and evidence |
| --- | --- |
| P1-01 | Versioned 120-case synthetic benchmark; frozen development/heldout split and adoption gates; extraction, copied-fact selection, adversarial recovery, JD-question context/duplication and controlled source support. Heldout hybrid nDCG@3 0.9511 vs lexical 0.6991. See [evaluation](ai-evaluation.md). |
| P1-02 | Genuine BGE CLS embeddings in the normal Worker plan path, private model/profile/full-JD versioned D1 cache, hard daily text allowance and lexical fallback. Python normal plans integrate optional genuine BGE/FAISS separately. No FAISS-on-Workers claim. |
| P1-03 | Structured compensation, experience, skills, canonical/application URL, source, posting/expiry, selection text, provenance and explained quality rules across schema, extractors, APIs, UI and reports. Source/fact versions revoke stale reviews; guarded writes reject stale scores/PDFs and clean orphan files. |
| P1-04 | All-time employer exclusion after known submissions, normalized identities plus explicit private aliases, conservative uncertain-write handling, no substring collision or automatic reapplication window. Confirmed listing snapshots preserve historical facts, including explicit unknown values. |
| P1-05 | Actual source-specific Internship and Job searches, verified full detail pages and truthful restricted/empty diagnostics; public opportunities remain unsubmitted during QA. Detailed release results belong in [acceptance](p1-acceptance.md). |
| P1-06 | Both modes, exact PDF/answer review, controlled Browser Run, shared weekly quota, immutable history, preparation/report/library, mobile and logout. Failure/race cases have separate real D1/local Chromium coverage; see release result below. |
| P1-07 | [Architecture](architecture.md), [clean setup](fresh-setup.md), isolated clean dependency/migration evidence, actual secret-free PostgreSQL/Docker application cycle and [demo](demo.md). A new physical laptop/account is not claimed. |
| P1-08 | Source-fact extraction and visual/reader checks on 16 generated PDFs/19 pages, long/multicolumn/sparse/URL/Latin/Devanagari examples, actual three-PDF Gemini probes and bounded Unicode rendering. [PDF evidence](p1-pdf-quality.md). Text-based extraction is distinct from OCR. |
| P1-09 | Profiling, private telemetry, batched account/editor/report reads, versioned queued score/PDF work, bounded source parsing, durable queued discovery and queued maintenance. Actual release CPU must be interpreted by fetch/queue/scheduled trigger, not combined indiscriminately. [Capacity evidence](p1-capacity.md). |

## Checks and evidence boundaries

Corrected local gates: **470 Worker tests, 373 Python tests and 127 frontend tests
passed**; four Worker and three Python opt-in live tests were skipped. Typecheck,
Worker dry run, Cloudflare frontend build, actual isolated React/Worker/D1/R2
browser E2E and the 120-case evaluation passed. The separate Docker check used
PostgreSQL migration 005, a non-root API user and actual in-container Chromium;
all provider keys were blank. [Sanitized Docker proof](evidence/p1-docker-cycle.json).

All three GitHub workflows passed for `bd6fff2`, including PostgreSQL migration
upgrade/rollback/reupgrade/check, PDF reader tests and isolated browser E2E. The
corrected source requires its own passing CI before release closure.

Benchmark labels are repository-authored synthetic judgments, not independently
human-reviewed hiring outcomes. Actual provider token/billing totals are not
known. Controlled citation grounding does not measure live resource usefulness;
behavioral fallback duplication remains a measured preparation weakness.
Production email, 100+ listing cycles, authenticated portal adapters, OCR and
Python editor/multistep parity remain separate P2/P3 work.

## First production run and correction

The 23 October run `bd0e4e7807ac` used Worker
`d9634e84-a645-4833-8da3-b091492f0e73` and Pages `cdc2de6a`. It verified five
Internship JDs (Internshala 1, Wellfound 3, Greenhouse 1) and five Job JDs
(Greenhouse 4, Lever 1). LinkedIn restrictions, empty Lever/Internship and empty
Naukri/Job results remained visible; each named source received one separate
search. Genuine hybrid matching and approved PDFs were exercised.

Both owned QA forms reached `applied`. Internship took one attempt; Job had a
sanitized temporary browser/network failure before submission and recovered on
its second attempt. The test stopped on its overly strict `attempts == 1`
assertion, so that run **does not establish mixed-report/mobile/logout completion
or a complete recorded demo**. Its failure proof and diagnostic history remain
unchanged. The corrected harness accepts 1–3 audited attempts, requires exactly
one applied event and reasoned retry transitions, and still guards exactly two
owned confirmations. It does not force product retries off to make a test pass.

Actual first-cycle HTTP CPU P95/P99 **28/108 ms** exceeded the Workers Free HTTP
allowance. Read-only CPU P95 5.989 ms was not a substitute for the application
cycle. Discovery now starts with a private 202 ticket and executes heavy public
parsing/scoring in the Queue; the UI polls private status. Five-minute Cron only
enqueues bounded maintenance. Queues have their separately documented CPU
allowance; no plan or browser/provider budget was raised.

## Corrected production release

The final release is **Worker `d3848a38-6007-41bf-8112-7a228a3a101d`**,
source **`595f68e`**, D1 migrations through **`0012`**, and Pages UI `85755cd9`.
The subsequent Pages artifact publication **`c11dc0d8`** adds the reviewed demo without changing
application JavaScript/CSS or the API Worker.

Fresh run **`83836557fce3`**, 25 October **10:34:49.314–10:40:46.454 UTC**, passed
normal PDF-only signup, editable facts, Internship and Job source searches,
actual queued BGE matching/PDF preparation, immutable PDF review/edit/comparison,
two reviewed owned-form submissions, both prep guides, mixed-week HTML report,
shared quota/no reset, unchanged historical PDF, mobile and logout/private 401s.
Both QA applications reached `applied` in **one attempt**; exactly two guarded
confirmations, zero browser errors and zero employer/email submissions.
Gemini extraction used the actual configured `gemini-3.5-flash-lite` fallback.

Internship searches verified **3** full JDs (Internshala 1, Wellfound 2);
Greenhouse/Lever were empty and LinkedIn restricted. Job searches verified **5**
(Greenhouse 3, Lever 2); Naukri was empty and LinkedIn restricted. Each of the
five/four named sources received one separate real search. Empty/restricted rows
were displayed accurately. [Sanitized production proof](evidence/p1-production.json).

The exact release window measured **120 product API fetches** with native
invocation-log CPU **P50/P95/P99 3/9/10 ms**, maximum **14 ms** from one signup.
Excluding six unrelated cheap probes leaves the same quantiles. Fourteen Queue
invocations had CPU P95 444 ms, within their separate allowance. Whole-Worker
GraphQL recorded **153 invocations, zero runtime errors**, and isolate memory
P99 **38,526,844 bytes**. Counts/precision differ by telemetry source; no Cron CPU
group was available. [Capacity proof](evidence/p1-capacity.json).

This closes P1-09 for the measured **single active interactive workflow**; it
is not an all-requests-below-10-ms guarantee, concurrent/sustained-load result or
large/complex-input capacity claim. The signup outlier and earlier failing
28/108- and 18/22-ms HTTP tails remain documented. No paid tier, allowance reset
or extra sampler traffic made the result pass.

[Watch the 4:45 captioned production demo](https://hireflow-dashboard.pages.dev/assets/hireflow-p1-demo.webm).
Its complete ordered recording is uniformly time-scaled; it is not a latency
benchmark. Privacy and native-PDF/report/mobile frame reviews passed.

Scoped cleanup removed synthetic owners **17–20**, six unreferenced owned QA
jobs and twenty private QA objects. Verified public jobs were retained. The real
owner's 11 applications, 11 resume versions and 12 private file hashes matched
before/after each cleanup. Actual browser/semantic usage and signup throttles
were preserved. [Sanitized cleanup proof](evidence/p1-cleanup.json).

Core release CI for `595f68e` passed [Backend](https://github.com/pankajbaid567/hireflow/actions/runs/40185275102)
and [Cloudflare](https://github.com/pankajbaid567/hireflow/actions/runs/40185275066).
Frontend-only CI correctly did not trigger for unchanged frontend files; its
applicable `c2e1647` workflow passed. Subsequent artifact/documentation commits
use the same applicable workflows; [current branch checks](https://github.com/pankajbaid567/hireflow/actions?query=branch%3Amain)
record their actual status. [Publication proof](evidence/p1-publication.json) verifies
the final anonymous browser, unchanged application assets, API health and exact public-video SHA-256.
