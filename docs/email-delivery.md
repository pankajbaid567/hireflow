# Weekly report delivery

The Cloudflare runtime queues one private, immutable delivery for an authenticated owner's saved report version. The recipient always comes from the owned profile; the endpoint accepts no arbitrary recipient. Nothing sends during profile creation, report generation, ordinary acceptance testing, or prep export generation. A manual send requires its own button/POST; scheduled sends require enabled weekly preparation and explicit email opt-in.

## Setup and current evidence

Set `EMAIL_PROVIDER=resend` or `sendgrid`, the corresponding Worker secret `RESEND_API_KEY` or `SENDGRID_API_KEY`, and a verified plain-address `FROM_EMAIL`. Verify sender/domain ownership and account quotas in that provider's dashboard. Keep secrets out of frontend variables, Git, reports and logs.

The deployed project has no configured email provider key or verified sender at this implementation checkpoint. No real email was sent. Provider-fixture tests prove the application behavior below; **actual owner-controlled inbox receipt remains unverified and P2-05/P2-07 delivery acceptance remains pending**. A real send also requires an explicitly authorized owner recipient. Readiness checks configuration presence, not successful provider/domain verification.

## Owner API

All routes require the owner's authenticated private session and use `Cache-Control: no-store`.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/report/{owner}/email-readiness` | Provider/configuration readiness without secrets |
| POST | `/report/{owner}/latest/email` | `202` durable ticket; an already accepted identical report returns `200` |
| GET | `/report/{owner}/email-deliveries/{ticket}` | Current state, attempts, timestamps and safe failure reason |

Repeated requests for the same immutable report HTML key, recipient and provider return the same delivery. They cannot create a blind resend. Review an uncertain provider outcome before generating and explicitly sending a new report. A newly generated report clears the old version's email timestamp.

## Snapshot and attachments

The enqueue request captures the report key, provider, sender, owner recipient, subject, exact resume versions and existing ready per-listing prep export versions. The queue builds the provider JSON once, stores it privately at `mail/{owner}/{ticket}/payload.json`, and binds its SHA-256 hash before any external write. Retries read those identical bytes and check the hash; a changed report, active resume or guide does not silently change the queued message. Missing selected files fail safely rather than omitting promised attachments. Export links retain their original version, stale-source label and expiry.

The HTML contains both Internship and Job groups, their summaries, overall top skills/study priorities, failure reasons/manual actions and the shared UTC-week quota policy. Existing ready guide exports add private standalone HTML/PDF links; generation of a report does not fabricate an export that was never built.

At most ten PDFs and 128 KiB of raw attachment bytes are attached. Remaining PDFs are authenticated versioned links, including prep PDFs when the attachment allowance is exhausted. The serialized provider payload is capped at 512 KB and report HTML at 250 KB. Up to the first 100 report applications are considered for PDF attachments; every application already remains in the report body. Private links require signing into the same workspace and do not become public bearer URLs. Prep export links expire after their separately documented retention window.

## Recovery and truthful status

States are `queued`, `preparing`, `ready`, `sending`, `retry_wait`, `accepted`, `failed`, `needs_action` and `cancelled`. Queue delivery is idempotent through conditional D1 leases. Maintenance recovers queue outages and expired preparation leases. A request records `sending` and its attempt before the provider POST; owner email, account deletion state and current scheduled consent are checked again in that final conditional claim. Pausing/changing a schedule or changing its captured profile prevents an unsent scheduled message from proceeding. Consent already handed to a provider cannot be recalled.

Resend receives the same `Idempotency-Key` and the same stored payload on bounded transient/network retries. Its documented key retention is 24 hours; HireFlow stops automatic retries after a conservative 23-hour window or three attempts. An interrupted SendGrid request never receives a blind automatic retry because the first write may have succeeded. Uncertain outcomes become `needs_action` with provider-dashboard instructions. Provider errors are classified without saving raw error bodies, keys, email addresses or request payloads in public status metadata.

An HTTP success sets `accepted_at`, provider message ID where available, and the compatibility `weekly_reports.email_sent_at`. This means **accepted by the provider**, not delivered to an inbox. `delivered_at` stays null without a verified delivery event. This implementation does not expose an unsigned webhook or infer delivery from an accepted response; adding authenticated provider webhook verification is a separate follow-up. The dashboard uses this distinction explicitly.

The source and payload keys are owner-private lifecycle references. Migration `0017` increments workspace revisions for delivery mutations, blocks artifact publication after a retention tombstone, and prevents binding/hash rotation. Backups exclude mail payloads and delivery authority; scoped deletion/reference checks protect in-flight source files and reject account deletion during `sending`. Pending requests expire after 30 days. Accepted outcome records and their immutable references remain until scoped account deletion; no untested automatic mail-record purge runs in production.

## Repeatable checks

`npm test --prefix cloudflare -- --run tests/email-delivery.test.ts tests/reports.test.ts tests/scheduler-discovery.test.ts` exercises actual isolated Worker/D1/R2/Queue operations with synthetic provider endpoints only. Coverage includes duplicate deliveries, exact-byte Resend retry, SendGrid uncertain interruption, expired keys, bounded attempts, setup errors, integrity/missing-file rejection, mixed report exports, ten-attachment/size link fallbacks, owner isolation, owner-email change, deletion races, schedule pause during payload read, queue recovery, revision/tombstone guards and immutable bindings.

`npm test --prefix frontend -- --run src/test/report-email.test.jsx` verifies explicit send controls, setup fallback, polling and accepted-versus-delivered language. Standalone guide PDF structure, extracted text, all-page rendering and clickable link QA are documented in [prep-exports.md](prep-exports.md).

Provider behavior references: [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys), [SendGrid Mail Send](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send), and [SendGrid response meanings](https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api/responses). Consult current account documentation before enabling a real send.
