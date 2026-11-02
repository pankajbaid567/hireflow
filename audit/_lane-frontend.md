# Frontend lane review (read-only) - frontend/ (Vite 6 + React 19 + react-router 7 + axios)

Labels: [CF]=confirmed fact (read in code), [INF]=inference, [UNK]=unknown/not verified. Paths relative to `frontend/`.
Method: static reading only. No installs, no .env values read. `npm audit --offline` ran: "found 0 vulnerabilities" (only meaningful against the lockfile's cached advisory data; [UNK] if cache is stale).

## Inventory [CF]
- src: 11 components + 7 pages + 1 context + 1 hook, ~1.6k lines (very long lines). Largest by bytes: styles.css 39.6KB (72 lines), PrepGuidePage 18.1KB (94 lines), ProfilePage 14.8KB (107), HiringPage 12.8KB, ApplicationReview 10.8KB, api/client.js 10.6KB, WeeklyPlanPage 8.1KB, ProfileDetailsEditor 8.0KB.
- Build output dist/assets: one JS chunk index-DDKdD37Z.js 458,117 B + css 41,111 B. No `lazy(`/`Suspense` anywhere in src (grep) [CF].
- public/ ships: assets/hireflow-p1-demo.webm (5,742,147 B), assets/hireflow-qa-form.html, careers/hireflow-qa-role-314.{html,js,json} (synthetic QA fixtures) [CF].

## Findings

FE-001 · S1 · security/auth · Proxy injects the server-held access code into every public `POST /profile`
Where: server/worker-proxy.js:25-31 (header set when `POST` and path `/profile`); functions/api/[[path]].js:9-10; api/proxy.js:4
Evidence: Caller-supplied `X-HireFlow-Access-Code` is stripped (OMIT_HEADERS line 1) then the proxy sets `WORKSPACE_ACCESS_CODE` for any anonymous caller. Comment on line 25 says it is a "bootstrap credential".
Impact: The backend's access-code gate on profile creation is effectively disabled for anyone who can reach the public site; unauthenticated users can create workspaces/consume LLM and storage quota. If the code was meant to gate signup (invite-only), this is an auth bypass. [CF] for the mechanism, [INF] that signup is intended to be gated (check backend ACCESS_CODE semantics and rate limits).
Fix: Decide intent. If open signup is intended, drop the code and use real abuse controls (Turnstile + per-IP rate limits at the edge). If invite-only, require the user to submit their own invite code and forward that.
Effort: S-M. Confidence: Med (intent unknown).

FE-002 · S2 · security/headers · No security headers on any deployment target
Where: public/ (no `_headers`), vercel.json (no `headers`), nginx.conf (only Cache-Control), index.html (no CSP meta), worker-proxy.js:44-50 (only cache headers added)
Evidence: grep for Content-Security-Policy, X-Frame-Options, Strict-Transport-Security, frame-ancestors across repo (excluding node_modules/dist) returned nothing [CF].
Impact: App is frameable (clickjacking on destructive actions like "Delete this workspace", approve application, passkey management), no CSP safety net, no HSTS/nosniff/Referrer-Policy/Permissions-Policy (the session-transfer fragment relies on referrer behaviour). Pages and Vercel give HSTS on *.pages.dev/*.vercel.app by platform default [INF]; custom domains and nginx do not.
Fix: Add public/_headers (Pages) and vercel.json `headers`, plus nginx add_header: CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, X-Content-Type-Options nosniff, Referrer-Policy no-referrer, Permissions-Policy (publickey-credentials-* self). Note ResumePreview uses an iframe (ResumePreview.jsx:25) - allow `frame-src 'self'` and keep `frame-ancestors 'none'`. Also add `Content-Disposition`/CSP sandbox for user-content artifact responses on the API side.
Effort: S. Confidence: High.

FE-003 · S2 · reliability/UX · Polling via `useRemote.reload` wipes data and flashes the loader
Where: src/hooks/useRemote.js:11-12 (`setData(null); setLoading(true)` on every effect run); src/pages/ApplicationTrackerPage.jsx:16-21 (`setInterval(reload, 10000)` while any item is confirmed/applying); src/pages/WeeklyPlanPage.jsx:30-33 (reload every 2s while `data.preparing`)
Evidence: [CF] reload bumps `revision`, effect re-runs and nulls data. In the tracker the polling effect depends on `[data, reload]` and `items` becomes empty during reload, so the interval is cleared/recreated and the whole table is replaced by `<Loading>` every 10s. Weekly plan: `selected` is reset by the effect on line 28 each time data changes (user's checkbox selection is lost on each 2s poll while preparing) [INF from line 28 `setSelected(...)` on `[data]`].
Impact: Table flicker, lost scroll/focus, screen readers re-announce "Checking your applications…" every 10s, selection loss mid-preparation; the "Cancel" button disappears under the pointer.
Fix: Add `silent`/`refresh()` in useRemote that keeps previous data (stale-while-revalidate) and skips setLoading; use it for polling; preserve selection for job ids still present.
Effort: S. Confidence: High.

FE-004 · S2 · state/data · No request cancellation, no 401 handling, no retry in API layer
Where: src/api/client.js:5 (axios.create, no interceptors; grep `interceptors` = 0), :115-196 (api object; only `discoverJobs` takes AbortSignal); src/hooks/useRemote.js:13-17 (ignores result via `active` flag but never aborts); src/context/ProfileContext.jsx:55
Evidence: [CF] A 401 mid-session (cookie expiry/revoke-all from another device) surfaces only as a generic error string in the page; ProfileContext is never told to clear, so the UI keeps showing `profile`, and every page just errors. No code path references status 401 outside tests (grep). `timeout: 120000` global (line 5) means a hung GET holds a spinner for 2 minutes. No retry/backoff for idempotent GETs; polling timers (Workspace/Discovery/Report/Prep/Hiring) have no max attempts except Hiring (deadline ref) and discovery (180s) [CF for DiscoveryCycle/WorkspaceSettings/ReportsPage timers: `setTimeout` chains with no cap seen at DiscoveryCyclePanel.jsx:6, WorkspaceSettings.jsx:6, ReportsPage.jsx:21; [INF] they stop on terminal state].
Impact: Silent session expiry UX, wasted requests after unmount (active-flag guard prevents state updates, so no setState-on-unmounted bug), long hangs on slow API.
Fix: Response interceptor: on 401 (excluding /session and passkey login calls) dispatch a `hireflow:unauthorized` event consumed by ProfileProvider to `clearProfile()` and route to /profile. Pass `signal` from useRemote's AbortController into loaders. Lower default timeout to ~30s, keep 120s only for generate/upload calls. Add 1 retry with jitter for GET on network error/502/503/504.
Effort: M. Confidence: High.

FE-005 · S2 · state/errors · No React error boundary; a render exception white-screens the app
Where: src/main.jsx:8-13 (StrictMode > BrowserRouter > ProfileProvider > App); grep `ErrorBoundary|componentDidCatch` = 0 in src [CF]
Evidence: Pages render server-supplied nested data directly (e.g. `data.budgets.searches` at DiscoveryCyclePanel.jsx:11, `cycle.budgets` unguarded; `profile.master_profile?.` mostly guarded). A malformed/partial API response throws in render and unmounts the whole tree.
Impact: Blank page with no recovery or sign-out path; with AI/scraped data shapes this is plausible. [INF] on likelihood.
Fix: Add a route-level ErrorBoundary (react-router `errorElement` or a class boundary around `<Routes>`) with "Reload" and "Go to profile"; log to console/reporting endpoint.
Effort: S. Confidence: High.

FE-006 · S3 · performance · Single 458KB JS chunk, no route-level code splitting, 5.7MB demo video in public
Where: src/App.jsx:3-10 (static page imports), no `lazy`; public/assets/hireflow-p1-demo.webm; vite.config.js (no manualChunks)
Evidence: [CF] dist/assets has one JS chunk. Video and QA fixtures are copied to dist and so deployed to production [CF]. `assets/` path is excluded from the Vercel catch-all rewrite (vercel.json:8 regex), `public/_routes.json` includes only /api/*.
Impact: Slower first load on mobile; ~6MB of QA/demo assets published on the prod origin (careers/hireflow-qa-role-314.* is a fake job posting on a real domain - SEO/phishing-surface smell).
Fix: `React.lazy` each page (PrepGuide, Hiring, Profile are the biggest) + Suspense fallback `<Loading/>`; move demo/QA fixtures out of public/ or gate on build mode; vendor chunk split for react/router/axios/lucide.
Effort: S. Confidence: High.

FE-007 · S3 · security · Untrusted URLs are mostly handled well; a few gaps to lock down
Where: src/api/client.js:16-22 (`externalUrl` allows only http/https), :25-31 (`artifactUrl`); every `target="_blank"` seen has `rel="noopener noreferrer"` (PrepGuidePage.jsx:10,49; ApplicationReview.jsx:70; ResumePreview.jsx:25 and others) [CF].
Evidence: `dangerouslySetInnerHTML` / `innerHTML` / `outerHTML`: zero occurrences in src (grep) [CF]. Job descriptions, scraped text and AI output are rendered as React text children, so XSS via text is not possible there [CF/INF]. `href` sinks: JobCard.jsx:7 `publicListingUrl` (not read in full - [UNK] that it enforces https), ApplicationTrackerPage `manual_action_url`/`resume` use `externalUrl`/`artifactUrl` [CF]. `artifactUrl` accepts any absolute http(s) URL (client.js:27) so an API-supplied `download_url` can point to an arbitrary https site, labelled as a HireFlow download (phishing risk, not XSS). The proxy iframe at ResumePreview.jsx:25 loads `href` into an iframe: javascript: is excluded by artifactUrl, but without a CSP `frame-src` a cross-origin https page can be framed.
Impact: No XSS found. Residual: open-link-to-attacker-controlled-URL from stored job data (listing/manual-action links) is by design for external jobs.
Fix: Restrict `artifactUrl` to same-origin/API-base for download fields; keep externalUrl for listings and show hostname next to external links; add `referrerpolicy="no-referrer"` on external links.
Effort: S. Confidence: Med (JobCard helper not fully verified).

FE-008 · S3 · security · Migration bridge: state-creating GET with cookie, trusted `Host`-relative endpoint, token in fragment
Where: server/workspace-migration.js:3-7 (GET `workspace-migrate`), :11-14 (POST /api/session/transfer using the incoming request's origin and ALL incoming headers), :15-19,23 (303 to fixed `dashboardOrigin`, fragment must match `#transfer=[a-f0-9]{64}`); vercel.json:8 rewrites every non-api/non-assets path to this bridge; ProfileContext.jsx:6-14 consumes and strips the fragment before the request
Evidence: [CF] Token is delivered only in the URL fragment with `Referrer-Policy: no-referrer` and `no-store`, destination origin and path pinned, token shape regex validated both server and client side. Good design. Concerns: (1) a cross-site top-level navigation to `/api/workspace-migrate` on the old host mints a transfer token for a logged-in victim, sends it only to the fixed dashboard (attacker cannot read the fragment) so impact is a forced session-transfer to the real dashboard (nuisance/login-CSRF style) [INF]; (2) transfer endpoint is built from `request.url` of the old host and forwards raw incoming headers including Cookie, fine, but also any `x-real-ip`/`cf-connecting-ip` the caller supplied (see FE-009); (3) catch-all rewrite means any path on the old Vercel host triggers a POST upstream, so crawlers/prefetchers hit a token-minting path [INF].
Fix: Require a same-site/`Sec-Fetch-Site` check or a user-click interstitial (POST form) before minting; add expiry/one-time-use verification on the API (token already consumed via `consumeTransfer`; [UNK] TTL, check backend); sunset the bridge and the catch-all rewrite once users migrate.
Effort: S. Confidence: Med.

FE-009 · S3 · security · Proxy forwards client-supplied hop/identity headers; CORS/cookie handling is otherwise sound
Where: server/worker-proxy.js:23-24 (forwards all request headers except an omit list and `x-forwarded-*`), :45-47 (strips upstream `access-control-*`, re-emits Set-Cookie verbatim), :53-57 (redirect same-origin check)
Evidence: [CF] `x-real-ip`, `cf-connecting-ip`, `x-vercel-forwarded-for`, `forwarded`, `origin` are passed to the API. [INF] If the API trusts any of those for rate limiting/audit, they are spoofable on the Vercel path (on Cloudflare, cf-connecting-ip is overwritten by the platform). Same-origin architecture means no CORS is needed and stripping `access-control-*` is correct. Set-Cookie is passed unmodified: cookie attributes (Secure, HttpOnly, SameSite, Domain) are decided by the API and not enforced here [UNK what the API sets]. Dev nginx sets `X-Real-IP` itself (nginx.conf:11) but no proxy hardening elsewhere. `redirect:'manual'` and fixed https origin check (line 11) prevent open proxy/SSRF [CF].
Fix: Whitelist forwarded request headers (cookie, content-type, accept, authorization, user-agent, x-request-id, range, if-*, origin) and set the client IP explicitly from the platform header. Assert cookie attributes in proxy tests.
Effort: S. Confidence: Med.

FE-010 · S2 · a11y · Colour contrast and colour-only status signalling
Where: src/styles.css (single-line file; `.status-badge` rule), `--muted:#7a867f` (:root, line 1) used for text; src/components/UI.jsx:21 (badge is `<span>` dot + label)
Evidence: [CF] `.status-badge` is 9px with colour `#8c9a7b` on `#f0f3eb` (approx 2.7:1), `.status-applied` `#739858` on `#edf5e7` (approx 3:1), `.status-failed` `#bd8a78` on `#fcf0ed` (approx 2.6:1), all below WCAG AA 4.5:1; `--muted` `#7a867f` on `#fff` is approx 3.8:1 and is used for body helper text. The badge does include a text label (`{label}`) plus a coloured dot, so status is not colour-only [CF].
Impact: Primary state information (applied/failed/applying) is hard to read for low-vision users; 9px size compounds it.
Fix: Darken text tokens to >=4.5:1, raise badge font to >=12px, keep the text label. Add an icon per status for non-colour redundancy.
Effort: S. Confidence: High (computed ratios are approximate).

FE-011 · S2 · a11y · No per-route title, no route-change focus/announcement, no skip-to-focus on navigation
Where: index.html:8 (static title); grep `document.title` in src = 0 [CF]; src/App.jsx:24-25 (`<main id="main-content" tabIndex="-1">` exists but is never focused on navigation; no `.focus()` in App); styles.css `main{...outline:none}`
Evidence: [CF] Every route has the document title "HireFlow · Your career, in motion". SPA navigation gives screen-reader users no announcement.
Impact: WCAG 2.4.2 (page titled) and 4.1.3/2.4.3 failures on all 8 routes.
Fix: A `useDocumentTitle(title)` hook in each page's `PageHeading`; on location change focus `#main-content` or h1 and set an `aria-live` route announcer.
Effort: S. Confidence: High.

FE-012 · S3 · a11y · Positive and gap findings in static review
Where: positives: skip link App.jsx:24; `<nav aria-label>`, `<main id=main-content>` App.jsx:24-25; `ErrorNotice` `role=alert` UI.jsx:8; `Loading` `role=status` UI.jsx:11; modal focus trap + Escape + focus restore in ResumePreview.jsx:8-23 and ApplicationReview.jsx:29-41 with `role="dialog" aria-modal aria-labelledby` (ResumePreview.jsx:25); icon button `aria-label="Open navigation"` App.jsx:25; `autoComplete` set on profile/recovery fields (ProfilePage.jsx:93, RecoverWorkspace.jsx:24).
Gaps [CF]: modal focus trap queries `document.querySelectorAll('[data-resume-dialog] ...')` and does not include `input/select/textarea/[tabindex]` (ResumePreview.jsx:17; ApplicationReview.jsx:35-36 similar - verify), so tabbing can leave the dialog when it contains form fields (ApplicationReview has inputs) [INF]; rest of the page is not `inert`/`aria-hidden` while a modal is open; `UI.jsx:11` `Loading` spinner icon has no `aria-hidden`; polling progress notices rely on role=status in some places (DiscoveryCyclePanel.jsx:11, PrepGuidePage.jsx:51, WeeklyPlanPage.jsx:72) but not the tracker status column; `.spin` animation honours `prefers-reduced-motion` (single media query exists) [CF]; `:focus-visible` rules: 5 in styles.css, `outline:none` only on `main` [CF]; `select`/`input` labels: 48 `<label>` tags vs 19 input/select/textarea usages in components, labels wrap inputs [CF]. Some inputs' autocomplete only on profile form; email field `autoComplete="email"` not verified [UNK].
Fix: Use the native `<dialog>`+`showModal()` or add `inert` on `#root` and complete the focusable selector; add `aria-hidden` on decorative lucide icons globally via a wrapper.
Effort: M. Confidence: Med.

FE-013 · S3 · architecture · Oversized, mixed-concern components with copy-pasted data/polling code
Where: src/pages/PrepGuidePage.jsx (18KB; fetching, polling, export management and presentation in one file), ProfilePage.jsx (14.8KB; session transfer helper `previousWorkspace`, form state, resume upload), HiringPage.jsx (12.8KB; bypasses `api` object with its own `get/post` at HiringPage.jsx:8, polls email delivery at :13 and report at :23), WeeklyPlanPage.jsx, ApplicationReview.jsx (modal + form + fetch + compare tabs in 75 dense lines)
Evidence: [CF] At least 8 hand-written `setTimeout` polling effects (WorkspaceSettings:6, DiscoveryCyclePanel:6, HiringPage:13/23, PrepGuidePage:33/71, ReportsPage:21, WeeklyPlanPage:31) + 1 `setInterval` (ApplicationTrackerPage:19). Modal focus trap duplicated in ResumePreview.jsx and ApplicationReview.jsx. Prop drilling is limited: only one context (ProfileContext, value object recreated every render, ProfileContext.jsx:57 - unmemoized, causing consumer re-renders on every provider render [CF]; effect deps `[]` omit `activateProfile` [low risk]).
Impact: Maintainability and inconsistent polling/abort behaviour (this is the root cause for FE-003/004).
Fix: Extract `usePolling(fetcher, {until, intervalMs, maxMs})` and `<Modal>`; move HiringPage calls into `api`; memoize context value; keep files under ~150 formatted lines. Formatting: enforce Prettier, ~148 lines >300 chars hurt review.
Effort: M-L. Confidence: High.

FE-014 · S3 · state · ProfileContext: auth state is session-cookie driven (good) but `loading`/error races and a stale `error`
Where: src/context/ProfileContext.jsx:31-34 (`selectProfile` sets `loading` true without an `active` guard), :37-52 (mount effect), :55
Evidence: [CF] localStorage ID is deliberately purged and never trusted (line 40) - good. `selectProfile` can resolve after `logoutProfile`/`clearProfile` and re-activate a profile (no request token). `logoutProfile` (line 27) clears local state only if the POST succeeds; on network failure the user remains "logged in" in the UI with no message (throws to the caller). `restoreCloudSession` falls back to `getSession()` after a failed transfer? No: the `await pendingTransfer` rejects and the catch at line 50 sets an error and the user must click again [CF]; the invalid-token path throws a user-readable message (line 11).
Fix: Guard `selectProfile` with a request counter; clear local state in `finally` of logout.
Effort: S. Confidence: Med.

FE-015 · S3 · CSS · Architecture: minimal tokens, no dark mode or print, one giant file
Where: src/styles.css (72 lines, 39.6KB; plus src/components/OperationsStatus.css)
Evidence: [CF] `:root` defines only 7 variables (`--green,--green-dark,--muted,--line,--surface,--sage,--orange`); 239 raw hex literals elsewhere. `@media` breakpoints: 1000, 1200, 480 (x2), 600 (x3), 640 (x2), 680, 760, min 1500 (inconsistent set); `prefers-color-scheme`: 0; `@media print`: 0 (a reports/prep-guide app with printable output has none [INF]); `prefers-reduced-motion`: 1. Dead rules by class-name grep (170 selectors vs jsx): only `status-applied/applying/confirmed/failed/needs_action` are unmatched, and these are generated via `status-${status}` (UI.jsx:21), so essentially no dead CSS [CF]. Font `'DM Sans'` is declared but never loaded (no @import/link/font-face) so it falls back to system fonts [CF].
Fix: Promote colours/spacing/radius/font-size into tokens, add a dark theme and print stylesheet, load or drop DM Sans, split CSS per feature.
Effort: M. Confidence: High.

FE-016 · S3 · tests · 100 tests across 15 files; solid on flows, thin on state/infra
Where: src/test/*.test.jsx|js (pages.test.jsx 32 tests, discovery-polling 8, discovery 8, account-security 7, report-email 7, hiring 5, application-review 5, operations 5, session 5, client 4, workspace 4, ...); setup.js stubs localStorage
Evidence: [CF] Mocking is `vi.mock` x12 (api module) and `vi.fn` x96; `vi.spyOn` x2; no MSW/network-level mocks, so axios config, timeouts and the proxy are not exercised from the UI side. client.test.js has 4 tests (errorMessage/artifactUrl/discovery). server/*.test.js cover the proxy (worker-proxy 107 lines), migration and pages-deployment. Untested/under-tested [INF from file list]: `useRemote` directly (race, unmount, deps), ProfileContext 401/expiry, 404 route, ErrorBoundary (does not exist), ResumeLibraryPage/ReportsPage error paths beyond happy path (only via pages.test), `ProfileDetailsEditor`, `ModeSelector`, `RecoverWorkspace` partly, polling stop/timeout of tracker (FE-003 would be caught by a test that counts renders), keyboard/focus-trap behaviour, a11y (no jest-axe), CSS/print. No Playwright/e2e and no coverage threshold in vite config.
Fix: Add jest-axe smoke per page, a `useRemote` unit test (stale response, abort), an interceptor test for 401, and the tracker poll "keeps rows visible" test. Add `coverage` config with thresholds.
Effort: M. Confidence: Med.

FE-017 · S4 · deps · Dependencies are current; ranges are caret and only one is pinned
Where: package.json (axios ^1.12.2 resolved 1.20.0; react ^19.0.0 resolved 19.3.1; react-router-dom ^7.9.1 resolved 7.18.4; lucide-react ^0.468.0 (0.x caret = exact minor, fine); @simplewebauthn/browser 14.0.0 pinned; vite 6.4.5, vitest 4.1.12, jsdom 26.1.0)
Evidence: [CF] `npm ls --depth=0` works offline; `npm audit --offline` printed "found 0 vulnerabilities" ([UNK] freshness of advisory cache). All 6 runtime deps are imported (@simplewebauthn/browser in AccountSecurity.jsx and ProfilePage via passkeys; lucide, router, axios, react used); no unused runtime dependency found. `vitest ^4.1.12` with `vite ^6` and `engines node >=20.19` is consistent. Deployment tooling `wrangler` is not a dep (wrangler.jsonc refs `../cloudflare/node_modules`) [INF OK].
Fix: Run `npm audit` online in CI; commit lockfile (present); consider exact pins or Renovate.
Effort: S. Confidence: Med.

FE-018 · S4 · config · Hard-coded hosts in code and config
Where: server/workspace-migration.js:2 (`https://hireflow-dashboard.pages.dev`), wrangler.jsonc `WORKER_API_URL` = `https://hireflow-api.baidpankaj567.workers.dev` (personal workers.dev subdomain in repo), ProfilePage.jsx:22 (`VITE_PREVIOUS_DASHBOARD_URL`)
Impact: Environment promotion and forks require code edits; account subdomain leaks (public anyway).
Fix: Move to env bindings. Effort: S. Confidence: High.

FE-019 · S4 · API client · Error normalisation is string-only and loses status/code
Where: src/api/client.js:7-14
Evidence: [CF] `errorMessage` returns a string; HTTP status is lost for callers (so 401/403/409/429 cannot be handled differently); 429 `Retry-After` not surfaced; raw `error.message` (e.g. "Request failed with status code 502") may reach the user for non-FastAPI errors (the proxy returns `{detail}` JSON, so Cloudflare/Vercel-origin errors mostly normalise; platform HTML error pages would not). Base URL: `VITE_API_URL || '/api'` (line 3) - same-origin cookie model, `withCredentials:true` (line 5). Doc mismatch: `.env.example` says nginx proxies FastAPI, while Vercel/Cloudflare use the proxy code.
Fix: Return `{message,status,code,retryAfter}` via an `ApiError` class; keep `errorMessage` wrapper. Effort: S. Confidence: High.

## Positives worth keeping [CF]
- Same-origin API with HttpOnly cookie session; no tokens in JS storage; legacy localStorage id purged on boot (ProfileContext.jsx:40).
- Session transfer token in URL fragment, immediately removed with `history.replaceState`, regex-validated (ProfileContext.jsx:6-12).
- Proxy has fixed https origin, no open proxy, `redirect:'manual'`, same-origin redirect rewrite, 60s timeout, `no-store` on all responses.
- Discovery polling in client.js is carefully built: abort, deadline, UUID validation, cleanup in `finally`.
- No dangerouslySetInnerHTML; all external `target=_blank` links have rel noopener noreferrer.

## 10-line summary
1. No XSS found: zero dangerouslySetInnerHTML/innerHTML, external hrefs filtered through `externalUrl`/`artifactUrl` (http/https only), all `_blank` links have rel.
2. FE-001 (S1): the proxy injects the server access code into every anonymous `POST /profile`, so the signup gate is effectively open; confirm intent.
3. FE-002 (S2): no CSP, frame-ancestors, HSTS, nosniff or Referrer-Policy on any target (Pages, Vercel, nginx); clickjacking on destructive actions is possible.
4. FE-003 (S2): `useRemote.reload` nulls data and shows the loader, so the tracker table blinks every 10s and weekly-plan selection is reset every 2s while preparing.
5. FE-004/005 (S2): no 401 handling, no abort in `useRemote`, no retry, 120s default timeout, and no error boundary so one bad payload white-screens the app.
6. FE-010/011 (S2): status badges at 9px with about 2.6-3:1 contrast, `--muted` at 3.8:1; no per-route document.title and no focus/announcement on route change.
7. FE-006: one 458KB JS chunk, no lazy routes; 5.7MB demo video and fake QA job-posting fixtures ship in public/ to production.
8. FE-008/009: the migration bridge is well-pinned (fixed destination, fragment token, no-referrer) but mints tokens on GET and forwards spoofable client-IP headers to the API.
9. Tests: 100 tests in 15 files, API mocked at the module level; no useRemote/401/focus-trap/a11y tests; deps current, `npm audit --offline` reports 0 vulnerabilities, no unused runtime deps.
10. CSS: 7 tokens vs 239 hex literals, no dark mode or print styles, one reduced-motion rule, DM Sans declared but never loaded; dead rules negligible.
