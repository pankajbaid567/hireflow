# Private hiring shortlists

The optional hiring module is available at `/hiring` in an authenticated
workspace. It compares applicant-provided job-relevant facts with a JD,
persists a private report, and supports separately authorized Gmail delivery.
It makes no hiring decision and never sends an applicant an automated rejection.

## Supported inputs and evidence

Send JSON applicants or a CSV with unique headers including `name`. At most
200 applicants and 128 KiB of applicant data are accepted per batch; the complete
request is bounded to 200,000 bytes. Larger pools must be split explicitly.
The JD is bounded to 30,000 characters and shortlist size to 1–200.

Allowed applicant fields are `name`, `skills`, `experience_years`, `projects`,
`experience`, `education`, `target_roles` and `preferred_locations`. JSON skills
are an array of strings. Project and experience objects may contain an explicit
`technologies` array; CSV skills use semicolons, commas or pipes inside a quoted
cell, and structured columns use JSON. Invalid quoting, duplicate headers,
inconsistent row widths, negative/non-finite experience, malformed structured
facts and overlarge pools fail visibly before persistence.

Project objects support name, description, public HTTP(S) URL and technologies.
Experience supports role, company, description, supplied dates and technologies.
Education supports degree, institution, field and graduation year. Missing years
remain `null` in report facts; dates do not silently become experience years.
No institution prestige, inferred nationality, name, age, gender, religion, caste, ethnicity, disability or photo is used as a ranking signal. Unknown input
fields are discarded rather than copied to a new report snapshot.

Skill matches are supported by exact source paths and quotes from declared
skills or explicit project/experience technologies. Canonical aliases such as
JS → JavaScript use the same maintained alias table as candidate matching.
Education and descriptions remain visible for human review. They do not add a
new qualification score or establish proficiency, credential authenticity,
project ownership or independent verification. A free-text technology mention
alone is not promoted to a demonstrated skill.

## Scoring and reports

The same six-factor lexical scorer is used: skill match 40%, role fit 20%,
experience fit 15%, location 10%, compensation 10%, listing-evidence signal 5%.
No separate model changes those weights. The report explains each factor and
its missing-input defaults. In particular, the shared experience scorer receives
its existing zero-years default when years are absent, while the report retains
`null` and a review warning. Scores are comparison signals, not calibrated
hiring probabilities.

Candidates are ordered by decreasing score with input order breaking ties.
Only candidates with at least one explicit matching skill enter the requested
top N. Every normalized candidate remains in the complete report, including
nonmatches and candidates outside N. Empty pools and zero matches produce an
empty shortlist with a truthful summary rather than invented recommendations.

Production scoring runs on the existing Queue (`PLAN_WORK_IN_QUEUE=true`),
keeping the 200-candidate work off the HTTP CPU allowance. Owner-bound input
snapshots, conditional leases and idempotent queue handling prevent duplicate
publication. An active workspace deletion prevents publication. Completed
reports and HTML/hash bindings are immutable; rerunning creates a new report.
At most three reports per owner may be pending and at most 100 are retained per
workspace. A shared app safety ledger admits at most 20 report-generation
requests per UTC day across owners; it is an app limit, not a provider quota.
Interrupted scoring stops after three claimed attempts. Waiting/failed work and
exhausted budgets remain visible instead of being labelled as a completed report.

The dashboard shows candidate details and source evidence, and provides a
standalone private HTML report. HTML escapes applicant/JD text, disallows
scripts, requires the same owner session and uses `Cache-Control: no-store`.
Applicant PDF intake and PDF report rendering are separate future extensions;
neither is claimed by this version.

## API

| Method | Route | Behavior |
| --- | --- | --- |
| POST | `/hiring/shortlist` | Create; 202 queued in production, 200 completed in synchronous fixtures |
| GET | `/hiring/shortlists?page=1&page_size=20` | Owner-only history; page size up to 50 |
| GET | `/hiring/shortlists/{id}` | State, complete result or safe failure reason |
| GET | `/hiring/shortlists/{id}/report.html` | Owner-only standalone report |
| GET | `/hiring/email-readiness` | Gmail configuration state without credentials or full recipient list |
| POST | `/hiring/shortlists/{id}/email` | Explicit reviewed report/recipient authorization |
| GET | `/hiring/email-deliveries/{uuid}` | Owner-only delivery state and timestamped history |

Creating or viewing a shortlist does not create email consent. Email POST must
provide `{recipient, confirm_recipient, report_hash, reviewed: true}`. The hash
must identify the exact completed report and both recipient entries must match.
Only `GMAIL_USER` or a recipient in the private `GMAIL_ALLOWED_RECIPIENTS`
configuration is eligible. The allowlist is operator authorization, not a claim
that email ownership has been independently verified. The report must fit the
transport's 250,000-byte HTML bound; use private downloads for a larger report.

Delivery snapshots sender, recipient, HTML, SHA-256, subject, deterministic
Message-ID and Date before the Queue can invoke Nodemailer. Gmail has no server
idempotency key: one delivery gets at most one SMTP attempt. A lost/interrupted
or uncertain write becomes `needs_action` and is never automatically resent.
Repeated requests for the same report/recipient return the original ticket.
Changed configuration, unauthorized recipients, corrupt payloads and workspace
deletion are rechecked before outbound work. Successful SMTP acceptance records
`accepted_at`; it is not proof of inbox placement or reading. Event history is
append-only and participates in deletion-preview invalidation. Gmail's shared
daily attempt budget includes weekly and hiring report sends.

## Python/local support

The Python agent and API maintain JSON/CSV evidence scoring, deterministic
ordering, private pagination/detail/HTML reports and owner isolation. Alembic
`006` adds nullable ownership: old unassigned operator rows remain inaccessible
over HTTP and are not assigned to whichever user signs in next. Python's hiring
team-email API and queue are deliberately unavailable; the deployed Cloudflare
runtime owns the delivery workflow above. The existing Python weekly email
service is maintained separately.

## Verification

`pytest tests/test_hiring_shortlist.py` covers shared scorer equality, ordering,
JSON/CSV facts, source quotes, protected-field exclusion, unknown inputs,
persistence and owner isolation. `npm test --prefix cloudflare -- --run
tests/hiring-reports.test.ts` uses actual Worker/D1/migrations/Queue handlers;
only Gmail's external boundary is mocked. Frontend tests cover structured input,
source display, review/recipient consent and honest acceptance/uncertainty.
The transport's native Cloudflare compatibility and credential requirements are
documented separately in [email delivery](email-delivery.md). Provider fixtures
do not establish a real recipient inbox receipt. No real team email is sent by
these checks.
