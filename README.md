# HireFlow AI

HireFlow helps students and job seekers build a reviewed application plan, prepare truthful resume PDFs, track supported automatic applications, and study for interviews. Applications require explicit confirmation. Blocked forms, CAPTCHAs, expired vacancies, and uncertain submissions are recorded for manual action.

**Live dashboard:** [hireflow-dashboard.pages.dev](https://hireflow-dashboard.pages.dev/profile).
React/Pages and the [API Worker](https://hireflow-api.baidpankaj567.workers.dev/health)
run on Cloudflare with D1, private KV files, Queues and Browser Run.
**P0 and P1 are implemented and production verified within their documented scopes.**
The 25 October two-mode run used a synthetic PDF, real source searches and BGE
matching, reviewed PDFs, two owned QA submissions, prep guides, mixed report,
mobile and logout. [Verification](docs/p1-verification.md) ·
[Watch the 4:45 demo](https://hireflow-dashboard.pages.dev/assets/hireflow-p1-demo.webm).
The old Vercel origin remains a temporary workspace-migration bridge.

P2 adds resumable larger discovery, bounded public JavaScript reading,
evidence-labelled preparation, private versioned guide exports, opt-in weekly
draft scheduling, signed report-delivery receipts and coordinated workspace
backup/restore. [P2 verification](docs/p2-verification.md) separates controlled
tests and live evidence. Native JavaScript hydration is verified on an owned
synthetic source; the deployed allowlist contains only that host. A real 100+
relevant pool and arbitrary external JavaScript portal coverage remain
unverified. Actual email sender setup and inbox receipt are still required;
a queued or provider-accepted email is not delivery.

The original specification is **not fully complete**. Read the [milestone audit](docs/milestone-audit.md) for implemented, partial, missing, and unverified requirements, and the [prioritized roadmap](future.md) for remaining work, improvements and future additions.

**P0 is implemented and deployed:** passkeys/single-use recovery keys, Python
cookie ownership, immutable per-opportunity PDF editing and comparison,
exact-version/answer approval, queued cancellation, supported four-step recovery
and operational diagnostics. The new production account-recovery check and
Pages application cycle passed. See [P0 verification](docs/p0-verification.md)
for the evidence and remaining portal/capacity boundaries. A separate old-site
transfer rerun passed migration, replay rejection and logout on both origins.

## Current application

| Component | Runtime / resource |
| --- | --- |
| React dashboard and private `/api` proxy | Cloudflare Pages project `hireflow-dashboard` |
| API, application queue consumer, recovery cron | Cloudflare Worker `hireflow-api` |
| Profiles, ownership sessions, jobs, applications, guides, reports | D1 database `hireflow` |
| Private uploads, versioned resume PDFs, HTML reports | Workers KV namespace `hireflow-files`; R2 adapter optional |
| Confirmed application work | Queue `hireflow-applications` and Browser Run |
| PDF extraction / text generation | Gemini / configured Groq or Gemini provider |
| Semantic matching | Workers AI BGE CLS, private versioned D1 vectors; Python FAISS is separate |

[Deployment and resource details](docs/cloudflare.md) include the actual bindings, secrets, quotas, commands, and verification status. No provider secret belongs in browser code.

The 26 October deployment uses Worker source `e6d5e4c`, version
`70ad62bb-eca4-4be4-9c82-ef28ab64e02d`, Pages `ec151322` (assets from
`a6814e6`), and D1 migrations through `0019`. Exact CI and production evidence
are recorded in [P2 verification](docs/p2-verification.md).

## User flow

1. Upload a PDF and save the profile, or enter details manually. The browser receives a private session automatically; normal users enter no operator code or profile ID.
2. Review extracted facts and edit experience, projects, education, summary, links, certifications, achievements, and spoken languages. Set internship/job mode, target roles, locations, minimum compensation, excluded companies, weekly quota, and batch or individual review.
3. Choose **Find opportunities** or add an actual listing URL and full job description. Internship mode makes five separate source searches (Internshala, Wellfound, Greenhouse, Lever, LinkedIn); job mode makes four (Naukri, LinkedIn, Greenhouse, Lever). Candidates are verified in rotation, with up to eight accepted listings across the combined Find opportunities operation. Repeated listings are deduplicated; the UI shows per-site results, restrictions and original listing links. This is not a 100+ listing pool or authenticated portal integration.
4. Review the ranked plan and skill gaps. Edit, compare, reject or regenerate each opportunity’s PDF, then review its answers and approve that exact version. Swap listings or change the selection; confirm only the approved opportunities you authorize.
5. Track the result and any manual instructions. Open private resume versions, interview guides, and the weekly HTML report.

The Worker uses **six-factor hybrid matching**: genuine Workers AI BGE embeddings contribute only 20% of the technical factor, with private versioned D1 vectors and a visible lexical fallback. The separate Python plan path supports real BGE/FAISS when explicitly enabled. On the frozen synthetic heldout benchmark, hybrid nDCG@3 was **0.9511 versus 0.6991** for lexical matching; these are authored relevance labels, not hiring outcomes. [Evaluation and limitations](docs/ai-evaluation.md) include factuality, source support, error analysis and actual-model provenance. Groq selects existing facts/projects for resume tailoring; immutable PDFs retain method, model and profile version.

Automatic submission supports suitable public native forms with up to eight recognizable steps and encrypted completed-step checkpoints. Unknown controls, login walls and uncertain submissions require manual action; arbitrary employer portals are not certified. See the [compatibility matrix](docs/portal-compatibility.md). There is no blanket guarantee that a listing can be applied to automatically. **Gmail + Nodemailer is implemented** with two private Gmail settings, fixed TLS, a shared daily attempt allowance and explicit recipient/report review. Existing Resend/SendGrid support remains available. Gmail credentials and an authorized real inbox test are still needed; no actual email delivery is claimed. See [setup](docs/email-delivery.md) and [P3 verification](docs/p3-verification.md).

The optional [hiring dashboard](https://hireflow-dashboard.pages.dev/hiring)
provides private JSON/CSV shortlists, source-attributed applicant facts, immutable
HTML reports and reviewed Gmail team delivery. A separate
[learned reranker experiment](docs/reranker-experiment.md) tied the existing
hybrid, so its frozen adoption gate failed and production ranking stays unchanged.

## Existing workspace migration

The migration release routes old dashboard pages through a temporary bridge instead of mirroring the frontend. A signed-in old browser receives a single-use transfer valid for five minutes; Pages consumes it and creates a new private session. A signed-out browser reaches the Pages profile screen. **Continue an existing workspace** on Pages opens the same bridge. No ID/email-only login or operator-code prompt is used. The new source binds outstanding links to their active source session, so sign-out/revocation invalidates them.

For lost sessions or another device, save a passkey or recovery keys in **Account
security and recovery** before signing out. Open **Already have a workspace?
Sign in** to recover. Cloudflare supports passkeys and keys; Python supports
keys and explicitly reports passkeys unavailable. An email address alone proves
no ownership. See [account setup and recovery](docs/account-security.md) for
migrations, verification and the precise runtime capabilities.

## Local development

There are two independent backends. Cloudflare uses TypeScript/D1/KV; the original local/container path uses Python/FastAPI/PostgreSQL. They do not share database records automatically.

For the original Docker app:

```bash
cp .env.example .env
# Configure local provider keys and database settings.
docker compose up --build -d --wait
```

Open <http://localhost:3000>; FastAPI docs are at <http://localhost:8000/docs>.
Python private routes now require the owner's HttpOnly session cookie; numeric
IDs are not credentials. Apply Alembic migrations through `005` before starting the new
API. Existing local owners can create recovery keys using the private offline
bootstrap described in [account security](docs/account-security.md).
[Container setup and persistence](docs/deployment.md) remain separate from
Cloudflare deployment.

For Worker/Pages development, use **Node 22 or newer** and follow [the Cloudflare guide](docs/cloudflare.md#local-development-and-checks). Python development requires Python 3.11+, the project virtual environment, dependencies, and Playwright Chromium; [workflow.md](docs/workflow.md) covers those commands.

Publish the existing Pages project from the repository root with
`npm --prefix frontend run deploy:cloudflare`. The wrapper builds in Cloudflare
mode and runs pinned Wrangler 4.151.3 from `frontend/`, so API Functions accompany
the assets. After building, `node scripts/deploy_cloudflare_pages.mjs --verify-only`
checks typed API health and invalid-profile validation without publishing or
creating an owner. See the [deployment steps](docs/cloudflare.md#deploy-or-redeploy).

## Checks

```bash
npm ci --prefix frontend
npm test --prefix frontend
npm run build:cloudflare --prefix frontend
npm ci --prefix cloudflare
npm run check --prefix cloudflare
# With the configured Python virtualenv and Chromium installed:
venv/bin/python -m pytest tests/ -v
```

Recorded local release gates: **407 Python, 774 Worker and 157 frontend tests
passed**, with three Python and four Worker opt-in tests skipped. Frontend
coverage includes five Pages deployment-guard regressions. Typecheck, Pages
build, Worker dry run and isolated React/Worker/D1/private-file browser E2E
passed. The unchanged **120-case AI evaluation**, 16-case preparation check
and PostgreSQL/Docker cycle have passing evidence. [P2 release evidence and CI](docs/p2-verification.md)
distinguish exact source revisions, mocked, actual-provider and controlled-form stages.

The historical P1 interactive cycle had HTTP CPU **P95/P99 9/10 ms**, zero native
runtime errors and one **14 ms signup outlier**. Heavy search, matching, PDF and
maintenance work runs in the Queue. This is a small single-workflow Free-tier
sample, not a sustained/concurrent capacity guarantee. [P1 capacity details](docs/p1-capacity.md).
P2 analytics cover mixed HTTP/Queue work; trigger-specific queries were unavailable,
so they do not establish current HTTP-only headroom. [P2 measurements](docs/p2-verification.md#measured-discovery-and-remaining-acceptance).

Default tests use isolated data and controlled forms. Live provider/browser verification requires explicit run switches and consumes account usage. It must target HireFlow's synthetic QA form, never a real employer application. Local test success does not by itself prove a complete production UI workflow or compliance with Workers Free CPU limits.

## Repository map

| Path | Purpose |
| --- | --- |
| `frontend/` | React dashboard, Pages Functions proxy, temporary Vercel migration bridge |
| `cloudflare/` | Worker API, D1 migrations, file adapter, queue, browser automation, PDF/report generation |
| `src/`, `tests/` | Original Python agents, scrapers, scoring, FastAPI, SQLAlchemy, tests |
| `scripts/` | Controlled browser/provider verification helpers |
| `docs/cloudflare.md` | Pages/Worker deployment, resources, sessions, limits, provider setup |
| `docs/deployment.md` | Deployment status, local Docker operations, persistence and migration notes |
| `docs/milestone-audit.md` | Requirement-by-requirement audit and remaining work |
| `docs/architecture.md`, `docs/fresh-setup.md` | Runtime boundaries, data flow and verified clean setup |
| `docs/ai-evaluation.md`, `docs/p1-pdf-quality.md` | Measured AI and PDF quality, with limitations |
| `docs/p2-source-adapters.md`, `docs/dynamic-sources.md` | Public source coverage, bounded JavaScript transport and native verification limits |
| `docs/demo.md` | Synthetic walkthrough and actual recording evidence |
| `future.md` | Prioritized remaining work, AI improvements and optional future additions |

NST Engineering — HireFlow
