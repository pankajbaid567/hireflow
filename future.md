# HireFlow: remaining work and future roadmap

Updated: **27 October 2026 (IST)**. P0 and P1 are published within their documented scopes; [P2 verification](docs/p2-verification.md) records the new release and remaining acceptance.

This is the prioritized backlog for finishing the original project, improving its AI and engineering quality, and considering new capabilities. **Checked items have the scoped implementation/evidence linked below; unchecked items remain pending.** P1 completion is distinct from completing every original milestone or certifying arbitrary employer portals.

Sources: [original milestones](MILESTONES.md), [expectation-versus-reality audit](docs/milestone-audit.md), [current application](README.md), and [Cloudflare deployment and limits](docs/cloudflare.md). The audit contains the detailed evidence; this file describes what to do next.

## Current baseline

- The live dashboard is [Cloudflare Pages](https://hireflow-dashboard.pages.dev); its backend is the [API Worker](https://hireflow-api.baidpankaj567.workers.dev/health), using D1, private KV documents, Queues and Browser Run. The Python/FastAPI/PostgreSQL application is a separate local/container implementation.
- PDF intake, rich profile editing, reviewed plans, swaps, company blacklisting, private versioned PDFs, application history, prep guides and weekly HTML reports have working paths.
- Discovery makes **five separate searches in Internship mode** and **four in Job mode**, using private durable Queue tickets and UI polling. Both modes have actual source-specific production evidence; restricted/empty sites remain visible. Quick searches are bounded to eight verified full JDs each. P2 larger cycles separately rotate six Internship/five Job sources (including Ashby), with resumable search/detail reservations and a persistent local option; a real relevant 100+ pool is not demonstrated.
- Deployed matching uses genuine BGE CLS embeddings with private versioned D1 vectors, preserves six-factor weights/explanatory gaps and falls back lexically. Python normal plans optionally use genuine BGE/FAISS. The frozen 120-case synthetic benchmark has heldout hybrid nDCG@3 0.9511 vs lexical 0.6991; labels are not independent hiring outcomes. Model matching and PDF preparation run in bounded versioned Queue work on production.
- Both-mode production UI acceptance has exercised real PDF extraction/search/embeddings, two reviewed owned-QA submissions, preparation, a mixed-mode report, shared quota, immutable PDFs, mobile and logout. Exact release and CPU results are in the verification documents. This does not certify real employer portals. Opt-in timezone-aware draft scheduling, reminders and pause/resume are now implemented. Real email sender configuration/inbox receipt remains incomplete; schedules never authorize submissions.
- Current local gates are **407 Python, 774 Worker and 157 frontend tests**, with typecheck and the Worker deployment dry run passing. The frozen 120-case AI evaluation and 16-case preparation comparison pass. Isolated React/browser E2E and actual secret-free PostgreSQL/Docker integration have separate evidence. GitHub CI separately verifies migrations/rollback, readers, evaluation and builds. Functional test counts alone do not establish AI quality.

## Priority and tracking rules

| Priority | Meaning | Work order |
| --- | --- | --- |
| **P0** | User trust, safe review/submission, recovery and operation | Address before expanding public usage or promising broader automation. |
| **P1** | Core acceptance gaps and measurable AI quality | Finish after the relevant P0 dependencies; these give the largest product and AI-portfolio improvement. |
| **P2** | Scale, remaining delivery/preparation features and maintainability | Extend the verified core while respecting account budgets. |
| **P3** | Optional module or research experiments | Start after the required candidate workflow is reliable. |

Item types: **Remaining** = an unfinished original requirement; **Verification** = evidence still needed; **Improvement** = hardening or quality beyond the current baseline; **Decision** = a scope/architecture choice that must be documented. Dependencies refer to item IDs. Check an item only after its completion criteria have evidence.

Priority expresses importance, not a completion-time promise. Provider credentials, sender/domain setup, account entitlements and third-party accessibility may block specific integrations. No item authorizes paid infrastructure or external application/email delivery by itself.

## P0 — user trust and reliable operation

**Completed for the Cloudflare application**, with Python ownership/recovery also secured. [P0 verification](docs/p0-verification.md) links behavior, tests and production evidence. Public native ATS-shaped fixtures establish conditional support; they do not certify real employer portals.

### P0-01 — Verified account recovery and ownership

- [x] **Improvement / Verification · M1, M8:** Add a verified sign-in/recovery flow for an expired/lost session and another device. Preserve the existing secure cookie ownership and single-use migration protections; an email address or numeric profile ID alone must not grant access.
- **Done when:** an owner can recover the same workspace on a new browser, revoke sessions and log out; expired/replayed recovery links and cross-user access to profiles, resumes, guides and reports fail in integration tests.
- **Implemented choice:** Cloudflare supports user-verified passkeys and single-use recovery keys; Python now enforces cookie ownership and supports recovery keys, with passkeys explicitly unavailable. Email ownership is not asserted. Full Python/Worker feature parity remains P2-09.

### P0-02 — Per-opportunity resume edit, reject and reapproval

- [x] **Remaining · M4, M8; issues 24–25:** Add an editor for each planned resume, a clear reject/regenerate action, a comparison with its previous version and explicit review of the final version.
- **Done when:** edits create immutable versions; a profile, resume or material JD change invalidates the old approval; confirmation submits exactly the version the user reviewed. Rejected drafts cannot be submitted. Existing historical applications retain their original PDF.
- **Product decision:** retain preview generation **before** “Confirm and Apply,” as required by issue 24. Document the conflict with M4's older wording instead of claiming both timing rules are satisfied.

### P0-03 — Portal compatibility and durable multi-step forms

- [x] **Remaining / Verification · M5:** Extend the existing shared form engine with explicit portal adapters, beginning with permitted public Greenhouse/Lever forms. Add step detection, required-answer validation, a final review gate and safe checkpoints for multi-page applications; retain the existing file-upload support.
- **Done when:** a controlled four-step form can recover from a pre-submission failure without losing approved facts or duplicating submission; expired jobs, login walls, CAPTCHA, unknown required questions and uncertain submission outcomes produce specific manual instructions. Publish a compatibility matrix that distinguishes discovery, JD verification, form filling and submission.
- **Verification boundary:** use owned forms and sanctioned test environments. Real employer submission requires the user's explicit authorization for that opportunity; searching a portal does not provide it. Internshala login flows and LinkedIn Easy Apply are separate, currently unsupported integrations. Do not attempt CAPTCHA solving or bypass access restrictions.

### P0-04 — Provider degradation and actionable recovery

- [x] **Improvement · M1, M4–M6:** Improve the existing visible fallback with a bounded, user-triggered retry/regeneration flow, clear readiness/error states and provider health information. Recheck configured model availability through opt-in diagnostics rather than assuming a model name remains valid forever.
- **Done when:** 429s, timeouts, unavailable models and malformed responses are distinguishable; retry limits prevent expensive loops; regenerated PDFs require review. No failed extraction silently saves an empty profile, and no missing experience or answer is invented. Test recovery with both Groq and Gemini outages.
- **Existing behavior to retain:** the saved-profile check produced nine ready PDFs, with three provider-selected drafts and six explicit deterministic fallbacks. Fallback is already implemented; reducing its frequency and improving recovery are the work here.

### P0-05 — Production capacity, cost visibility and alerts

- [x] **Improvement / Verification · M2, M5, M8:** Measure representative Worker CPU/memory, queue wait, browser usage, provider latency, failures and per-cycle consumption. Add redacted correlation IDs and actionable alerts for repeated failures, stuck work and exhausted budgets.
- **Done when:** a repeatable load check reports percentiles and relevant failures, and the UI explains budget exhaustion without claiming success. Existing atomic claims, browser spacing, idempotency and no-repeat-after-uncertain-submit protections remain intact.
- **Remaining M5 detail:** expose and verify configurable delays between submissions within provider minimum spacing and daily budgets; configuration must not allow those safeguards to be disabled.
- **Constraint:** the current conservative application budget permits at most nine browser reservations/day; a quota of ten is not a promise of ten automatic applications in one day. Measure sustainable capacity before increasing limits. Keep credentials, PDF contents and session tokens out of telemetry; do not enable paid plans automatically.

### P0-06 — Answer review and queued-application cancellation

- [x] **Improvement · M4, M5, M8:** Let users review generated free-text answers alongside the selected PDF and cancel an authorized application before execution starts. Bind approved answers and the resume version to the authorization; protect against instructions embedded in an external JD/form changing the permitted task or exposing private facts.
- **Done when:** queued cancellation is atomic against worker claims; editing an answer requires reapproval; unknown eligibility, work-authorization, availability or sensitive answers require user input. After execution/submission may have started, display an accurate state and reconciliation instructions instead of falsely promising the external application was withdrawn.
- **Preserve:** existing no-repeat-after-uncertain-submission behavior. A local cancel action cannot undo an application already accepted by an employer.

## P1 — complete the core and demonstrate AI quality

### P1-01 — Labeled AI evaluation suite

- [x] **Improvement · M1, M3, M4, M6:** Build a versioned, consent-safe dataset of profiles, PDFs, JDs, rankings, resume selections and preparation outputs. Include India-specific compensation, fresher/experienced profiles, ambiguous skills, short JDs, unavailable providers and adversarial instructions in external text.
- **Done when:** a documented evaluation set, ideally 100+ representative cases, measures extraction accuracy, unsupported/fabricated claims, fact preservation, ranking relevance, question specificity, source support, latency and cost. Keep development and held-out evaluation data separate. Publish error analysis and compare changes against the current baseline; counts of passing functional tests alone do not satisfy this item.
- **Evaluation controls:** set justified quality thresholds before changing the implementation. Combine deterministic checks and a reviewed human rubric; an LLM judge alone is insufficient evidence of factual correctness.
- **Evidence:** Versioned 120-case corpus, frozen adoption gates, real model provenance, extraction/factuality/source-support/question-context/duplication metrics and authored review rubric are published in [AI evaluation](docs/ai-evaluation.md). Independent human ratings, actual billing totals and live resource usefulness remain explicitly unmeasured.

### P1-02 — Embeddings and hybrid matching in the actual plan path

- [x] **Remaining / Improvement · M3:** Connect profile/JD embeddings and retrieval to normal plan generation. Integrate the existing FAISS helper into the Python path; choose a separately compatible vector-storage/retrieval design for Workers rather than pretending FAISS runs in the deployed Worker.
- **Done when:** saved vectors are versioned by model/profile/JD, updates invalidate stale results, and the UI's ranking actually uses the retrieval output. Compare lexical, semantic and hybrid ranking on held-out relevance labels using Recall@K and nDCG, with latency/cost measurements. Adopt the more complex approach only if results justify it.
- **Preserve:** the documented six-factor weights, deterministic tie-breaking, explanatory skill gaps and a lexical fallback. A similarity score is not a calibrated hiring probability.
- **Depends on:** P1-01; a cost/capacity decision for any external embedding or vector service.
- **Evidence:** Workers AI BGE CLS/private D1 and optional Python BGE/FAISS normal-plan integration, heldout ranking comparison, invalidation/budgets and actual provider/route evidence are in [AI evaluation](docs/ai-evaluation.md).

### P1-03 — Complete listing schema and reliable fit signals

- [x] **Remaining · M2, M3:** Persist source, canonical application URL, required skills, required experience, posting/expiry dates, selection process and structured compensation. Represent missing information explicitly and retain evidence/provenance instead of turning inferred values into facts.
- **Done when:** schema migrations, all supported extractors, APIs and reports agree on these fields. Normalize INR/LPA, monthly/annual amounts, ranges, other currencies and undisclosed pay; compare against the correct internship stipend or job salary preference without using unrelated JD numbers. Test role, location, experience and company signals on labeled cases.
- **Python extraction gap:** ensure generic/static scrapers persist a real full JD instead of a placeholder description; snippets and empty descriptions cannot qualify as complete verified listings.
- **Related quality work:** connect spam/quality filtering to normal persistence, store an explained confidence score, and evaluate false positives on legitimate small startups. Clarify what company quality actually measures.
- **Evidence:** D1 migrations 0008–0012 / Alembic005, shared pay contracts, full-detail extraction, explained risk rules, API/UI/report facts and stale-write safeguards are implemented; see [P1 verification](docs/p1-verification.md).

### P1-04 — Company-wide prior-application exclusion

- [x] **Remaining · M4:** Prevent future drafts for an already-applied company according to a documented company-level policy, beyond the existing user/job duplicate protection and explicit blacklist.
- **Done when:** normalized company identities/aliases handle different postings from the same employer, historical applications remain unchanged, and tests cover similarly named unrelated companies. Define how failed/manual-action attempts, reapplications and time windows affect eligibility instead of silently guessing.
- **Evidence:** Normalized identities, explicit private aliases, all-time known-submission exclusion, conservative uncertain-write policy and immutable historical snapshots have real D1/Python regressions; see [company policy](docs/architecture.md#lifecycle-and-authorization).

### P1-05 — Live Job-mode discovery verification

- [x] **Verification · M2, M8:** Run the equivalent production UI discovery check in Job mode for Naukri, LinkedIn, Greenhouse and Lever, with real source-specific calls and retained sanitized evidence.
- **Done when:** accepted active JDs, canonical URLs, source diagnostics, duplicate handling, filters and correct mode are verified through the UI. Restricted/empty sources must remain visible; do not fabricate a Naukri success to complete the matrix. This check must not submit any application.
- **Existing evidence:** the five-source Internship path is already production verified. Named source configuration and local Job-mode fixtures do not prove live Job-mode results.
- **Evidence:** Actual two-mode source-specific UI search evidence, including empty Naukri and restricted LinkedIn rather than fabricated imports, is recorded in [production acceptance](docs/p1-acceptance.md).

### P1-06 — Complete acceptance scenarios for both modes

- [x] **Remaining / Verification · M1–M8:** Exercise each mode from intake through real discovery, ranking, reviewed PDFs, controlled application, preparation and report, and verify an explicit mixed-mode week. Add failure scenarios for stale profiles/approvals, partial batches, CAPTCHA, provider/search failure, budget exhaustion and interrupted work.
- **Done when:** evidence identifies exactly which stages used real providers and which used controlled forms; quota accounting, status trails and private document versions remain correct. A complete run must not be inferred by combining unrelated passing unit tests. Real-source discovery must not cause an employer submission during QA.
- **Depends on:** relevant P0 work, P1-05 and P2-07 for the mixed-mode report acceptance case.
- **Evidence:** Complete both-mode production UI acceptance plus separate failure/race coverage and shared-week quota/history checks are recorded in [production acceptance](docs/p1-acceptance.md). Final queued-plan release results are linked there after execution.

### P1-07 — Architecture, reproducible setup and honest demo

- [x] **Remaining / Decision · M1, M8:** Add `docs/architecture.md`, a 3–5-minute demo with `docs/demo.md`, and a fresh-machine walkthrough. Explain Pages/Worker/D1/KV/Queues versus Python/FastAPI/PostgreSQL, actual agent boundaries, data flow, review state and failure handling.
- **Done when:** a clean environment can follow the maintained setup instructions, install the required Python dependencies and Chromium, migrate its database and run the documented checks. Verify the Cloudflare account bootstrap separately from the local Docker path, and keep resource IDs/account configuration environment-specific.
- **Documentation cleanup:** reconcile older local-oriented instructions such as `docs/workflow.md` with the live deployment, preserve historical evidence as historical, and remove unsupported architecture claims. Queue/outbox orchestration is currently real; a working LangGraph `StateGraph` is not. Choose whether an evaluated graph implementation is actually needed instead of adding a framework solely for resume keywords.
- **Evidence:** [Architecture](docs/architecture.md), [clean environment and actual Docker evidence](docs/fresh-setup.md) and [demo evidence](docs/demo.md) are delivered. Same-host isolated installation, fresh CI runners and a container build are distinguished from an independently provisioned physical laptop/account.

### P1-08 — Resume extraction and rendering coverage

- [x] **Improvement / Verification · M1, M4:** Expand the quality corpus for long/multi-column resumes, unusual layouts, sparse profiles, links and non-ASCII names/content. Improve Unicode/font support where the current PDF renderer is limited, while retaining complete facts, readable wrapping and explicit size/content bounds.
- **Done when:** extracted facts and selected resume facts are checked against the source; rendered pages have no clipping, missing sections or broken links across representative PDFs. Distinguish text-based extraction from OCR support rather than silently claiming scanned PDFs work. Regression evidence should include visual inspection and machine-readable text checks.
- **Evidence:** 16 artifacts/19 rendered pages, source/fact/URL/bounds checks, visual inspection, Latin/Devanagari support and actual Gemini PDF extraction probes are recorded in [PDF quality](docs/p1-pdf-quality.md). OCR and arbitrary scripts remain separate.

### P1-09 — Reduce measured Worker CPU tail

- [x] **Improvement / Verification · M8:** Profile the deployed account, PDF/review, plan and telemetry paths, reduce avoidable CPU and repeat a representative load sample. The first post-P0 window had no invocation errors but CPU P95/P99 of 14.581/24.715 ms exceeded the published Free 10 ms HTTP allowance; occasional platform flexibility is not sustainable headroom.
- **Done when:** measured route/cycle percentiles and failure rates justify the documented free-tier usage envelope. Retain bounded work, private telemetry and safe manual handoff; do not activate paid infrastructure automatically. [Measured evidence](docs/p0-operations.md#post-deployment-sample).
- **Evidence:** Final real two-mode release measured 120 product API fetches with CPU P50/P95/P99 3/9/10 ms, one 14 ms signup outlier, zero native runtime errors and bounded memory. Heavy discovery/matching/PDF/maintenance use the Queue allowance. This validates a small single-workflow envelope, not sustained/concurrent or worst-case input capacity. [Measured evidence](docs/p1-capacity.md), [portable aggregates](docs/evidence/p1-capacity.json).

## P2 — scale discovery and finish delivery/preparation features

**Release status (2026-10-26):** Core implementation is published on the free Cloudflare deployment. [Release, production-browser and recovery evidence](docs/p2-verification.md) records what was actually verified. P2-02's documented public-source scope, P2-03, P2-04, the non-email P2-06 workflow, P2-08 and P2-09 are implemented and verified within their bounds. P2-01's real 100+ pool, P2-05's real inbox receipt and P2-07's delivery acceptance remain open. Arbitrary authenticated/dynamic portals are not certified. A passing mocked or synthetic test does not close an unmet live acceptance condition.

### P2-01 — Background discovery and a measured 100+ pool

- **Now shipped:** bounded durable discovery tickets plus private resumable query/source checkpoints, atomic attempt reservations, source rotation, full-JD verification, deduplication, progress, cancellation/resume and explicit persistent local execution. Tavily query variants are not advertised as provider pagination.

- [ ] **Acceptance still open · M2:** Demonstrate the real relevant 100+ pool with measured source/mode/geography precision. The engine passes an actual workerd/D1 100-distinct-synthetic-JD test and local process-restart tests. The first live pilot made 11 search attempts / 62 detail-check reservations and retained zero listings; its checkpoint was explicitly cancelled. A false geography rejection was repaired. A later real production cycle imported three verified listings and one Internshala opportunity completed the plan/PDF/preparation/report browser workflow; remaining LinkedIn candidates encounter HTTP 429. These checks do not establish the 100+ live pool. See [discovery policy and local alternative](docs/p2-discovery-scheduler.md).
- **Done when:** a cycle demonstrates 100+ distinct, active, sufficiently complete relevant listings with source/mode/geography precision measurements, not 100 search snippets or repeated records. Respect provider and per-domain budgets and preserve partial results on failures.
- **Depends on:** P0-05, P1-03 and P1-05. If that throughput is not sustainable on the configured free accounts, document the measured limit and offer explicit local execution or a separately approved infrastructure choice.

### P2-02 — Portal adapters, career pages and shared rate limits

- [x] **Implemented / verified within documented public-source scope · M2, M5:** Public Ashby/Greenhouse/Lever APIs, static/JSON-LD pages, Internshala/Wellfound detail parsing, source failure states, shared daily budgets, per-host scheduling/cache/backoff and metadata regression fixtures are shipped. The bounded [JavaScript source reader](docs/dynamic-sources.md) passes Chromium/D1 tests and an actual Cloudflare Queue/Browser Run probe, with native resource reads and shared limits enforced. Production initially permits only the owned fixture host; new external hosts require explicit access validation/configuration. [Source coverage and actual read checks](docs/p2-source-adapters.md) distinguish current detail evidence, empty/restricted sources and landing-only observations. Authenticated portals remain unsupported; neither a successful fixture nor landing-page availability certifies an external individual JD.
- **Done when:** each supported source has a fixture suite, documented field coverage and a current live read-only check. A failure on one portal leaves other sources usable. Keep login-required, restricted and inaccessible states explicit; follow permitted APIs/access rules rather than assuming every portal exposes an accessible feed.
- **Depends on:** P0-03 for applying support. An adapter that only reads JDs must not be advertised as automatic application support.

### P2-03 — Better preparation and company evidence

- [x] **Implemented / verified with explicit fallbacks · M6; issues 17–19:** Fetch accessible company/career evidence, label predicted rounds as estimates, improve strong/moderate/gap analysis, validate 2–3 useful resources per supported topic and produce 5–10 JD-specific questions across the required categories when evidence/budgets permit.
- **Done when:** outputs are distinct per JD and mode, resources are checked and attributed, recent news has a valid date within the required window, and stage/team/stack/review claims distinguish sourced facts from estimates. Evaluate relevance and duplication using P1-01, not JSON shape alone.
- **Evidence:** [16-case preparation comparison](docs/p2-preparation-quality.md), frozen 120-case regression and production guides with cited evidence and visible warnings. The final real-opportunity check generated eight JD-specific questions with ten explicit evidence/budget warnings, and verified all questions in the exact private four-page export. Known-case behavioral duplication fell from 87.5% to 0%; independent human relevance/resource-usefulness evaluation is not claimed.
- **Fallback rule:** when links/reviews or model output are unavailable, retain clear warnings and useful guidance. Never invent reviews, interview rounds, citations or extra questions just to meet a count; track these shortfalls as acceptance limitations.

### P2-04 — Standalone preparation exports

- [x] **Implemented / production verified · M6:** Generate a private per-listing HTML/PDF guide with rounds, topics, working resource links, questions, company evidence and generation time.
- **Evidence:** Owner-only immutable export versions, expiry/stale/failure behavior and real PDF-reader tests; production four-page PDF and HTML linked from the weekly report, with anonymous access denied. See [exports](docs/prep-exports.md) and [release evidence](docs/p2-verification.md).
- **Done when:** the artifact is saved/versioned and linked from the guide, library/report where appropriate; authorization and expired/deleted artifact behavior are tested. A weekly report that merely links to the React guide does not satisfy this export requirement.

### P2-05 — Configure and verify email delivery

- [ ] **Blocked on external sender setup / receipt · M7; issue 21:** Configure a real supported provider and verified sender, then verify HTML reports, up to ten resume attachments, oversized-attachment link fallback and delivery timestamps/failure reasons.
- **Done when:** an explicitly authorized test to an owner-controlled address confirms receipt; retry/idempotency controls prevent duplicate delivery; links preserve document privacy and have an appropriate authenticated or expiring access design. Mocked provider success is not delivery proof.
- **Implementation shipped:** immutable queued payloads, owner-derived recipient, attachment/link bounds, exact document versions, provider-specific idempotency/uncertain-send recovery and signed Resend/SendGrid receipt handling pass 59 isolated tests. The UI distinguishes API acceptance, signed recipient-mail-server delivery and actual inbox confirmation. No real send is claimed; supported-provider keys are absent. [Free Resend self-demo setup](docs/email-delivery.md#setup-and-current-evidence) needs no purchased domain when sending only to the Resend account's own inbox. Gmail + Nodemailer is now implemented with a credential-free native TLS/EHLO check; actual authenticated delivery/inbox receipt still requires private credentials and explicit authorization.
- **Dependencies:** provider key, verified sender/domain as required, account quotas and P0-01 where authentication is needed. Do not send to applicants, employers or other recipients during ordinary testing.

### P2-06 — Consent-preserving weekly scheduler

- [x] **Implemented / non-email workflow verified · M7:** Schedule discovery, draft planning, review reminders, preparation/report generation and optional opted-in report delivery with user timezone, per-cycle deduplication and durable recovery. Weekly reports/email are explicit commitments; a complete autonomous scheduler, timezone controls and pause/resume are additional workflow scope rather than literal M7 acceptance criteria.
- **Done when:** missed/duplicate ticks, restarts, provider outages, timezone/week boundaries and quota rollover are tested. Scheduled work may prepare and remind; only a valid review/confirmation can authorize the exact submitted opportunities/resume versions. Provide pause/resume controls and visible next-run state.
- **Evidence:** [Timezone/lease/recovery and consent policy](docs/p2-discovery-scheduler.md), actual scheduling-stage tests, and production UI opt-in/pause/next-run/mobile checks. Real scheduled email remains unavailable until P2-05 is configured; no application approval is created by a schedule.
- **Depends on:** P0-02, P0-05, P2-01 and P2-05 for email scheduling.

### P2-07 — Mixed-mode and delivery-complete reports

- **Now shipped:** mixed-week Internship/Job grouping, shared UTC-week quota/no reset, immutable resume versions, private standalone guide exports, HTML summaries/action instructions and matching immutable provider-payload fixtures. Production HTML links were verified. Real inbox delivery remains P2-05's external dependency; this entire item is not checked off.

- [ ] **Delivery acceptance still open · M7, M8:** Verify an explicitly authorized real mixed-mode report in the owner inbox, including authenticated exact-version links and delivery/failure timestamps. Existing mode-switch/shared-quota rules, summaries and HTML/provider-payload content are covered by tests; provider acceptance is not proof of delivery.
- **Done when:** mixed statuses and both listing types appear with the correct PDF/guide links, compensation units, failure reasons and manual instructions. Verify mode-specific and overall summaries, HTML rendering and emailed content. Explicit policy must prevent mode switching from accidentally resetting consumed quota.

### P2-08 — Backup, restore, retention and migration lifecycle

- [x] **Implemented / production archive restored offline · M1, M8:** Document and exercise coordinated D1/document backup and restore, artifact retention, orphan cleanup and scoped user export/deletion. Define rollback expectations for schema and application releases.
- **Done when:** a synthetic workspace can be restored with correct ownership, status history and PDF versions, without cross-user leakage. Cleanup cannot delete referenced or submitted artifacts unintentionally.
- **Evidence:** [Lifecycle policy](docs/workspace-lifecycle.md), actual isolated D1/file tests and a five-artifact production synthetic archive restored into a new local D1/KV workspace. A second process reopened persistent records/history/resume version and verified all five hashes. The current-schema restore includes migration 0019 and verifies all 22 authorization/execution tables empty, including email receipts. Production orphan cleanup remains dry-run and disabled. Scoped QA cleanup and preservation checks are recorded in [release evidence](docs/p2-verification.md).
- **Migration lifecycle:** keep the old Vercel bridge while needed; define verified recovery/migration readiness and a communicated retirement plan before removing it. R2 is an optional future storage migration, not a required fix or permission to activate billing.

### P2-09 — Backend parity and regression maintenance

- [x] **Implemented / documented supported scope · M1–M8:** Decide which Python and Worker features are maintained to parity and publish an API/behavior matrix. If the Python path remains supported, wire its normal plan route to the intended optional tailoring/prep configuration and verify the behavior, rather than treating unused helpers as integrated features.
- **Evidence:** [Backend matrix](docs/backend-parity.md), normal Python plan/pipeline factory wiring and shared regression/CI. Python deliberately lacks the listed Cloudflare-only features; it is not advertised as full deployed-runtime parity.
- **Done when:** shared contract fixtures cover schemas, scoring/versioning, confirmation, ownership and statuses; CI makes intentional differences visible. Keep database records independent unless a tested migration/import path is explicitly provided. Document the smaller runtime requirements versus optional embedding/ML dependencies for reproducible installs.

## P3 — optional module and experiments

### P3-01 — Finish the hiring-side module

- [x] **Implemented / scoped verification, optional M7 · issue 22:** Private JSON/CSV shortlists now preserve source-attributed skills, experience, projects and education, use the maintained scorer, provide per-candidate HTML reports, and queue explicitly reviewed Gmail team delivery. Applicant declarations are not independently verified proficiency. [Hiring implementation](docs/hiring.md) and [P3 evidence](docs/p3-verification.md) record API, ownership, queue, UI and SMTP-boundary tests. Actual team inbox receipt remains the external P2-05 configuration/authorization condition.
- **New extensions:** applicant PDF intake, a hiring dashboard and private HTML/PDF exports go beyond the original JSON/CSV API requirement. Track them separately when defining the optional module's release scope.
- **Done when:** the same maintained scoring engine is used, top-N/ties/no-match behavior is reproducible, explanations are traceable to applicant evidence, and tenant ownership is enforced. Include error handling for unreadable PDFs and incomplete profiles. Evaluate job-relevant matching without using protected or irrelevant personal traits as ranking signals.
- **Depends on:** P0-01, P1-01, P1-02 if semantic matching is claimed, P1-03 and P2-05 for email. This optional module must not delay fixing the candidate workflow.

### P3-02 — Learned reranking experiment

- [x] **Completed experiment / research:** A frozen four-feature pairwise model was trained only on embargoed development candidates and compared on unchanged reused-heldout labels. It tied hybrid nDCG@3 at 0.9511 and failed the predeclared improvement gate; production matching remains unchanged. [Policy, artifacts, errors, latency and limitations](docs/reranker-experiment.md) are reproducible without hosted calls.
- **Done when:** a reproducible report explains whether the experiment improves ranking and for whom; deploy only if it beats the simpler baseline under acceptable budgets. Fine-tuning is optional, not a prerequisite for a credible Applied AI product.
- **Depends on:** P1-01 and P1-02.

## Additional future product ideas

These are **new proposals**, not missing original acceptance criteria. The priority below is relative to other optional additions; finish the relevant core items first. Prototype only after defining the user benefit and success metric.

| ID / suggested priority | Addition | User benefit and completion direction | Main dependencies / constraints |
| --- | --- | --- | --- |
| **F01 · P2** | Saved searches and new-match alerts | Persist role/location/compensation filters; notify about genuinely new relevant openings and allow frequency/unsubscribe controls. | Background discovery, deduplication, verified email if used; no automatic submission. |
| **F02 · P2** | Richer application preferences and answer library | Structured availability/start date, internship duration, notice period, relocation/remote preferences and reviewed recurring application answers. | Existing profile already supports roles, locations, compensation, links and blacklist. Ask for missing required facts rather than inferring sensitive answers. |
| **F03 · P2** | Resume comparison and application evidence | Highlight selected/omitted facts and JD coverage; show which approved PDF and answers were actually used. | P0-02, immutable versions and fact provenance. Keep evidence private and avoid exposing sensitive form content in logs. |
| **F04 · P2** | Better accessibility and keyboard workflows | Audit focus, labels, screen readers, contrast, error announcements and readable mobile review flows. | Existing mobile responsiveness is a baseline, not proof of accessibility; verify with assistive-technology checks. |
| **F05 · P3** | Interview practice with feedback | Run JD-specific text or voice mock sessions, with a cited rubric, actionable feedback and progress over time. | P1-01 and P2-03; recording/storage consent, privacy and measured feedback quality. |
| **F06 · P3** | Adaptive study plan and progress tracking | Convert recurring gaps into a weekly learning plan, completed exercises and revised recommendations. | Reliable gap labels; distinguish self-reported progress from demonstrated proficiency. |
| **F07 · P3** | Application outcome analytics | Track callbacks/interviews/offers and compare source, role and resume-version outcomes. | Sufficient consented outcome data; avoid presenting correlation as proof that a resume caused a callback. |
| **F08 · P3** | Calendar and follow-up reminders | Add interview dates, preparation reminders and user-reviewed follow-up drafts. | Explicit calendar/email permissions; creating a draft is separate from sending it. |
| **F09 · P3** | GitHub/portfolio evidence import | Let users select repositories, projects and accomplishments to include as reviewed profile facts. | Explicit account permissions, source attribution and confirmation; never infer ownership or impact solely from a URL. |
| **F10 · P3** | Grounded cover letters and outreach drafts | Produce JD-specific drafts using approved facts and show their sources for review. | Factuality evaluations and per-draft approval; no unsolicited automated outreach. |
| **F11 · P3** | User-controlled browser companion | Assist with supported forms in the user's browser and hand off login/manual steps clearly. | Separate security/permissions design, platform rules and P0-03. Keep final submission explicit; do not bypass CAPTCHA. |
| **F12 · P3** | Multilingual profiles and scanned-PDF OCR | Support additional Indian languages and image-only resumes with confidence-aware review. | P1-08, evaluated extraction and appropriate fonts; expose low-confidence facts before use. |
| **F13 · P3** | Model/provider comparison dashboard | Compare quality, factuality, latency and per-task cost across configured providers/models; route tasks only from measured results. | P1-01, opt-in live checks and budgets. More model calls are not automatically better. |
| **F14 · P3** | Collaborative hiring workspaces | Add reviewer roles, notes, shortlist comparison and human decisions for hiring teams. | P3-01, verified identity/tenant isolation and audit trails; preserve human accountability for hiring decisions. |
| **F15 · P3** | Installable dashboard and optional offline study | Save selected non-sensitive preparation material for offline reading with clear cache/logout controls. | Private-data threat review and explicit user choice; do not cache session secrets or submit applications offline. |

## Recommended execution sequence

1. **Trust and control:** P0-01 through P0-06. Establish safe recovery, final-version/answer review, queued cancellation, supported-form boundaries and measured capacity.
2. **AI depth and core correctness:** P1-01 and P1-03, then P1-02; complete company exclusion, Job-mode evidence, PDF coverage and architecture/setup/demo work in parallel where independent.
3. **Close original delivery gaps:** background discovery, better preparation and exports, configured email, scheduler and mixed-mode reports, followed by the full P1-06 acceptance scenarios.
4. **Maintain and expand deliberately:** backend parity, recovery drills, optional hiring, experiments and selected F-series ideas based on user value and measured results.

For an AI internship portfolio, the highest-value proof after the trust fixes is **a labeled evaluation suite, a measured semantic/hybrid matching improvement, and a reproducible supported application workflow**. Adding more pages or an orchestration framework without evidence has lower priority.

## Definition of completion

- [ ] Link every completed item to its implementation and relevant test/evaluation evidence; distinguish isolated tests, actual providers and production browser runs.
- [ ] Re-run checks appropriate to the change. Validate actual AI quality separately from schema/functional correctness; keep nondeterministic paid/provider tests opt-in.
- [ ] Preserve factual resume content, explicit confirmation, tenant ownership, accurate statuses and the rule against blind resubmission after uncertain outcomes.
- [ ] Update [the audit](docs/milestone-audit.md), [README](README.md) and applicable deployment documents. Mark a milestone complete only after its remaining acceptance conditions are satisfied or a scope change is explicitly recorded.
- [ ] Keep test identities/evidence sanitized and use owned application forms; never include keys, cookies, private resumes or real user data in public artifacts.

Do not present planned features, restricted-source search results, mocked email delivery, an unused embedding helper, a generic form fixture or an estimated interview process as verified real-world capability.

These are historical estimates from before P0–P2 implementation, not estimates of the remaining work or provider/domain waiting time. Use the item status/evidence above for current progress.

| Priority | Original estimated elapsed time |
|---|---:|
| P0 | 10–20 hrs |
| P1 | 10–20 hrs |
| P2 | 15–30 hrs |
| P3 | 5–10 hrs |
| Total | 40–80 hrs |
