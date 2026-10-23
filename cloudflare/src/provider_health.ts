import { ApiError, type Env } from './types';
import { recordOperation, safeModel, type OperationName } from './telemetry';

export type ProviderName = 'groq' | 'gemini' | 'tavily' | 'serpapi';
export type ProviderFailureKind = 'not_configured' | 'rate_limited' | 'timeout' | 'model_unavailable' | 'malformed' | 'authentication' | 'unavailable' | 'invalid_request';
const messages: Record<ProviderFailureKind,string> = {
  not_configured: 'This provider is not configured. Enter profile facts manually or contact the operator.',
  rate_limited: 'The provider is rate limited. Wait before requesting another attempt.',
  timeout: 'The provider timed out. Your saved facts are unchanged; you can request another attempt.',
  model_unavailable: 'The configured model is unavailable. Contact the operator to check the model setting.',
  malformed: 'The provider returned an unusable response. Review the fallback or request another attempt.',
  authentication: 'The provider rejected its configuration. Contact the operator; repeated retries will not fix this.',
  unavailable: 'The provider is temporarily unavailable. Review the fallback or try again later.',
  invalid_request: 'The provider could not accept this request. Review the inputs or contact the operator.',
};
export class ProviderFailure extends Error {
  readonly retryable: boolean;
  constructor(readonly provider: ProviderName, readonly kind: ProviderFailureKind, readonly http_status?: number, readonly retry_after_seconds?: number) {
    super(messages[kind]); this.name = 'ProviderFailure';
    this.retryable = ['rate_limited','timeout','malformed','unavailable'].includes(kind);
  }
  toJSON() { return { provider: this.provider, kind: this.kind, message: this.message, retryable: this.retryable, ...(this.http_status ? { http_status: this.http_status } : {}), ...(this.retry_after_seconds ? { retry_after_seconds: this.retry_after_seconds } : {}) }; }
}
export function classifyProviderError(provider: ProviderName, error: unknown, options: { status?: number; retryAfter?: string | null; malformed?: boolean; timedOut?: boolean; notConfigured?: boolean } = {}): ProviderFailure {
  if (options.timedOut) return new ProviderFailure(provider,'timeout');
  if (error instanceof ProviderFailure) return error;
  const detail = error && typeof error === 'object' ? error as { status?: unknown; message?: unknown; category?: unknown; name?: unknown; provider_failure?: unknown } : {};
  if (detail.provider_failure instanceof ProviderFailure) return detail.provider_failure;
  const status = options.status ?? (typeof detail.status === 'number' ? detail.status : undefined);
  const message = typeof detail.message === 'string' ? detail.message.slice(0, 500) : '';
  const kind: ProviderFailureKind = options.notConfigured ? 'not_configured' : status === 429 ? 'rate_limited' : options.timedOut || status === 408 || status === 504 || detail.name === 'AbortError' || detail.category === 'timeout' || /timed?\s*out|timeout|aborted/i.test(message) ? 'timeout' : status === 404 || /model[_ -](?:not[_ -]found|decommissioned|unavailable)/i.test(message) ? 'model_unavailable' : status === 401 || status === 403 ? 'authentication' : options.malformed || /invalid (?:response|JSON|selection)|no answer text|did not complete/i.test(message) ? 'malformed' : status && status >= 400 && status < 500 ? 'invalid_request' : 'unavailable';
  let seconds: number | undefined;
  if (options.retryAfter) {
    const numeric = Number(options.retryAfter); const value = Number.isFinite(numeric) ? numeric : (Date.parse(options.retryAfter) - Date.now()) / 1000;
    if (Number.isFinite(value) && value > 0) seconds = Math.ceil(Math.max(1, Math.min(300, value)));
  }
  if (!seconds && kind === 'rate_limited') seconds = 60;
  return new ProviderFailure(provider, kind, status && status >= 100 && status <= 599 ? status : undefined, seconds);
}
const configuredKey = (value: unknown) => typeof value === 'string' && Boolean(value.trim()) && !/^(?:none|null|undefined)$/i.test(value.trim()) && !/your_|placeholder/i.test(value);
export function configuredModels(env: Env) {
  const models: { provider: 'groq' | 'gemini'; model: string; role: 'primary' | 'fallback'; configured: boolean }[] = [
    { provider: 'groq', model: env.GROQ_MODEL || 'openai/gpt-oss-20b', role: 'primary', configured: configuredKey(env.GROQ_API_KEY) },
    { provider: 'gemini', model: (env.GEMINI_MODEL || 'gemini-3.8-flash').replace(/^models\//, ''), role: 'primary', configured: configuredKey(env.GEMINI_API_KEY) || configuredKey(env.GOOGLE_API_KEY) },
  ];
  const fallback = env.GEMINI_FALLBACK_MODEL?.replace(/^models\//, '');
  if (fallback && fallback !== models[1].model) models.push({ provider: 'gemini', model: fallback, role: 'fallback', configured: models[1].configured });
  return models.map(model => ({ ...model, model: safeModel(model.model) || 'invalid-model-setting', configured: model.configured && Boolean(safeModel(model.model)) }));
}
export async function recordProviderOutcome(env: Env, provider: ProviderName, model: string, data: { success: boolean; latency_ms: number; failure?: ProviderFailure; operation?: OperationName; user_id?: number; attempt?: number }): Promise<void> {
  await recordOperation(env, { operation: data.operation || 'provider_text', outcome: data.success ? 'success' : 'failed', latency_ms: data.latency_ms, provider, model, error_kind: data.failure?.kind, http_status: data.failure?.http_status, attempt: data.attempt, user_id: data.user_id });
  if (!env.DB || !safeModel(model)) return;
  try {
    await env.DB.prepare(`INSERT INTO provider_health(provider,model,state,error_kind,latency_ms,consecutive_failures,checked_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(provider,model) DO UPDATE SET state=excluded.state,error_kind=excluded.error_kind,latency_ms=excluded.latency_ms,consecutive_failures=CASE WHEN excluded.state='healthy' THEN 0 ELSE provider_health.consecutive_failures+1 END,checked_at=excluded.checked_at`).bind(provider,model,data.success ? 'healthy' : 'degraded',data.failure?.kind || null,Math.max(0,Math.min(86400000,Math.round(data.latency_ms))),data.success ? 0 : 1,new Date().toISOString()).run();
  } catch { /* Provider work must survive monitoring outages. No raw error logging. */ }
}
export async function safeProviderHealth(env: Env) {
  let rows: Record<string,unknown>[] = [];
  try { if (env.DB) rows = (await env.DB.prepare('SELECT * FROM provider_health ORDER BY checked_at DESC LIMIT 20').all()).results; } catch { /* Unknown is honest when monitoring storage is unavailable. */ }
  return configuredModels(env).map(config => {
    const row = rows.find(item => item.provider === config.provider && item.model === config.model);
    const fresh = row && Date.now() - Date.parse(String(row.checked_at)) < 15 * 60000;
    const kind = row?.error_kind as ProviderFailureKind | undefined;
    return { ...config, state: !config.configured ? 'not_configured' : !fresh ? 'unknown' : row!.state, checked_at: row?.checked_at || null, latency_ms: fresh ? row!.latency_ms : null, failure_kind: fresh ? kind || null : null, message: !config.configured ? messages.not_configured : !fresh ? 'Not checked recently. Run diagnostics to check the configured model.' : row!.state === 'healthy' ? 'The most recent provider request succeeded.' : messages[kind || 'unavailable'] || messages.unavailable };
  });
}
async function boundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return '';
  let result = '', size = 0; const decoder = new TextDecoder();
  const abort=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener('abort',abort,{once:true});
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 32768) throw new Error('invalid response'); result += decoder.decode(next.value,{stream:true}); } return result + decoder.decode(); }
  catch (error) { await reader.cancel(); throw error; }
  finally {signal.removeEventListener('abort',abort);reader.releaseLock();}
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new DOMException('Timed out','AbortError'));
    if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
export async function runModelDiagnostics(env: Env, userId: number, options: { fetcher?: typeof fetch; timeoutMs?: number } = {}) {
  if (!Number.isSafeInteger(userId) || userId < 1) throw new ApiError(422,'Invalid profile ID');
  const now = Date.now();
  const allowed = await env.DB.prepare('INSERT INTO provider_diagnostic_limits(user_id,next_allowed_at) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE provider_diagnostic_limits.next_allowed_at<=? RETURNING user_id').bind(userId,now+60000,now).first();
  if (!allowed) throw new ApiError(429,'Model diagnostics can run once per minute. Please wait before trying again.');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(8000,Math.max(1,options.timeoutMs || 8000)));
  try {
    const checks = await Promise.all(configuredModels(env).filter(config => config.configured).slice(0,3).map(async config => {
      const started = Date.now(); let failure: ProviderFailure | undefined;
      try {
        const groq = config.provider === 'groq';
        const response = await abortable((options.fetcher || fetch)(groq ? 'https://api.groq.com/openai/v1/chat/completions' : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`, { method:'POST',redirect:'manual',signal:controller.signal,headers:groq ? {Authorization:`Bearer ${env.GROQ_API_KEY!.trim()}`,'Content-Type':'application/json'} : {'x-goog-api-key':(env.GEMINI_API_KEY || env.GOOGLE_API_KEY)!.trim(),'Content-Type':'application/json'},body:JSON.stringify(groq ? {model:config.model,messages:[{role:'user',content:'Reply with HireFlow ready.'}],max_completion_tokens:64,reasoning_effort:'low',temperature:0} : {contents:[{parts:[{text:'Reply with HireFlow ready.'}]}],generationConfig:{maxOutputTokens:64}}) }),controller.signal);
        if (!response.ok) { await response.body?.cancel(); throw classifyProviderError(config.provider,null,{status:response.status,retryAfter:response.headers.get('retry-after')}); }
        let value;
        try {value=JSON.parse(await abortable(boundedBody(response,controller.signal),controller.signal));}
        catch {await response.body?.cancel().catch(()=>{});throw classifyProviderError(config.provider,null,{malformed:true,timedOut:controller.signal.aborted});}
        const answer = groq ? value.choices?.[0]?.message?.content : value.candidates?.[0]?.content?.parts?.find((part: {text?:unknown}) => typeof part.text === 'string')?.text;
        if (typeof answer !== 'string' || !answer.trim()) throw classifyProviderError(config.provider,null,{malformed:true});
      } catch (error) { failure = classifyProviderError(config.provider,error,{timedOut:controller.signal.aborted}); }
      const latency = Date.now() - started;
      await recordProviderOutcome(env,config.provider,config.model,{success:!failure,latency_ms:latency,failure,operation:'provider_diagnostic',user_id:userId});
      return { provider:config.provider,model:config.model,role:config.role,state:failure ? 'degraded' : 'healthy',latency_ms:latency,...(failure ? {failure:failure.toJSON()} : {}) };
    }));
    return { checked_at:new Date().toISOString(),checks,providers:await safeProviderHealth(env),message:'Diagnostics use a small synthetic prompt, never your resume or profile. Results describe these checks, not a guarantee of availability.' };
  } finally { clearTimeout(timer); }
}
