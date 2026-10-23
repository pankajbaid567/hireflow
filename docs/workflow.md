# HireFlow workflow and verification

The maintained public dashboard is
[Cloudflare Pages](https://hireflow-dashboard.pages.dev/profile). Its `/api`
requests reach the TypeScript Worker through a fixed Pages service binding.
Python/FastAPI at `http://localhost:8000` is a separate local/container runtime;
Vite/nginx serves its dashboard at `http://localhost:3000`. Start with
[fresh setup](fresh-setup.md), [architecture](architecture.md) and the
[runtime/deployment guide](cloudflare.md).

## Candidate flow on the deployed dashboard

1. Upload a PDF or enter truthful profile facts. Signup issues a private browser
   session automatically; there is no owner-code/profile-ID sign-in. Review
   extracted experience, projects, education, skills and links. Empty/failed
   extraction must not become fabricated profile content.
2. Set Internship/Job mode, quota, target roles, locations, compensation and
   excluded employers. Save a passkey or one-use recovery keys while signed in.
   Browser storage, email and profile numbers are not proof of ownership.
3. Use **Find opportunities**, or import a real listing URL with its full JD.
   Internship mode searches Internshala, Wellfound, Greenhouse, Lever and LinkedIn;
   Job mode searches Naukri, LinkedIn, Greenhouse and Lever. Each source gets a
   separate bounded search. Active full JDs are verified, canonical duplicates
   handled, and source restrictions/empty results shown. A source name is not a
   promise of authenticated scraping or automatic application compatibility.
4. Review ranks, explicit matches/gaps, structured pay/experience and private
   PDFs. Ranking uses the six-factor weights and a bounded, evaluated semantic
   contribution. Employer completeness is not company prestige or proof of
   legitimacy. Prior submitted/uncertain employers are conservatively excluded
   under the documented policy; user blacklisting remains explicit.
5. Open **Review resume & answers**. Edit the opportunity's truthful draft,
   compare immutable versions, reject/regenerate if needed, open the final PDF
   and review its answers. Approve that exact version, then confirm only the
   selected opportunities you authorize. Changed source/PDF/answers require
   another approval. Bounded regeneration is not submission authorization.
6. The queue claims the approved generation and checks its PDF hash/current
   review before advancing/submitting. **Cancel queued application** can stop
   unclaimed work, not withdraw an external submission. CAPTCHA, login, unknown
   required questions, expired jobs and uncertain writes produce manual action.
7. Track statuses/reasons, open versioned resumes, prep guides and the private
   weekly HTML report. Predicted rounds are guidance. Missing company/review
   evidence stays unknown and useful links retain sources. Viewing/generating a
   report does not send email.
8. Check **Service status** when a provider/budget causes a delay. Diagnostics are
   opt-in and use tiny synthetic prompts, not the resume. An explicit plan refresh
   can retry matching after an embedding outage under its three-request/ten-minute
   limit; passive polling does not repeatedly bill failed embedding calls.

Cycles begin Monday UTC. Confirmed, applying, applied, failed and needs-action
work consumes its cycle quota; switching mode does not reset consumed quota.
Unconfirmed drafts are revalidated for freshness/mode/blacklist and quota.
Historical submitted PDFs are retained. The cron repairs outbox/recoverable work;
a complete autonomous weekly scheduler and configured real email delivery remain
separate backlog items.

## API map and ownership

Browser requests use `/api` on the dashboard origin. The table omits that proxy
prefix; a direct Worker or Python request uses its root API path.

| Feature | Endpoint / runtime boundary |
| --- | --- |
| Profile | `POST /profile`, `PATCH /profile/{id}`, `GET /profile/{id}`; private owner cookie after creation. |
| Restore/logout | `GET /session`, `POST /session/logout`; both runtimes. |
| Recovery and sessions | `/account/*`; Cloudflare passkeys and keys, Python keys with passkeys explicitly unavailable. |
| Live discovery/import | `POST /jobs/{id}/discover`, `POST /jobs/{id}`; Cloudflare. Python retains scraper CLIs. |
| Plan/swap | `GET /weekly-plan/{id}`, `POST /weekly-plan/{id}/swap`. |
| Matching retry | `POST /weekly-plan/{id}/refresh-matches`; Cloudflare, bounded and owned. |
| Draft/reject/regenerate | `/applications/{application_id}/resume-draft`, `/resume-reject`, `/resume-regenerate`; Cloudflare. |
| Review/confirm | `GET/POST /applications/{application_id}/review`; Cloudflare confirmation includes exact `review_ids` and `confirmed_job_ids`. Python retains its smaller `confirmed_job_ids` contract. |
| Queued cancellation | `POST /applications/{application_id}/cancel`; Cloudflare, atomic against claim. |
| Tracker | `GET /applications/{id}?status=needs_action&page=1&page_size=20`. |
| Guide/library/PDF | `GET /applications/{application_id}/prep-guide`, `GET /resumes/{id}`, `GET /resumes/{id}/{application_id}/download?version=1`. |
| Report | `POST /report/{id}/generate`, `GET /report/{id}/latest`, `GET /report/{id}/latest/html`. |
| Explicit configured email | `POST /report/{id}/latest/email`; no delivery is implied by mocked tests or an unconfigured sender. |
| Operations | `GET /operations/{id}`, `POST /operations/{id}/diagnostics`; Cloudflare owner only. |
| Readiness | `GET /health`. |

IDs identify records after ownership is established; they do not authorize access.
Do not put provider keys, operator bootstrap values, session cookies or recovery
keys into `VITE_` variables, URLs, Git or public screenshots. See
[account security](account-security.md) for strict source-bound workspace transfer
and offline existing-owner bootstrap.

## Runtime differences and providers

The [architecture](architecture.md) maps each source boundary. Cloudflare uses
D1/private KV/Queue/Browser Run and optional Workers AI inference. Python uses
SQLAlchemy/PostgreSQL, local artifact storage and local Playwright/background
tasks. The normal Python scoring route can invoke genuine FAISS when its
optional dependencies and semantic flag are configured, but it does not silently
inherit the Worker's immutable answer-review/checkpoint implementation. Full
parity remains explicit backlog work.

Model IDs belong to configuration and readiness checks, not timeless guarantees.
The maintained configuration uses Groq `openai/gpt-oss-20b`, Gemini
`gemini-3.8-flash` and the explicit `gemini-3.5-flash-lite` extraction fallback.
Recent probes found primary Gemini timeouts and a functioning configured fallback;
show the actual method/failure rather than claiming primary success. Python PDF
intake reads text before its configured provider; Cloudflare can use Gemini PDF
intake. Neither runtime claims OCR for arbitrary scanned resumes.

The deployed semantic model is BGE small with CLS pooling. Its private vector
cache and daily cap are independent of browser reservations. Lexical fallback is
labelled when the model, schema, binding or quota is unavailable. Changing models
requires fresh evaluation; a similarity score is not a hiring probability.

Tavily/SerpAPI search supplies resources and company evidence within budgets.
News needs a valid recent date, reviews need an attributed accessible source, and
missing information stays unknown. No CAPTCHA solving, login bypass or employer
submission is part of ordinary QA.

## Checks and live proof

Default tests run on isolated databases and owned local forms:

```bash
python -m pytest tests/ -q
npm test --prefix frontend
npm run build:cloudflare --prefix frontend
npm run check --prefix cloudflare
node scripts/run_ai_evaluation.mjs
node scripts/verify_cloudflare_dashboard.mjs
node scripts/verify_account_security.mjs
```

See [AI evaluation](ai-evaluation.md) for the 120-case corpus, real model
provenance, frozen heldout comparison, actual provider subset and unmeasured
human/source-quality boundaries. See [PDF quality](p1-pdf-quality.md) for Unicode,
source facts, layout and actual extraction coverage. Functional test counts alone
do not establish AI quality.

Production browser checks and actual provider evaluation are explicit opt-in.
They may consume free account usage, create synthetic records and require scoped
cleanup. Use only the owned HireFlow QA form for submit tests:

```bash
node scripts/verify_account_security_live.mjs --run-live
node scripts/verify_p0_review_operations_live.mjs --run-live
node scripts/verify_cloudflare_live_ui.mjs --run-live
```

The separate local-provider tests are also opt-in:
`RUN_LIVE_LLM_TESTS=1 pytest tests/test_llm_client.py -k live -v` or
`RUN_LIVE_E2E_TESTS=1 pytest tests/test_live_e2e.py -v`. They do not prove the
Cloudflare deployment, and they must never target an actual employer vacancy.

### Historical evidence

On **21 October 2026**, the original Docker/PostgreSQL dashboard flow passed with
Groq, including local applied/CAPTCHA outcomes, PDF/report/mobile checks and zero
browser errors. The then-current suite had 293 passed tests. Separate local
provider application tests used two calls each: Groq completed in 6.42s and Gemini
in 101.07s; proof XML files were `/tmp/hireflow-live-groq-e2e.xml` and
`/tmp/hireflow-live-gemini-e2e.xml`. These are historical snapshots, not the current
suite count or evidence of the new P1 deployment. Current scoped evidence is in
[the audit](milestone-audit.md), [P0 verification](p0-verification.md), the P1
quality documents and the coordinated release proof.
