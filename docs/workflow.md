# HireFlow workflow and verification

The dashboard runs at `http://localhost:3000`, with API docs at
`http://localhost:8000/docs`. Docker setup is described in
[deployment.md](deployment.md). All application submission tests use local HTML
forms; email and search tests use mocked providers. Explicit live tests exercise
the configured LLM while keeping every application submission local.

## Using the application

1. Create a profile at `/profile`, entering skills, mode, quota, contact details,
   and optionally a PDF. Save the returned profile ID; the browser also remembers
   it. Name/email/mode fields supplied with a PDF take precedence over extraction.
2. Import listings with the existing scrapers. For example, run
   `python -m src.scrapers.lever_scraper --help` or
   `python -m src.scrapers.greenhouse_scraper --help` for their URL options.
   Discovery runs explicitly; opening the dashboard does not scrape arbitrary sites.
3. Open `/weekly-plan`. The backend scores eligible listings for the selected
   mode and prepares resume PDFs before confirmation. Preview a PDF, swap a job
   with an alternative, and select the jobs you want to apply to.
4. Click **Confirm and Apply**. The application pipeline generates prep guides,
   submits supported forms, and records outcomes independently for each listing.
5. Use `/applications` for current status, reasons, manual-action URLs, and prep
   guides. `/resumes` retains all generated PDF versions. Editing a profile makes
   draft resumes require another review; previously submitted PDFs are retained.
6. Open `/reports` to generate or view the weekly report. Report generation also
   runs after a confirmed application batch finishes. Delivery is explicit:
   `POST /report/{user_id}/latest/email` sends to the profile's saved email using
   the configured provider. Generating or viewing a report does not send email.

Weekly cycles start on Monday in UTC. Confirmed, processing, applied, failed, and
manual-action applications consume the quota for their cycle. Old unconfirmed
drafts are revalidated and carried forward; expired, blocked, spam, mismatched-mode,
or excess drafts are removed with an audit reason. An already applied listing is
never submitted again by refreshing the weekly plan.

## API map

| Feature | Endpoint |
| --- | --- |
| Create/update/read profile | `POST /profile`, `PATCH /profile/{id}`, `GET /profile/{id}` |
| Weekly plan and alternatives | `GET /weekly-plan/{user_id}` |
| Swap a listing | `POST /weekly-plan/{user_id}/swap` |
| Confirm selected jobs | `POST /weekly-plan/{user_id}/confirm` |
| Paginated application tracker | `GET /applications/{user_id}?status=needs_action&page=1&page_size=20` |
| Structured prep guide | `GET /applications/{application_id}/prep-guide` |
| All resume versions | `GET /resumes/{user_id}` |
| Preview/download a PDF | `GET /resumes/{user_id}/{application_id}/download?version=1` |
| Generate/latest report | `POST /report/{user_id}/generate`, `GET /report/{user_id}/latest` |
| HTML report | `GET /report/{user_id}/latest/html` |
| Explicit email delivery | `POST /report/{user_id}/latest/email` |
| JSON or CSV applicant shortlist | `POST /hiring/shortlist` |
| API and database readiness | `GET /health` |

Shortlisting accepts `applicants` as an array or a CSV string with `name` and
`skills` headers. Quote comma-separated skills in CSV, or separate them with
semicolons. Ties preserve applicant input order. Candidates without matching
skills are omitted instead of presenting them as qualified matches.

## Providers and recovery

The models verified against the supplied accounts on 2026-10-21 are:

| Provider | Configuration | Key variable |
| --- | --- | --- |
| Groq | `LLM_PROVIDER=groq`, `GROQ_MODEL=openai/gpt-oss-20b` | `GROQ_API_KEY` |
| Gemini | `LLM_PROVIDER=gemini`, `GEMINI_MODEL=gemini-3.8-flash` | `GEMINI_API_KEY`, with `GOOGLE_API_KEY` accepted as a fallback |

The local `.env` and application defaults select Groq and retain the verified
Gemini model for switching providers. Gemini uses the `google-genai` SDK's
Interactions API with `store=False`; `GEMINI_API_KEY` takes precedence when both
key names are configured. Restart the API after changing provider settings.

Configure a valid LLM provider for resume-only profile extraction and written
application answers. Manual profiles work without an LLM; resume previews use
the profile's supplied facts and prioritize JD-relevant skills/projects. Original
uploaded resume text is retained when structured experience is unavailable.
Programmatic callers can inject an LLM into `ResumeService` and `PrepGuideAgent`
to add summary/question generation. Generated summaries never change the supplied
experience, education, or skills.

Tavily or SerpAPI supplies current resources and company information. Broken links
are skipped; if too few accessible sources exist, the guide includes a warning.
Company facts retain source URLs; absent facts are marked unknown. News requires
a usable publication date within the last 90 days. Candidate interview reports
are attributed to Glassdoor or AmbitionBox, and absent reviews receive fallback
preparation guidance.

The application agent detects CAPTCHA challenges and returns `needs_action` with
`CAPTCHA detected`. It never solves them. Unknown required answers also require
manual action. Temporary pre-submission network failures use exponential backoff
with three total attempts by default. Missing forms/selectors fail after one
attempt. After a submit click, an unconfirmed outcome requires manual review;
the agent avoids blindly retrying a potentially accepted submission.

The current executor uses FastAPI background tasks in a single service. Keep the
API running until batches finish. If the process is interrupted mid-submission,
review any `applying` records against the external site before retrying. Interview
round estimates are preparation guidance, with explicit JD details taking priority.

## Tests

```bash
pytest tests/ -v
cd frontend
npm ci
npm test
npm run build
npm audit
```

The backend suite includes real Chromium form filling/PDF uploads, CAPTCHA and
retry fixtures, state-history and pagination checks, source-search and email
provider mocks, matching/shortlist tests, quota rollover/concurrency safeguards,
and API-to-browser application/report integration. Frontend tests cover profile
submission, mode selection, failures, plan swaps/confirmation, resume preview,
tracker pagination, guide sections, reports, and navigation.

Live LLM testing is explicit: run `RUN_LIVE_LLM_TESTS=1 pytest
tests/test_llm_client.py -k live -v` with a working provider key. The default suite
does not require external credentials or contact real applicants or recipients.

The provider-to-application integration tests also accept an explicit opt-in:

```bash
RUN_LIVE_E2E_TESTS=1 pytest tests/test_live_e2e.py -v
```

Each provider case extracts a profile from a synthetic PDF and answers a written
question during a local Chromium submission, then verifies the saved status,
resume, prep guide and report. Keys are read from `.env` and are not printed.

Both live provider cases passed on 2026-10-21:

| Provider and primary model | Application-level LLM calls | Verified flow | Duration |
| --- | --- | --- | --- |
| Groq `openai/gpt-oss-20b` | 2 | PDF-only profile extraction, written form answer, actual PDF upload/submission, applied status, prep guide and report | 6.42s |
| Gemini `gemini-3.8-flash` | 2 | The same complete API/PDF/Chromium/application/report flow | 101.07s |

Both cases kept their configured primary model throughout. Gemini also returned
temporary upstream 503 responses and variable latency during earlier checks;
retry live verification later if the provider is temporarily unavailable. The
successful test reports were saved as `/tmp/hireflow-live-groq-e2e.xml` and
`/tmp/hireflow-live-gemini-e2e.xml`.

## Browser dashboard verification

`scripts/verify_dashboard.py` drives the real React frontend, API, PostgreSQL and
application browser together. It creates a synthetic profile through the UI,
uploads a PDF, tests mode/quota selection, previews and swaps a resume, confirms
one successful application and one CAPTCHA fixture, filters the tracker, opens
a prep guide/question and report, and downloads every generated PDF. It also
checks mobile navigation, horizontal overflow and browser runtime errors.

Use an isolated Compose project with ports 3000, 8000 and 8899 available. The
extra loopback port serves the local HTML fixtures from inside the API container;
it lets both the application browser and the dashboard's manual-action link
reach the same test page.

```bash
cat > /tmp/hireflow-dashboard-test.yml <<'YAML'
services:
  api:
    ports:
      - '127.0.0.1:8899:8899'
    environment:
      LLM_PROVIDER: groq
      GROQ_MODEL: openai/gpt-oss-20b
      TAVILY_API_KEY: ''
      SERPAPI_API_KEY: ''
      SENDGRID_API_KEY: ''
      RESEND_API_KEY: ''
YAML
docker compose -p hireflow-dashboard-check -f docker-compose.yml -f /tmp/hireflow-dashboard-test.yml up --build -d --wait
venv/bin/python scripts/verify_dashboard.py --compose-project hireflow-dashboard-check --live-llm --output-dir /tmp/hireflow-dashboard-proof
docker compose -p hireflow-dashboard-check down
```

`--live-llm` uses the configured Groq key for the required written answer on the
local form. Omit it to supply a deterministic answer and run without provider
requests. This check never sends email or submits to external job sites. The
output directory contains `result.json`, the synthetic input PDF, and desktop
and mobile screenshots. Existing test volumes are retained after shutdown; use
a new project name for a separate empty test database.

Verified on 2026-10-21 with **Groq `openai/gpt-oss-20b`**: the complete browser
flow passed, including `applied` and `needs_action` outcomes, three downloadable
PDFs, nine screenshots, zero JavaScript runtime errors, and no horizontal page
overflow at 1440px and 390px. The updated API image's default suite passed
**293 tests with three live-provider tests skipped**.

## Issue coverage

| Issues | Implementation | Main tests |
| --- | --- | --- |
| 14–15 | Application agent, semantic form filler, CAPTCHA detection, retries | `test_automation.py`, `test_e2e.py` |
| 16 | Transactional state history, tracker and artifact APIs | `test_status_logger.py` |
| 17–18 | Interview rounds, topic analysis, resources, JD-specific questions | `test_prep_guide.py` |
| 19 | Attributed company research and persisted interview guidance | `test_company_intel.py` |
| 20 | Weekly metrics, insights/study plan, database and HTML reports | `test_report.py` |
| 21 | SendGrid/Resend delivery, bounded attachments/download links, timestamps | `test_email_service.py` |
| 22 | Shared-scorer JSON/CSV shortlisting and database persistence | `test_hiring_shortlist.py` |
| 23–25 | Responsive React dashboard and connected views | Frontend Vitest suite |
| 26 | Container startup, migrations, health checks, deployment guide | PostgreSQL/SQLite migration checks, Compose smoke checks, `test_e2e.py` |

Public Railway/Render deployment remains intentionally unperformed. The API
currently identifies profiles by ID; it is intended for a trusted local/private
workspace. Configure authenticated access before offering it as a public
multi-user service.
