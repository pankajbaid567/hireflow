# P3 and Gmail implementation verification

Published 27 October 2026 (IST); final CI and scoped production cleanup were
independently checked on 28 October 2026.

P3 implements the two numbered roadmap items: private hiring shortlists and a
learned reranking experiment. The separate F-series proposals remain future
scope. Existing candidate workspaces, consent, reviewed resume versions and
production ranking are preserved.

## Implemented scope

- `/hiring` accepts bounded JSON/CSV applicant facts, shows deterministic top-N
  results and every candidate's declared skill/project/experience evidence, and
  persists an owner-only standalone HTML report. It uses the existing six-factor
  lexical scorer; it does not verify proficiency or infer protected traits.
- Hiring scoring uses bounded Queue claims in production, with owner/global
  budgets, recovery and a three-attempt ceiling. Reports are immutable. Explicit
  report-hash review and confirmed operator-authorized recipients are required
  before creating a private Gmail delivery ticket. SMTP is attempted once;
  uncertain outcomes require reconciliation and are never blindly resent.
- Weekly reports support Gmail through pinned Nodemailer 10.2.1 and the fixed
  Gmail TLS socket. Sender, recipient policy, private payloads and dates remain
  bound to the queued snapshot. Gmail SMTP acceptance is separate from recipient
  inbox receipt. Python has a separate standard-library SMTP_SSL implementation
  and local SQLite quota; it is not the Cloudflare queue or a shared quota.
- The frozen four-feature pairwise reranker experiment tied the existing hybrid
  at **0.9511 heldout nDCG@3**. The predeclared +0.02 gain gate failed, so it is
  **not adopted**. Production matching is unchanged. The original frozen labels
  and semantic alpha were not tuned. See [experiment evidence](reranker-experiment.md).

## Local and isolated checks

The full Worker gate passes **774 tests**, with four opt-in skips, plus
TypeScript and a Worker deployment dry run. Python passes **407 tests** with
three opt-in skips; frontend passes **157 tests** and its Cloudflare build.

The Gmail subset has 92 tests: 24 protocol/MIME, seven actual isolated durable
Gmail delivery cases, two populated D1 migration cases and the existing 59
Resend/SendGrid delivery/receipt cases. SMTP response boundaries, authentication
rejection, synchronous socket failure, disconnect/uncertain writes, immutable
PDF/report binding, no blind retries and shared quota races are exercised with
synthetic sockets/providers. These tests send no real email.

The React/Worker/D1/file browser workflow also exercises hiring JSON intake,
source evidence, the actual hiring Queue dispatcher, private HTML, missing-Gmail
setup, mobile at 390 pixels without horizontal overflow, and download denial
after logout. All 18 workflow checks pass with zero page errors. A plain
name/skills CSV regression confirms absent experience remains unknown, and a
bounded import larger than the normal profile request cap is tested.

An isolated loopback PostgreSQL 16 container passed `alembic upgrade head`,
`downgrade base`, `upgrade head` and `check`, including new revision 006. The
container and its temporary password file were removed. No production Python
or PostgreSQL database was touched.

The current archive/restore tests preserve completed hiring reports, deactivate
unfinished analysis, exclude hiring email authority, reject dirty destinations,
and bind deletion to new delivery evidence. Both runtime schemas keep ownership
explicit; old unassigned Python shortlist rows remain inaccessible over HTTP.

## Native Gmail compatibility, without credentials

The final production transport source SHA-256 is
`ea551e8ee93088401003b0d374309ce511c362b43ecc54b738a4fc457a286abe`.
An actual private Cloudflare Queue invocation bundled this source with Nodemailer
10.2.1 and verified `smtp.gmail.com:465` TLS/EHLO at
**2026-10-26T20:24:17.878Z**. It used no Gmail credentials and performed no AUTH,
MAIL, RCPT or DATA. This establishes native transport compatibility, not Gmail
login, submission, inbox placement or real end-to-end delivery.

The first probe timed out without reaching its D1 guard: exact Queue metrics
showed one write/read/successful delete and an empty backlog. That supports an
early pre-secret consumer acknowledgement, not an SMTP failure. Its failed proof
is retained. The helper now binds its QA secret atomically on the initial
deployment. The next probe and the final frozen-source probe passed. An
independent final read verified all three runs' exact Workers, Queues, private
KV results, D1 guards and temporary secret files absent. Main API and same-origin
Pages API remained healthy. No counters were reset or paid resources activated.

## Deployment and remaining evidence

Published on **27 October 2026 (IST)** to the existing free deployment:

| Component | Published value |
| --- | --- |
| Source | `7c9e3ad09d65c471c35cba07bb33926062ad2b4a` |
| Dashboard | [hireflow-dashboard.pages.dev](https://hireflow-dashboard.pages.dev/hiring) |
| Pages deployment | `712c55b3` ([deployment URL](https://712c55b3.hireflow-dashboard.pages.dev)) |
| API Worker | `705de1ec-4e7a-43fd-a656-bf438eb4ea33` |
| D1 schema | Migrations through `0021` |

Migration 0020 extends Gmail without editing applied 0017/0019: it preserves
existing provider payloads, signed receipts, scheduled bindings, revision
counters and guards during the table swap. Migration 0021 adds private hiring
reports/delivery history. Both were tested before application and passed on
production D1; the subsequent foreign-key check returned no violations. A
private pre-migration recovery bookmark was retained. Applied migrations remain
immutable.

The Pages publication wrapper uploaded Functions and assets, then verified
typed same-origin JSON health and HTTP 422 for an invalid empty profile without
creating a workspace.

Exact source `7c9e3ad` passed [Cloudflare CI](https://github.com/pankajbaid567/hireflow/actions/runs/40396964148),
[Backend CI](https://github.com/pankajbaid567/hireflow/actions/runs/40396964165)
and [Frontend CI](https://github.com/pankajbaid567/hireflow/actions/runs/40396964074).
Cloudflare's Chromium dependency installation took longer than the other jobs;
it subsequently completed successfully at `2026-10-26T20:58:14Z`. Final read-only
GitHub metadata verification on 28 October confirms all three conclusions.

The production browser run used one disposable synthetic workspace and no real
applicants. Both JSON and ordinary name/skills CSV requests returned HTTP 202,
progressed from `queued` to `completed` through the production Queue and recorded
one scoring attempt each. The JSON top two retained project technologies,
canonical JavaScript alias evidence and supplied education; missing experience
years remained unknown. Refreshing preserved report hashes and ranking.
Authenticated private HTML downloaded with the matching hash, no-store and CSP;
anonymous download returned 401. Desktop and 390-pixel mobile checks passed with
zero page errors or horizontal overflow. Gmail readiness was false and send
controls were disabled. No email, search, model-diagnostic or employer-submission
request was made. Operator ledgers showed no external/provider work; ordinary
HTTP request telemetry was retained separately.

The first browser helper timed out on an incorrect nested-select label before
any shortlist POST. Its failed proof is retained. Correcting only the private
helper resumed the same workspace; no duplicate profile or third report was
created. Stable screenshots were recaptured in fresh contexts after mobile
navigation transitions settled.

Normal exact-owner deletion subsequently completed in the production Queue,
revoked the test session and removed both reports and all scoped workspace rows.
The reports were inline D1 records, so there were zero private artifact files to
delete. No broad resource or other-owner cleanup was performed.

After cleanup, all seven original workspace tables and all twelve private files
matched both the pre-migration snapshot and the original P2 baseline. A second
existing workspace's eight-table snapshot also matched. Shared Gmail, discovery
and embedding usage counters were unchanged. The sanitized
[release evidence](evidence/p3-production.json) contains the gates, publication,
production UI, cleanup and preservation results without credentials, sessions,
applicant facts or existing workspace records.

**No Gmail credentials, authenticated SMTP transaction or real email is claimed.**
Set the two private Gmail values using [the setup guide](email-delivery.md), then
explicitly authorize a test to an owner-controlled inbox. P2-05/P2-07 actual
inbox acceptance and the real 100+ relevant discovery pool remain open.
