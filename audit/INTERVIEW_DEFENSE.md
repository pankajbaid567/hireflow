# Interview defense notes

Answers are written for the questions in `MILESTONES.md` ("Defense Questions"), grounded in what this audit verified. Each has **say** (what you can defend), **evidence** (where to point), and **don't say** where the repo contradicts a tempting answer. Practise saying the *limits* out loud; interviewers reward calibrated claims over inflated ones.

## Thirty-second pitch
"HireFlow turns a PDF resume into a reviewed weekly application plan: it ranks listings, builds a truthful per-job resume where the model can only *pick* facts you already stated, asks you to approve the exact PDF and answers, and then submits through a queue with duplicate-submission protection. It runs on Cloudflare Workers, D1 and Queues. I audited it end to end, measured the matching benchmark honestly against stronger baselines, and fixed what I found."

## Architecture and ownership (M1, M8)
- **Q: Walk through intake → DB.** *Say:* upload (≤3 MB, `%PDF-` check) → Gemini extracts JSON → server **sanitises and bounds** every field (links must be http(s), numbers clamped, collections capped — hardened in this audit, F-041) → profile saved with a `profile_version`, session cookie issued (HttpOnly, Secure, Lax, 30 d, token stored hashed). *Evidence:* `intelligence.ts extractProfile`, `profile.ts`, `audit-hardening.test.ts`. *Don't say:* the model output is trusted.
- **Q: Why Alembic?** *Say:* forward/back, reviewable history, CI runs `upgrade head → downgrade base → upgrade → check`; this audit added revision 007 and verified it on Postgres 16 including de-duplicating existing rows. Worker side uses 21 forward-only D1 SQL migrations (no downgrade — a stated limitation).
- **Q: How does `mode` flow?** *Say:* it changes search sources (5 for internship, 4 for job), experience scoring defaults, compensation unit (monthly stipend vs annual salary), summary wording and prep-question level. *Evidence:* `scoreMatch`, `tailorResume`, `prep_intelligence.ts`.
- **Q: LangGraph / agents? (M8-2)** *Say:* "I did not use it — deliberately." The orchestration is a queue with idempotent checkpoints; a graph runtime would add a Python framework in front of a TypeScript Worker. It's documented in an ADR. *Don't say:* any claim of multi-agent coordination. *Evidence:* 04-ai-genai-review §6; `requirements.txt` cleaned.
- **Q: Add a new portal?** *Say:* source adapters (`dynamic_source.ts`, Ashby adapter test) and a form-adapter layer; discovery is separate from submission, and unsupported portals degrade to `needs_action` with a manual link.

## Scraping and discovery (M2)
- **Playwright vs Selenium, infinite scroll:** bounded public-JS reading with a host allowlist and a request budget (24 fetches/task); I'd pick Selenium only for legacy grid/browser matrices. *Don't say* it handles arbitrary JS portals — only an owned synthetic host is verified.
- **Rate limiting / bans (Q4):** *Honest:* the Python scraper uses a flat per-process sleep, not per-domain (F-012); the Worker path uses shared per-host reservations and daily budgets (`discovery-reservations.test.ts`).
- **Selector drift (Q5):** *Honest:* adapters fail closed to "unsupported/needs action" rather than guess; there is no automatic selector self-healing.
- **Spam false positives (Q3):** the Python filter threshold is 0.7 (`settings.py`); the Worker treats spam as an evidence-quality factor worth 5% of the score, never prestige. No measured false-positive rate exists — say so.

## Matching (M3)
- **Which model, how evaluated?** *Say:* BGE-small (CLS pooling, 384-d) as a **re-ranker over a skill-overlap score** (technical factor = 0.8·skill coverage + 0.2·cosine). Evaluated on a 120-case synthetic benchmark with frozen thresholds and a domain split: heldout nDCG@3 0.70 → 0.95; vs BM25 +0.12 (CI +0.08…+0.15). *Limits to volunteer:* author-written, templated labels; effective n = 10 domains; Recall@1 is capped at 0.5 by construction; hybrid ≈ semantic-only. *Don't say:* "36% better".
- **Why FAISS? (Q2)** *Honest:* production doesn't use FAISS — it caches vectors in D1 and uses Workers AI; FAISS is the Python reference path. Chroma would win with a managed persistent store and metadata filtering.
- **Why 40% for skills? (Q3)** *Honest:* the 40/20/15/10/10/5 weights are product judgement, not fitted to outcomes; they're pinned by tests (a mutation to 50% is caught) and have no learning-to-rank evidence behind them. Say what you'd do: collect accept/reject feedback and fit weights.
- **Ties (Q4):** deterministic by job/application ID (`(-score, job_id)`).
- **"0 to 1 years preferred" for a fresher (Q6):** the parser reads min 0 / max 1; `experienceFit` returns 1 for 0 years. After this audit, "our mentors have 10 years of experience" no longer counts as a requirement (it previously dropped a fresher's score 0.75 → 0.61: a bug I found by property testing).
- **Chunking (Q5):** *Honest:* none — whole-JD embedding; short JDs simply embed short.

## Resume and approval (M4)
- **How are 2–3 projects chosen? (Q1)** deterministic ranking by required-skill overlap (5 points per matched skill, 1 per tech overlap), optionally an LLM that returns **IDs only**, validated against the catalog. 0 matching projects ⇒ falls back to facts you stated; with no facts it says so rather than inventing (`no_source_facts`).
- **LaTeX vs ReportLab (Q2):** *Honest:* ReportLab was chosen (no TeX toolchain on Workers/containers); LaTeX was the spec — scope change D-3. Trade-off: less typographic control, easier deterministic build and Unicode-font embedding.
- **Why always confirm? (Q7)** wrong-company or stale-resume submissions are irreversible; approval is bound to the exact PDF version + answers + profile version + listing text, revalidated before the click.
- **Change a company after resumes exist (Q6):** a review that is revoked, expired, or bound to an older PDF/profile version cannot be claimed by the queue (tested in `review-workflow` and `tasks`; I did not trace the exact swap UI path, so check it before describing the swap mechanics).

## Automation (M5)
- **Page 3 of 4 fails (Q1):** the checkpoint is stored encrypted and phase-forward-only; resumable at a step boundary, but **once `submitting` is written, an unclear outcome becomes `uncertain → needs_action` and is never auto-resent**.
- **CAPTCHA (Q2):** detected by selector/iframe; stops and hands the user a manual URL; solving CAPTCHAs is out of scope and prohibited.
- **Anti-detection (Q3):** *Honest:* none, by design — only a user-agent; this system is a human-approved assistant, not a stealth bot.
- **Retries (Q4):** *Honest:* queue `max_retries: 100`, concurrency 1, **no dead-letter queue** (F-019) — this is the first thing I'd change; also `retry_delay` is 40 s.
- **Two portal shapes (Q5):** adapters plus a shared fill/validate engine; verified on Greenhouse- and Lever-shaped **owned** forms only.

## Preparation, reports, hiring (M6, M7)
- **Rounds when the JD is silent (Q1/Q5):** labelled **estimates** (internship default 2, job 3, +1 for enterprise) with `source: estimated`; explicit JD or career-page text is quoted as evidence. Never presented as company fact.
- **Broken/paywalled links (M6-2):** `accessible()` HEAD/GET + redirect revalidation; broken ones are skipped and fewer-than-two is warned (fixture-tested; live resource quality unmeasured).
- **JD-specific questions (M6-3):** questions must overlap JD requirement terms; invented candidate history, URLs, markup and instruction-like text are rejected (hardened here); fallbacks are templates quoting the JD. Known weakness: behavioral fallback questions had an 87.5% cross-case duplicate rate.
- **Zero reviews (M6-4):** output says "No interview reviews found" and gives fallback guidance — verified.
- **Hiring fairness (M7-3):** *Honest:* ranking is skill-overlap based and can disadvantage non-traditional backgrounds; there is no bias analysis. Say you'd add structured evidence, human review and disparate-impact tests.
- **Email readability (M7-1):** report is HTML with links; **delivery is unverified** — no Gmail credentials were available; a queued/accepted email is not an inbox receipt.

## Retrospective (M8-4…6)
- **Do differently:** split `ACCESS_CODE`'s three roles; add a DLQ before launch; commit to one backend (Worker) and freeze the Python path; keep the eval's labels independent of the generator.
- **Hardest edge case:** the click-then-lose-the-response case. Solution: durable `submitting` marker *before* the click, forward-only checkpoint SQL, uncertain ⇒ stop.
- **Silent failure in production:** a stuck queue with no DLQ; "email accepted" mistaken for delivery; deployed-vs-main drift (the Worker `/health` exposes no version — F-005). Detection: DLQ + alert, delivery webhooks (signed, 5-minute tolerance), and a `/health` that reports build SHA and probes D1/KV/Queue.

## Questions about *this audit* (they will ask)
- "How do you know the tests are meaningful?" → 20 hand-made guard mutations: 12 caught, 1 equivalent, 2 real gaps closed, 5 on the submit path still documented gaps. Offer the script.
- "What did you get wrong?" → my first "blocked" injection result was a false pass (a control case exposed it); my first experience-parser test encoded the bug as the expected value; four mutation 'kills' turned out to be an unrelated flaky test.
- "What would you not ship?" → real-portal auto-submit, hiring ranking without a fairness review, and any claim of production health without a version-bearing `/health`.
