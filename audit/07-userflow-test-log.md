# User-flow test log

Environment: **local only** (Miniflare Worker + real Pages proxy + built SPA + Chromium), synthetic users, outbound stubbed. No production accounts, no real email, no submission to any employer. Status taxonomy: VERIFIED (run here, passed) · FIXED (failed, fixed, re-run) · NOT RUN (reason).

| # | Flow | How | Result |
|---|---|---|---|
| 1 | First visit → profile form renders under the new CSP | Chromium desktop + mobile | VERIFIED, 0 CSP/console errors |
| 2 | Sign up through the real form (name/email/skills/roles/quota → Save) | Playwright, UI | VERIFIED: 201, cookie `hireflow_session` (HttpOnly, Secure, Lax), `GET /session` → authenticated |
| 3 | Navigate by link and by full reload / direct URL to `/weekly-plan` | Playwright | VERIFIED: session and profile restored each time |
| 4 | Signup rate limit (6th signup from one IP in 10 min) | UI | VERIFIED: 429 shown as a visible alert |
| 5 | Visit all 6 routes, both viewports, with axe | Playwright | FIXED: 49 violations → 0 |
| 6 | Keyboard traversal (12 Tabs per route) | Playwright | VERIFIED: visible focus on every stop |
| 7 | Anonymous empty state on mobile | screenshot | FIXED (overlapping button) |
| 8 | Cross-user resume download via own path (M11) | integration test | VERIFIED: 404, no PDF bytes; owner gets 200 |
| 9 | Foreign vs missing application prep-guide | integration test | FIXED (distinguishable → identical 404) |
| 10 | Python duplicate application rows → migration | Postgres 16 | VERIFIED: 3 → 1, `alembic check` clean, downgrade/upgrade round-trip |
| 11 | Hostile model output / JD injection through real Worker functions | offline mocks | 37 cases; 6 not blocked → F-037/039/040/041 fixed and re-tested |
| 12 | Upload a real PDF, extract with a live LLM | — | **NOT RUN**: needs a provider key and spend |
| 13 | Find opportunities (live search), apply to an owned QA form on production | — | **NOT RUN**: production, needs your approval and a synthetic account |
| 14 | Approve → queue → submit → duplicate protection | existing 821-test suite (real Chromium on owned local forms) | VERIFIED by suite; 5 sub-guards lack TOCTOU tests (see 05) |
| 15 | Email a report / hiring shortlist | — | **NOT RUN**: no Gmail app password; honest 503 "configure provider" confirmed in Phase 3 |
| 16 | Passkey registration/login with a real authenticator | — | **NOT RUN**: needs hardware or a virtual authenticator; logic reviewed statically |
| 17 | Delete workspace with hiring data | existing test blocks on in-flight send; no successful-delete assertion | PARTIAL (F-035) |
