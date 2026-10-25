# Fresh setup and verification

Use a clean clone and **Node22+, Python3.11+ and Git**. Chromium is installed by
Playwright. PDF quality checks use Poppler (`pdftotext`, `pdftoppm`, `pdfinfo`).
On macOS install Poppler with `brew install poppler`; on Ubuntu install
`poppler-utils` and the dependencies reported by `playwright install-deps chromium`.
The normal resume renderer uses checked-in licensed fonts; no system font choice
or TeX installation is required by the normal API preview path. The legacy
XeLaTeX generator has its own optional TeX requirement.

Choose the runtime explicitly. **Cloudflare/D1 and Python/PostgreSQL are separate
applications/data stores**. Neither `.env` nor a numeric profile ID migrates an
existing workspace. Do not copy production databases/resumes into setup tests.

## 1. Clean clone and install

```bash
git clone https://github.com/pankajbaid567/hireflow.git
cd hireflow
python3.11 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-runtime.txt pytest pytest-asyncio
python -m playwright install chromium
npm ci --prefix frontend
npm ci --prefix cloudflare
```

On Linux, `python -m playwright install --with-deps chromium` can install the
browser's OS dependencies; that step requires the normal package-manager
permissions. Do not reuse a project `node_modules` or Python `site-packages`
directory as evidence of a clean install.

The minimal runtime omits PyTorch/sentence-transformers. Default tests and lexical
fallback do not download an embedding model. To explicitly use the Python
semantic pipeline, install the optional embedding dependencies, choose the
model, and set `SEMANTIC_MATCHING_ENABLED=true`; Docker exposes
`INSTALL_EMBEDDINGS=true` for that build. Model downloads/local compute are
separate from the Worker embedding binding. See [AI evidence](ai-evaluation.md).

## 2. Python API and dashboard

Copy `.env.example` to a private `.env`. Configure a local PostgreSQL database
and `DATABASE_URL`, or use a disposable SQLite file for local verification:

```bash
cp .env.example .env
# For an isolated SQLite verification only:
export DATABASE_URL=sqlite:///./data/fresh_setup.sqlite
mkdir -p data
python -m alembic upgrade head
python -m alembic check
python -m uvicorn src.api.main:app --host 127.0.0.1 --port 8000
```

The defaults in `.env.example` are not a substitute for a working PostgreSQL
server. For the original container path use `docker compose up --build -d --wait`
with the maintained [container guide](deployment.md); keep its volumes and
credentials separate from a disposable test. The Docker image copies the
checked-in font assets used by Python.

In another shell, activate the same environment and run:

```bash
npm run dev --prefix frontend
curl --fail http://127.0.0.1:8000/health
```

Open `http://localhost:3000/profile`. Vite proxies `/api` to the local API by
default. A manually entered synthetic profile works without provider keys; PDF
extraction needs the configured provider. Do not set `VITE_DEPLOYMENT_TARGET` for
the Python UI. Signup issues an HttpOnly ownership cookie, and `/session`
restores it. Save recovery keys before signing out; profile IDs/email addresses
are not credentials. Python explicitly lacks passkeys and the complete
Cloudflare immutable-answer/multi-step contract.

For an existing local owner without a session, use only the private filesystem
bootstrap in [account security](account-security.md); there is no public ID-login
workaround.

## 3. Cloudflare local checks

These default checks use isolated fixtures and local storage. They do not submit
an employer application or send email:

```bash
cd cloudflare
npx playwright-core install chromium
npm run check
cd ..
node scripts/verify_cloudflare_dashboard.mjs
node scripts/verify_account_security.mjs
node scripts/run_ai_evaluation.mjs
```

For an interactive local Worker, run `npm run db:local --prefix cloudflare` first.
Use `npm run dev --prefix cloudflare -- --local` to disable remote bindings.
Set `SEMANTIC_MATCHING_ENABLED=false` and `BROWSER_ENABLED=false` for offline
manual development using the local variable/configuration mechanism. Workers AI
inference and remote bindings consume real account usage when enabled; the
synthetic runtime tests above supply their own bindings rather than silently
contacting a production service. Keep local secret files ignored, and follow
[Cloudflare development configuration](cloudflare.md#local-development-and-checks)
for the API proxy origin and server-only bootstrap value.

## 4. New Cloudflare account versus existing deployment

The checked-in Wrangler resource IDs identify the maintained HireFlow deployment.
They must **not** be copied blindly to another account. A new operator must sign
in to the intended account, create their own D1/KV/Queue resources, replace those
bindings, configure allowed origins/public URL and the private required secrets,
then apply their D1 migrations before publishing. The AI binding does not make
FAISS run in a Worker; its application-level cap remains explicit.

The [Cloudflare deployment guide](cloudflare.md) supplies the current resource
inventory and ordered commands. Verify the authenticated identity, account,
resource and environment before a remote mutation. R2 is optional; do not enable
billing to follow the default setup. The frontend build for the maintained Pages site is
`npm run build:cloudflare --prefix frontend`, followed by the documented Pages
publication flow. On a different account/domain, override
`VITE_PREVIOUS_DASHBOARD_URL` with an empty value unless you own and have verified
a corresponding migration bridge; do not link new users to this project’s old
Vercel host accidentally. A successful dry run is not a deployment or complete live test.

The recorded P1 check used the existing account only for separate release work;
**no empty/new Cloudflare account bootstrap was executed as part of fresh setup**.
The new-account instructions are an operator walkthrough, not evidence that a
new account was created.

## 5. Verification and recorded result

```bash
python -m pytest tests/ -q
npm test --prefix frontend
npm run build:cloudflare --prefix frontend
npm run check --prefix cloudflare
node scripts/run_ai_evaluation.mjs
```

For a disposable migration drill only, run upgrade → downgrade base → upgrade →
schema check against the disposable database. **Never run `downgrade base` on
production** to imitate a setup test. CI separately exercises PostgreSQL16.

The actual [sanitized fresh-environment proof](evidence/fresh-setup.json), dated
23 October 2026, used a newly copied source tree, new Python venv and new
`node_modules` for both packages on the existing macOS host. It installed minimal
runtime/test dependencies and Chromium; SQLite upgrade/rollback/reupgrade/schema
check passed; **369 Python tests and 115 frontend tests passed**, with three
opt-in Python tests skipped. Worker typecheck, deployment dry run, Cloudflare
frontend build and the 120-case offline evaluation passed. A real localhost API
also started, created a synthetic manual profile/cookie, permitted its owner and
rejected anonymous and logged-out reads with 401. No provider call, deployment,
employer submission or email occurred.

That proof records an in-progress P1 source snapshot and its manifest hash; later
source changes require their normal final tests/CI. It is clean-environment
installation evidence on the same physical OS, **not an independent physical
machine, new Docker image or empty Cloudflare account claim**. Private logs are
kept at `/tmp/hireflow-fresh-setup-20261023-082934/`; public proof contains no keys,
cookies, private resumes or production user data.


A later [current-source SQLite recheck](evidence/p1-final-sqlite.json) also passed
upgrade → downgrade base → upgrade → schema check with migration 005 including
`applications.job_snapshot`. It used another disposable database and did not
alter the earlier fresh-install proof or any production data.


## Separate isolated Docker full-cycle proof

The [Docker/PostgreSQL proof](evidence/p1-docker-cycle.json) was verified on
**25 October 2026** against code `bd6fff2`. It used the isolated Compose project
`hireflow-p1-check` on ports 18000/13000, with Postgres 16, migration 005 and the
nonroot application user. All 75 checked backend source/font files matched the
current commit; the images were built on 23 October and remained healthy.

API-driven signup/confirmation through the actual nginx proxy created only a
synthetic workspace. The normal plan generated a private PDF whose Latin-accented
name and Devanagari project survived logical extraction and visual inspection.
In-container Chromium filled/uploaded/submitted the owned local fixture, reached
`applied` once, retained the confirmed job snapshot and status history, and
produced a two-round/four-question fallback guide and private HTML report/library.
A real host browser then restored that synthetic cookie, rendered the React
tracker/mobile navigation without document overflow or runtime errors, and signed
out through the UI; API and PDF reads subsequently returned 401.

No provider key was configured, semantic matching was deliberately disabled in
this minimal Docker image, and no employer request or email was sent. The separate
[real Python BGE/FAISS API proof](../evals/results/python-plan-real-model.json)
covers the optional semantic path; do not infer that it ran inside this image.
All three test containers and only this project's two named volumes were removed
after evidence was retained. No global Docker prune or production mutation was
performed. Private screenshots/PDF/proof remain under
`/tmp/hireflow-p1-docker-cycle-f33817de4c/`.
