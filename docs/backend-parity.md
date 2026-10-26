# Supported backends and regression contract

Cloudflare is the deployed product backend. The Python/FastAPI implementation
remains supported for local development, containers, offline experiments and
Playwright application automation. These are independent installations, with
different databases, credentials, private document stores and execution models.
The Python server is not an automatic failover for a Cloudflare workspace.

The maintenance decision is to share factual listing rules, matching behavior,
candidate evidence, readable resume content, ownership and status semantics.
Cloudflare's durable product workflows are maintained on Cloudflare. We do not
promise identical APIs or authorization protocols for features absent from the
Python implementation.

## Behavior matrix

| Capability | Deployed Cloudflare backend | Supported Python backend | Maintenance contract |
| --- | --- | --- | --- |
| Storage | D1 and private KV, native Queue tasks | SQLAlchemy/PostgreSQL or SQLite and private local files | Separate state; no implicit synchronization or migration |
| Profile and private resources | Owner cookie, passkeys, single-use recovery keys; owner-scoped records and downloads | Owner cookie and recovery keys; global API dependency enforces matched user/application ownership | Both require ownership; Python does not implement passkeys or assert email ownership |
| Listing facts | Normalized source/application URLs, extracted requirements, geography, eligibility and source provenance | Shared fact contract for scrapers, profile matching and quota selection | Same authored listing fixtures; runtime-specific source adapters and restrictions remain explicit |
| Discovery | Bounded resumable source cycles, rotated queries, per-domain budgets/cache, cancellation and Queue recovery | Synchronous scraper/search pipeline and supported local discovery tooling | A search snippet never establishes a verified full JD; identical search result counts are not promised |
| Matching | Six-factor explanations; optional genuine BGE CLS with private versioned D1 cache and lexical fallback | Six-factor explanations; optional genuine BGE/FAISS normal-plan matching and lexical fallback | Shared scoring/eligibility intent and evaluation cases; neural runtime/cache outputs need not be byte-identical |
| Resume preparation | Versioned Queue preparation, model provenance, editable structured resume and exact immutable reviewed PDF | Normal plan GET/swap prepares versioned local PDFs; optional grounded source-sentence selection | Preserve source facts and readable Unicode/link content; renderer bytes and editing APIs differ |
| Confirmation and submission | Review binds PDF hash/version, profile/JD versions, answers and target; durable claim and supported application safety checks | Confirmation checks that the local PDF exists, records the listing/target snapshot, enforces eligibility/quota; background pipeline rejects changed targets and uses the atomic application claim | Python does **not** implement Cloudflare's exact artifact/answer review protocol; do not use it as a replacement for that guarantee |
| Execution/recovery | Durable Queue stages, bounded work, retained status trail and cancellation | FastAPI process-local BackgroundTasks and Playwright; persisted application statuses/retry policy | Restart-safe orchestration parity is not claimed for Python BackgroundTasks |
| Preparation guidance | Evidence-backed company/topic/question content, explicit refresh and immutable HTML/PDF exports | Normal confirmed pipeline creates evidence-backed guidance; optional LLM question generation; configured search can supply resources/company evidence | Shared quality rules and authored evaluation cases; Python has no equivalent refresh/export Queue API |
| Reports and email | Immutable queued Gmail/Nodemailer or Resend/SendGrid payloads, exact PDFs/private links and provider-specific recovery | Local ReportGenerator; Gmail SMTP_SSL and existing HTTP providers, local SQLite attempt quota | SMTP/API acceptance is distinct from inbox receipt; quotas and execution state are separate across runtimes |
| Hiring | Owner-only JSON/CSV evidence shortlists, bounded scoring Queue, immutable private HTML and explicitly reviewed Gmail team delivery | Owner-only JSON/CSV evidence shortlists, synchronous scoring and private HTML; legacy unassigned rows inaccessible | Same maintained lexical six-factor engine; Python has no hiring team-email Queue/API. Applicant PDF intake/report PDF and team reviewer roles remain future scope |
| Scheduling | Opt-in timezone-aware weekly draft cycle, durable runs, pause/resume and reminders | No equivalent public weekly scheduler | Scheduling never grants application submission approval |
| Workspace lifecycle | Scoped private manifest/artifact export, confirmed queued deletion, isolated offline restore and conservative retention | Operator-managed database/file backups; no equivalent public lifecycle API | Restore credentials or pending submission authority in neither workflow; see the Cloudflare lifecycle guide |

## Optional generation in normal Python routes

The factories in `src/pipelines/preparation_services.py` are used by the real
weekly-plan GET/swap routes and the confirmed application pipeline. They do not
cache candidate content or provider objects between requests.

Both settings default to `false`, even when an API key is present for another
feature:

```dotenv
PYTHON_LLM_TAILORING_ENABLED=false
PYTHON_LLM_PREP_ENABLED=false
```

To opt in, configure a supported `LLM_PROVIDER` and its private key/model settings
in `.env`, then enable the relevant flag and restart the Python server. The
settings and examples live in `.env.example`; never put keys in a committed
file. Opting in can make external model requests. The flags do not disable
independently configured search, resume ingestion or application form providers.

`PYTHON_LLM_TAILORING_ENABLED=true` permits summary selection from existing
profile/experience/project sentences. Unsupported output is rejected, and the
PDF retains source facts. The plan response includes each item's
`resume_preparation.method` and `warnings`, with warnings also collected at plan
level. Methods are `source_fact_ordering`, `llm_source_sentence_selection` and
`existing_pdf`. `existing_pdf` means reuse of the persisted version; it does not
assert which model, if any, originally produced it. Enabling a setting does not
silently rewrite a previously generated or reviewed PDF.

`PYTHON_LLM_PREP_ENABLED=true` injects the configured client into the normal
confirmed pipeline's prep agent. Its contextual questions still pass the
evidence/schema checks. Configuration failures and runtime generation failures
retain JD-based guidance with visible warnings. Resource/company search uses
the configured search adapter separately. A missing provider configuration is
not a reason to invent an answer or fail an otherwise grounded plan.

No live model call, real employer submission or real email is required to run
the regression tests. Provider failures are tested with synthetic clients.

## Regression boundaries

| Contract | Verification |
| --- | --- |
| Normal Python opt-in/default/fallback behavior | `tests/test_preparation_services.py` exercises authenticated plan and confirmation routes, a real persisted PDF/readback and guide, provider-boundary mocks, PDF reuse and private-error suppression |
| Confirmed target and eligibility guard | `tests/test_application_pipeline.py` verifies changed target rejection before preparation/browser work and unchanged-target execution |
| Listing facts and eligibility | `tests/fixtures/listing_contract.json`, `tests/test_listing_facts.py`, `cloudflare/tests/listing-facts.test.ts` |
| Matching and explicit fallback | `tests/test_semantic_matching.py`, `cloudflare/tests/semantic-matching.test.ts`, `evals/` frozen cases; see [AI evaluation](ai-evaluation.md) |
| Source facts and Unicode PDF readability | `tests/test_pdf_quality.py` and the Worker PDF reader/corpus tests; content and bounds are tested rather than identical file bytes |
| Evidence and preparation quality | `tests/test_prep_quality.py`, `cloudflare/tests/prep-quality.test.ts`, `scripts/evaluate_prep_quality.mjs`; see [quality evidence](p2-preparation-quality.md) |
| Native product lifecycle | Actual Worker/D1/private-store tests and isolated browser workflows; see [workspace lifecycle](workspace-lifecycle.md), [guide exports](prep-exports.md), [scheduler](p2-discovery-scheduler.md) and [release evidence](p2-verification.md) |

Run Python regressions with the configured virtual environment:

```bash
venv/bin/python -m pytest -q
```

The separate backend CI runs Python tests and PostgreSQL migration
upgrade/downgrade checks. Cloudflare CI runs Worker typechecking/tests, frozen
evaluations, isolated browser workflows, the frontend build and a deployment
dry run. Passing these gates establishes the listed contracts, not unimplemented
API parity or real-world hiring outcomes. New shared behavior needs a regression
case in both runtimes; Cloudflare-only behavior must remain identified here.
