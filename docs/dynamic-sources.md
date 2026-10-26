# Bounded public JavaScript job details

HireFlow can hydrate an individual public job page when its static response is
accessible but does not expose a complete description. This is read-only source
collection. It does not log in, solve a challenge or authorize an application.

## Deployment policy

Set `DYNAMIC_SOURCE_ENABLED=true`, `BROWSER_ENABLED=true` and exact, comma-separated
`DYNAMIC_SOURCE_HOSTS` in the Worker configuration. No wildcard, credential,
private address or implicit subdomain permission is accepted. The deployed
initial allowlist is `hireflow-dashboard.pages.dev`, for the labelled synthetic
verification fixture. An operator must review and explicitly configure another
public career/CDN host before it can render. Static public adapters and the
Greenhouse/Lever/Ashby APIs continue working without browser hydration.

The fixture at `/careers/hireflow-qa-role-314.html` loads external JavaScript and
JSON before creating its JobPosting. It is marked noindex/nofollow and plainly
states that it is not a vacancy. It is not evidence of an external employer's
availability and is never counted toward a real 100-listing pool.

## Accepted evidence

Rendering accepts one unambiguous JobPosting from observed JSON-LD, explicit
JobPosting microdata, or a single `article[data-job-id]` with dedicated title,
company and description attributes. A rendered description must contain at
least 250 characters. Postal/location and explicit applicant eligibility,
employment type, source posting/expiry dates, skills and supported compensation
are retained when provided. An explicit `Place.name` is preserved when postal
fields are absent; countries are not inferred from city names.

The normal parser still checks complete fields, expiry, freshness, mode,
experience, skills and geography. Login/CAPTCHA responses, closed banners,
multiple jobs, listing directories and unsupported JavaScript shells fail
explicitly. Search snippets and navigation text cannot replace a full JD.
Unknown or inaccessible fields remain unknown rather than being generated.

## Execution and shared limits

- The already checked static HTML can fulfill the first browser document,
  after exact URL and 180,000-byte validation. This avoids a second HTML read
  and works with no-store pages; it does not fabricate a cache hit.
- Every subsequent resource uses the native guarded source reader. Only public
  HTTPS GET/HEAD is allowed, on exact configured hosts. Main navigation remains
  on the original origin. Redirects are validated and driven explicitly;
  Chromium cannot follow an intercepted redirect around the native guard.
- Each render has at most 20 seconds of work, two seconds for close acknowledgement,
  twelve resource requests, thirty-six intercepted requests, 1 MiB of combined
  resources and a 180,000-byte structured snapshot. The renderer admits at most
  eighteen additional D1 calls. Normal queued import with cold HTML/JS/JSON is
  tested against Free's fifty-call invocation limit; `db.batch()` counts as one
  call. A limit defers work instead of bypassing it.
- Shared source day reservations, per-host spacing, cache policy and Retry-After
  still apply. JavaScript MIME types are allowed only in the explicit script
  transport; a script cache entry cannot become an ordinary JD response.
- A fresh browser context contains no candidate data, stored login or forwarded
  cookies/authorization. Service workers, background workers, WebSockets,
  EventSource, beacons, popups, iframes, downloads and form writes are blocked.
- A render reserves **90 seconds** in the same browser ledger as applications,
  with the existing launch spacing. The reservation allows for interrupted
  cleanup and the native idle timeout; it is not an exact usage measurement.
  The configured 540-second shared allowance admits at most six such render
  reservations if no application consumes it. Reservations are not refunded
  after an uncertain launch. Native Free-plan limits remain authoritative.

Run timing, resource/D1 counts, initial-document reuse and close acknowledgement
belong to attempt traces. They are excluded from versioned listing facts, so
an unchanged source does not invalidate a reviewed PDF merely because a cache
hit or rendering timestamp changed.

A cached document followed by a denied pre-launch reservation is known zero
outbound work. A browser launch or native read followed by another resource's
deferral remains charged. Source/bodyless responses cannot forge internal
cache-accounting headers.

## Recovery and verification

Daily search exhaustion no longer strands already collected detail candidates.
Each rate-limited candidate keeps its own deferred deadline, while other hosts
and queries can proceed. When no useful work remains, the cycle waits for the
earliest applicable allowance and preserves its cursor. Redirect aliases count
as one verified canonical listing, with all actual attempts still charged.

Tests use actual Chromium with isolated D1, and actual workerd for source,
transport, budget and database behavior:

```bash
npm --prefix cloudflare test -- tests/dynamic-source.test.ts \
  tests/dynamic-source-runtime.test.ts tests/dynamic-discovery.test.ts \
  tests/source-reader.test.ts tests/discovery-reservations.test.ts
```

The separately opted-in live helper uses an ephemeral protected Worker/Queue,
existing Free bindings and only the owned fixture. It sends no employer
application or email. Production/public-source measurements are recorded in
[P2 verification](p2-verification.md); controlled fixtures do not certify an
arbitrary authenticated or JavaScript-only portal.

Official references: [Browser Run Playwright](https://developers.cloudflare.com/browser-run/playwright/),
[Browser Run limits](https://developers.cloudflare.com/browser-run/limits/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and
[Playwright request interception](https://playwright.dev/docs/network).
