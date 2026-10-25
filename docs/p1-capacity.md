# P1 capacity measurements and CPU changes

The deployment is the existing free Cloudflare account, Worker `hireflow-api`
and Pages dashboard. No plan, browser allowance or provider budget is raised by
this work. The P0 full-cycle measurement remains historical:
CPU P50/P95/P99 **3.515/14.581/24.715 ms**, 252 invocations and zero errors.
Those numbers must not be replaced by unrelated health-only latency.

The final production cycle meets the bounded interactive target: **120 product
HTTP fetches, CPU P50/P95/P99 3/9/10 ms, max 14 ms**. The 14-ms signup outlier
remains explicit. This is one active owner's complete two-mode workflow, not a
sustained-load or concurrency guarantee. Portable, sanitized aggregates are in
[p1-capacity.json](evidence/p1-capacity.json).

## Measurement boundaries

Two separate tools now supply reproducible evidence:

- `scripts/profile_worker_operations.mjs` captures actual V8 CPU samples through
  the inspector of an isolated **workerd** runtime. It supports operations,
  account-security and ASCII/Latin/Devanagari PDF fixtures. No production data,
  credentials, models or external forms are used. Active local samples identify
  hot functions; they are **not Cloudflare billed CPU quantiles**. The first
  dispatch measurement starts after runtime/module initialization, so it is not
  startup CPU. Source/bundle hashes, query plans and private `.cpuprofile` files
  accompany the reports.
- `scripts/profile_cloudflare_routes.mjs` samples five fixed safe production GET
  routes with one explicitly created synthetic workspace. It records client
  wall P50/P95/P99 separately from actual Cloudflare GraphQL CPU and isolate
  memory. Each route's exact traffic window is retained; concurrent callers and
  recovery cron can contribute, so a window is not exclusive route attribution.
  Analytics ingestion can lag. Refresh the same proof instead of silently
  treating missing samples as zero CPU.

The official [production profiling API](https://developers.cloudflare.com/workers/observability/profiling-in-production/)
was tried twice on the confirmed active P0 version while live requests succeeded.
It returned HTTP 404, code `10393` (no recent executions), including during the
authenticated operations workload. **No production pprof capture is claimed.**
Local inspector captures and platform CPU/memory measurements remain distinct
evidence. Source maps are uploaded by the installed Wrangler version by default.

## Changes supported by profiling

1. **Account security:** the local capture showed repeated native fetch/span and
   result conversion work around three sequential owner-scoped reads. The
   session list, passkeys and recovery-key totals now use one D1 batch/snapshot.
   Authorization, signature checks, revocation and atomic key consumption are
   unchanged; credentials are not cached between requests.
2. **Operations sample:** the previous route returned up to 1,000 latency rows,
   converted them to objects and sorted them in JavaScript. D1 now returns one
   aggregate row with the same nearest-rank percentiles and latest-1,000 owner
   bound. The local capture confirms less conversion work, but its total local
   CPU/wall result alone did not establish an overall speedup: SQLite work and
   local runtime overhead also contribute. The production candidate comparison
   remains the deciding gate.
3. **Latest-request index:** migration `0010_operations_request_index.sql` adds
   `(user_id, operation, created_at DESC)`. Actual `EXPLAIN QUERY PLAN` changed
   from the owner/cycle index plus `USE TEMP B-TREE FOR ORDER BY` to the new index
   with owner, operation and date constraints. This avoids sorting unrelated
   cycle/provider history before the sample cap; the owner boundary remains.
4. **Unicode fonts:** PDF profiling identified repeated font-stream conversion.
   Static font streams/widths are prepared during isolate initialization. Each
   document owns its Hindi shaping engine and glyph cache; the shared template
   contains parsed font data, not a previous user's glyph sequence. See
   [PDF quality evidence](p1-pdf-quality.md) for reader/fact/isolation checks.

The operations response also shows the shared semantic daily text allowance,
reserved texts/characters, remaining texts and configured pooling/model. It uses
the same hard-100/default-100/invalid-zero helper as embedding reservation.
Reading status makes no model call. When allowance is exhausted, the UI says
that new uncached matches use lexical matching; existing cached embeddings
remain usable. This adds one small D1 status query, so the P1 response is not
identical to the P0 benchmark response.

## Isolated results — 23 October 2026

| Workload | Evidence and observed result |
| --- | --- |
| Account GET, 1,000 reads after ten warmups | Local sampled active mean **1.332 → 0.973 ms/request**; client wall P95 **2.824 → 1.991 ms**. Proofs `/tmp/hireflow-p1-capacity/account-before.json` and `account-after.json`. This supports the batch change, not a remote CPU guarantee. |
| Operations, 1,000 owner request events | D1 conversion frames decreased, but sequential local total active mean was **2.055 → 2.346 ms/request** before the additional index/status fields. No overall improvement is claimed from this run. Proofs `operations-before-sequential.json` and `operations-after-sequential.json`. |
| Small ASCII PDF, 50 reads | 2,545-byte PDF; local active mean **0.506 ms/request**, wall P95/P99 **0.877/1.481 ms**. First dispatch after runtime ready **2.94 ms**. Proof `pdf-ascii.json`. |
| Accented Latin PDF, 50 reads | 504,336-byte PDF with embedded font; active mean **1.155 ms/request**, wall P95/P99 **1.697/2.155 ms**. First dispatch **4.52 ms**. Proof `pdf-latin.json`. |
| Small Devanagari PDF, 50 reads | Same 411,581-byte output before/after: active mean **3.729 → 2.689 ms/request**, wall P95 **7.091 → 3.713 ms**, P99 **11.373 → 5.017 ms**. First dispatch after runtime ready **11.89 ms** after optimization. Proofs `pdf-hindi-before.json` and `pdf-hindi-after.json`. |

Artifacts in this table live under `/tmp/hireflow-p1-capacity/`, outside Git.
Sampling, host contention and JIT make local microbenchmarks variable. Small
Unicode documents do not establish the cost of long Hindi paragraphs or every
script. Complex text is bounded and unsupported/oversized content is handed off
without silently deleting facts. Cold module startup and a complete deployed
profile/discovery/ranking/review/application cycle require separate evidence.

## Production baseline

P0 Worker version `cdaf5730-d2ea-4544-86b2-746b3694feb6` was measured before P1
changes with **100/100 HTTP-200 reads**, concurrency two: 20 each of health,
session, synthetic profile, account security and operations. No provider, job,
queue, browser application or email operation was invoked.

After ingestion, the whole traffic window contained **97 sampled invocations,
zero errors**, actual CPU P50/P95/P99 **3.801/7.388/8.334 ms**, and V8 isolate
memory P99 **20,288,820 bytes**. The difference from 100 client reads and the
per-window counts is retained accurately: analytics are sampled, and shared
background traffic can contribute. It is not evidence that every request was
observed in GraphQL.

| Traffic window | Actual platform CPU P50/P95/P99, ms |
| --- | --- |
| Health | 2.396 / 7.415 / 8.334 |
| Session | 2.403 / 4.290 / 4.556 |
| Profile | 3.758 / 5.490 / 5.671 |
| Account security | 4.648 / 6.434 / 7.836 |
| Operations | 4.895 / 8.060 / 8.060 |

Proof: `/tmp/hireflow-p1-capacity/routes-before.json`. Warm read-only traffic
already fitted a small sub-10-ms sample on P0; it does not explain away the
higher P0 full-cycle tail. The new bundle's whole-cycle and Unicode behavior
must be measured after deployment before closing that release gate.

## Production P1 read comparison

Candidate Worker `d9634e84-a645-4833-8da3-b091492f0e73`, with migrations
`0008`–`0010` and Pages deployment `cdc2de6a`, received the same matrix using
the same synthetic owner: **100/100 HTTP-200 reads, zero network failures**,
20 requests per route, concurrency two. Its exact window was
**2026-10-23 09:19:09.607–09:19:45.675 UTC**. The original owner/session was
reused, rather than comparing unrelated accounts or creating extra fixtures.

After ingestion, native analytics contained **99 sampled invocations and zero
errors**, CPU P50/P95/P99 **3.222/5.989/8.336 ms**. The observed P95 was about
19% lower than the P0 read window; P99 was essentially unchanged. Isolate
memory P99 increased from **20,288,820 to 29,551,534 bytes** with the larger
Unicode-capable bundle, below the 128-MiB isolate allowance in this sample.
These whole-Worker time windows can include other callers/background work;
they cannot establish an exclusive causal effect of one optimization. The
controlled application cycle below started after this read matrix ended.

| Traffic window | P0 CPU P50/P95/P99, ms | P1 CPU P50/P95/P99, ms | P1 client wall P95, ms |
| --- | --- | --- | --- |
| Health | 2.396 / 7.415 / 8.334 | 2.866 / 5.708 / 8.156 | 1,464.0 |
| Session | 2.403 / 4.290 / 4.556 | 2.770 / 4.042 / 4.222 | 606.2 |
| Profile | 3.758 / 5.490 / 5.671 | 3.240 / 5.347 / 5.619 | 906.3 |
| Account security | 4.648 / 6.434 / 7.836 | 3.616 / 5.989 / 6.259 | 857.8 |
| Operations | 4.895 / 8.060 / 8.060 | 4.369 / 8.336 / 8.336 | 1,108.7 |

The operations window does **not** demonstrate a tail reduction: P95/P99 were
slightly higher, while the response now includes semantic-quota status. The
account-security result is consistent with the isolated batch improvement,
although this small shared production sample is not a sustained-load guarantee.
Client wall time is dominated by additional network/platform work and remains
separate from measured request CPU; it must not be substituted for CPU.

Proof: `/tmp/hireflow-p1-capacity/routes-after.json`, refreshed at
09:20:33.854 UTC. The synthetic owner-17 session was subsequently revoked,
authenticated profile access returned 401, and the private cookie state file
was removed. Its owner-scoped database cleanup is tracked by the release
runner. No browser/provider allowance was reset. Deployment output did not
provide startup CPU, so no production cold-start CPU result is claimed.

## First P1 controlled-cycle findings

The 23 October run `bd0e4e7807ac` on the same candidate is **a failed E2E run**,
not a completed acceptance proof. It reached both modes and two confirmations,
then stopped at the job review stage on an assertion (`2 !== 1`). The retained
measurement window starts at its recorded `started_at`, **09:21:05.372 UTC**,
and ends at the final proof-file write, **09:27:02.365 UTC**. The proof did not
record an instrumented finish time, so the latter is an artifact boundary.

Native GraphQL analytics retained **72 sampled invocations, zero runtime
errors**, CPU P50/P95/P99 **7.108/108.545/546.309 ms**, and memory P99
**38,473,588 bytes**. That dataset's inspected schema has no event-type/trigger
dimension. It cannot label this aggregate as HTTP-only, and a successful
runtime outcome is separate from the E2E assertion result.

The official Workers Observability aggregate API provides verified keys
`$workers.eventType`, `$workers.outcome`, `$workers.cpuTimeMs` and
`$workers.wallTimeMs`. A read-only, `dry:true` query scoped to the exact Worker,
candidate version and window separates the workloads without retrieving raw
log events, headers, query strings, prompts or response bodies:

| Invocation type / outcome | Reported invocation count | CPU P50 / P95 / P99 / max, ms | Wall P95, ms |
| --- | --- | --- | --- |
| fetch / ok | 71 | 6 / 28 / 108 / 108 | 4,291 |
| scheduled / ok | 1 | 10 / 10 / 10 / 10 | 3,157 |
| queue / ok | 5 | 309 / 546 / 546 / 546 | 26,550 |

Invocation-log CPU values have millisecond precision. The fetch aggregate's
sample interval was about 1.145, while queue/scheduled groups reported 1;
weighted counts, ingestion and differing datasets explain why counts are not
identical to GraphQL. Missing groups are unobserved, not zero-cost work.
The published [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)
list **10 ms for Free HTTP and Free Cron CPU**. The separate
[Queues limits](https://developers.cloudflare.com/queues/platform/limits/#increasing-queue-consumer-worker-cpu-limits)
describe a 30-second default consumer CPU limit and a 15-minute wall limit.
Queue time must not be compared to the HTTP CPU allowance.

The **28-ms HTTP P95 fails the 10-ms objective** for this candidate, despite the
safe read matrix passing. Aggregate route investigation identified discovery
at **70/108 ms** (two requests, P50/P95), weekly-plan GET at **8/40 ms** (12),
signup at **22 ms** (one), swap at **18/22 ms** (two), draft edit at **15 ms**
(one), and confirmation at **9/13 ms** (two). Paths are normalized before proof
output; separate raw-path groups are not merged into invented percentiles.

Private retained artifacts: `cycle-interrupted.json`,
`cycle-interrupted-trigger-aggregates.json` and
`cycle-interrupted-route-aggregates.json` under `/tmp/hireflow-p1-capacity/`.
The CLI's existing OAuth could read GraphQL but received 403/code 10000 for
Workers Logs; the connected Cloudflare MCP supplied the authorized aggregate
read. This did not change credentials, logging sampling, plans or quotas.

## Discovery CPU correction — 25 October

An isolated workerd fixture runs the actual discovery logic with **five
independent source searches, four results per source and eight verified full
8,199-character JDs**. Provider responses are generated outside the profiled
Worker, so fixture construction is excluded from its CPU capture. Ordinary
HTML is 125,934 bytes, with real JSON-LD plus irrelevant JavaScript. No live
provider call or employer submission occurs.

Profiling confirmed duplicate payload cost: search requested raw page text for
all candidates, although only fetched source HTML/ATS JSON can supply a
verified JD. Discovery now explicitly requests Tavily `include_raw_content:
false`; snippets never become authoritative descriptions. It also skips
invisible script/navigation text before entity decoding, reuses a static entity
table, avoids an extra byte copy for a single response chunk, and uses a linear
tag scan that keeps unclosed scripts hidden. Escaped HTML and UTF-8 split across
chunks retain their source facts; visible expired banners remain rejected.

| Local workload | Before | Corrected |
| --- | --- | --- |
| Ordinary HTML, first sampled active runs | 14.210 ms/read (40 reads) | 10.844 ms/read (100 reads) |
| Ordinary HTML, later 100-read repeat | 11.360 ms/read | 17.865 ms/read |
| Ordinary HTML, provider response bytes | 1,339,379/read | 683,119/read |
| Truncated script, sampled active mean | 23.529 ms/read | 13.244 ms/read (40 reads each) |
| Truncated script, wall P95 | 45.916 ms | 17.556 ms |
| Truncated script, tag/text self samples | 439.718 ms total | 50.699 ms total (text plus scanner) |

The ordinary repeats vary materially and do **not** establish a stable total
local CPU speedup; the last repeat's native fetch/read frames also increased.
The smaller provider payload is deterministic, while shared-host scheduling,
JIT and runtime overhead affect sampling. The malformed fixture preserves the
same verified JDs but ends in a 125-KB
unclosed script containing repeated `<` tokens. It exposes the old broad tag
regex's repeated scanning. These local results support the changes; they are
**not billed CPU P95 values** and do not establish a 10-ms HTTP discovery bound.
The scanner also avoids lowercasing a whole Unicode page: characters such as
`İ` can expand and invalidate offsets. Mixed-case tags and unchanged multilingual
source facts have an explicit regression. The measured need for bounded queue
stages remains: `waitUntil()` would keep
the work charged to the same HTTP invocation. New orchestration and a complete
candidate cycle must be measured before the release gate can pass.

## Queued-discovery release: complete functional cycle, remaining CPU work

Worker `2ef717f6-2ca8-4754-8ade-f141ade740e5` (source `c2e1647`, migration
`0011`, Pages `85755cd9`) moved discovery and maintenance into owned Queue
tasks. The full two-mode run `328d62554e26` **passed functional E2E**, including
two confirmations, from **2026-10-25 10:10:25.824 to 10:16:18.375 UTC**.
Capacity collection added **no health or sampler traffic** during that cycle.

| Invocation type / outcome | Reported count | CPU P50 / P95 / P99 / max, ms | Wall P95, ms |
| --- | --- | --- | --- |
| fetch / ok | 110 | 4 / 18 / 22 / 24 | 2,972 |
| queue / ok | 7 | 80 / 468 / 468 / 468 | 23,186 |

Both invocation-log groups reported sample interval 1. No scheduled group was
observed; a separate scheduled GraphQL query also returned no rows for this
window. That is not a zero-cost Cron measurement. Native whole-Worker GraphQL
contained **118 invocations, zero runtime errors**, mixed CPU P50/P95/P99
**4.461/24.013/354.020 ms**, and isolate memory P99 **32,452,690 bytes**.
The mixed CPU tail must not be used as the HTTP tail.

The queued discovery entry now costs **5/6 ms** (P50/P95, two calls), while its
poll endpoint costs **2/3 ms** (21 calls). Draft edit measured **6 ms**, and
confirmation **8/10 ms**. The residual heavy fetch groups are weekly-plan GET
**8/24 ms** (19 calls), signup **22 ms** (one), swap **19 ms** (two), manual
job import **12/18 ms** (two), and report generation **12 ms** (one).

This release reduced the observed HTTP P95 from **28 to 18 ms** and max from
**108 to 24 ms**, with distinct finite cycles rather than a matched-load causal
experiment. It still **fails the 10-ms HTTP P95 gate**. Plan/resume preparation
and swap follow-up require further bounded orchestration; functional success
and zero runtime errors do not certify sustained Free-tier CPU capacity.
The first failed-cycle results above remain historical evidence.

Private evidence: `cycle-corrected-328d62554e26.json`,
`corrected-cycle-trigger-aggregates.json` and
`corrected-cycle-route-aggregates.json` under `/tmp/hireflow-p1-capacity/`.

### Profile intake experiment

The 22-ms production signup tail was investigated separately using real
`saveProfile` logic in isolated workerd: a synthetic 2,185-byte multipart PDF,
external mocked Gemini response, private KV persistence, normal signup
reservations and session creation. Forty measured signups plus ten warmups use
exactly the unchanged 50/day local allowance; documented test IPs are distinct.
No production counters, provider calls or billing are involved. This fixture
exercises successful inline extraction, not live-provider fallback latency.

An `INSERT/UPDATE ... RETURNING` experiment eliminated the final owner reread
without batching sessions against a guessed inserted ID. Three paired repeats
gave sampled active means **5.424/5.879/6.118 ms before**, versus
**7.256/5.620/5.927 ms after** (medians **5.879/5.927 ms**). There was no
conclusive CPU reduction, so the experiment was reverted. No profile/auth
behavior change is retained from this investigation. Private proofs are
`profile-signup-{before,after}-repeat-{1,2,3}.json` under the same directory.

## Final queued-plan release: bounded interactive target met

Worker **`d3848a38-6007-41bf-8112-7a228a3a101d`**, source **`595f68e`**, migration
`0012` with `PLAN_WORK_IN_QUEUE=true`, and Pages `85755cd9` completed run
**`83836557fce3`** successfully. The exact proof window is **2026-10-25
10:34:49.314–10:40:46.454 UTC**. PDF signup, both listing modes, real source
discovery, hybrid matching, queued PDF preparation, two exact reviewed
submissions to owned forms, prep guides, the weekly report, mobile checks and
logout passed. No health sampler or other extra application traffic was added
to improve the percentiles.

| Final invocation scope / outcome | Reported count | CPU P50 / P95 / P99 / max, ms | Wall P95, ms |
| --- | --- | --- | --- |
| All fetch / ok in the shared window | 126 | 3 / 9 / 10 / 14 | 2,989 |
| Product API fetch / ok, excluding six unrelated probes | 120 | 3 / 9 / 10 / 14 | 2,989 |
| Queue / ok | 14 | 19 / 444 / 444 / 444 | 20,373 |
| Scheduled | Unobserved | Not measured | Not measured |

All observed invocation-log groups reported sample interval 1. Six unsolicited
environment-file probes appeared in the shared public Worker window at 1–4 ms
CPU. Removing only those unrelated probes leaves the product CPU percentiles
unchanged; no expensive endpoint was excluded. Scheduled CPU was unavailable
even in a same-Worker query without a version filter, and the scheduled
GraphQL dataset returned no rows. Its absence does not establish zero cost.

Native GraphQL for the exact final version/window reports **153 invocations,
zero runtime errors**, mixed CPU P50/P95/P99 **3.631/19.519/253.053 ms**, and
isolate memory P50/P95/P99 **24,883,280/33,513,212/38,526,844 bytes**. Queue CPU
belongs to its consumer allowance; the mixed GraphQL P95 is not the HTTP P95.
Different telemetry datasets, sampling and retained CPU fields can produce
different counts. No missing samples are interpreted as zero.

| Product route group | Count | CPU P50 / P95 / P99 / max, ms |
| --- | --- | --- |
| PDF signup | 1 | 14 / 14 / 14 / 14 |
| Weekly-plan GET | 30 | 6 / 9 / 9 / 9 |
| Swap | 2 | 9 / 10 / 10 / 10 |
| Confirmation | 2 | 6 / 9 / 9 / 9 |
| Manual job import | 2 | 4 / 6 / 6 / 6 |
| Discovery start | 2 | 3 / 5 / 5 / 5 |
| Discovery polling | 18 | 2 / 6 / 6 / 6 |
| Report generation | 1 | 8 / 8 / 8 / 8 |
| Draft edit | 1 | 7 / 7 / 7 / 7 |
| Operations status | 7 | 2 / 7 / 7 / 7 |
| Account security | 4 | 1 / 3 / 3 / 3 |

| Release / functional result | Reported fetch count | HTTP CPU P50 / P95 / P99 / max, ms |
| --- | --- | --- |
| First P1 `d9634e84`, failed E2E assertion | 71 | 6 / 28 / 108 / 108 |
| Queued discovery `2ef717f6`, passed E2E | 110 | 4 / 18 / 22 / 24 |
| Queued plans `d3848a38`, passed E2E | 120 product / 126 total | 3 / 9 / 10 / 14 |

The observed product HTTP P95 fell **28 → 18 → 9 ms**, meeting the **≤10-ms**
target for this complete single-owner workflow. These are distinct finite
cycles, not a matched-load causal experiment. The signup's **14-ms** maximum
exceeds the per-request allowance and remains a rare observed tail; it is not
proven to be cold-start CPU. Module startup was not instrumented. This evidence
does not establish a sustained SLA, concurrent-user capacity, or safe cost for
every large document/complex Unicode input. No paid plan, extra allowance or
budget reset was used to achieve the result.

Portable evidence is [p1-capacity.json](evidence/p1-capacity.json). Private
platform and aggregate proofs are `cycle-final-83836557fce3.json`,
`final-cycle-trigger-aggregates.json`, `final-cycle-route-aggregates.json`,
`final-cycle-api-no-probes.json` and scheduled-availability records under
`/tmp/hireflow-p1-capacity/`. They contain no raw application request logs.

## Reproduce and compare

Use Node 22+, installed locked Cloudflare dependencies and Playwright tooling.
The default local profiler is isolated; the production tool requires `--run-live`.

```bash
# Local P0 source and candidate, using the same bounded synthetic fixture:
node scripts/profile_worker_operations.mjs --baseline-ref 358510a \
  --without-request-index --requests 1000 --output /tmp/ops-before.json
node scripts/profile_worker_operations.mjs --requests 1000 --output /tmp/ops-after.json
node scripts/profile_worker_operations.mjs --route account_security \
  --requests 1000 --output /tmp/account-after.json
node scripts/profile_worker_operations.mjs --route pdf_devanagari \
  --requests 50 --output /tmp/pdf-hindi.json
node scripts/profile_worker_operations.mjs --route discovery \
  --requests 100 --output /tmp/discovery-after.json
node scripts/profile_worker_operations.mjs --route profile_signup \
  --requests 40 --output /tmp/profile-signup.json
# Keep a private pre-edit source snapshot for like-for-like before comparison:
node scripts/profile_worker_operations.mjs --route discovery \
  --source-file /tmp/intelligence-before-discovery.ts --discovery-shape truncated_script \
  --requests 40 --output /tmp/discovery-before.json

# Exactly one synthetic owner, reused across release measurements:
node scripts/profile_cloudflare_routes.mjs --run-live --create-fixture \
  --version DEPLOYED_VERSION_UUID --capture-cpu --output /tmp/routes-before.json
# After deployment, omit --create-fixture and use the actual new UUID:
node scripts/profile_cloudflare_routes.mjs --run-live \
  --version NEW_DEPLOYED_VERSION_UUID --output /tmp/routes-after.json
# Allow analytics ingestion, then refresh the fixed recorded windows:
node scripts/profile_cloudflare_routes.mjs --run-live --refresh-proof /tmp/routes-after.json
# Revoke the synthetic session and remove its private state file:
node scripts/profile_cloudflare_routes.mjs --run-live --logout-only

# Read only already-executed cycle analytics; no new application/provider traffic.
node scripts/profile_cloudflare_cycle.mjs --run-live \
  --from ACTUAL_START_UTC --to ACTUAL_END_UTC --version DEPLOYED_VERSION_UUID \
  --output /tmp/cycle-capacity.json
```

The private state file defaults to `/tmp/hireflow-p1-capacity/private-session.json`
with mode 0600 and never enters proof output. It is only for the synthetic owner;
do not use a real owner's session. Scoped cleanup of that owner and its telemetry
is separate from browser/provider budgets, which must never be reset for QA.

## Release gate

**The bounded interactive release gate is met: product HTTP P95 9 ms across
120 fetches in a complete, passed two-mode production cycle.** The 14-ms signup
outlier and unmeasured startup/concurrency/large-input boundaries remain above.
The exact earlier failed and successful cycle scopes are retained. The
warm read matrix does not certify long Unicode resumes, uncached discovery,
model calls or cold module startup. Record CPU/memory, invocation errors and
the measured bundle/version, and retain any unmeasured boundaries. The published
[Workers CPU allowance](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)
has limited burst flexibility; passing a short test is not sustained capacity.
No paid infrastructure should be activated automatically to make a test pass.
