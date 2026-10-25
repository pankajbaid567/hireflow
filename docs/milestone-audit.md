# HireFlow expectation versus reality

Audit: **25 October 2026**, against [MILESTONES.md](../MILESTONES.md) and the
later issue acceptance criteria. P0 is published; P1 implementation and its
measured evidence are described in [P1 verification](p1-verification.md).
Completing a roadmap priority does not imply every original milestone or
employer integration is complete.

## Milestone assessment

| Milestone | Expected | Current behavior and evidence | Remaining boundary |
| --- | --- | --- | --- |
| **M1 — Foundation/profile** | Persistent SQL records, PDF/JSON intake, editable profile, both modes, quota and reproducible setup. | Production Worker/D1 private workspaces, PDF-only signup and rich structured edits; signed passkeys and single-use recovery keys. Separate FastAPI/PostgreSQL implementation has cookie ownership and recovery keys. Clean dependency installation, SQLite upgrade/rollback/check and an actual PostgreSQL/Docker cycle passed. | **Implemented with runtime adaptation.** Cloudflare is TypeScript/D1, not a Python/PostgreSQL process. Python deliberately reports passkeys unsupported. No email-verified ownership, new physical laptop or independently provisioned Cloudflare account is claimed. |
| **M2 — Discovery** | 100+ complete, fresh listings per cycle, named sources, mode-specific discovery, spam/quality and rate controls. | Five separate Internship searches and four Job searches, actual public full-JD verification, source diagnostics, canonical deduplication, source-backed dates/pay/experience/skills/process and explained fee/sparsity risk rules. Discovery runs on an owner-bound durable Queue ticket with private polling; raw search snippets cannot substitute for full JDs. Both modes have actual production evidence. | **Partial.** Each bounded search accepts at most eight verified listings. No 100+ pool, comprehensive authenticated portal feeds or fleet-wide per-domain scheduler. Risk rules are explained heuristics, not calibrated fraud probabilities or employer verification. |
| **M3 — Matching** | Genuine profile/JD embeddings and FAISS retrieval, six weighted factors, deterministic ranking, gaps and compensation comparison. | Genuine BGE CLS matching in the deployed plan, private model/profile/full-source versioned D1 vectors and lexical fallback; Python normal plans integrate optional BGE/FAISS and have actual-model route evidence. Exact 40/20/15/10/10/5 weights retained; semantics blends only 20% of the technical factor. Currency/period/range-aware pay and explicit experience handling are shared across runtimes. | **Implemented alternative with bounded evaluation.** Worker vectors are not FAISS. Python model dependencies/flag are opt-in. Semantic text is bounded and emphasizes skills, roles, summary and projects; numeric experience fit remains separate. Synthetic relevance labels are not independent hiring outcomes or a calibrated hiring probability. |
| **M4 — Plan/resume** | Top-N quota, explicit review, swaps/removal, previous-employer exclusion, truthful JD/mode tailoring and versioned ATS PDFs. | Company normalization/explicit aliases, all-time known-submission exclusion and conservative uncertain-write handling. Grounded project/fact selection, immutable edits/comparison/rejection/regeneration, exact PDF/answer approval, historical listing snapshots and guarded stale-score/PDF writes are implemented. Unicode/long/multicolumn/sparse PDFs have actual reader and visual evidence. | **Implemented on Cloudflare; Python parity remains partial.** Python lacks the full per-opportunity editor/answer authorization workflow. Original M4 prohibits generating before confirmation while later issue 24/M8 require preview beforehand; the maintained decision is preview/edit first, explicit approval/confirmation before submission. Unsupported or oversized text fails visibly without discarding facts. |
| **M5 — Application automation** | Fill/upload/answer/submit on internship/job portals; multi-step, CAPTCHA, retries, status history and recovery. | Real Browser Run applied to owned QA forms in both modes. Local real-browser/D1 tests exercise four-step recovery, CAPTCHA/manual action, changed forms, stale approvals, cancellation, interrupted/uncertain work and safe retries. Submitted PDF/answers remain bound to the exact approval. | **Partial portal coverage.** Public native forms are supported within the compatibility matrix; arbitrary ATS vendors, login/Easy Apply and custom/embedded controls are not certified. CAPTCHA is detected, never solved. Python retains separate single-form automation. |
| **M6 — Preparation** | Predicted rounds, skill categories, 2–3 useful resources/topic, 5–10 JD-specific questions, current company/review evidence and export. | Saved guides/viewer, topics, expandable questions, attributed external resources and source-backed or explicitly unknown company information. Actual provider-backed preparation was opened in both modes. Controlled evaluation measures JD context, supported claims and missing/stale/broken sources. | **Partial.** Counts/accessibility depend on evidence and provider availability; fallback behavioral questions have measured high duplication. No standalone prep PDF/HTML export or comprehensive company-career-page research. Controlled citation support does not prove every live link is useful. |
| **M7 — Reports/delivery/hiring** | Weekly insights/study plan, mixed-mode summaries, email HTML/PDF/resumes, scheduler and optional hiring workflow. | Private weekly HTML, per-application status/failure/manual links, scores, skill demand and study priorities. Production mixed week contains Internship and Job applications, uses one shared UTC-week quota and preserves submitted PDFs after mode changes. JSON/CSV shortlisting and mocked SendGrid/Resend integrations exist. | **Partial.** Real email/verified sender, report PDF/export and full weekly scheduling are incomplete. No comprehensive applicant-PDF parsing, hiring dashboard/export/email workflow. A report is not automatically an email. |
| **M8 — Dashboard/integration/demo** | All views, mobile, both modes end-to-end, failure handling, architecture, fresh setup and 3–5-minute demo. | Rich profile, plan/source diagnostics, immutable PDF review, tracker, prep, library and report. Fresh production run `328d62554e26` passed real intake/search/hybrid ranking/review → two owned applications → both preps → mixed report/quota → mobile/logout. Architecture, clean install and isolated actual Docker integration are documented. | **Verified controlled scope; final release gate tracked separately.** A complete synthetic run is not all-employer certification or a 100+ weekly application cycle. The recorded demo is synthetic and edited pacing is not a latency benchmark. Final queued-plan release measured product HTTP CPU P95/P99 9/10 ms with one 14 ms signup outlier; see the bounded usage envelope in capacity evidence. |

## Runtime and portal boundaries

| Surface | Actual implementation | What it does not establish |
| --- | --- | --- |
| Cloudflare production | Pages React/private proxy → TypeScript Worker → D1/private KV → durable Queue/outbox → Browser Run. Optional R2 adapter is not activated. | Python, PostgreSQL, sentence-transformers or FAISS running inside a Worker. |
| Python/local/container | FastAPI/SQLAlchemy/PostgreSQL (SQLite for isolated tests), ReportLab, local Playwright and optional genuine BGE/FAISS. | Shared production D1 records or full Cloudflare review/multistep parity. |
| Internshala, Wellfound | Separate searches and read-only public individual-detail verification; actual Internship results retained in sanitized acceptance evidence. | Authenticated portal crawling, portal login or automatic portal-specific application certification. |
| Greenhouse, Lever | Source-specific searches plus actual read-only ATS detail APIs and structured descriptions/pay where supplied. Actual Job results were verified. | Every tenant's hosted/custom application form being supported. |
| LinkedIn | Separate discovery searches; restrictions remain visible and unavailable details are omitted. | LinkedIn login or Easy Apply. |
| Naukri | Separate Job-mode search; empty/unverified outcomes remain visible. | A fabricated successful Naukri import or authenticated adapter. |
| Generic company careers | Supported public individual URLs/full text or JobPosting metadata; directories, expired roles and snippets are rejected. | Complete discovery of every career site, JS-only/custom controls or bypassing access restrictions. |

The [portal compatibility matrix](portal-compatibility.md) remains the detailed
submission contract. Public discovery and permission to submit are distinct:
QA never confirms an actual discovered employer listing.

## Evidence that changed the assessment

- [AI evaluation](ai-evaluation.md): 120 versioned synthetic cases; genuine model
  provenance, heldout lexical/semantic/hybrid metrics, actual extraction and
  grounding checks, declared weaknesses and a human review rubric. No independent
  human ratings or actual billing totals are invented.
- [PDF quality](p1-pdf-quality.md): 16 generated artifacts/19 pages, logical-text,
  link/bounds/reader checks, visual inspection and actual three-PDF Gemini
  extraction. Latin/Devanagari support is bounded; image-only OCR remains separate.
- [Clean setup](fresh-setup.md): new source copy/venv/node_modules on the existing
  host, dependency/Chromium installation, migrations and tests. The separate
  [Docker evidence](evidence/p1-docker-cycle.json) exercised actual PostgreSQL,
  non-root API, Unicode PDF, local Chromium submission, UI/mobile and logout.
- [Production acceptance](p1-acceptance.md): exact real-provider and controlled-form
  boundaries, both modes, actual retries, quota/history/privacy and cleanup.
  Failed runs remain failed evidence rather than being retrospectively relabelled.
- [Capacity](p1-capacity.md): native CPU/memory and trigger-separated aggregates.
  The first P1 HTTP P95/P99 was 28/108 ms; queued discovery lowered it to 18/22 ms
  but that still exceeded the HTTP objective. Warm read-only health samples and
  Queue CPU cannot substitute for the full HTTP cycle. The final queued-plan cycle measured 120 product fetches at CPU P50/P95/P99 3/9/10 ms, one 14 ms signup outlier and zero native runtime errors. P1-09 is closed for that measured single-workflow envelope; concurrency and worst-case capacity remain unclaimed.
- P0 ownership, edit/reapproval, durable recovery and provider/budget checks remain
  [historical verified evidence](p0-verification.md), not missing capabilities.
  [Account security](account-security.md) describes exact recovery guarantees.

All three CI workflows passed for P1 implementation `bd6fff2` and queue-discovery
correction `c2e1647`; applicable Backend/Cloudflare CI also passed for queued-plan release `595f68e`, including PostgreSQL rollback/check, real PDF reader tests,
AI evaluation and isolated React/Worker/D1/R2 browser E2E. Local corrected gates
are 470 Worker, 373 Python and 127 frontend tests, plus the 120-case evaluation.
Opt-in live checks are reported separately.

## Remaining work

Use [future.md](../future.md) as the prioritized backlog. P2 covers larger
resumable discovery pools, broader adapters/rate controls, improved preparation
and source relevance, exports, real configured email, scheduling, backup/restore
and Python parity. P3 covers the optional hiring module and evaluated research
experiments. Additional frameworks or model calls do not substitute for evidence.

No real employer application, email delivery, paid-plan activation, independent
human evaluation, universal OCR/font support or sustained unlimited free capacity
is claimed by this audit.
