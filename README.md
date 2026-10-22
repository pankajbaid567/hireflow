# HireFlow AI

HireFlow helps students and job seekers build a reviewed application plan, prepare truthful resume PDFs, track supported automatic applications, and study for interviews. Applications require explicit confirmation. Blocked forms, CAPTCHAs, expired vacancies, and uncertain submissions are recorded for manual action.

**Live dashboard:** [hireflow-dashboard.pages.dev](https://hireflow-dashboard.pages.dev/profile). The frontend and backend are hosted on Cloudflare: Pages serves React and the same-origin API proxy, and the [API Worker](https://hireflow-api.baidpankaj567.workers.dev/health) handles application data and work. Release verification on 23 October 2026 (IST) passed: PDF-only signup, structured profile edits, plan/PDF review, one controlled form submission, tracking, prep, report, downloads, mobile and logout. Old-browser workspace transfer and replay rejection passed in a separate browser run. Production UI discovery made five separate searches and verified eight listings across Internshala, Wellfound and Greenhouse; source counts and original listing links are visible. The old Vercel origin is retained temporarily as a session-migration bridge.

The original specification is **not fully complete**. Read the [milestone audit](docs/milestone-audit.md) for implemented, partial, missing, and unverified requirements.

## Current application

| Component | Runtime / resource |
| --- | --- |
| React dashboard and private `/api` proxy | Cloudflare Pages project `hireflow-dashboard` |
| API, application queue consumer, recovery cron | Cloudflare Worker `hireflow-api` |
| Profiles, ownership sessions, jobs, applications, guides, reports | D1 database `hireflow` |
| Private uploads, versioned resume PDFs, HTML reports | Workers KV namespace `hireflow-files`; R2 adapter optional |
| Confirmed application work | Queue `hireflow-applications` and Browser Run |
| PDF extraction / text generation | Gemini / configured Groq or Gemini provider |

[Deployment and resource details](docs/cloudflare.md) include the actual bindings, secrets, quotas, commands, and verification status. No provider secret belongs in browser code.

## User flow

1. Upload a PDF and save the profile, or enter details manually. The browser receives a private session automatically; normal users enter no operator code or profile ID.
2. Review extracted facts and edit experience, projects, education, summary, links, certifications, achievements, and spoken languages. Set internship/job mode, target roles, locations, minimum compensation, excluded companies, weekly quota, and batch or individual review.
3. Choose **Find opportunities** or add an actual listing URL and full job description. Internship mode makes five separate source searches (Internshala, Wellfound, Greenhouse, Lever, LinkedIn); job mode makes four (Naukri, LinkedIn, Greenhouse, Lever). Candidates are verified in rotation, with up to eight accepted listings per search. Repeated listings are deduplicated; the UI shows per-site results, restrictions and original listing links. This is not a 100+ listing pool or authenticated portal integration.
4. Review the ranked plan, skill gaps, and PDF versions. Swap listings or change the selection. Confirm only the opportunities you authorize.
5. Track the result and any manual instructions. Open private resume versions, interview guides, and the weekly HTML report.

The deployed Worker uses **weighted lexical matching**, with aliases and cached scores. Its resume tailoring asks Groq to select verified profile facts and two or three relevant projects for each JD, then composes a mode-specific summary without accepting invented accomplishments. Provider failures use a visible deterministic fallback. Immutable PDF versions retain the method, model and profile version. It does not run FAISS/sentence-transformers; the separate Python embedding helpers are not part of that deployed path.

Automatic submission supports suitable forms; arbitrary employer portals, authenticated application systems, and durable multi-step checkpoints remain limited. There is no blanket guarantee that a listing can be applied to automatically. **Production email is not configured:** SendGrid/Resend integration exists, but a provider key and verified sender are still needed, and no real delivery is claimed.

## Existing workspace migration

The migration release routes old dashboard pages through a temporary bridge instead of mirroring the frontend. A signed-in old browser receives a single-use transfer valid for five minutes; Pages consumes it and creates a new private session. A signed-out browser reaches the Pages profile screen. **Continue an existing workspace** on Pages opens the same bridge. No ID/email-only login or operator-code prompt is used. Lost/expired sessions and a different device still require operator-assisted recovery. See [session migration](docs/cloudflare.md#existing-browser-session-migration).

## Local development

There are two independent backends. Cloudflare uses TypeScript/D1/KV; the original local/container path uses Python/FastAPI/PostgreSQL. They do not share database records automatically.

For the original Docker app:

```bash
cp .env.example .env
# Configure local provider keys and database settings.
docker compose up --build -d --wait
```

Open <http://localhost:3000>; FastAPI docs are at <http://localhost:8000/docs>. The Python API currently trusts numeric user IDs, so keep this path in a trusted local environment until authenticated ownership is added. [Container setup, persistence, and migrations](docs/deployment.md) explain the details.

For Worker/Pages development, use **Node 22 or newer** and follow [the Cloudflare guide](docs/cloudflare.md#local-development-and-checks). Python development requires Python 3.11+, the project virtual environment, dependencies, and Playwright Chromium; [workflow.md](docs/workflow.md) covers those commands.

## Checks

```bash
npm ci --prefix frontend
npm test --prefix frontend
npm run build --prefix frontend
npm ci --prefix cloudflare
npm run check --prefix cloudflare
# With the configured Python virtualenv and Chromium installed:
venv/bin/python -m pytest tests/ -v
```

Latest local checks: **294 Python tests, 274 Worker tests and 93 frontend tests passed**; typecheck, frontend build and Worker deploy dry run passed. Seven opt-in live tests were skipped by default; actual providers and the production browser flow were verified separately.

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

NST Engineering — HireFlow
