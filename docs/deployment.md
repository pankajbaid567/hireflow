# Running and deploying HireFlow

## Current public deployment target

The live frontend is **Cloudflare Pages**, project `hireflow-dashboard`, at [hireflow-dashboard.pages.dev/profile](https://hireflow-dashboard.pages.dev/profile). The live API Worker is [hireflow-api.baidpankaj567.workers.dev](https://hireflow-api.baidpankaj567.workers.dev/health). Release verification passed on 23 October 2026 (IST): public availability/private ownership, the complete controlled Pages UI application cycle, and a separate old-cookie migration/replay/logout browser run. Pages deployment is `115fbb66`; Worker version is `a16cf206-9a60-4bf7-8979-b3f29bc2da49`, with D1 migrations through `0003`. No real employer application or email was sent during QA.

| Resource | Actual project / binding |
| --- | --- |
| Dashboard / private `/api` proxy | Pages `hireflow-dashboard`; service binding `API=hireflow-api` |
| API / queue / recovery cron | Worker `hireflow-api` |
| SQL state | D1 `hireflow`, binding `DB` |
| Private PDFs/uploads/reports | KV `hireflow-files`, binding `FILES_KV` |
| Application dispatch | Queue `hireflow-applications`, binding `APPLICATION_QUEUE` |
| Browser | Browser Run binding `BROWSER` |
| Old browser session transfer only | `https://hireflow-blue-seven.vercel.app/api/workspace-migrate` |

Follow [the Cloudflare guide](cloudflare.md) for the complete Pages/Worker deployment commands, variables, secrets, resource IDs, limits, private sessions, migration flow, and release verification. The legacy Vercel site is retained temporarily so an already signed-in browser can transfer its workspace with a five-minute, single-use token. It is no longer the preferred frontend target; it does not expose an operator-code prompt or email/ID-only login.

The source repository is [pankajbaid567/hireflow](https://github.com/pankajbaid567/hireflow), current branch `main`. Source publication and application deployment are separate operations. The [milestone audit](milestone-audit.md) records remaining acceptance gaps. Production email is **not configured/verified**; generating a report does not send it.

The sections below cover the independent, original **Python/Docker** runtime. They do not describe the live Worker's D1/KV database or execute Python on Cloudflare.

## Local Docker deployment

Requirements: Docker Desktop or Docker Engine with Compose 2.24+, and available
ports 3000 and 8000. PostgreSQL is private to the Compose network.

```bash
cp .env.example .env
# Configure your chosen LLM, search and email providers in .env.
docker compose up --build -d --wait
curl --fail http://localhost:8000/health
curl --fail http://localhost:8000/docs
curl --fail http://localhost:3000/
```

Open <http://localhost:3000>. The frontend forwards `/api` requests to the API,
which listens at <http://localhost:8000>. PostgreSQL must pass its readiness
check before database migrations run; the API must pass its health check before
the frontend starts. API startup runs `alembic upgrade head` and exits on a
migration failure.

```bash
docker compose logs -f api
docker compose exec api alembic current
docker compose exec db psql -U postgres -d hireflow
docker compose down
```

Named volumes `application_data` and `postgres_data` retain resumes, reports and
database records after `docker compose down`. Do not use `down -v` if you need
to keep them. The API runs as a non-root user and keeps Playwright Chromium in
the image. Weekly-plan resume generation uses ReportLab, so TeX Live is not
required in the container. The original standalone LaTeX `PDFGenerator` requires
XeLaTeX if used separately.

The default image includes all API, form automation, scraper and LLM provider
dependencies. Semantic embeddings are an optional standalone pipeline; to use
it inside the image, set `INSTALL_EMBEDDINGS=true` in `.env` and rebuild. This
installs CPU-only PyTorch and sentence-transformers. Its first execution also
downloads the configured embedding model. Full local development dependencies
remain available in `requirements.txt`.

## Configuration

Every setting is documented in `.env.example`. The API container receives the
entire local `.env` through `env_file`; the frontend image receives no private
provider credentials. Compose overrides `DATABASE_URL` with its internal
PostgreSQL address and stores files under `/app/data`. Set
`POSTGRES_PASSWORD` before first startup; changing it later requires changing
the existing PostgreSQL user's password as well.

`PUBLIC_BASE_URL` must be an externally reachable API URL for email download
links. `ALLOWED_ORIGINS` is a comma-separated list of frontend origins.
`VITE_API_URL` is a frontend build/development setting, not a secret. The
standard Docker build uses the same-origin `/api` proxy. For frontend development,
set it in `frontend/.env.local` or export it before `npm run dev`; the root `.env`
is read by the API and Compose. Custom development proxy targets can be supplied
with `API_PROXY_TARGET=http://your-api:8000 npm run dev`.

At least one configured LLM provider is required for live resume extraction and
free-text form answers. Tavily or SerpAPI is required for live resource and
company searches. SendGrid or Resend requires a key and verified `FROM_EMAIL`
for actual delivery. Missing provider credentials produce useful configuration
errors or documented fallback results. Tests use fixtures and provider mocks;
they do not send application forms or emails to real recipients.

## Validation

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements-runtime.txt pytest pytest-asyncio
playwright install chromium
pytest tests/ -v
cd frontend
npm ci
npm test
npm run build
```

`tests/test_e2e.py` covers profile creation, ranking/weekly planning, local form
confirmation and tracking. It uses an isolated database, local forms and mocked
external integrations. The GitHub workflows run backend tests, Playwright,
PostgreSQL migration upgrade/downgrade checks and the frontend test/build.

Local verification on 2026-10-21: all three Compose services became healthy;
API docs, SPA routes and the frontend API proxy returned HTTP 200. The complete
React UI flow against PostgreSQL uploaded a PDF, previewed/swapped a plan,
used Groq `openai/gpt-oss-20b` for a written answer, submitted a local form
through Chromium, detected another fixture's CAPTCHA, and displayed the saved
status history, prep guide, HTML report and three downloadable PDFs. Desktop
and mobile checks recorded zero browser runtime errors or horizontal page
overflow. The updated API image passed **293 tests, with three optional live
tests skipped**, running as its non-root user. PostgreSQL and SQLite migrations
passed upgrade/downgrade/upgrade and schema-drift checks, including legacy-row
preservation. Reproduction commands and screenshot output are described in
[workflow.md](workflow.md#browser-dashboard-verification). Test services were
stopped afterward; their named volumes were retained.

Separate opt-in live API/PDF/Chromium tests passed with both Groq
`openai/gpt-oss-20b` and Gemini `gemini-3.8-flash`, using two application-level
LLM calls per provider. Provider configuration, SDK details and timings are
recorded in [workflow.md](workflow.md#providers-and-recovery).

Before upgrading an existing installation, back up PostgreSQL and file storage.
Migration `003` retains existing application states and imports a starting
status event for each old application. The new weekly-report uniqueness rule
requires one report per user and week. If an old database contains duplicate
reports for the same `(user_id, week_start_date)`, reconcile those rows before
migration; the migration deliberately does not discard them. Downgrading
`003` maps its new workflow states to the legacy `pending` status and removes
the new fields/tables; restore a backup if you need their data afterward.

## Railway or Render deployment

This is an optional alternative to the Cloudflare deployment. No Railway or Render deployment is claimed. Running these steps publishes a separate Python/container service and requires an explicitly chosen target.

1. Provision a PostgreSQL 16 service. Backups are recommended for persisted
   applications. Copy its private connection URL to the API's `DATABASE_URL`,
   using the `postgresql+psycopg2://` scheme for the installed database driver.
2. Create an API Docker service from the repository root and `Dockerfile`.
   Configure the variables from `.env.example`, set `APP_ENV=production` and
   `DEBUG=false`, and add a persistent disk/volume mounted at `/app/data`.
   Ensure that volume is writable by the image's user with UID `10001`.
   Set `LOCAL_STORAGE_PATH=/app/data` and `FAISS_INDEX_PATH=/app/data/faiss_index`.
   The Docker start command honors the platform's `PORT` and runs migrations.
3. Set the API health-check path to `/health`. Set `PUBLIC_BASE_URL` to the
   generated HTTPS API domain and `ALLOWED_ORIGINS` to the frontend HTTPS
   domain. Provider keys are runtime secrets on the API service.
4. Deploy `frontend` as a static site: build command `npm ci && npm run build`,
   publish directory `dist`, and build variable `VITE_API_URL` set to the API's
   HTTPS domain. Configure SPA fallback to `/index.html`. Alternatively deploy
   its Docker image with an nginx proxy adjusted to the hosted API address.
5. Verify `/health`, `/docs`, frontend routes, resume downloads, and a local or
   designated test application. Configure a verified email sender before
   testing report delivery.
6. Record the resulting public API and frontend URLs here only after deployment
   succeeds and both are reachable without local networking.

To redeploy, rebuild the API and frontend from the desired revision, preserving
the database and `/app/data` volumes. Run migrations on one API instance before
scaling out; concurrent migration runners are not supported. With Railway CLI,
the future explicit publish command is `railway up` after selecting the correct
project/service. Render can rebuild an explicitly selected service from its
dashboard. Automatic deploys should be configured only when intended.

Provider references: [Railway health checks](https://docs.railway.com/deployments/healthchecks),
[Railway persistent volumes](https://docs.railway.com/volumes), and
[Render SPA rewrites](https://render.com/docs/redirects-rewrites).
