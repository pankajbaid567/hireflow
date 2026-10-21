# HireFlow AI

Career autopilot for students. HireFlow discovers jobs and internships, tailors your resume for each one, applies on your behalf, and gives you a prep guide - all in one weekly cycle.

NST Engineering - HireFlow
Framework: Build, Understand, Defend

---

## What Does HireFlow Do?

You tell HireFlow:
- Your resume and skills
- How many applications you want per week (e.g. 10)
- What roles you are targeting ("AI Engineer Intern", "ML Developer")
- Mode: Internship or Full-time Job

HireFlow then:
1. Imports openings with the Lever, Greenhouse, or generic career-page scrapers
2. Scores every listing against your profile and picks the best matches
3. Builds a weekly plan with versioned resume PDFs for your review
4. Lets you swap listings and select the applications you want to confirm
5. Applies to confirmed listings using Playwright, retaining a timestamped status trail
6. Flags CAPTCHAs, missing answers, and uncertain submissions for manual review
7. Builds interview prep guides and a weekly HTML report with skills to study
8. Supports explicit report delivery through configurable SendGrid or Resend

It also works in reverse - companies can use HireFlow to shortlist the best applicants from a pile of 100+ resumes.

---

## Two Modes

**Internship Mode**
- Targets internship listings (Internshala, Wellfound, LinkedIn internships, company pages)
- Filters by stipend range
- Resume and prep guide tuned for fresher and early-career profiles
- Interview prep covers lighter, shorter rounds typical of internship hiring

**Job Mode**
- Targets full-time job listings (LinkedIn, Naukri, Greenhouse, Lever, company pages)
- Filters by salary range
- Resume tailored for experienced or final-year profiles
- Interview prep covers multi-round structured hiring processes

The user selects a mode at profile setup. Both modes use the same core pipeline - scrapers, scorer, resume engine, application agent, and prep guide generator.

---

## Tech Stack

| What | Tool |
|------|------|
| Application Execution | FastAPI background tasks and Python agents |
| LLM | Groq (free), Gemini (free), Ollama (local), OpenAI or Anthropic (paid) |
| Web Scraping | Playwright and BeautifulSoup |
| Vector Matching | FAISS and Sentence Transformers |
| Backend API | FastAPI |
| Frontend Dashboard | React, Vite, React Router, Axios, and responsive CSS |
| Database | PostgreSQL |
| Resume Generation | ReportLab for dashboard previews; optional LaTeX pipeline |
| Email Delivery | SendGrid or Resend |
| Web Search | Tavily or SerpAPI |
| Deployment | Local Docker Compose; Railway/Render instructions prepared |

---

## Project Structure

```
hireflow-ai/
- src/
  - agents/        (Application, preparation, company research, report, shortlist)
  - scrapers/      (Job discovery scrapers - Lever, Greenhouse, generic)
  - pipelines/     (Match scoring, embedding, resume generation)
  - automation/    (Form filler, CAPTCHA handler)
  - api/           (FastAPI routes)
  - models/        (Data models - User, Job, Application, PrepGuide)
  - templates/     (LaTeX resume templates)
  - utils/         (Shared helpers)
  - config/        (Configuration and settings)
- tests/           (Unit and integration tests)
- notebooks/       (Exploration and experimentation)
- data/            (Sample data, fixtures)
- docs/            (Architecture diagrams, module docs)
- frontend/        (React dashboard)
- .env.example     (Copy to .env and fill in your keys)
- requirements.txt (Python dependencies)
- docker-compose.yml
- README.md
```

---

## Getting Started (Local Setup)

### Prerequisites
- Python 3.11 or higher
- Node.js 20.19 or higher (for frontend)
- Docker (optional but recommended)
- PostgreSQL

### Step 1 - Clone the repo
```bash
git clone https://github.com/pankajbaid567/hireflow.git
cd hireflow
```

### Step 2 - Set up Python environment
```bash
python -m venv venv
source venv/bin/activate

pip install -r requirements.txt
playwright install chromium
```

### Step 3 - Configure environment variables
```bash
cp .env.example .env
# Open .env and fill in your API keys
```

### Step 4 - Run with Docker (easiest)
```bash
docker compose up --build -d --wait
```

Or run manually:
```bash
alembic upgrade head
uvicorn src.api.main:app --reload
```

In another terminal, run `cd frontend && npm ci && npm run dev`. Open
<http://localhost:3000>; API documentation is at <http://localhost:8000/docs>.
For a local SQLite setup, set `DATABASE_URL=sqlite:///./hireflow.db` before
running migrations and the API. Docker uses PostgreSQL automatically.

See [the workflow guide](docs/workflow.md) for discovery, API routes, provider
configuration, and test commands. See [deployment instructions](docs/deployment.md)
for container setup, migrations, backups, and future Railway/Render deployment.
No public deployment has been created.

Note: Docker is optional for development. Students working on individual modules only need steps 1 to 3. Docker is required for deployment.

---

## Pod Structure

| Role | Count | Responsibility |
|------|-------|----------------|
| Maintainer | 1 | Repo architecture, PR reviews, LangGraph orchestration, integration |
| Contributor 1 | 1 | M2 - Job Discovery Engine |
| Contributor 2 | 1 | M3 and M4 - Match Scorer and Resume Tailoring |
| Contributor 3 | 1 | M5 and M4 - Application Automation Agent |
| Contributor 4 | 1 | M6 and M7 - Prep Guide Generator and Weekly Report |

---

## Milestones (8 Sprints, around 3 days each)

| # | Milestone | Key Output |
|---|-----------|------------|
| M1 | Project Scaffold and User Onboarding | DB schema, profile model, profile intake API |
| M2 | Job Discovery Engine | Scrapers for 3 portal types and spam classifier |
| M3 | Job-Profile Match Scorer | Embedding pipeline, FAISS, multi-factor scorer |
| M4 | Weekly Quota Selector and Resume Engine | Top-N selector and LaTeX resume generator |
| M5 | Application Automation Agent | Playwright form filler and error recovery |
| M6 | Preparation Guide Generator | Interview rounds prediction, resources, mock questions |
| M7 | Weekly Report and Hiring Side Module | Email report and hiring shortlist agent |
| M8 | Dashboard, Integration and Demo | React dashboard, end-to-end testing, demo video |

---

## How to Contribute

Read CONTRIBUTING.md for the full workflow. Short version:

1. Find an open issue assigned to your milestone
2. Comment "I am working on this" to claim it
3. Create a branch: `git checkout -b feature/your-feature-name`
4. Write your code, commit with clear messages
5. Open a PR, Maintainer reviews, merge only when all criteria are met

AI tools are allowed. But you must be able to explain every decision in your code. If you used LangChain, know why. If you chose FAISS over ChromaDB, know why.

---

## Milestone Q&A (Accountability Sessions)

Every 2 to 3 days, students sit with faculty for a short Q&A on what was built in that sprint:
- Contributors: Why this solution? What other approaches exist?
- Maintainer: Why did you approve this PR? What did you check?
- Faculty probes: Edge cases, error handling, design decisions

---

## Links

- Project Board - HireFlow Sprint Tracker (add GitHub Projects link)
- Issues (add GitHub Issues link)
- Blueprint - Full Spec (hireflow-ai-blueprint)

---

NST Engineering - HireFlow
Framework: Build, Understand, Defend
