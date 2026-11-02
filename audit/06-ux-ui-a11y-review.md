# Phase 6 — UX / UI / accessibility review

**Scope and limits.** Real Chromium, real built SPA (`frontend/dist`), the real Pages proxy code, the real Worker in Miniflare with a local D1 and a stubbed outbound network (0 egress; `evidence/ux/serve.mjs`). Synthetic users only. **No production browsing was done**: the optional capped production smoke needs your go-ahead and a synthetic account, so it is listed under human actions. Tools: Playwright + axe-core 4.10.2 (WCAG 2.0/2.1 A+AA and best-practice rules). Viewports 1366×900 and 390×844. An automated scan finds roughly a third of accessibility issues; the keyboard and visual checks below cover some of the rest, and **no screen reader (VoiceOver/NVDA) was run**.

## 1. Results

| Check | Before | After fixes |
|---|---|---|
| axe violations, 6 routes × 2 viewports | **49** (serious: colour-contrast, 15–49 nodes per route; moderate: `region` ×2–3 per route, `landmark-unique` on /profile) | **0** on all 12 |
| Contrast pairs failing 4.5:1 | 35 distinct text colours, worst `#a5b694` on `#edf2e4` = **1.9:1**; typical body-small text `#77847a` on white = 3.9:1 at 12 px | all meet 4.5:1 against the darkest surface (`#eef3e7`) |
| Distinct page titles | **1** for every route ("HireFlow · Your career, in motion") | 7 (`Weekly plan · HireFlow` …, prep guide, fallback) |
| CSP violations with the new `_headers` | n/a | **0** console/CSP errors on all routes, desktop and mobile; React inline styles via CSSOM still work under `style-src 'self'` |
| Horizontal overflow at 390 px | none | none |
| Keyboard: 12 Tab presses per route | focus ring present on every focusable element (0 "no-focus-style") | unchanged |
| Skip link, `<main>`, nav label | present | present; breadcrumb now inside `<header>`, sidebar `aside` named |
| Session survives reload / direct URL | **yes** (cookie `HttpOnly; Secure; SameSite=Lax`; `GET /session` restores the profile) | — |
| Signup rate limit surfaced to the user | **yes**: alert "Too many profile creation attempts. Please try again in 10 minutes." | — |

## 2. Defects found and fixed

| ID | Sev | Finding | Fix |
|---|---|---|---|
| F-044 | S2 | Low-contrast text throughout (see above); 105 hard-coded colours darkened in `styles.css` and `OperationsStatus.css` with a luminance gate so light-on-dark text was untouched | re-scan: 0 violations |
| F-045 | S3 | Every route had the same `<title>` | `routeTitle()` + test |
| F-046 | S3 | Empty-state **button overlapped the wrapped paragraph on mobile** (link was passed as a child of `<p>`; seen in screenshot) | `EmptyState` renders controls after the `<p>`; 2 tests; re-screenshotted |
| F-024 (part) | S2 | landmark gaps | `<header>`, labelled sidebar |
| F-047 | S4 | Fresh profile triggers two console 404s (`/jobs/{id}/discovery-cycles`, `/report/{id}/latest`): empty states are modelled as errors | **open**: return 200 with an empty list, or stop logging expected 404s |
| F-048 | S4 | Mobile layout shows a faint grey gradient on the left edge (off-canvas sidebar shadow bleeding into the viewport) | **open**, cosmetic |

## 3. Not covered (be explicit)
- **Authenticated pages with real data** (plan cards, tracker rows, prep guide, review modal) were not axe-scanned in this run; the scans show the empty and just-signed-up states. The review modal has focus-trap code (`ApplicationReview.jsx:30–41`) that I read but did not drive. → follow-up with a seeded job set (the Phase 3 probe already seeds jobs).
- No screen-reader pass, no 200 % zoom/reflow check, no reduced-motion check, no real touch device.
- No Lighthouse run; the single 458 kB (142 kB gz) JS bundle with no route splitting (F-008) was not measured for load time.
- No production visual smoke; production's response headers were last seen *without* CSP/HSTS (Phase 0), so the `_headers` fix is **unproven in production until deployed**.
- F-023 (poll clears data / no abort / no error boundary) is still open; it is a reliability issue the empty-state scans cannot reveal.

## 4. Reproduce
```
cd frontend && npm run build:cloudflare && cd ..
node audit/evidence/ux/serve.mjs 4173 &            # Node >=22.12
node audit/evidence/ux/audit_flow.mjs <path-to>/axe.min.js > audit/evidence/ux/flow-results.json
```
`flow-results-before.json` holds the pre-fix run; screenshots in `evidence/ux/screens/`.
