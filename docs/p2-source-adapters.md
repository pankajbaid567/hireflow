# Public source adapters and shared limits

The discovery readers retrieve public job descriptions. They do **not** imply support for automatically applying on the same portal. Authenticated feeds, login-required content and CAPTCHA solving are not provided by these adapters.

## Field coverage and supported reads

| Source | Read path | Covered fields and limitations |
| --- | --- | --- |
| Ashby | Official public Job Postings API | Listed-post identity, title, plain/HTML description, location, employment type, publication date, canonical/apply URLs and a single unambiguous Salary component. Equity/bonus are not salary. Missing/false visibility and wrong-host IDs are rejected. Boards larger than 4 MiB are unsupported. |
| Greenhouse | Official public Job Board GET API | Full description, company/title/location, `first_published` when present, official absolute application URL, explicit JD skills/experience/pay. `updated_at` never substitutes for posting date. Public GET support does not grant application POST credentials. |
| Lever | Official public posting GET API | Plain description plus listed/additional sections, location/commitment, available creation time, apply URL and supported structured salary range. Empty tenants do not imply an active pool. |
| Internshala / Wellfound | Accessible individual public HTML/JobPosting metadata | Full source description and exposed role/company/date/location/type/pay fields when public. A search snippet is not the description. Restricted, missing, unparseable, directory and explicit login/CAPTCHA interstitial pages are omitted. |
| LinkedIn / Naukri | Accessible public individual listing metadata | Same bounded public metadata path; login, restriction and client-rendered-only pages can prevent a verified result. No authenticated integration is claimed. |
| Other company career pages | Static visible text / JobPosting JSON-LD; bounded hydration on explicitly approved hosts | Explicit source fields only; missing pay/date stay unknown. JavaScript hydration requires an accessible individual page, exact host approval and observed structured job evidence. The deployed hydration allowlist currently contains only HireFlow's synthetic fixture host; external JavaScript portals are not certified. |

Ashby uses the [official public API](https://developers.ashbyhq.com/docs/public-job-posting-api). Greenhouse documents [unauthenticated Job Board GETs](https://docs.greenhouse.io/job-board.html), separately from authenticated submission endpoints. Lever's [official posting API specification](https://github.com/lever/postings-api) defines list/detail reads. The project uses these read endpoints without account credentials.

Fixtures cover source descriptions rather than cached search snippets, Unicode/entity decoding, expiry, metadata absence, malformed pages, unsafe redirects and independent source failure. New Ashby fixtures additionally cover official `/application` links, listed/unknown visibility, wrong-host job URLs, Salary versus bonus/equity, and conflicting location/currency summaries.

The [bounded public JavaScript reader](dynamic-sources.md) is an optional fallback after a successful, unrestricted static read lacks a complete JD. It does not retry through a login wall, HTTP 401/403 or CAPTCHA. It reuses the checked document, then routes approved public GET/HEAD resources through the same native source guards. Observed JSON-LD or explicit job microdata must identify one complete posting; listing directories and snippets cannot become job descriptions. The current exact host allowance is `hireflow-dashboard.pages.dev`, for an owned, labelled noindex fixture, not arbitrary employer portals.

## Shared account and host policy

`source_reader.ts` is used by guarded discovery and preparation research when `DISCOVERY_SHARED_GUARDS=true`:

- Atomic UTC-day counters default to **25 searches / 400 detail requests** across callers. Configured values cannot exceed 40 / 800. Budget rejection occurs before outbound I/O.
- A shared per-hostname reservation permits one new request start per second. A short host deferral can wait/retry once within the task deadline, so same-host canonical redirects and HEAD-to-GET fallback do not restart indefinitely; cache hits spend neither a network request nor another detail reservation.
- Transient transport/5xx failures persist exponential backoff. HTTP 429/5xx `Retry-After` dates or seconds persist in domain state, up to a seven-day safety bound; a queued delivery cannot bypass that state.
- Public GET cache lifetime is at most six hours, shortened by `max-age`, `s-maxage`, `Age` and `Expires`. Private, no-store, no-cache, personalized/Vary and Set-Cookie responses are not cached. Explicit removed/restricted responses evict older successful data; only their empty failure status may be retained for one minute when cache policy permits.
- Normal source bodies are capped at **180,000 bytes**. Official Ashby board responses are capped at **4 MiB**, because the current public board measured 2.20 MB. Responses larger than **1 MiB** are not written to D1; the cache holds at most 100 entries, bounding its theoretical body storage to 100 MiB. Truncated/invalid UTF-8/partial responses are not cached.
- Only body-free GET/HEAD is allowed. Credentials, personal/credential-like URL query parameters and nonstandard ports are rejected; caller cookies and Authorization are never forwarded. Redirects are returned without their bodies and every next hop is validated before another read.
- JavaScript MIME types are accepted only by the explicit rendering transport. Cached content is checked against each caller's MIME policy. Native responses generate their own cache-accounting headers, including bodyless responses; upstream headers cannot forge a cache hit. Caller cancellation remains active alongside the source timeout.

Successful cache, prune and host-state writes share one D1 batch without changing atomic day/host reservations. A render permits at most eighteen additional D1 calls, twelve resource reads and twenty seconds of work. It reserves **90 seconds** against the same conservative browser allowance used by applications, including allowance for interrupted cleanup. This is a reservation, not measured browser duration. See the [rendering limits and isolation policy](dynamic-sources.md#execution-and-shared-limits).

When searches exhaust their shared daily allowance, the cycle can still drain already collected detail candidates. A host-specific deferral preserves that candidate's deadline while other eligible hosts proceed. Canonical redirect aliases deduplicate the result, while actual read and browser attempts remain charged. Exhausted allowances preserve the checkpoint rather than silently discarding pending details.

These limits bound free-account use; they do not guarantee that an arbitrary 100-result request will complete. Large uncached Ashby boards require another bounded read when checking another candidate. Domain limits, stale publication dates and unavailable providers can reduce the final verified pool. Progress/partial results remain the cycle engine's responsibility.

## Recorded public-source check, 25 October 2026

Run the explicit opt-in check:

```bash
node scripts/verify_source_adapters.mjs --run-live
```

The [recorded public-source check](evidence/p2-public-sources.json) ran actual bundled Worker functions in isolated workerd/D1 against public GET responses on 2026-10-25. It made **8 outbound requests**, with **zero Tavily searches, model calls, applications or emails**.

- Ashby's official board returned 67 published entries, including 17 within the 30-day freshness window. One current detail passed the actual adapter with a 9,490-character source JD, publication date, compensation and official application URL. The 67 index entries are not counted as 67 verified relevant opportunities.
- The sampled Greenhouse detail was accessible but rejected outside the 30-day publication window. It is not represented as a fresh accepted listing.
- Lever's sampled tenant returned HTTP 200 with zero current postings; no live detail field coverage is claimed from that empty response.
- Internshala returned a public redirect; Wellfound, LinkedIn and Naukri public landing checks returned HTTP 200. These are explicitly **landing-only** observations, not evidence that individual JDs or application forms were extracted. Wellfound's landing response reached the bounded read limit.

These are sampled access/field checks, not source-wide availability, geography precision or automatic application certification. The production 100-target cycle has separate measured evidence. No login or access restriction was bypassed.

## Native JavaScript verification, 26 October 2026

Source `a6814e6` was exercised through an actual protected Cloudflare Queue and Browser Run session against the owned fixture. The pipeline made **four native GETs**: a canonical 308 and HTML response, followed by the renderer's JavaScript and JSON reads. It retained a 428-character JD and explicit `Remote — India`, used **fifteen renderer D1 calls**, reused the checked initial document and acknowledged normal browser closure. This is a synthetic source transport/field-policy proof; it is not a real vacancy or part of a 100+ pool.

Both temporary QA runs' Worker/Queue resources and their exact private result/guard keys were removed and independently checked absent. Shared source/browser usage was retained. No search, model call, employer submission or email was used by that probe. The [P2 evidence](p2-verification.md) distinguishes this successful native run from the earlier failed setup attempt and records release/followup status.

## Structured India eligibility regression

The 26 October production pilot exposed a false geography rejection: an
Internshala listing retained Kolkata but lost its explicit `IN` country and
remote applicant eligibility. The reader now retains postal and eligibility
evidence, normalizes explicit `IN` to India, and gives remote applicant
restrictions precedence over the employer address. It does not infer countries
from cities or turn a generic remote label into worldwide permission.

The [actual detail check](evidence/p2-structured-location-live.json) used one
public GET through the real bundled reader in isolated workerd/D1, with the
unchanged 180,000-byte source limit. It extracted a 5,610-character JD, source
posting/expiry dates, and `Remote — India`; the actual geography/skill policy
accepted it. This made zero Tavily/model calls and no applications or emails.
Thirteen regression cases include US-only eligibility despite an India office,
on-site US work, Puerto Rico, unknown remote geography, multiple explicit
countries and untrusted country names. This proves that specific reader fix,
not a 100-result production discovery pool.
