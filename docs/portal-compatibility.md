# Application portal compatibility

This matrix describes the deployed Cloudflare implementation and controlled tests. The release is published and its owned single-page production QA form passed with exact review authorization. Multi-step recovery is verified with actual local Chromium; no real employer submission or ATS vendor certification is claimed. See [release evidence](p0-verification.md). The retained Python backend has a separate, single-form implementation; the review and checkpoint guarantees below apply to the Cloudflare path.

| Portal or form | Discovery and JD reading | Automatic application scope | Verification and handoff boundary |
|---|---|---|---|
| Greenhouse public forms | Public listings and supported detail APIs | Visible native public application form, including `#application_form`; first/last name, email, phone, PDF and exact approved answers; recognizable Next/Continue and final Submit controls | Real Chromium runs on an owned Greenhouse-shaped fixture and the shared four-step fixtures. No real employer POST. Embedded iframe forms, custom comboboxes, unsupported required fields and access restrictions require manual action. |
| Lever public forms | Public listings and supported detail APIs | Visible native public application form, including `#application-form` and `data-qa=application-form`; full name, email, phone, PDF and exact approved answers | Real Chromium runs on an owned Lever-shaped fixture and shared step engine. No real employer POST. Login, custom controls or unsupported form structure require manual action. |
| Generic public native HTML | Verified public detail page; up to two unambiguous Apply hyperlinks may be followed using GET | Standard profile fields, PDF upload, exact reviewed answers; recognizable step controls and confirmed final submission | Owned single-page and four-step Chromium fixtures, including redirects, cookies, transient failures and one final POST. A URL change alone does not prove submission. |
| Internshala | Production discovery/JD verification has returned active listings | No dedicated authenticated application adapter | Sign-in, eligibility questions or restricted flows are manual. Discovery is not automatic application support. |
| Wellfound | Production discovery/JD verification has returned active listings | No dedicated authenticated application adapter | Account-based flows and unsupported controls are manual. |
| LinkedIn | Source-specific discovery can report restricted or expired results | Easy Apply and account automation unsupported | Never bypass login, bot challenges or access restrictions. |
| Naukri | Included in full-time discovery source configuration; completeness remains provider-dependent | No dedicated authenticated application adapter | No automatic login or account-based application claim. |

## Review and execution contract

An approved snapshot binds the application, current profile version, JD fingerprint, exact PDF SHA-256/version/path and the reviewed answers. The queue must carry that exact review ID. A stale queue generation cannot execute a newer confirmation. Profile, JD, PDF or answer changes, expiry or revocation require another review. The worker validates the approval before reserving browser time, claims execution atomically against cancellation, and revalidates immediately before each Next action and the final submission.

Only exact normalized question matches use the approved answer map. Normalization is shared with the review API. Profile defaults and live LLM generation during applying cannot answer an unreviewed question. Unknown required inputs, unknown written answers, eligibility and consent defaults are handed to the user. The final click is blocked without a current review callback and binding.

## Durable recovery

The engine supports at most eight recognizable steps and retains its 42-second work deadline plus bounded cleanup. It persists completed pre-submit step URL, field names, browser cookies/local storage and session storage, encrypted with AES-GCM and bound to one application and review. Private state is never included in API tracker responses or telemetry.

A handled transient failure during a safe GET can resume the last completed step with its saved browser state and approved facts. A lost consumer is automatically resumable only when its durable phase is `ready` and its approval remains current. A page that cannot reconstruct its controls from URL and stored browser state is handed off; storing a DOM snapshot does not recreate arbitrary JavaScript application state.

Before an intermediate action, the phase becomes `advancing`. Before forwarding a POST or another mutating request, that fact is durably recorded. An uncertain intermediate POST is not repeated. The native-form adapter permits only one mutating request per recognized action and blocks a site script that retries a final POST; flows requiring multiple background upload/submission requests need a separately verified adapter. Before the final click, a durable `submitting` marker is written and `submitted` is set before the click; uncertain final outcomes, including timeouts, are never automatically retried. Successful and uncertain final markers cannot be downgraded to a retryable state, even after expiry or a new review. Expired completed-step snapshots can be removed; private cookie/storage ciphertext is erased after its lifetime while small intermediate/final uncertainty markers remain until an explicit future reconciliation workflow exists.

CAPTCHA, visible login/registration, a closed vacancy, an ambiguous action, unsafe destinations or an unavailable review/checkpoint store produce specific manual instructions. Resume recovery is intentionally conservative: a human must check the employer when an external operation may have happened. Cancellation only stops a queued application before its atomic claim; it does not withdraw an application already sent.

## Reproduce the controlled checks

From `cloudflare/`, using Node 22 and an installed Playwright Chromium:

```bash
npm run typecheck
npx vitest run tests/automation.test.ts tests/automation-runtime.test.ts tests/tasks.test.ts
```

These tests use owned local fixtures or intercepted fixture responses. Real Chromium verifies DOM filling, in-memory PDF upload, four-step recovery and exactly one final POST. Real workerd/D1 tests verify immutable review checks, queue generation, encryption, budget reservations and recovery. Runtime transport tests cover public redirect validation, cookie preservation, response bounds and gzip handling. They do not send a job application or email to a third party.

Python/Docker retains its existing confirmation/status and uncertain-submission safeguards, but does not yet share Cloudflare's immutable answer review or encrypted multi-step recovery. Full parity belongs to the separate backend-parity roadmap work.
