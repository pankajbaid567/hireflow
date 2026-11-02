# Resume truth ledger

Purpose: every claim you might put on a resume, LinkedIn or in an interview, checked against evidence in this repository. **SAFE** = reproduced in this audit. **REWORD** = true only with the qualifier given. **DON'T CLAIM** = not supported or contradicted. I have not seen your resume; these are the claims the repo invites. Check your own wording against the rows.

## Authorship (read first)
`git shortlog` at the audit baseline (main @ cd2ac5d): **pankajbaid567 38 commits, five other contributors ≈ 25** (Bipul Shahi, Anant Jain (two identities), frenemy17, siddhanth-raikar, Anuj192006). This is a team repository. Write "built/led/owned **X**" only for parts you can show in `git log --author` and can explain line by line; otherwise "contributed to". Interviewers do run `git blame`. (F-016)

## Claims

| # | Claim | Verdict | Evidence / required wording |
|---|---|---|---|
| 1 | "Built a full-stack AI job-application assistant on Cloudflare (React, Workers, D1, Queues, KV, Workers AI)" | **SAFE**, with authorship caveat | Deployed stack matches `wrangler.jsonc`; 821 Worker tests pass in real workerd/Miniflare with real D1 migrations. Production deployment itself was **not re-verified** this audit (no `/health` version; Phase 0/3) — say "deployed", not "currently running version X" |
| 2 | "Human-in-the-loop auto-apply with duplicate-submission protection" | **SAFE** | Atomic conditional claim → `submitting` checkpoint → pre-click re-validation → uncertain ⇒ needs_action, never auto-resend. 12/20 mutation probes killed incl. the pre-click check; **five inner guards are not directly tested** (05-test-strategy). Say "three independent layers", not "proven" |
| 3 | "Applies to Internshala / Lever / Greenhouse automatically" | **DON'T CLAIM** | Submissions were certified only on **owned synthetic QA forms** (D-4). Real portals were deliberately not exercised. Say "supports Greenhouse/Lever-shaped forms, validated on owned fixtures" |
| 4 | "Finds 100+ relevant listings per cycle" | **DON'T CLAIM** | Measured live ceiling is lower (LinkedIn 429, Naukri empty); README says 100+ is unverified (D-1) |
| 5 | "Semantic job matching with BGE embeddings improved ranking by 36%" | **DON'T CLAIM that wording** | The +0.25 nDCG@3 is against a deliberately weak baseline. Defensible: *"On a 120-case synthetic benchmark (domain-split, thresholds frozen before inference), BGE-small + skill overlap raised heldout nDCG@3 from 0.70 to 0.95 (20 queries/10 domains; 95% CI of gain +0.13…+0.38) and beat BM25 by +0.12 (CI +0.08…+0.15). Labels are author-written and templated; not a hiring-outcome result."* |
| 6 | "Hybrid scoring beats pure semantic" | **DON'T CLAIM** | +0.005 nDCG@3, CI [0, +0.013] |
| 7 | "LLM never fabricates resume content (zero hallucination)" | **REWORD** | By construction the model only **selects fact IDs**; text is copied verbatim; 8/8 tailoring/truthfulness attacks blocked offline. Say "constrained so the model cannot author resume claims", not "zero hallucination" (the profile-extraction step *does* depend on a model reading a PDF and was measured on 6 live cases: 30/30 fields, a tiny sample) |
| 8 | "Prompt-injection hardened" | **REWORD** | 37 offline cases; 24 blocked, 6 gaps found and all 6 fixed and regression-tested this audit; the guard is a denylist plus isolation (no tools, no cross-user data). Say "tested against a prompt-injection corpus with an isolated, tool-less LLM", not "immune" |
| 9 | "LangGraph / LangChain / multi-agent orchestration" | **DON'T CLAIM** | Never imported; removed from `requirements.txt`. Real orchestration = Queue + idempotent checkpoints (ADR in 04-ai-genai-review §6). Honest line: "deliberately chose a queue + state machine over a graph framework" |
| 10 | "FAISS vector search / MiniLM" | **REWORD** | Production uses Workers AI BGE + D1 cached vectors; FAISS exists only in the Python reference path; default model is `bge-small-en-v1.5`, not MiniLM (F-015, D-2) |
| 11 | "Passkeys (WebAuthn) and recovery keys" | **REWORD** | Implemented with `@simplewebauthn/server`; origin/rpID pinned, single-use challenges, counter CAS (code-read). **Never exercised with a real authenticator in this audit** |
| 12 | "Secure multi-tenant design, no IDOR" | **SAFE** (scoped) | 39 dynamic probes, 0 leaks; per-feature isolation tests; resume-download gap closed. Say "tested", not "pen-tested"; one shared `ACCESS_CODE` still lets its holder log in as any user (F-022) |
| 13 | "SSRF-hardened URL fetching" | **SAFE** (after this audit) | 16/19 hostile URLs rejected before; now ports and wildcard-DNS names too. Redirects revalidated per hop |
| 14 | "821 Worker + 415 Python + 164 frontend tests" | **SAFE** | Reproduced at branch head; 4+3 opt-in skips disclosed |
| 15 | "CI/CD with GitHub Actions" | **SAFE** | 3 workflows (Node 22, Python 3.11, Postgres 16); now least-privilege + Dependabot. Not SHA-pinned; no CodeQL |
| 16 | "WCAG-compliant UI" | **REWORD** | 0 axe violations on 12 route/viewport scans after fixes; **no screen-reader testing**, authenticated data views not scanned. Say "axe-clean, keyboard-navigable", not "WCAG compliant" |
| 17 | "Cut costs / saved X hours / N users" | **DON'T CLAIM** | No usage, cost or user metrics exist in the repo |
| 18 | "Production-grade / zero downtime" | **DON'T CLAIM** | Queue has no DLQ and 100 retries (F-019); no uptime evidence; `/health` is shallow |
| 19 | "Reproduced byte-identical model artefacts" | **SAFE** | Reranker model rebuild matched (Phase 0) |
| 20 | "Mutation-tested critical invariants" | **SAFE** (honest form) | "Sampled 20 guard mutations: 12 caught, 5 on the submit path open as documented test gaps" — more credible than a score |

## Before sending a resume
- Pick **2–3** projects/claims you can defend for 10 minutes each (see `INTERVIEW_DEFENSE.md`).
- Link the repo only after the owner decisions are made: LICENSE, README claims (§ of README now links this audit), and the production-drift question.
