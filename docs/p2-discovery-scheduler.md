# Larger discovery and weekly draft preparation

The production dashboard is <https://hireflow-dashboard.pages.dev>. Its API is
<https://hireflow-api.baidpankaj567.workers.dev>. These features use the existing
free D1, private KV and Queue bindings; they do not enable R2 billing.

## Discovery checkpoints

`POST /jobs/{owner}/discovery-cycles` starts a private profile/mode-bound cycle.
The default target is 100, with 20 search-attempt slots and 300 detail-check slots. Targets
are goals, not availability guarantees. Each Queue message performs at most one
search or detail operation. The UI shows source counts, budgets and retained
results, with cancel/resume controls. Slots are reserved before external work; an interrupted, uncertain request remains charged to prevent budget overspend on restart. Only a known zero-read wait may release a per-cycle slot; account-wide reservations are never refunded. A profile change invalidates the old
checkpoint; cancellation keeps verified jobs. Checkpoints expire after 48 hours.

Tavily has no result cursor. Saved query variants rotate sources and explicit
role/skill/location queries; they are not advertised as provider pagination.
Canonical URLs deduplicate candidates. Job description verification uses public
Greenhouse, Lever and Ashby APIs or permitted public structured/static pages.
Search snippets alone never count as verified listings. Missing evidence stays
unknown. Authenticated sites, bot restrictions and closed/unlisted jobs do not
become success by retrying a different URL.

Shared limits default to 25 searches and 400 source reads per UTC day. They are
pessimistic reservations, with no failure refund. The per-host gate spaces reads
by one second, respects bounded Retry-After and caches complete public responses
for six hours. Private/no-store and truncated responses are not cached. Current
HTTP sources have strict redirect/URL/byte/time bounds. These safeguards are
separate from provider billing limits and cannot promise free provider credits.

The controlled runtime test verifies **100 distinct complete synthetic JDs**,
source rotation, a cancelled/resumed checkpoint and duplicate deliveries using
actual workerd/D1. This is a deterministic engine-capacity test. It is not a
claim that 100 relevant live jobs were available to a particular profile.
The production measurement is recorded separately in P2 verification.

## Explicit local alternative

For a larger pool without Cloudflare's request execution limits, run the same
engine on your own machine. Local execution still consumes real provider credits
and obeys source restrictions; it cannot manufacture 100 suitable openings.

```bash
cd cloudflare
# Use Node 22. The environment file and profile JSON stay private.
node --env-file=../.env scripts/discover_local.mjs \
  --profile /private/profile.json --directory /private/discovery --target 100
# After interruption, use the same directory and add --resume.
```

The profile JSON uses the normal fields: name, email, mode, skills, target_roles,
preferred_locations and experience_years. The directory contains local D1,
private documents, a private owner session/checkpoint and verified full-JD JSON.
Keep it out of Git and shared/public folders. This command performs no employer
submission, email delivery or remote database migration. A partial result includes
the reason and actual counts rather than being padded with snippets.

## Weekly scheduling policy

Scheduling is disabled by default. Profile settings expose timezone, weekday,
hour/minute, discovery target (at most 50), guide preparation, optional email,
pause/resume, next run and recent run status. The five-minute cron dispatches
bounded stages. A unique owner/local-Monday-week key prevents duplicate cycles.
After an outage, only the most recent due week is prepared; historical missed
weeks are not replayed. UTC-week application quota remains shared across modes.

IANA timezones determine the local week and wall-clock schedule. A fall-back
clock fold uses the first occurrence; a nonexistent spring time moves forward
by the gap. Settings changes cancel active scheduled work and discovery cycles created by that run. An already-existing manually started discovery cycle reused by a schedule keeps its own explicit cancel control. Profile changes stop
old captured work. Queue leases and the 48-hour expiry bound recovery.

Stages are discovery, plan, optional guides, report, optional opted-in email and
an in-app review reminder. Email opt-in is rejected until a supported sender is
configured. A delivery request still has its own idempotency/failure state.
Scheduling **never calls the confirmation endpoint**, creates a submission
review, or authorizes an application. Reviewed resumes/answers and explicit
confirmation remain required for every external submission.

`tests/scheduler-discovery.test.ts` covers local week/year boundaries, India and
DST transitions, duplicate/missed ticks, restart recovery, pause, profile changes,
unconfigured email, partial discovery and the absence of submission authority.
