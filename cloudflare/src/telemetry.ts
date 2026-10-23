import { ApiError, type Env, type Row, weekStart } from './types';
import { EMBEDDING_MODEL, semanticDailyTextBudget } from './semantic_matching';

export interface OperationContext { correlation_id: string; user_id?: number; cycle_id?: string; }
export type OperationName = 'request' | 'provider_text' | 'provider_extract' | 'resume_tailoring' | 'provider_diagnostic' | 'provider_search' | 'queue_apply' | 'queue_prep' | 'queue_delay' | 'browser_budget';
export type OperationOutcome = 'success' | 'degraded' | 'failed' | 'retry_scheduled' | 'limited' | 'skipped' | 'cancelled';
export interface OperationEvent extends Partial<OperationContext> {
  operation: OperationName; outcome: OperationOutcome; latency_ms: number;
  provider?: string; model?: string; error_kind?: string; http_status?: number;
  attempt?: number; queue_delay_seconds?: number; budget_reserved_seconds?: number;
}
const operations = new Set(['request','provider_text','provider_extract','resume_tailoring','provider_diagnostic','provider_search','queue_apply','queue_prep','queue_delay','browser_budget']);
const outcomes = new Set(['success','degraded','failed','retry_scheduled','limited','skipped','cancelled']);
const providers = new Set(['groq','gemini','tavily','serpapi','browser']);
const failures = new Set(['not_configured','rate_limited','timeout','model_unavailable','malformed','authentication','unavailable','invalid_request','budget_exhausted','queue_backlog','cancelled']);
const uuid = (value: unknown) => typeof value === 'string' && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value) ? value : crypto.randomUUID();
const owner = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
const cycle = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
const number = (value: unknown, max = 86400000) => Number.isFinite(value) ? Math.max(0, Math.min(max, Math.round(Number(value)))) : 0;
const optionalNumber = (value: unknown, max?: number) => value === undefined ? null : number(value, max);
export const safeModel = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9/._-]{0,120}$/.test(value) && !/^(?:gsk_|AIza|sk-)/.test(value) ? value : null;
export function newOperationContext(userId?: number, cycleId = weekStart()): OperationContext {
  return { correlation_id: crypto.randomUUID(), ...(owner(userId) ? { user_id: userId } : {}), ...(cycle(cycleId) ? { cycle_id: cycleId } : {}) };
}
export function submissionDelayMs(env: Env): number {
  const configured = Number(env.SUBMISSION_DELAY_SECONDS);
  return Math.round(Math.max(21, Math.min(300, Number.isFinite(configured) && configured > 0 ? configured : 21)) * 1000);
}
export function browserDailyBudgetSeconds(env: Env): number {
  const value = Number(env.BROWSER_DAILY_BUDGET_SECONDS ?? 540);
  return Math.floor(Math.max(0, Math.min(540, Number.isFinite(value) ? value : 0)));
}
export async function recordOperation(env: Env, event: OperationEvent): Promise<void> {
  if (!operations.has(event.operation) || !outcomes.has(event.outcome)) return;
  const context = env.OPERATION_CONTEXT;
  const clean = { correlation_id: uuid(event.correlation_id || context?.correlation_id), user_id: owner(event.user_id ?? context?.user_id), cycle_id: cycle(event.cycle_id || context?.cycle_id), operation: event.operation,
    provider: providers.has(event.provider || '') ? event.provider! : null, model: safeModel(event.model), outcome: event.outcome, latency_ms: number(event.latency_ms), error_kind: failures.has(event.error_kind || '') ? event.error_kind! : null,
    http_status: event.http_status && event.http_status >= 100 && event.http_status <= 599 ? Math.round(event.http_status) : null, attempt: optionalNumber(event.attempt, 100), queue_delay_seconds: optionalNumber(event.queue_delay_seconds, 86400), budget_reserved_seconds: optionalNumber(event.budget_reserved_seconds, 600) };
  // The whitelist above is the entire persisted/logged shape. Never spread an
  // exception, request, headers, provider body, profile, prompt or PDF here.
  if (!env.DB) return;
  try {
    await env.DB.prepare(`INSERT INTO operation_events(correlation_id,user_id,cycle_id,operation,provider,model,outcome,latency_ms,error_kind,http_status,attempt,queue_delay_seconds,budget_reserved_seconds) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...Object.values(clean)).run();
  } catch { console.warn(JSON.stringify({ event: 'telemetry_write_failed', correlation_id: clean.correlation_id })); }
}
// Aggregate the bounded sample inside D1. Returning 1,000 individual latency
// rows made D1's JSON conversion and this function's sorting the largest local
// CPU-profile frames for the operations route. Nearest-rank percentiles retain
// the previous semantics, including an empty sample and even-sized P50s.
const latencySummarySql = `WITH recent AS (
  SELECT latency_ms FROM operation_events WHERE user_id=? AND operation='request' AND created_at>=?
  ORDER BY created_at DESC LIMIT 1000
), ranked AS (
  SELECT latency_ms,ROW_NUMBER() OVER (ORDER BY latency_ms) AS position,COUNT(*) OVER () AS total FROM recent
)
SELECT COUNT(*) AS sample_count,
  MAX(CASE WHEN position=(total+1)/2 THEN latency_ms END) AS p50,
  MAX(CASE WHEN position=(total*95+99)/100 THEN latency_ms END) AS p95,
  MAX(CASE WHEN position=(total*99+99)/100 THEN latency_ms END) AS p99
FROM ranked`;
export async function getOperationsStatus(env: Env, userId: number) {
  if (!owner(userId)) throw new ApiError(422, 'Invalid profile ID');
  const now = Date.now(), since = new Date(now - 7 * 86400000).toISOString(), day = new Date(now).toISOString().slice(0, 10);
  const results = await env.DB.batch<Row>([
    env.DB.prepare(latencySummarySql).bind(userId, since),
    env.DB.prepare('SELECT operation,provider,outcome,error_kind,count(*) AS count,round(avg(latency_ms)) AS avg_latency_ms,max(latency_ms) AS max_latency_ms FROM operation_events WHERE user_id=? AND created_at>=? GROUP BY operation,provider,outcome,error_kind LIMIT 80').bind(userId, since),
    env.DB.prepare('SELECT cycle_id,count(*) AS event_count,sum(CASE WHEN outcome IN (\'failed\',\'degraded\',\'limited\') THEN 1 ELSE 0 END) AS issues FROM operation_events WHERE user_id=? AND created_at>=? GROUP BY cycle_id ORDER BY cycle_id DESC LIMIT 8').bind(userId, since),
    env.DB.prepare("SELECT count(*) AS queued,min(updated_at) AS oldest_at FROM applications WHERE user_id=? AND status='confirmed'").bind(userId),
    env.DB.prepare('SELECT reserved_seconds,last_launch_at FROM browser_budget WHERE day=?').bind(day),
    env.DB.prepare("SELECT count(*) AS recent_failures FROM operation_events WHERE user_id=? AND provider IN ('groq','gemini','tavily','serpapi') AND outcome IN ('failed','degraded') AND created_at>=?").bind(userId,new Date(now-15*60000).toISOString()),
    env.DB.prepare("SELECT count(*) AS stuck FROM applications WHERE user_id=? AND status='applying' AND (processing_started_at IS NULL OR processing_started_at<?)").bind(userId,new Date(now-10*60000).toISOString()),
    env.DB.prepare('SELECT texts_reserved,characters_reserved FROM semantic_usage WHERE day=?').bind(day),
  ]);
  const timing = results[0].results[0];
  const queued = Number(results[3].results[0]?.queued || 0), oldest = results[3].results[0]?.oldest_at;
  const budget = browserDailyBudgetSeconds(env), reserved = Number(results[4].results[0]?.reserved_seconds || 0), remaining = Math.max(0, budget - reserved);
  const recentFailures=Number(results[5].results[0]?.recent_failures || 0),stuck=Number(results[6].results[0]?.stuck || 0);
  const semanticEnabled=env.SEMANTIC_MATCHING_ENABLED==='true',semanticBudget=semanticDailyTextBudget(env),semanticReserved=Number(results[7].results[0]?.texts_reserved || 0),semanticRemaining=Math.max(0,semanticBudget-semanticReserved);
  const alerts: string[] = [];
  if (env.BROWSER_ENABLED !== 'true') alerts.push('Automatic browser submissions are disabled. Reviewed resumes remain available for manual use.');
  if (remaining < 60) alerts.push('The daily browser allowance cannot start another application. Manual application is available.');
  else if (reserved >= budget * 0.8) alerts.push('Most of the daily browser allowance has been reserved.');
  if (queued >= 20 || oldest && now - Date.parse(String(oldest)) > 600000) alerts.push('Applications are waiting in the queue. Check their status before retrying; do not submit duplicates.');
  if(recentFailures>=3)alerts.push('Several provider requests failed in the last 15 minutes. Check configured models and wait before requesting more attempts.');
  if(stuck)alerts.push('An application has been processing for an unusual time. Check its employer site before retrying to avoid a duplicate submission.');
  if(semanticEnabled&&!env.AI)alerts.push('Semantic matching is unavailable. Plans use lexical matching until an embedding binding is configured.');
  if(semanticEnabled&&semanticRemaining===0)alerts.push('The daily semantic matching allowance is exhausted. New uncached matches use lexical matching; cached embeddings remain available.');
  return { checked_at: new Date(now).toISOString(), providers: [], capacity: { browser_enabled: env.BROWSER_ENABLED === 'true', day_utc: day, daily_budget_seconds: budget, reserved_seconds: reserved, remaining_seconds: remaining, remaining_application_slots: Math.floor(remaining / 60), submission_delay_seconds: submissionDelayMs(env) / 1000, queued_applications: queued, stuck_processing:stuck, recent_provider_failures:recentFailures,
      semantic_matching_enabled:semanticEnabled,semantic_daily_text_budget:semanticBudget,semantic_texts_reserved:semanticReserved,semantic_texts_remaining:semanticRemaining,semantic_characters_reserved:Number(results[7].results[0]?.characters_reserved || 0),semantic_model:`${EMBEDDING_MODEL}:cls` },
    telemetry: { window_days: 7, request_sample_count: Number(timing?.sample_count || 0), wall_time_ms: { p50: timing?.p50 ?? null, p95: timing?.p95 ?? null, p99: timing?.p99 ?? null }, operations: results[1].results, cycles: results[2].results, cpu_time_ms: null, memory_bytes: null, platform_metrics_note: 'Wall time includes network waits. CPU time and isolate memory require Cloudflare platform analytics; these values are not inferred.' }, alerts };
}
export async function pruneOperations(env: Env): Promise<void> {
  const raw = Number(env.OPERATIONS_RETENTION_DAYS || 7), days = Math.max(1, Math.min(30, Number.isFinite(raw) ? raw : 7));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM operation_events WHERE created_at<?').bind(new Date(Date.now() - days * 86400000).toISOString()),
    env.DB.prepare('DELETE FROM provider_diagnostic_limits WHERE next_allowed_at<?').bind(Date.now() - 86400000),
  ]);
}
