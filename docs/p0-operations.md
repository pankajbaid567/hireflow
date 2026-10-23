# Provider recovery and operational visibility

This describes the deployed P0 implementation. [Release verification](p0-verification.md) records the passing new Pages application and account-recovery flows separately from local tests and the legacy bridge boundary. Neither those checks nor a short sample prove sustained Workers Free CPU headroom.

## Safe provider failures

Groq and Gemini failures carry a safe classification: rate limit, timeout, unavailable model, malformed response, authentication/configuration failure, or temporary unavailability. Raw provider bodies, credentials, profile content and PDF bytes are excluded from diagnostics, health records and telemetry. Resume fallback metadata includes the classification and a visible review warning. The factual fallback preserves source evidence and does not claim that a model-backed draft succeeded.

Resume upload failures preserve the previous profile and file. Rate limiting returns HTTP 429 with a bounded `Retry-After` and is not automatically retried against another model; other provider failures return a safe 503 response with `provider_failure`. Text generation shares a 15-second deadline across headers and body consumption. Extraction's existing bounded recovery for temporary failures and explicitly configured fallback remain in place. An unavailable model is a configuration problem; repeatedly requesting the same model does not fix it. See the official [Groq error reference](https://console.groq.com/docs/errors) and [Gemini troubleshooting guide](https://ai.google.dev/gemini-api/docs/troubleshooting).

User-requested resume regeneration is integrated by the reviewed-submission workflow. It must preserve the existing reviewed PDF until a new immutable version is ready, invalidate previous review authorization when the version changes, and enforce the server's three-attempt/ten-minute allowance. A retry never authorizes an employer submission by itself.

## Model diagnostics

Ownership-protected `GET /operations/{user_id}` reports recent provider health, shared browser capacity, owner-scoped cycle metrics and queue alerts. Reading status does not call a model. `POST /operations/{user_id}/diagnostics` is explicit opt-in: at most three already configured model IDs receive a tiny synthetic prompt in parallel, under an eight-second common provider deadline. A durable D1 guard allows one diagnostics request per user per minute. Request-supplied model IDs and URLs are not accepted. Missing keys cause no outbound request.

Health means the most recent request/check succeeded; it is not a promise of continuing availability. After fifteen minutes without a check, status becomes unknown. The optional configured Gemini fallback is labelled separately. The dashboard's **Check configured models** button performs the diagnostic; automatic status loading does not.

## Durable telemetry and capacity controls

Migration `0007_operations.sql` adds `operation_events`, `provider_health` and diagnostic throttles. UUID correlation IDs connect request/provider/task events; the API returns `X-Request-ID`. Owner IDs are stored privately for access filtering. Event fields are explicitly whitelisted: operation/outcome, provider/model, bounded latency, canonical error kind/status and optional attempt/queue/budget counts. Headers, URLs, cookies, emails, names, prompts, JDs, PDFs, answers and raw exception messages are not stored. Monitoring failure does not discard a successful profile or application operation.

Provider latency is recorded for the logical operation. PDF extraction includes its bounded retry/fallback work; it is not a count of every HTTP upload, poll or cleanup subrequest. Search telemetry records each instrumented provider query. This distinction matters when comparing application telemetry to a provider's metered request count.

`OPERATIONS_RETENTION_DAYS` defaults to 7 and is clamped to 1–30 for scheduled pruning. Status aggregates a bounded sample of the owner's last seven days. Request P50/P95/P99 are **wall time**, including network waits. CPU time and isolate memory remain null when platform measurements are unavailable; no conversion from response latency is made. Cloudflare exposes those separately in its [Workers metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/) and [GraphQL analytics guide](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/).

`SUBMISSION_DELAY_SECONDS` defaults to 21 and is clamped to 21–300 seconds. The queue's atomic browser gate enforces this interval across consumers; a waiting delivery is rescheduled rather than sleeping inside a Worker. `BROWSER_DAILY_BUDGET_SECONDS` defaults to 540, cannot exceed 540, and an explicitly invalid value fails closed at zero. Each browser attempt reserves 60 seconds. Remaining slots reflect reservations and do not guarantee successful submissions. Capacity, exhausted-budget and old-queue alerts are shown without exposing other users' profiles or employers. Three provider failures in fifteen minutes trigger a diagnostic warning; an applying record older than ten minutes or missing its processing start triggers a stuck-processing warning. Both counts are owner-scoped and advise checking before retrying. Recovery never bypasses cancellation or current review authorization.

## Repeatable evidence

Use Node 22+ and run only against an authorized deployment. The sampler caps concurrency at 10, requests at 100, individual waits at eight seconds and the sampling window at sixty seconds. It accepts GET `/health`, `/session` or `/operations/{id}` only; it cannot trigger search, resume generation or submission. For protected status, provide `HIREFLOW_SESSION` through the environment, never command arguments.

```bash
node scripts/measure_cloudflare_capacity.mjs \
  --base https://hireflow-dashboard.pages.dev/api \
  --requests 20 --concurrency 4 \
  --platform-metrics --output /tmp/hireflow-capacity-live.json
```

`--platform-metrics` makes one read-only query for this configured Worker's GraphQL invocation/CPU/memory data. It defaults to a clearly labelled mixed last-hour window. Add `--since 2026-10-23T03:00:00.000Z` with the actual deployment-completion timestamp to exclude older invocations; only valid past UTC ISO timestamps are accepted, and the window is capped at 24 hours. The report records exact start/end and whether it was clamped. Wait for analytics ingestion and inspect the resulting sample count before attributing metrics to that release. It uses `CLOUDFLARE_API_TOKEN` or captures the official `wrangler auth token --json` command in memory to refresh existing OAuth, with the standard local OAuth file as a fallback. Credentials never enter arguments or reports. Existing credential refresh can take up to 25 seconds, followed by a ten-second analytics deadline; these are outside the load-sampling window. No plan, scope, new token or account configuration is changed. The live GraphQL schema identifies CPU quantiles as microseconds and `memoryUsageBytesP50/P95/P99` as V8 isolate bytes. The report preserves raw CPU values and also provides an explicit milliseconds conversion. Missing platform data stays unavailable.

On 23 October 2026, the production health sample completed 20/20 successful responses at concurrency four. Client wall P50 was **319 ms**, P95 **851 ms**, P99 **879 ms**, with no HTTP/network failures. Proof: `/tmp/hireflow-capacity-live.json` on the verification machine. This is a small read-only smoke sample, not a maximum-capacity benchmark.

The first analytics request used a stale OAuth credential and received 401. Refresh through the official CLI resolved it. The subsequent last-hour platform sample covered **31 invocations, zero invocation errors**: actual CPU P50 **2.589 ms**, P95 **9.486 ms**, P99 **9.895 ms**; V8 isolate memory P50 **17,197,040 bytes**, P95 **17,205,232 bytes**, P99 **17,213,424 bytes**. Evidence: `/tmp/hireflow-capacity-platform-live.json`, with field/unit introspection in `/tmp/hireflow-platform-schema.json`. These are sampled metrics for the **then-deployed baseline**, not exclusively the health load run and not the P0 bundle. The post-deployment sample below measures the new release separately and retains the CPU-headroom limitation explicitly.

Local verification covers typed Groq/Gemini outages, malformed/model-not-found responses, common diagnostic timeout, response-size limits, redirect refusal, durable throttling, redaction, owner isolation, retention and delay/budget clamps. The load sampler is tested against a local HTTP server and rejects side-effecting endpoints. Actual production review-bound submission and the Pages flow are recorded in the release evidence. The multi-step fault matrix and deterministic spacing/concurrency tests use controlled fixtures; they do not certify arbitrary portals.

## Post-deployment sample

The sampler was rerun after Worker `cdaf5730-d2ea-4544-86b2-746b3694feb6`, using
`--since 2026-10-23T03:38:58Z`. In the sample ending `03:56:21Z`, 20/20 health
requests at concurrency four succeeded: wall P50 **559 ms**, P95 **807 ms**,
P99 **894 ms**. Platform analytics for the release window contained **252
invocations, zero invocation errors**. Actual CPU P50/P95/P99 were
**3.515/14.581/24.715 ms**, and V8 isolate memory was
**17,187,132/20,042,342/20,575,636 bytes**. Proof:
`/tmp/hireflow-capacity-postdeploy-final.json`. This window includes account recovery
and the controlled application cycle, not only health requests; ingestion is
sampled and the request count is not a count of every browser API action.

No resource-limit error was observed in these checks. The CPU tail nevertheless
exceeds the published **10 ms Free HTTP allowance**. Cloudflare documents limited
isolate flexibility for occasional overruns; sustained overruns can be
terminated. Therefore these results **do not establish sustained free-tier
capacity**. Profile and reduce the expensive paths before increasing usage; keep
browser limits and manual handoff intact. See the official
[CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)
and the remaining capacity hardening in [future.md](../future.md). No paid plan
or resource was enabled.

The live review/operations UI proof
`/tmp/hireflow-p0-review-operations-live/a89af405d50a/proof.json` also passed:
three regeneration requests accepted, the fourth returned 429, new PDFs required
review, and exactly one diagnostics request checked three configured models.
Groq `openai/gpt-oss-20b` and Gemini fallback `gemini-3.5-flash-lite` were healthy.
Gemini primary `gemini-3.8-flash` timed out and was shown as needing attention.
Capacity displayed **21-second spacing, eight remaining reservations and zero
queued applications**. The test made no queue confirmation or employer
submission; diagnostics tested availability at that moment only.
