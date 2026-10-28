# Weekly report delivery

The Cloudflare runtime queues one private, immutable delivery for an authenticated owner's saved report version. The recipient always comes from the owned profile; the endpoint accepts no arbitrary recipient. Nothing sends during profile creation, report generation, ordinary acceptance testing, or prep export generation. A manual send requires its own button/POST; scheduled sends require enabled weekly preparation and explicit email opt-in.

## Free setup without SendGrid

### Gmail with Nodemailer

The deployed Worker supports `EMAIL_PROVIDER=gmail`, using pinned Nodemailer
10.2.1 with the fixed `smtp.gmail.com:465` TLS connection. No SendGrid/Resend
API key or purchased domain is required for this path. Gmail's account limits
and automated-login restrictions still apply; the app's own quota is separate.

1. Enable [Google 2-Step Verification](https://myaccount.google.com/signinoptions/two-step-verification),
   then open [App Passwords](https://myaccount.google.com/apppasswords) and create
   a dedicated HireFlow password. This generated 16-character code is
   `GMAIL_APP_PASSWORD`; `GMAIL_USER` is the full Gmail sender address, not an API
   key. See [Google's instructions](https://support.google.com/accounts/answer/185833). Google may not
   offer App Passwords for some managed or Advanced Protection accounts.
2. Put `GMAIL_USER` and `GMAIL_APP_PASSWORD` in an ignored local `.env`, or enter
   them through Worker secrets. Use the App Password, never the normal Google
   account password. Do not paste credentials in chat, Git or frontend variables.
3. Publish both secrets to `hireflow-api`; a local `.env` is not automatically
   uploaded. From `cloudflare/`, the pinned interactive commands are
   `npm exec -- wrangler secret put GMAIL_USER` and
   `npm exec -- wrangler secret put GMAIL_APP_PASSWORD`.
4. The Gmail sender always derives from `GMAIL_USER`. `FROM_EMAIL` applies only
   to Resend/SendGrid. The default recipient is the same Gmail inbox; additional
   team inboxes require the private comma-separated `GMAIL_ALLOWED_RECIPIENTS`
   secret (at most ten extra addresses). This is operator authorization, not
   independent email-ownership verification.
5. Generate and review a report, then explicitly send it. For hiring reports,
   confirm the recipient twice and approve that exact report hash. Verify
   receipt in the intended inbox before claiming end-to-end email delivery.

Weekly and hiring sends share an atomic D1 allowance of ten SMTP attempts per
UTC day. `GMAIL_DAILY_ATTEMPT_LIMIT` can be configured from one to twenty; it
cannot disable the bound. Uncertain attempts are never refunded. The Node
transport uses a fresh non-pooled connection, verified certificates and TLS1.2+
with a twenty-second overall deadline, no file/URL attachment access and no
SMTP credential/body logging. Gmail JSON never chooses a server, TLS policy,
password or arbitrary recipient. Public access to a profile does not authorize
sending to an address outside the private operator allowlist.

Gmail has no submission idempotency key. An interrupted or uncertain transaction
becomes `needs_action`; it is never blindly retried. Check the sender Sent folder
and recipient before considering a fresh report. SMTP250 records `accepted_at`
and `smtp_server_acceptance`; it never fills `delivered_at` or invents a signed
webhook/inbox receipt. Existing Resend/SendGrid receipts remain independent.

The local Python helper supports the same Gmail configuration with standard
library `SMTP_SSL`; Nodemailer runs in the Worker/Node path. Python's atomic
SQLite quota ledger is under its private local-storage directory and is
**separate** from Cloudflare's D1 ledger. It is not cross-runtime quota sharing.

## Setup and current evidence

Gmail is the selected Worker provider, but no Gmail credentials are configured
and **no actual email or SMTP authentication has occurred**. The credential-free
native Cloudflare Queue probe verified Nodemailer TLS/EHLO/QUIT against Gmail;
it cannot send mail or prove authentication/inbox placement. The final factory
has actual protocol/MIME tests and native compatibility evidence, including
cleanup of every exact QA resource. See [P3 verification](p3-verification.md).

Alternative providers remain supported: select `EMAIL_PROVIDER=resend` or
`sendgrid`, configure the corresponding private API key and a provider-verified
`FROM_EMAIL`. Keep secrets server-side. Signed receipt setup is described below.
Resend's [free plan](https://resend.com/pricing) currently allows 3,000 emails/month,
capped at 100/day. Its `onboarding@resend.dev` test sender can send only to the
inbox associated with that Resend account; other recipients require a verified
domain. See [the test-domain restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain).

**P2-05/P2-07 real delivery acceptance remains open** until an explicitly
authorized test to an owner-controlled inbox confirms receipt. Mocked provider
success, native TLS/EHLO, and SMTP acceptance are different evidence. Neither
adding credentials nor running the test suite authorizes a real test email.

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

For Resend/SendGrid, an HTTP success sets `accepted_at`, provider message ID where available, and the compatibility `weekly_reports.email_sent_at`. This means **accepted by the provider**. If a verified `email.sent`/`processed` event arrives first, its event timestamp fills missing acceptance timestamps for the exact original report version; existing HTTP acceptance timestamps remain unchanged. A delivered or bounced event alone does not fabricate this timestamp. Signed provider events separately populate `delivery_status`, `delivery_status_at`, `receipt_received_at` and, only for a verified delivered event, `delivered_at`. The internal queue `state` remains separate: an accepted request can subsequently be delayed, bounced or complained about. `delivery_evidence` identifies signed webhook evidence versus API acceptance. A provider-delivered event means acceptance by the recipient mail server; it does not establish inbox placement, display or reading by the owner. Actual P2 inbox-receipt acceptance still needs the explicitly authorized human check above.

The source and payload keys are owner-private lifecycle references. Migration `0017` increments workspace revisions for delivery mutations, blocks artifact publication after a retention tombstone, and prevents binding/hash rotation. Backups exclude mail payloads and delivery authority; scoped deletion/reference checks protect in-flight source files and reject account deletion during `sending`. Pending requests expire after 30 days. Accepted outcome records and their immutable references remain until scoped account deletion; no untested automatic mail-record purge runs in production.

## Signed delivery receipts

Apply additive migration `0019_email_receipts.sql` before deploying its receipt
handler. Previously applied migrations remain unchanged. Provider callbacks use
the direct API Worker origin and need no HireFlow session cookie:

| Provider | POST route | Worker verification setting |
| --- | --- | --- |
| Resend | `/email/webhooks/resend` | Secret `RESEND_WEBHOOK_SECRET` (`whsec_…`) |
| SendGrid | `/email/webhooks/sendgrid` | `SENDGRID_WEBHOOK_PUBLIC_KEY` (base64 SPKI or PUBLIC KEY PEM, P-256) |

Create the matching webhook in the provider dashboard. For Resend select
`email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`,
`email.failed`, `email.suppressed` and `email.complained`; save the signing secret
privately. For SendGrid select processed, delivered, deferred, bounce, dropped
and spam-report events, enable **Signed Event Webhook**, save, then copy its
public verification key. These configurations are independent of the send API
key. Do not expose either setting through the frontend or commit it to Git.
Unconfigured receipt verification fails closed with HTTP 503.

Resend HMAC verification uses the exact raw bytes with its signed message ID and
timestamp. Multiple v1 signatures support secret rotation. SendGrid verification
uses its signed timestamp plus the exact raw bytes, a P-256 SPKI key and the DER
ECDSA signature. Requests require a signature timestamp within five minutes,
JSON without compression, at most **128 KiB**, at most **100 events**, and a
five-second body-read bound. Re-serializing JSON before verification is not
permitted. Opens/clicks are ignored and never treated as delivery evidence.

New immutable payloads contain only the random delivery UUID in a Resend tag or
SendGrid custom argument. Provider receipts must match that captured delivery,
provider, owner-derived recipient, started send attempt and any already-bound
message ID. The UUID permits a receipt to arrive before the provider HTTP
response is saved. Existing untagged Resend sends can match their exact saved
email ID. SendGrid's API X-Message-ID and webhook sg_message_id differ; the
reader does not invent a prefix-equivalence rule. Unknown messages receive the
same generic acknowledgement and cannot alter a workspace.

A transactional private ledger retains event-ID hashes, normalized outcome,
provider event time, capture time and a content hash, with no raw body, email
address, diagnostic, IP address or user-agent. Logical retries are deduplicated;
an identifier reused with conflicting content is rejected. Freshly re-signed
provider replays remain idempotent. At most 512 receipt records are retained per
delivery until scoped owner deletion; no automatic receipt-record purge is
claimed. A new receipt that cannot be captured at that bound returns 503 rather
than being silently acknowledged. Retry the provider notification, not the email.

Status ordering uses source event time and terminal-outcome rules: sent/delayed
replays cannot erase delivery or failure; complaints remain visible; a later
bounce can replace the current delivered status while preserving the original
`delivered_at` evidence. A verified result stops blind retry after an uncertain
send. A late API response loses its lease and cannot erase the receipt or update
a newer report version. Receipt rows cascade with the owned delivery on account
deletion and are excluded from restorable email/submission authority.

The bounded ledger writes use one D1 transaction batch plus indexed lookups.
[D1's batch limit policy](https://developers.cloudflare.com/d1/platform/limits/#batch-limits)
counts a batch as one invocation query, while each statement retains its normal
size/parameter limits. Functional bounds are not an HTTP CPU-headroom claim.

## Repeatable checks

`npm test --prefix cloudflare -- tests/email-delivery.test.ts tests/email-webhooks.test.ts tests/reports.test.ts tests/scheduler-discovery.test.ts` exercises actual isolated Worker/D1/R2/Queue operations with synthetic provider endpoints only. Coverage includes duplicate deliveries, exact-byte Resend retry, SendGrid uncertain interruption, expired keys, bounded attempts, setup errors, integrity/missing-file rejection, mixed report exports, ten-attachment/size link fallbacks, owner isolation, owner-email change, deletion races, schedule pause during payload read, queue recovery, revision/tombstone guards and immutable bindings.

Receipt tests include the published Svix and SendGrid SDK cryptographic vectors,
exact CRLF preservation, timestamp/signature/raw-body rejection, duplicate and
concurrent events, recipient/message binding, cross-owner negatives, a receipt
arriving before the API response, out-of-order delivery/bounce/complaint events,
the 100-event batch bound, ledger capacity and late receipts after owner deletion.
They perform no real external email send and cannot establish owner inbox receipt.

`npm test --prefix frontend -- --run src/test/report-email.test.jsx` verifies explicit send controls, setup fallback, polling and accepted-versus-delivered language. Standalone guide PDF structure, extracted text, all-page rendering and clickable link QA are documented in [prep-exports.md](prep-exports.md).

Provider behavior references: [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys), [Resend signed requests](https://resend.com/docs/webhooks/verify-webhooks-requests), [Svix manual signature specification](https://docs.svix.com/receiving/verifying-payloads/how-manual), [Resend delivered-event semantics](https://resend.com/docs/webhooks/emails/delivered), [SendGrid signed Event Webhooks](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features), [SendGrid event fields](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event), and [SendGrid Mail Send](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send). Consult current account documentation before enabling a real send.
